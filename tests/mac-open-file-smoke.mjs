// node tests/mac-open-file-smoke.mjs /absolute/path/to/Docent.app
// Exercise Launch Services on a fresh process, before its renderer or models are ready.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
if (process.platform !== "darwin")
  throw new Error("This smoke test requires macOS.");
const bundle = resolve(process.argv[2]);
const types = JSON.parse(
  execFileSync(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleDocumentTypes",
      "json",
      "-o",
      "-",
      join(bundle, "Contents/Info.plist"),
    ],
    { encoding: "utf8" },
  ),
);
assert.ok(
  types.some(
    (t) =>
      t.LSItemContentTypes?.includes("public.data") &&
      t.LSItemContentTypes?.includes("public.folder") &&
      t.LSHandlerRank === "Alternate",
  ),
);
const work = mkdtempSync(join(tmpdir(), "docent-native-open-"));
const file = join(work, "Cold launch document.txt"),
  folder = join(work, "Cold launch folder");
writeFileSync(file, "A file supplied by Launch Services.");
mkdirSync(folder);
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
execFileSync("/usr/bin/open", [
  "-n",
  "-a",
  bundle,
  file,
  folder,
  "--args",
  `--user-data-dir=${join(work, "profile")}`,
  `--remote-debugging-port=${port}`,
]);
let browser;
try {
  for (let i = 0; i < 100 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
    } catch {
      await delay(200);
    }
  }
  assert.ok(browser, "The fresh packaged app should start its renderer.");
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await page.waitForFunction(
    async () =>
      window.api &&
      (await window.api.imports.pending()).flatMap((r) => r.items).length === 2,
  );
  const pending = await page.evaluate(() => window.api.imports.pending());
  assert.deepEqual(pending.flatMap((r) => r.items.map((i) => i.name)).sort(), [
    "Cold launch document.txt",
    "Cold launch folder",
  ]);
  assert.equal(
    (await page.evaluate(() => window.api.sets.list())).length,
    0,
    "native drops still require an import destination",
  );
  await page.getByText(/drops? (?:is|are) waiting/).waitFor();
  await page.screenshot({ path: join(work, "native-open.png") });
  console.log(
    "Packaged macOS native-open smoke passed: registered file/folder types and cold-launch drops retained before model setup.",
  );
} finally {
  if (browser) {
    const session = await browser.newBrowserCDPSession();
    // Electron can exit before acknowledging Browser.close over CDP.
    await Promise.race([session.send("Browser.close").catch(() => {}), delay(1000)]);
    await browser.close().catch(() => {});
  }
}
