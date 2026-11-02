import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-code-rendering-"));
const replyPath = join(work, "reply.md");
const source = join(work, "attention.txt");
const log = join(work, "chat.jsonl");
const code = [
  "def attention(queries, keys, values):",
  "    # Compute scores and select a row",
  "    scores = queries @ keys.T",
  "    first = scores[0]",
  "    rows = [1, 2, 99]",
  "",
  '    label = "Keep  two  spaces and this long literal string"',
  "    return first, values",
  "",
].join("\n");
const htmlCode =
  '<script>window.executedCode = true</script>\n<img src=x onerror="window.executedCode = true">\n' +
  `<!-- ${"long-line-".repeat(45)} -->\n`;
const reply =
  "**Attention example** [1].\n\n```python\n" +
  code +
  "```\n\nUse **`queries[0]`** for the first row [1].\n\n~~~html\n" +
  htmlCode +
  "~~~\n";
writeFileSync(replyPath, reply);
writeFileSync(
  source,
  "Attention computes scores from queries and keys and uses them to weight values. The first row is an example.",
);
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
    DOCENT_TEST_CODE_REPLY: replyPath,
    DOCENT_TEST_CHAT_LOG: log,
  },
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (/same key|unique.*key/i.test(m.text())) errors.push(m.text());
  });
  const startupDeadline = Date.now() + 30000;
  while (
    !(await page.evaluate(
      async () => (await window.api.runtime.state()).phase === "ready",
    ))
  ) {
    assert.ok(Date.now() < startupDeadline, "Model did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await app.evaluate(({ clipboard }) => {
    globalThis.codeCopies = [];
    clipboard.writeText = (text) => globalThis.codeCopies.push(text);
  });
  await page.getByLabel("Speak replies").uncheck();
  await page.getByPlaceholder("Ask something").fill("Show a code example");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The first fence must render before its closing fence arrives.
  await page.waitForFunction(() => {
    const code = document.querySelector(
      ".message.assistant pre code",
    )?.textContent;
    return (
      document.querySelector(".message.error") ||
      (code?.includes("def attention") && !code.includes("return first"))
    );
  });
  assert.equal(
    await page.getByRole("button", { name: "Stop", exact: true }).isVisible(),
    true,
  );
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  const message = page.locator(".message.assistant").last();
  assert.equal(await message.locator("pre code").nth(0).textContent(), code);
  assert.equal(
    await message.locator("pre code").nth(1).textContent(),
    htmlCode,
  );
  assert.equal(
    await message.locator("code.inline-code").textContent(),
    "queries[0]",
  );
  assert.equal(
    await message.locator("pre .cite, code .cite, pre strong").count(),
    0,
  );
  assert.equal(await message.locator("script, img").count(), 0);
  assert.equal(await page.evaluate(() => window.executedCode), undefined);
  assert.equal(
    await message
      .locator("pre")
      .last()
      .evaluate((el) => el.scrollWidth > el.clientWidth),
    true,
  );
  assert.equal(
    await page
      .locator(".messages")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
    "long code lines must scroll within the snippet",
  );
  await message
    .locator(".answer-code")
    .first()
    .getByRole("button", { name: "Copy code", exact: true })
    .click();
  await message
    .locator(".answer-code")
    .first()
    .getByRole("button", { name: "Copied!", exact: true })
    .waitFor();
  assert.equal(await app.evaluate(() => globalThis.codeCopies.at(-1)), code);
  await page.screenshot({ path: join(work, "code-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: join(work, "code-light.png") });
  const saved = await page.evaluate(() => window.api.chat.conversations());
  const general = saved.find((c) => c.title === "Show a code example");
  assert.ok(
    general.messages.at(-1).text.includes("```python\n" + code + "```"),
  );

  // The document answer passes through evidence review and final citation cleanup too.
  await page.getByPlaceholder("New set name").fill("Research");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, source);
  await page.getByRole("button", { name: "Add files", exact: true }).click();
  await page.getByText("1 file", { exact: true }).waitFor();
  await page
    .getByPlaceholder("Ask something")
    .fill("Show attention code from these notes");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  assert.equal(await message.locator("pre code").first().textContent(), code);
  assert.equal(await message.locator(".text .cite").count(), 2);
  const requests = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(
    requests.length,
    2,
    "code strings and array indices must not trigger a spurious repair",
  );
  await message.locator(".text .cite").first().click();
  await page
    .locator(".source-detail blockquote")
    .filter({ hasText: "Attention computes" })
    .waitFor();
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page
    .locator(".history-row")
    .filter({ hasText: "Show a code example" })
    .getByRole("button")
    .first()
    .click();
  assert.equal(
    await page.locator(".message.assistant pre code").first().textContent(),
    code,
  );
  assert.deepEqual(errors, []);
  console.log(`Code rendering E2E passed; screenshots: ${work}`);
} catch (error) {
  const page = await app.firstWindow();
  console.error(
    "Code-rendering failure:",
    await page.locator("body").innerText(),
  );
  console.error(
    "Model state:",
    await page.evaluate(() => window.api.runtime.state()),
  );
  console.error("Test profile:", work);
  throw error;
} finally {
  await app.close();
}
