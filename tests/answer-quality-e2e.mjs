// A real Electron turn with two native calls, malformed final output, recovery, and attributed posts.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-answer-quality-"));
const doc = join(work, "thread-tool.md"),
  log = join(work, "chat.jsonl");
writeFileSync(
  doc,
  `# Thread Tool\n\n## Post 1 — Alice\n\n<p>Please add a thread tool for screws.</p>\n\n## Post 2 — Staff\n\n<aside class="quote"><blockquote>Please add a thread tool for screws.</blockquote></aside>\n<p>What I’d like to understand is why you need the threads to be modeled.</p>\n\n## Post 3 — Bob\n\n<p>+1 for the feature request</p>\n`,
);
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
    DOCENT_TEST_CHAT_LOG: log,
    DOCENT_TEST_PROTOCOL_FAULT: "1",
  },
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.getByPlaceholder("New set name").fill("Forum");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, doc);
  await page.getByRole("button", { name: "Add files", exact: true }).click();
  await page.getByText("1 file", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.leakedControl = false;
    new MutationObserver(() => {
      if (
        [...document.querySelectorAll(".message.assistant .text")].some((el) =>
          /<tool_call|<function=|<parameter=/.test(el.textContent),
        )
      )
        window.leakedControl = true;
    }).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  const ask = async (q) => {
    await page.getByPlaceholder("Ask something").fill(q);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  };
  await ask("How is thread support described in this forum?");
  assert.match(
    await page.locator(".message.assistant .text").last().innerText(),
    /The answer is in your documents/,
  );
  assert.equal(await page.evaluate(() => window.leakedControl), false);
  const requests = () =>
    readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(
    requests().length,
    5,
    "two tool rounds, one broken final response, one recovery, and evidence review",
  );
  assert.equal(
    requests()
      .at(-1)
      .some((m) => m.role === "tool" || m.tool_calls),
    false,
    "recovery uses a fresh evidence context",
  );
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await ask("Who has requested Thread support");
  const text = await page
    .locator(".message.assistant .text")
    .last()
    .innerText();
  assert.match(text, /Alice/);
  assert.match(text, /Bob/);
  assert.doesNotMatch(text, /Staff/);
  assert.equal(
    requests().length,
    5,
    "named request examples come directly from attributed evidence",
  );
  await page.locator(".message.assistant .cite").first().click();
  const evidence = await page.locator(".source-detail").innerText();
  assert.match(evidence, /Post 1 — Alice/);
  assert.match(evidence, /Please add a thread tool for screws/);
  await page.screenshot({ path: join(work, "answer.png") });
  console.log(
    `Answer quality E2E passed; screenshot: ${join(work, "answer.png")}`,
  );
} finally {
  await app.close();
}
