// Exercise native application identity, Help actions and File imports with an isolated library.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
import { developmentElectron } from "../scripts/dev.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const work = mkdtempSync(join(tmpdir(), "docent-menu-e2e-"));
const profile = join(work, "profile");
const doc = join(work, "manual.txt");
const folder = join(work, "Research");
writeFileSync(doc, "Replace the filter every six months.");
mkdirSync(folder);
writeFileSync(
  join(folder, "notes.txt"),
  "Research notes about filter maintenance.",
);
const originalPlist =
  process.platform === "darwin"
    ? resolve(dirname(require("electron")), "../Info.plist")
    : undefined;
const originalBytes = originalPlist && readFileSync(originalPlist);
const executablePath = developmentElectron();
assert.equal(developmentElectron(), executablePath, "reuse the cached runtime");
if (originalPlist) {
  assert.deepEqual(
    readFileSync(originalPlist),
    originalBytes,
    "leave the installed Electron runtime unchanged",
  );
  const bundle = resolve(dirname(executablePath), "../..");
  const plist = JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", join(bundle, "Contents/Info.plist")],
      { encoding: "utf8" },
    ),
  );
  assert.equal(plist.CFBundleDisplayName, "Docent");
  assert.equal(plist.CFBundleName, "Docent");
  assert.equal(plist.CFBundleExecutable, "Electron");
  assert.equal(plist.CFBundleIdentifier, "com.yepher.docent.development");
  assert.deepEqual(
    readFileSync(join(bundle, "Contents/Resources", plist.CFBundleIconFile)),
    readFileSync(join(root, "build/icon.icns")),
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
}
const app = await electron.launch({
  executablePath,
  args: [root, `--user-data-dir=${profile}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
  },
});
let page = await app.firstWindow();
const until = async (check) => {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the app");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const clickMenu = (id) =>
  app.evaluate(
    ({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(),
    id,
  );
try {
  await page.waitForFunction(() => !!window.api);
  const identity = await app.evaluate(({ app }) => ({
    name: app.getName(),
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
  }));
  assert.deepEqual(identity, {
    name: "Docent",
    userData: realpathSync(profile),
    packaged: false,
  });
  await until(() =>
    page.evaluate(
      async () => (await window.api.runtime.state()).phase === "ready",
    ),
  );
  if (process.platform === "darwin") {
    const nativeName = execFileSync(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("AppKit"); ObjC.unwrap($.NSRunningApplication.runningApplicationWithProcessIdentifier(${app.process().pid}).localizedName);`,
      ],
      { encoding: "utf8" },
    ).trim();
    assert.equal(
      nativeName,
      "Docent",
      "the native running-app name used by the Dock must be Docent",
    );
  }
  const menu = await app.evaluate(({ Menu }) => {
    const walk = (items) =>
      items.map((item) => ({
        label: item.label,
        role: item.role,
        id: item.id,
        submenu: item.submenu && walk(item.submenu.items),
      }));
    return walk(Menu.getApplicationMenu().items);
  });
  assert.ok(menu.some((item) => item.label === "Help"));
  assert.ok(
    !/Electron|toggledevtools|forcereload|"reload"/i.test(JSON.stringify(menu)),
  );
  if (process.platform === "darwin") assert.equal(menu[0].label, "Docent");
  assert.ok(JSON.stringify(menu).includes("About Docent"));
  for (const role of [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectall",
    "minimize",
  ]) {
    assert.ok(JSON.stringify(menu).toLowerCase().includes(`"role":"${role}"`));
  }

  // Click real menu handlers, but intercept browser launches so no issue is opened or posted.
  await app.evaluate(({ shell, dialog }) => {
    globalThis.menuTest = {
      urls: [],
      pickers: [],
      messages: [],
      nextPick: { canceled: true, filePaths: [] },
    };
    shell.openExternal = async (url) => {
      globalThis.menuTest.urls.push(url);
    };
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.menuTest.pickers.push(options);
      return globalThis.menuTest.nextPick;
    };
    dialog.showMessageBox = async (options) => {
      globalThis.menuTest.messages.push(options);
      return { response: 0 };
    };
  });
  for (const id of ["help-project", "help-report-issue", "help-releases"])
    await clickMenu(id);
  assert.deepEqual(await app.evaluate(() => globalThis.menuTest.urls), [
    "https://github.com/yepher/docent-app",
    "https://github.com/yepher/docent-app/issues/new",
    "https://github.com/yepher/docent-app/releases",
  ]);
  await clickMenu("import-documents");
  assert.equal(
    (await page.evaluate(() => window.api.imports.pending())).length,
    0,
    "canceling the file picker stages nothing",
  );
  assert.deepEqual(
    await app.evaluate(() => globalThis.menuTest.pickers[0].properties),
    ["openFile", "multiSelections"],
  );

  await app.evaluate(({ BrowserWindow }, doc) => {
    globalThis.menuTest.nextPick = { canceled: false, filePaths: [doc] };
    BrowserWindow.getAllWindows()[0].minimize();
  }, doc);
  await clickMenu("import-documents");
  let chooser = page.getByRole("dialog", { name: "Add to Docent" });
  await chooser.waitFor();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMinimized(),
    ),
    false,
  );
  assert.equal(
    (await page.evaluate(() => window.api.sets.list())).length,
    0,
    "a menu import still asks for its destination",
  );
  await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
  await chooser.waitFor({ state: "hidden" });
  assert.equal((await page.evaluate(() => window.api.sets.list())).length, 0);

  await app.evaluate((_electron, folder) => {
    globalThis.menuTest.nextPick = { canceled: false, filePaths: [folder] };
  }, folder);
  await clickMenu("import-folder");
  await chooser.waitFor();
  assert.deepEqual(
    await app.evaluate(() => globalThis.menuTest.pickers.at(-1).properties),
    ["openDirectory", "multiSelections"],
  );
  await chooser.getByLabel("Import set name").fill("Menu research");
  await chooser.getByRole("button", { name: "Import", exact: true }).click();
  await chooser.waitFor({ state: "hidden" });
  await until(() =>
    page.evaluate(async () =>
      (await window.api.sets.list()).some(
        (set) => set.name === "Menu research" && set.documentCount === 1,
      ),
    ),
  );

  // The macOS application menu continues working after the last window closes.
  if (process.platform === "darwin") {
    await app.evaluate(
      ({ BrowserWindow }) =>
        new Promise((resolve) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.once("closed", resolve);
          window.close();
        }),
    );
    const [reopened] = await Promise.all([
      app.waitForEvent("window", { timeout: 15_000 }),
      clickMenu("import-documents"),
    ]);
    page = reopened;
    chooser = page.getByRole("dialog", { name: "Add to Docent" });
    await chooser.waitFor();
    await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  assert.equal(
    (await app.evaluate(() => globalThis.menuTest.messages)).length,
    0,
  );
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("Browser unavailable");
    };
  });
  await clickMenu("help-report-issue");
  await until(() =>
    app.evaluate(() => globalThis.menuTest.messages.length === 1),
  );
  assert.equal(
    await app.evaluate(() => globalThis.menuTest.messages[0].message),
    "Could not open GitHub Issues",
  );
  console.log(
    "Menu E2E passed: native Docent identity, cached signed runtime, unchanged library path, Help links, File imports, cancellation, window restore/reopen and browser error feedback.",
  );
} catch (error) {
  console.error("Test profile:", work);
  console.error(
    await app
      .evaluate(({ BrowserWindow }) => ({
        menus: globalThis.menuTest,
        windows: BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          url: window.webContents.getURL(),
        })),
      }))
      .catch(() => "Application closed"),
  );
  console.error(
    await page
      .locator("body")
      .innerText()
      .catch(() => "Window closed"),
  );
  throw error;
} finally {
  await app.close();
}
