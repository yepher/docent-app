import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, powerMonitor } from "electron";
import electronUpdater from "electron-updater";
import { startUpdater, updateSupportMessage } from "../src/main/updater";
import type { UpdateState } from "../src/shared/types";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), {
      getVersion: () => "0.1.1",
      get isPackaged() {
        return true;
      },
    }),
    powerMonitor: new EventEmitter(),
  };
});
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: {
      autoUpdater: Object.assign(new EventEmitter(), {
        checkForUpdates: vi.fn(),
        quitAndInstall: vi.fn(),
        autoDownload: false,
        autoInstallOnAppQuit: false,
        allowPrerelease: true,
        allowDowngrade: true,
      }),
    },
  };
});

const { autoUpdater } = electronUpdater;
const info = {
  version: "0.1.2",
  files: [],
  releaseDate: "2026-11-01",
  path: "update.zip",
  sha512: "test-checksum",
  downloadedFile: "/test/update.zip",
};
const sixHours = 6 * 60 * 60 * 1_000;
let updater: ReturnType<typeof startUpdater>;
let states: UpdateState[];
const start = () => (updater = startUpdater((state) => states.push(state)));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  vi.stubEnv("APPIMAGE", "/test/Docent.AppImage");
  Object.defineProperty(app, "isPackaged", { configurable: true, value: true });
  states = [];
  vi.mocked(autoUpdater.checkForUpdates)
    .mockReset()
    .mockImplementation(async () => {
      autoUpdater.emit("update-not-available", info);
      return { isUpdateAvailable: false, versionInfo: info, updateInfo: info };
    });
  vi.mocked(autoUpdater.quitAndInstall).mockReset();
});
afterEach(() => {
  updater?.stop();
  autoUpdater.removeAllListeners();
  powerMonitor.removeAllListeners();
  app.removeAllListeners();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("application updates", () => {
  it("checks after startup and every six hours, downloads stable releases and never restarts on its own", async () => {
    start();
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.allowDowngrade).toBe(false);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.state()).toEqual({ status: "idle" });
    await vi.advanceTimersByTimeAsync(sixHours - 10_000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(sixHours);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("quietly handles offline launches and retries later; manual checks explain failures", async () => {
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(async () => {
      const error = new Error("getaddrinfo ENOTFOUND github.com");
      autoUpdater.emit("error", error);
      throw error;
    });
    start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual([]);
    await updater.check();
    expect(states[0]).toEqual({ status: "checking" });
    expect(updater.state()).toMatchObject({
      status: "error",
      message: expect.stringContaining("internet"),
    });
    await vi.advanceTimersByTimeAsync(sixHours);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it("reports no update using the installed version, not a newer ineligible release", async () => {
    start();
    await updater.check();
    expect(updater.state()).toEqual({ status: "up-to-date", version: "0.1.1" });
    expect(() => updater.install()).toThrow("No downloaded update");
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("shares checks, retains download progress and readiness, and installs only when ready", async () => {
    let finishCheck!: (
      value: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>,
    ) => void;
    let finishDownload!: (paths: string[]) => void;
    const download = new Promise<string[]>((resolve) => {
      finishDownload = resolve;
    });
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    start();
    const first = updater.check();
    const second = updater.check();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    autoUpdater.emit("update-available", info);
    finishCheck({
      isUpdateAvailable: true,
      versionInfo: info,
      updateInfo: info,
      downloadPromise: download,
    });
    autoUpdater.emit("download-progress", {
      percent: 42.4,
      total: 1000,
      transferred: 424,
      delta: 424,
      bytesPerSecond: 424,
    });
    expect(updater.state()).toEqual({
      status: "downloading",
      version: "0.1.2",
      percent: 42,
    });
    expect(() => updater.install()).toThrow("No downloaded update");
    await updater.check();
    await vi.advanceTimersByTimeAsync(sixHours);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    autoUpdater.emit("update-downloaded", info);
    finishDownload(["/test/update.zip"]);
    await first;
    expect(updater.state()).toEqual({ status: "ready", version: "0.1.2" });
    await updater.check();
    expect(states.at(-1)).toEqual({ status: "ready", version: "0.1.2" });
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    updater.install();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("catches the separate download rejection and offers a retry", async () => {
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(async () => {
      autoUpdater.emit("update-available", info);
      return {
        isUpdateAvailable: true,
        versionInfo: info,
        updateInfo: info,
        downloadPromise: Promise.reject(new Error("connection reset")),
      };
    });
    start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updater.state()).toMatchObject({
      status: "error",
      message: expect.stringContaining("downloaded or prepared"),
    });
    expect(() => updater.install()).toThrow();
    await updater.check();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("revokes readiness if native signature validation fails", async () => {
    start();
    autoUpdater.emit("update-downloaded", info);
    autoUpdater.emit("error", new Error("Code signature validation failed"));
    expect(updater.state()).toMatchObject({
      status: "error",
      message: expect.stringContaining("verified"),
    });
    expect(() => updater.install()).toThrow();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("checks when resuming after a long sleep, but ignores frequent resumes and stops on quit", async () => {
    start();
    await updater.check();
    powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(0);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + sixHours);
    powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(0);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    app.emit("before-quit");
    await vi.advanceTimersByTimeAsync(sixHours * 2);
    powerMonitor.emit("resume");
    await updater.check();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("keeps development builds offline and explains how to get updates", async () => {
    Object.defineProperty(app, "isPackaged", { value: false });
    start();
    await vi.advanceTimersByTimeAsync(sixHours * 2);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    await updater.check();
    expect(updater.state()).toMatchObject({
      status: "unsupported",
      message: expect.stringContaining("development build"),
    });
    expect(() => updater.install()).toThrow("development build");
    expect(updateSupportMessage(true, "linux", "")).toContain(
      "package manager",
    );
    expect(
      updateSupportMessage(true, "linux", "/opt/Docent.AppImage"),
    ).toBeUndefined();
    expect(updateSupportMessage(true, "win32", "")).toBeUndefined();
  });
});
