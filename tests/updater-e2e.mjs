// Native IPC and renderer behavior, with update events simulated so no installer is run.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const profile = mkdtempSync(join(tmpdir(), "docent-update-e2e-"));
const app = await electron.launch({
  args: [root, `--user-data-dir=${profile}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
  },
});
const page = await app.firstWindow();
const publish = (state) =>
  app.evaluate(({ BrowserWindow }, state) => {
    globalThis.updateTest.state = state;
    BrowserWindow.getAllWindows()[0].webContents.send("update:state", state);
  }, state);
try {
  await page.waitForFunction(() => !!window.api);
  assert.deepEqual(await page.evaluate(() => window.api.update.state()), {
    status: "idle",
  });
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById("check-updates").click(),
  );
  await page.getByText(/This is a development build/).waitFor();
  assert.equal(
    (await page.evaluate(() => window.api.update.state())).status,
    "unsupported",
  );
  await assert.rejects(
    page.evaluate(() => window.api.update.install()),
    /development build/,
  );
  await page
    .locator(".update")
    .getByRole("button", { name: "Dismiss" })
    .click();

  // Test the shipped UI against retained main-process state and events, without invoking an updater binary.
  await app.evaluate(({ app, ipcMain, BrowserWindow, shell }) => {
    globalThis.updateTest = {
      state: { status: "idle" },
      checks: 0,
      installs: 0,
      urls: [],
      version: app.getVersion(),
    };
    const send = (state) => {
      globalThis.updateTest.state = state;
      BrowserWindow.getAllWindows()[0].webContents.send("update:state", state);
    };
    for (const channel of ["update:state", "update:check", "update:install"])
      ipcMain.removeHandler(channel);
    ipcMain.handle("update:state", () => globalThis.updateTest.state);
    ipcMain.handle("update:check", () => {
      globalThis.updateTest.checks++;
      send({ status: "checking" });
    });
    ipcMain.handle("update:install", () => {
      if (globalThis.updateTest.state.status !== "ready")
        throw new Error("No update ready");
      globalThis.updateTest.installs++;
    });
    shell.openExternal = async (url) => {
      globalThis.updateTest.urls.push(url);
    };
  });
  await page.getByText("Library backup & recovery", { exact: true }).click();
  await page
    .getByRole("button", { name: "Check for updates (online)" })
    .click();
  await page.getByText("Checking for updates…", { exact: true }).waitFor();
  const version = await app.evaluate(() => globalThis.updateTest.version);
  await publish({ status: "up-to-date", version });
  await page
    .getByText(`Docent ${version} is up to date.`, { exact: false })
    .waitFor();
  await page
    .locator(".update")
    .getByRole("button", { name: "Dismiss" })
    .click();
  await publish({ status: "downloading", version: "0.1.2", percent: 42 });
  assert.equal(
    await page
      .getByRole("progressbar", { name: "Downloading Docent update" })
      .getAttribute("value"),
    "42",
  );
  assert.equal(
    await page.getByRole("button", { name: "Restart to update" }).count(),
    0,
  );
  await publish({ status: "ready", version: "0.1.2" });
  await page.getByRole("button", { name: "Restart to update" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Restart to update" }).waitFor();
  await page.getByText(/It will install when you quit/).waitFor();
  await page.getByRole("button", { name: "Restart to update" }).click();
  assert.equal(await app.evaluate(() => globalThis.updateTest.installs), 1);
  await publish({
    status: "error",
    message:
      "The update could not be verified. You can download the latest Docent release from GitHub.",
  });
  await page.getByText(/The update could not be verified/).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Restart to update" }).count(),
    0,
  );
  await page.getByRole("button", { name: "See releases" }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.updateTest.urls), [
    "https://github.com/yepher/docent-app/releases",
  ]);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByText("Checking for updates…", { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.updateTest.checks), 2);
  console.log(
    "Updater E2E passed: native manual check, development feedback, progress, retained ready state after reload, restart action, verification failure, retry and release link. No installer ran.",
  );
} catch (error) {
  console.error("Test profile:", profile);
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await app.close();
}
