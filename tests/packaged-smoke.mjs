// Run against an already packaged executable: node tests/packaged-smoke.mjs /path/to/Docent
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { _electron as electron } from "playwright-core";
const work = mkdtempSync(join(tmpdir(), "docent-package-test-"));
if (process.platform === "darwin") {
  const contents = resolve(dirname(process.argv[2]), "..");
  const icon = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print CFBundleIconFile", join(contents, "Info.plist")],
    { encoding: "utf8" },
  ).trim();
  assert.deepEqual(
    readFileSync(join(contents, "Resources", icon)),
    readFileSync(new URL("../build/icon.icns", import.meta.url)),
    "Finder and the installer must use Docent's icon, not Electron's",
  );
}
const text = join(work, "manual.txt");
writeFileSync(text, "Replacement filter F19.");
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
  "<< /Length 0 >>\nstream\n\nendstream",
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objects.forEach((o, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const scan = join(work, "blank-scan.pdf");
writeFileSync(scan, pdf);
const app = await electron.launch({
  executablePath: process.argv[2],
  args: [`--user-data-dir=${join(work, "profile")}`],
});
try {
  const page = await app.firstWindow();
  await page
    .getByRole("button", { name: "Search library", exact: true })
    .waitFor();
  assert.equal(
    await app.evaluate(({ app, nativeImage }) => {
      const { join } = process.getBuiltinModule("node:path");
      return nativeImage
        .createFromPath(join(app.getAppPath(), "build/icon.png"))
        .isEmpty();
    }),
    false,
    "The runtime Dock icon is included in the packaged app",
  );
  const attached = await page.evaluate(
    async (bytes) => {
      const image = await window.api.vision.attach(
        Uint8Array.from(bytes).buffer,
        "packaged-test.png",
      );
      return window.api.vision.preview(image.source);
    },
    [...readFileSync(new URL("../build/icon.png", import.meta.url))],
  );
  assert.match(
    attached,
    /^data:image\/png;base64,/,
    "Packaged vision worker prepares and saves an image offline",
  );
  const tools = await page.evaluate(() => window.api.tools.list());
  assert.equal(tools.filter((t) => t.origin.kind === "bundled").length, 4);
  const toolTests = await page.evaluate(
    (pkg) => window.api.tools.testPackage(pkg),
    tools[0].package,
  );
  assert.ok(
    toolTests.every((t) => t.passed),
    JSON.stringify(toolTests),
  );
  const parse = (path) =>
    app.evaluate(async ({ app }, path) => {
      const { Worker } = process.getBuiltinModule("node:worker_threads");
      const { join } = process.getBuiltinModule("node:path");
      return await new Promise((resolve, reject) => {
        const worker = new Worker(
          join(app.getAppPath(), "out/main/library-worker.js"),
          { workerData: { kind: "parse", path } },
        );
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("Worker timeout"));
        }, 30000);
        worker.once("message", (r) => {
          clearTimeout(timer);
          worker.terminate();
          resolve(r);
        });
        worker.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    }, path);
  const result = await parse(text);
  assert.match(
    result.value?.[0]?.text ?? JSON.stringify(result),
    /Replacement filter F19/,
  );
  const blank = await parse(scan);
  assert.match(
    blank.value?.[0]?.text ?? JSON.stringify(blank),
    /Use Ask about this page/,
  );
  console.log(
    "Packaged icon, vision worker, local OCR, and offline QuickJS tool smoke test passed",
  );
} finally {
  await app.close();
  rmSync(work, { recursive: true, force: true });
}
