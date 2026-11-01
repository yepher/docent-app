// Native File objects travel through Chromium drag/drop, preload webUtils, and the real main process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-drop-e2e-"));
const folder = join(work, "Research folder"),
  doc = join(work, "manual.txt");
mkdirSync(join(folder, "nested"), { recursive: true });
writeFileSync(doc, "The manual describes replacing the filter.");
writeFileSync(
  join(folder, "paper.md"),
  "Research uses an attention mechanism.",
);
writeFileSync(
  join(folder, "nested", "notes.txt"),
  "Nested notes discuss a second study.",
);
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
  },
});
let page = await app.firstWindow();
try {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForFunction(
    async () => (await window.api.runtime.state()).phase === "ready",
  );
  const cdp = await page.context().newCDPSession(page);
  const drop = async (paths) => {
    const box = await page.locator(".chat").boundingBox();
    for (const type of ["dragEnter", "dragOver", "drop"])
      await cdp.send("Input.dispatchDragEvent", {
        type,
        x: box.x + box.width / 2,
        y: box.y + 200,
        data: { items: [], files: paths, dragOperationsMask: 1 },
      });
  };
  await drop([folder, doc]);
  let chooser = page.getByRole("dialog", { name: "Add to Docent" });
  await chooser.waitFor();
  assert.equal(await chooser.locator(".import-items li").count(), 2);
  assert.equal(
    (await page.evaluate(() => window.api.sets.list())).length,
    0,
    "a drop alone never creates a set",
  );
  await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
  await chooser.waitFor({ state: "hidden" });
  assert.equal((await page.evaluate(() => window.api.sets.list())).length, 0);

  await drop([folder]);
  await chooser.waitFor();
  assert.equal(
    await chooser.getByLabel("Import set name").inputValue(),
    "Research folder",
  );
  await chooser.getByLabel("Import set name").fill("Dropped research");
  await page.screenshot({
    path: process.argv[2] ?? join(work, "import-chooser.png"),
  });
  await chooser.getByRole("button", { name: "Import", exact: true }).click();
  await chooser.waitFor({ state: "hidden" });
  await page.getByText("2 files", { exact: true }).waitFor();
  const research = (await page.evaluate(() => window.api.sets.list()))[0];
  assert.equal(research.name, "Dropped research");
  assert.equal(
    (await page.evaluate((id) => window.api.sets.documents(id), research.id))
      .length,
    2,
    "folder import includes nested supported documents",
  );
  await drop([doc]);
  await chooser.waitFor();
  assert.equal(
    await chooser.getByLabel("Import destination").inputValue(),
    String(research.id),
  );
  await chooser.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByText("3 files", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.api.sets.list())).length, 1);

  // macOS Dock events share the chooser, coalesce multiple items, and restore the window.
  await app.evaluate(
    ({ app, BrowserWindow }, paths) => {
      BrowserWindow.getAllWindows()[0].minimize();
      for (const path of paths)
        app.emit("open-file", { preventDefault() {} }, path);
    },
    [folder, doc],
  );
  await chooser.waitFor();
  assert.equal(await chooser.locator(".import-items li").count(), 2);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMinimized(),
    ),
    false,
  );
  await chooser.getByLabel("Import destination").selectOption("new");
  await chooser.getByLabel("Import set name").fill("Dock import");
  await chooser.getByRole("button", { name: "Import", exact: true }).click();
  await page.waitForFunction(async () =>
    (await window.api.sets.list()).some(
      (s) => s.name === "Dock import" && s.documentCount === 3,
    ),
  );

  // A pending drop survives a renderer reload and can still be cancelled without importing.
  await drop([doc]);
  await chooser.waitFor();
  await page.reload();
  await chooser.waitFor();
  await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
  await chooser.waitFor({ state: "hidden" });
  assert.equal((await page.evaluate(() => window.api.sets.list())).length, 2);
  const unsupported = join(work, "archive.zip");
  writeFileSync(unsupported, "not a document");
  await drop([unsupported]);
  await page
    .getByRole("alert")
    .filter({ hasText: "not a supported document" })
    .waitFor();
  assert.equal(await chooser.count(), 0);

  // On macOS an app with no windows still receives Dock drops and opens a new window.
  if (process.platform === "darwin") {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    const nextWindow = app.waitForEvent("window");
    await app.evaluate(
      ({ app }, path) => app.emit("open-file", { preventDefault() {} }, path),
      doc,
    );
    page = await nextWindow;
    chooser = page.getByRole("dialog", { name: "Add to Docent" });
    await chooser.waitFor();
    await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  console.log(
    "Import E2E passed: native file/folder drops, chooser, new/existing sets, nested files, cancellation, Dock events, reload, and background reopen.",
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  console.error("Test profile:", work);
  await page.screenshot({ path: join(work, "failure.png") });
  throw error;
} finally {
  await app.close();
}
