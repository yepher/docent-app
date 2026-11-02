// Real Electron, IPC, settings and retrieval; fake scores make ordering and failures deterministic.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-reranker-e2e-"));
const log = join(work, "rerank.jsonl"),
  control = join(work, "control.json");
const requests = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
writeFileSync(control, JSON.stringify({ reverse: true }));
const paths = ["reset.md", "restart.md", "private.md"].map((name) =>
  join(work, name),
);
[
  "Restart the device with a factory reset to delete all saved projects.",
  "Restart the device safely by holding Power for ten seconds. Saved projects remain intact.",
  "PRIVATE SOURCE: Restart the device using a confidential process for saved projects.",
].forEach((text, i) => writeFileSync(paths[i], text));
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
    DOCENT_TEST_RERANK_LOG: log,
    DOCENT_TEST_RERANK_CONTROL: control,
  },
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  // waitForFunction treats a Promise as truthy before resolving it; poll IPC results explicitly.
  const waitForApi = async (predicate, arg) => {
    const deadline = Date.now() + 30000;
    while (!(await page.evaluate(predicate, arg))) {
      assert.ok(
        Date.now() < deadline,
        "Timed out waiting for the local app state",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1200, height: 900 });
  await waitForApi(
    async () => (await window.api.reranker.state()).phase === "ready",
  );
  const add = async (name, files) => {
    await page.getByPlaceholder("New set name").fill(name);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: paths,
      });
    }, files);
    await page
      .getByRole("button", { name: "Add files", exact: true })
      .last()
      .click();
    await waitForApi(
      async ({ name, count }) => {
        const set = (await window.api.sets.list()).find((s) => s.name === name);
        return set?.chunkCount === count;
      },
      { name, count: files.length },
    );
  };
  await add("Manuals", paths.slice(0, 2));
  await add("Private", paths.slice(2));
  await page.getByLabel("Use Private", { exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('input[aria-label="Use Private"]').checked,
  );
  await page.getByText("Search quality · Enhanced", { exact: true }).click();
  const toggle = page.getByLabel("Use enhanced retrieval", { exact: true });
  assert.equal(await toggle.isChecked(), true);
  const ask = async (question) => {
    await page.getByPlaceholder("Ask something").fill(question);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  };
  await ask("How do I restart the device and keep saved projects?");
  const firstRequest = requests()[0];
  assert.equal(firstRequest.documents.length, 2);
  assert.ok(
    firstRequest.documents.every((d) => !d.includes("PRIVATE SOURCE")),
    "unselected sources never reach the reranker",
  );
  // The fake server ranks the last candidate first. Inspect the actual displayed citation.
  await page.locator(".message.assistant .cite").last().click();
  assert.ok(
    (await page.locator(".source-detail").innerText()).includes(
      firstRequest.documents.at(-1).split("\n").slice(1).join("\n"),
    ),
    "the reranked first passage becomes citation 1",
  );
  await page
    .locator(".source-detail")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  writeFileSync(control, JSON.stringify({ fail: true }));
  await ask("How should I safely restart this device with saved projects?");
  await page
    .getByText(
      "The extra relevance check was unavailable, so this answer used standard search.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.evaluate(async () => (await window.api.runtime.state()).phase),
    "ready",
  );
  await toggle.click();
  await waitForApi(
    async () => (await window.api.reranker.state()).phase === "disabled",
  );
  const before = requests().length;
  await ask("What happens to saved projects when I restart the device?");
  assert.equal(
    requests().length,
    before,
    "disabled reranking makes no scoring requests",
  );
  await page.reload();
  await page.getByText("Search quality · Standard", { exact: true }).click();
  assert.equal(
    await toggle.isChecked(),
    false,
    "the disabled setting survives a reload",
  );
  // Restarting the model runtime also reads the persisted preference.
  await page.evaluate(() => window.api.runtime.restart());
  assert.equal(
    await page.evaluate(async () => (await window.api.reranker.state()).phase),
    "disabled",
  );
  writeFileSync(control, JSON.stringify({ delayMs: 10000 }));
  await toggle.click();
  await waitForApi(
    async () => (await window.api.reranker.state()).phase === "ready",
  );
  await page.evaluate(() => {
    window.testEvents = [];
    window.api.chat.onEvent((event) => window.testEvents.push(event));
  });
  await page
    .getByPlaceholder("Ask something")
    .fill("How do I restart the device and keep saved projects?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText("Checking which passages best answer your question…", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .getByRole("button", { name: "Send", exact: true })
    .waitFor({ timeout: 3000 });
  await page.waitForFunction(() =>
    window.testEvents.some(
      (e) => e.type === "error" && e.message === "Stopped.",
    ),
  );
  assert.equal(
    await page.evaluate(() =>
      window.testEvents.some((e) => e.type === "delta" || e.type === "done"),
    ),
    false,
    "the main process cancels instead of completing the answer later",
  );
  assert.equal(
    (await page.locator(".message.assistant .text").last().innerText()).trim(),
    "",
    "cancelling retrieval does not invent an answer",
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(work, "search-quality.png") });
  console.log(
    `Reranker Electron E2E passed; screenshot: ${join(work, "search-quality.png")}`,
  );
} catch (error) {
  console.error(await (await app.firstWindow()).locator("body").innerText());
  console.error("Rerank requests", requests());
  console.error(
    "Chat events",
    await (await app.firstWindow()).evaluate(() => window.testEvents),
  );
  throw error;
} finally {
  await app.close();
}
