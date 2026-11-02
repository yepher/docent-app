// Search is local: exercise the real renderer, indexing and IPC without generating an answer.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-citation-search-"));
const manual = join(work, "signals.txt");
const other = join(work, "garden.txt");
const first =
  "Amber signal.\n" +
  "Keep the surface clean.\n".repeat(11) +
  "An AMBER signal remains lit.\n" +
  "Check the wiring before use.\n".repeat(9) +
  "C++ and <script> are literal text.\nThe amber signal marks the ready state in this manual.";
writeFileSync(
  manual,
  first +
    "\n\n" +
    "Inspect each connection carefully. ".repeat(20) +
    "\n\nThe ORCHID marker is only in the full document.",
);
writeFileSync(
  other,
  "Violet flowers grow in the garden. Violet petals open in spring.",
);
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
  },
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.getByPlaceholder("New set name").fill("Manuals");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await app.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: files,
      });
    },
    [manual, other],
  );
  await page.getByRole("button", { name: "Add files", exact: true }).click();
  await page.getByText("2 files", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Search library", exact: true })
    .click();
  const openSource = async (query) => {
    await page.getByLabel("Search library", { exact: true }).fill(query);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.locator(".search-result").first().click();
  };
  await openSource("amber");
  const source = page.getByRole("complementary", { name: "Citation" });
  const field = source.getByLabel("Find in source");
  const counter = source.locator(".source-find-count");
  const expectCount = async (value) =>
    counter.getByText(value, { exact: true }).waitFor();
  const expectActiveVisible = async () => {
    await page.waitForFunction(() => {
      const panel = document.querySelector(".source-detail");
      const active = panel?.querySelector(".source-match-active");
      if (!active) return false;
      const r = active.getBoundingClientRect();
      const toolbar = panel
        .querySelector(".source-find")
        .getBoundingClientRect();
      return (
        r.top >= toolbar.bottom &&
        r.bottom <= panel.getBoundingClientRect().bottom
      );
    });
  };
  await field.fill("amber");
  await expectCount("1 of 3");
  assert.equal(await source.locator("mark").count(), 3);
  assert.equal(await source.locator(".source-match-active").count(), 1);
  await source.getByRole("button", { name: "Next match", exact: true }).click();
  await expectCount("2 of 3");
  await field.press("Enter");
  await expectCount("3 of 3");
  await expectActiveVisible();
  assert.equal(
    await field.evaluate((el) => el === document.activeElement),
    true,
  );
  await field.press("Enter");
  await expectCount("1 of 3");
  await field.press("Shift+Enter");
  await expectCount("3 of 3");
  await expectActiveVisible();
  await page.screenshot({ path: join(work, "citation-search-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: join(work, "citation-search-light.png") });
  await field.fill("not-present");
  await expectCount("No matches");
  assert.equal(
    await source
      .getByRole("button", { name: "Next match", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await source.locator("mark").count(), 0);
  await field.fill("C++");
  await expectCount("1 of 1");
  await source.locator(".evidence summary").click();
  await source.getByRole("button", { name: "Next match", exact: true }).click();
  await expectActiveVisible();
  await field.fill("<script>");
  await expectCount("1 of 1");
  assert.equal(await source.locator("script").count(), 0);
  await field.fill("orchid");
  await expectCount("No matches");
  await source.getByLabel("Search within").selectOption("document");
  await expectCount("1 of 1");
  await expectActiveVisible();
  await field.fill("amber");
  await expectCount("1 of 3"); // Indexed retrieval overlap must not count twice.
  await field.press("Escape");
  assert.equal(await field.inputValue(), "");
  assert.equal(await source.locator("mark").count(), 0);
  await page.getByLabel("Search library", { exact: true }).focus();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+f" : "Control+f",
  );
  assert.equal(
    await field.evaluate((el) => el === document.activeElement),
    true,
  );
  await field.fill("amber");
  await source
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  assert.equal(await field.inputValue(), "");
  // A second citation in the same document must reset find without remounting its visual viewer.
  await field.fill("amber");
  await page.locator(".search-result").nth(1).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Find in source"]')?.value === "",
  );
  assert.equal(await field.inputValue(), "");
  assert.equal(
    await source.getByLabel("Search within").inputValue(),
    "passage",
  );
  await openSource("violet");
  assert.equal(await field.inputValue(), "");
  assert.equal(
    await source.getByLabel("Search within").inputValue(),
    "passage",
  );
  await field.fill("violet");
  await expectCount("1 of 2");
  await source.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await page.locator(".source-detail").count(), 0);
  assert.deepEqual(errors, []);
  console.log(`Citation search E2E passed; screenshots: ${work}`);
} finally {
  await app.close();
}
