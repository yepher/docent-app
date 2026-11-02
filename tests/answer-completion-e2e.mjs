// Real Electron, text + speech, with a model deliberately returning only a source header.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
const root = resolve(import.meta.dirname, "..");
for (const fault of ["once", "always"]) {
  const work = mkdtempSync(join(tmpdir(), "docent-answer-completion-"));
  const doc = join(work, "2023-design-review.txt"),
    log = join(work, "chat.jsonl"),
    speech = join(work, "speech.jsonl");
  writeFileSync(
    doc,
    "Maya recommended adapter support to connect the existing equipment.\n",
  );
  const app = await electron.launch({
    args: [root, `--user-data-dir=${join(work, "profile")}`],
    cwd: root,
    env: {
      ...process.env,
      DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
      DOCENT_TEST_REFERENCE_ONLY: fault,
      DOCENT_TEST_CHAT_LOG: log,
      DOCENT_TEST_TTS_LOG: speech,
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    await page.getByPlaceholder("New set name").fill("Meeting notes");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, doc);
    await page.getByRole("button", { name: "Add files", exact: true }).click();
    await page.getByText("1 file", { exact: true }).waitFor();
    await page.getByLabel("Speak replies").check();
    await page.evaluate(() => {
      window.leakedSourceHeader = false;
      new MutationObserver(() => {
        if (
          [...document.querySelectorAll(".message.assistant .text")].some(
            (el) => /document ID|2023-design-review\.txt/.test(el.textContent),
          )
        )
          window.leakedSourceHeader = true;
      }).observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    await page
      .getByPlaceholder("Ask something")
      .fill("Who recommended adapter support?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    const text = await page.locator(".message.assistant .text").innerText();
    assert.match(
      text,
      fault === "once"
        ? /Maya recommended adapter support/
        : /couldn't turn them into a useful answer/,
    );
    assert.equal(await page.evaluate(() => window.leakedSourceHeader), false);
    assert.equal(await page.locator(".evidence-warning").count(), 0);
    const requests = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(requests.length, 2, "one draft and one bounded repair");
    const spoken = readFileSync(speech, "utf8");
    assert.doesNotMatch(spoken, /document ID|2023-design-review\.txt/);
    assert.match(spoken, fault === "once" ? /Maya/ : /useful answer/);
    await page
      .locator(
        fault === "once"
          ? ".message.assistant .cite"
          : ".message.assistant .uncited button",
      )
      .first()
      .click();
    assert.match(
      await page.locator(".source-detail").innerText(),
      /Maya recommended adapter support/,
    );
    console.log(`Answer completion E2E passed (${fault})`);
  } finally {
    await app.close();
  }
}
