// Compare general chat and document answers through real IPC, with isolated data and a fake model.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-general-chat-"));
const log = join(work, "chat.jsonl");
const doc = join(work, "reference.txt");
const broken = join(work, "broken.docx");
writeFileSync(doc, "The reference code for this document is TOPAZ-742.");
writeFileSync(broken, "Not a valid DOCX archive.");
const requests = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
const latest = () => requests().at(-1);
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
    DOCENT_TEST_CHAT_LOG: log,
  },
});
const page = await app.firstWindow();
const until = async (check) => {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Docent");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const ask = async (question, expected) => {
  await page.getByPlaceholder("Ask something").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .locator(".message.assistant .text")
    .last()
    .getByText(expected, { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
};
const addSet = async (name) => {
  await page.getByPlaceholder("New set name").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel(`Use ${name}`).waitFor();
};
const selectSet = async (name, selected) => {
  const checkbox = page.getByLabel(`Use ${name}`);
  if ((await checkbox.isChecked()) !== selected) await checkbox.click();
  // Selection is persisted in the main process before React refreshes the checkbox.
  await until(async () => (await checkbox.isChecked()) === selected);
};
const importFile = async (name, path) => {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
  await page
    .locator(".sets > li")
    .filter({ has: page.getByLabel(`Use ${name}`) })
    .getByRole("button", { name: "Add files", exact: true })
    .click();
};
try {
  await page.waitForFunction(() => !!window.api);
  await until(() =>
    page.evaluate(
      async () => (await window.api.runtime.state()).phase === "ready",
    ),
  );
  assert.equal(await page.getByLabel("Answer mode").inputValue(), "auto");
  await page
    .getByText("General knowledge · no document evidence", { exact: true })
    .waitFor();
  await ask("Explain photosynthesis.", "Hello from the fake model.");
  assert.equal(latest().length, 2);
  assert.match(latest()[0].content, /helpful assistant running privately/);
  assert.doesNotMatch(JSON.stringify(latest()), /Sources:|TOPAZ-742/);
  assert.equal(await page.locator(".message.assistant .cite").count(), 0);
  await ask("Explain it more simply.", "Hello from the fake model.");
  assert.ok(
    latest().some(
      (message) =>
        message.role === "user" &&
        message.content === "Explain photosynthesis.",
    ),
  );
  await until(() =>
    page.evaluate(async () =>
      (await window.api.chat.conversations()).some(
        (c) =>
          c.title === "Explain photosynthesis." &&
          c.messages.length === 4 &&
          c.mode === "general" &&
          c.answerMode === "auto",
      ),
    ),
  );

  await page.reload();
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page.getByRole("button", { name: /^Explain photosynthesis\./ }).click();
  assert.equal(
    await page.getByLabel("Answer mode").inputValue(),
    "auto",
    "reopening an automatic chat retains automatic switching",
  );

  await addSet("Library");
  await page.getByText("Answering from: Library", { exact: true }).waitFor();
  await page.getByText("Sources changed.", { exact: false }).waitFor();
  let before = requests().length;
  await ask("What is in the empty set?", "No searchable documents are ready");
  assert.equal(
    requests().length,
    before,
    "an empty selected set never falls back to base knowledge",
  );
  await importFile("Library", doc);
  await until(() =>
    page.evaluate(async () =>
      (await window.api.sets.list()).some(
        (s) => s.name === "Library" && s.chunkCount > 0,
      ),
    ),
  );
  await ask("What is the reference code?", "The answer is in your documents");
  assert.match(JSON.stringify(latest()), /TOPAZ-742/);
  assert.doesNotMatch(
    JSON.stringify(latest()),
    /photosynthesis|Explain it more simply/,
  );
  assert.ok((await page.locator(".message.assistant .cite").count()) > 0);
  await until(() =>
    page.evaluate(async () =>
      (await window.api.chat.conversations()).some(
        (c) =>
          c.mode === "documents" &&
          c.answerMode === "auto" &&
          c.messages.some((m) =>
            m.citations?.some((citation) => citation.cited),
          ),
      ),
    ),
  );

  await selectSet("Library", false);
  await page
    .getByText("General knowledge · no document evidence", { exact: true })
    .waitFor();
  await ask("What is the reference code?", "Hello from the fake model.");
  assert.equal(
    latest().length,
    2,
    "deselecting the last set clears document conversation history",
  );
  assert.doesNotMatch(
    JSON.stringify(latest()),
    /TOPAZ-742|Sources:|answer is in your documents/,
  );
  assert.equal(await page.locator(".message.assistant .cite").count(), 0);

  await page.getByLabel("Answer mode").selectOption("documents");
  before = requests().length;
  await ask("Strict document test.", "Select a document set");
  assert.equal(
    requests().length,
    before,
    "explicit document-only mode stays strict without selected sets",
  );
  await page.getByLabel("Answer mode").selectOption("general");
  await selectSet("Library", true);
  await ask("Explain gravity.", "Hello from the fake model.");
  assert.doesNotMatch(
    JSON.stringify(latest()),
    /TOPAZ-742|Sources:/,
    "explicit general chat ignores checked sets",
  );
  await until(() =>
    page.evaluate(async () =>
      (await window.api.chat.conversations()).some(
        (c) => c.title === "Explain gravity." && c.answerMode === "general",
      ),
    ),
  );
  await page.getByLabel("Answer mode").selectOption("auto");
  await page.getByText("Answering from: Library", { exact: true }).waitFor();
  await selectSet("Library", false);

  await addSet("Failed import");
  await importFile("Failed import", broken);
  await until(() =>
    page.evaluate(async () =>
      (await window.api.sets.list()).some(
        (s) => s.name === "Failed import" && s.failedCount === 1,
      ),
    ),
  );
  before = requests().length;
  await ask(
    "What does the failed document say?",
    "No searchable documents are ready",
  );
  assert.equal(
    requests().length,
    before,
    "failed imports cannot silently switch to base knowledge",
  );
  console.log(
    "General chat E2E passed: automatic empty-selection chat, follow-ups, saved mode, document/general context isolation, explicit overrides, empty sets and failed imports.",
  );
} catch (error) {
  console.error("Test profile:", work);
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await app.close();
}
