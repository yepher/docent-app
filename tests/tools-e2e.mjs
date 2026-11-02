// Real Electron/preload/SQLite/QuickJS workflow, using synthetic documents and a fake model.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright-core";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-tools-e2e-"));
const doc = join(work, "private-manual.txt");
const exported = join(work, "shared.docent-tool.json");
writeFileSync(doc, "Private library document: filter SECRET-7Q. Replace the filter.");
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
  },
});
const page = await app.firstWindow();
try {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByPlaceholder("New set name").fill("Manuals");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, doc);
  await page.getByRole("button", { name: "Add files", exact: true }).click();
  await page.getByText("1 file", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("heading", { name: "Tools for your library" }).waitFor();
  await page.locator(".tool-card").nth(3).waitFor();
  assert.equal(await page.locator(".tool-card").count(), 4);
  await page
    .getByRole("button", { name: /^Count documents mentioning a phrase/ })
    .click();
  await page.getByLabel("Literal phrase to look for").fill("filter");
  await page.getByRole("button", { name: "Run tool", exact: true }).click();
  await page.getByLabel("Tool result").waitFor();
  assert.equal(
    JSON.parse(await page.getByLabel("Tool result").innerText()).count,
    1,
  );
  const firstRun = (await page.evaluate(() => window.api.tools.runs()))[0];
  assert.equal(firstRun.record.coverage.complete, true);
  assert.equal(firstRun.citations[0].title, "private-manual.txt");
  await page
    .getByRole("button", { name: "Test examples", exact: true })
    .click();
  await page
    .getByLabel("Tool test results")
    .getByText(/Count a phrase once/)
    .waitFor();
  await page.getByText("Code and sharing", { exact: true }).click();
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exported);
  await page
    .getByRole("button", { name: "Export package", exact: true })
    .click();
  await page
    .getByText("Exported the tool and synthetic tests.", { exact: false })
    .waitFor();
  const pkg = JSON.parse(readFileSync(exported, "utf8"));
  assert.equal(pkg.format, "docent-tool");
  assert.doesNotMatch(
    readFileSync(exported, "utf8"),
    /Private library document|private-manual|SECRET-7Q/,
    "shared packages exclude the user library and run results",
  );

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, exported);
  await page
    .getByRole("button", { name: "Import package", exact: true })
    .click();
  await page.locator(".tool-preview").waitFor();
  await page
    .getByRole("button", { name: "Install disabled", exact: true })
    .click();
  await page
    .getByText("Installed. Enable the tool", { exact: false })
    .waitFor();
  const personal = page
    .locator(".tool-card")
    .filter({ hasText: "Personal tool" });
  assert.equal(await personal.getByRole("checkbox").isChecked(), false);
  await personal.getByRole("checkbox").check();
  await personal.getByRole("button").click();
  await page.getByText("Code and sharing", { exact: true }).click();
  await page
    .getByRole("button", { name: "Edit new version", exact: true })
    .click();
  const editor = page.getByLabel("Tool package editor");
  const edited = JSON.parse(await editor.inputValue());
  edited.manifest.description += " Community improvement example.";
  assert.equal(edited.manifest.version, "1.0.1");
  await editor.fill(JSON.stringify(edited, null, 2));
  await page.getByRole("button", { name: "Test draft", exact: true }).click();
  await page
    .getByLabel("Tool test results")
    .getByText(/Count a phrase once/)
    .waitFor();
  await page
    .getByRole("button", { name: "Review package", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Install disabled", exact: true })
    .click();
  await page
    .getByText("Installed. Enable the tool", { exact: false })
    .waitFor();
  await page
    .getByText("Installed versions and rollback", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await page.getByText("Version restored.", { exact: false }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.api.tools.list())).find(
      (t) => t.key === "local:count-mentions",
    ).package.manifest.version,
    "1.0.0",
  );

  // The production GitHub downloader is exercised with controlled responses in the test main process.
  const community = structuredClone(pkg);
  community.manifest.id = "community-counter";
  community.manifest.name = "Community phrase counter";
  const fixture = (commit, packageValue) => {
    const bytes = JSON.stringify(packageValue);
    return {
      commit,
      bytes,
      catalog: {
        format: "docent-tool-collection",
        formatVersion: 1,
        name: "Shared example tools",
        tools: [
          {
            id: packageValue.manifest.id,
            name: packageValue.manifest.name,
            description: packageValue.manifest.description,
            version: packageValue.manifest.version,
            file: "counter.docent-tool.json",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      },
    };
  };
  await app.evaluate(
    (_electron, value) => {
      globalThis.__docentRepoFixture = value;
      const original = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        const url = String(input),
          f = globalThis.__docentRepoFixture;
        if (!url.includes("docent-fixture/shared-tools"))
          return original(input, options);
        if (options?.body)
          throw new Error(
            "Repository operations must not upload library data.",
          );
        if (url.endsWith("/releases/latest"))
          return new Response(
            JSON.stringify({
              tag_name: "v" + JSON.parse(f.bytes).manifest.version,
            }),
          );
        if (url.includes("/commits/"))
          return new Response(JSON.stringify({ sha: f.commit }));
        if (!url.includes(f.commit))
          throw new Error("Download is not pinned to the commit.");
        return new Response(
          url.endsWith("/docent-tools.json")
            ? JSON.stringify(f.catalog)
            : f.bytes,
        );
      };
    },
    fixture("a".repeat(40), community),
  );
  await page.getByRole("button", { name: /^Repositories/ }).click();
  await page
    .getByLabel("GitHub repository URL")
    .fill("https://github.com/docent-fixture/shared-tools");
  await page
    .getByRole("button", { name: "Add repository", exact: true })
    .click();
  await page.getByRole("button", { name: "Review tool", exact: true }).click();
  await page
    .getByRole("button", { name: "Install disabled", exact: true })
    .click();
  await page
    .getByText("Installed. Enable the tool", { exact: false })
    .waitFor();
  const key = "github:docent-fixture/shared-tools:community-counter";
  let installed = (await page.evaluate(() => window.api.tools.list())).find(
    (t) => t.key === key,
  );
  assert.equal(installed.origin.commit, "a".repeat(40));
  assert.equal(installed.enabled, false);
  community.manifest.version = "1.1.0";
  community.code += "\n// A reviewed improvement.\n";
  await app.evaluate(
    (_electron, value) => {
      globalThis.__docentRepoFixture = value;
    },
    fixture("b".repeat(40), community),
  );
  await page.getByRole("button", { name: /^Repositories/ }).click();
  await page
    .getByRole("button", { name: "Check updates", exact: true })
    .click();
  await page.getByText("Catalog refreshed.", { exact: false }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.api.tools.list())).find(
      (t) => t.key === key,
    ).package.manifest.version,
    "1.0.0",
    "checking updates never replaces installed code",
  );
  await page
    .getByRole("button", { name: "Review available version", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Install disabled", exact: true })
    .click();
  await page
    .getByText("Installed. Enable the tool", { exact: false })
    .waitFor();
  installed = (await page.evaluate(() => window.api.tools.list())).find(
    (t) => t.key === key,
  );
  assert.equal(installed.package.manifest.version, "1.1.0");
  assert.equal(installed.versions.length, 2);
  await page.screenshot({ path: process.argv[2] ?? join(work, "tools.png") });
  await page.reload();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await page.getByLabel("Tool result").waitFor();
  assert.equal(
    JSON.parse(await page.getByLabel("Tool result").innerText()).count,
    1,
    "runs and versions survive a renderer restart",
  );
  console.log(
    "Tools E2E passed: offline execution, scope, evidence, import/export, edit/test, updates, rollback, persistence.",
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  await page.screenshot({ path: join(work, "failure.png") });
  console.error("Test artifacts:", work);
  throw error;
} finally {
  await app.close();
}
