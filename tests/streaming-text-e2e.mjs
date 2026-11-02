// Regression: bold fragments on either side of citations had duplicate React keys.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-streaming-text-"));
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
    DOCENT_TEST_FORMAT_STREAM: "1",
  },
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const deadline = Date.now() + 30000;
  while (
    !(await page.evaluate(
      async () => (await window.api.runtime.state()).phase === "ready",
    ))
  ) {
    assert.ok(Date.now() < deadline, "Model did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await page.getByLabel("Answer mode").selectOption("general");
  await page.getByLabel("Speak replies").uncheck();
  await page.evaluate(() => {
    window.duplicateText = false;
    new MutationObserver(() => {
      const text =
        document.querySelector(".message.assistant .text")?.textContent ?? "";
      if (
        (text.match(/Encoder/g) ?? []).length > 1 ||
        (text.match(/Decoder/g) ?? []).length > 1
      )
        window.duplicateText = true;
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.getByPlaceholder("Ask something").fill("Describe the layers");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  const text = await page.locator(".message.assistant .text").innerText();
  assert.equal((text.match(/Encoder/g) ?? []).length, 1, text);
  assert.equal((text.match(/Decoder/g) ?? []).length, 1);
  assert.equal(
    await page.evaluate(() => window.duplicateText),
    false,
    "no duplicate bold fragments during any streaming update",
  );
  assert.match(text, /cross-attention/);
  console.log("Streaming formatting E2E passed");
} finally {
  await app.close();
}
