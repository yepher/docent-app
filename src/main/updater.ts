import { app, powerMonitor } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateState } from "../shared/types";

const STARTUP_DELAY = 10_000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1_000;

export function updateSupportMessage(
  packaged: boolean,
  platform = process.platform,
  appImage = process.env.APPIMAGE,
): string | undefined {
  if (!packaged)
    return "This is a development build. Install a Docent release to receive automatic updates.";
  if (platform === "linux" && !appImage)
    return "Update this installation with your package manager or download the latest release. AppImage installations update automatically.";
  return undefined;
}

/** Checks without blocking startup; downloads verified releases and installs on quit or explicit restart. */
export function startUpdater(onState: (s: UpdateState) => void) {
  let state: UpdateState = { status: "idle" };
  let stopped = false;
  const publish = (next: UpdateState) => {
    if (stopped) return;
    state = next;
    onState(next);
  };
  const unsupported = updateSupportMessage(app.isPackaged);
  if (unsupported)
    return {
      state: () => state,
      check: async () =>
        publish({ status: "unsupported", message: unsupported }),
      install: () => {
        throw new Error(unsupported);
      },
      stop: () => {
        stopped = true;
      },
    };

  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  let inFlight: Promise<void> | undefined;
  let manual = false;
  let lastCheck: number | undefined;

  const failed = (error: unknown) => {
    if (state.status === "error") return;
    // Offline use should not produce a warning on every launch. A requested check or failed download does.
    if (manual || state.status === "downloading" || state.status === "ready") {
      const detail = error instanceof Error ? error.message : String(error);
      const verification =
        /signature|signed|code has no resources|verification|checksum|sha512/i.test(
          detail,
        );
      publish({
        status: "error",
        message: verification
          ? "The update could not be verified. You can download the latest Docent release from GitHub."
          : state.status === "downloading" || state.status === "ready"
            ? "The update could not be downloaded or prepared. Try again when connected, or download the latest release."
            : "Could not check for updates. Try again when connected to the internet.",
      });
    }
  };
  autoUpdater.on("update-available", (info) =>
    publish({ status: "downloading", version: info.version, percent: 0 }),
  );
  autoUpdater.on("update-not-available", () =>
    publish(
      manual
        ? { status: "up-to-date", version: app.getVersion() }
        : { status: "idle" },
    ),
  );
  autoUpdater.on("download-progress", (progress) => {
    if (state.status === "downloading" && Number.isFinite(progress.percent))
      publish({
        ...state,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      });
  });
  autoUpdater.on("update-downloaded", (info) =>
    publish({ status: "ready", version: info.version }),
  );
  autoUpdater.on("error", failed);

  const check = (requested = true): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (state.status === "ready" || state.status === "downloading") {
      if (requested) publish(state);
      return Promise.resolve();
    }
    if (requested) {
      manual = true;
      publish({ status: "checking" });
    }
    if (inFlight) return inFlight;
    lastCheck = Date.now();
    // Include the download promise: its rejection is independent of the metadata request.
    inFlight = Promise.resolve()
      .then(async () => {
        const result = await autoUpdater.checkForUpdates();
        if (result) await result.downloadPromise;
        else if (manual)
          publish({
            status: "unsupported",
            message:
              "Automatic updates are unavailable for this installation. Download the latest release from GitHub.",
          });
      })
      .catch((error) => {
        // electron-updater normally also emits 'error'; don't replace its more specific message.
        if (state.status !== "error") failed(error);
      })
      .finally(() => {
        inFlight = undefined;
        manual = false;
      });
    return inFlight;
  };
  const checkWhenDue = () => {
    if (lastCheck === undefined || Date.now() - lastCheck >= CHECK_INTERVAL)
      void check(false);
  };
  const startup = setTimeout(checkWhenDue, STARTUP_DELAY);
  const interval = setInterval(() => void check(false), CHECK_INTERVAL);
  startup.unref();
  interval.unref();
  powerMonitor.on("resume", checkWhenDue);
  const stop = () => {
    stopped = true;
    clearTimeout(startup);
    clearInterval(interval);
    powerMonitor.removeListener("resume", checkWhenDue);
    app.removeListener("before-quit", stop);
  };
  app.once("before-quit", stop);
  return {
    state: () => state,
    check,
    stop,
    install: () => {
      if (stopped || state.status !== "ready")
        throw new Error("No downloaded update is ready to install.");
      autoUpdater.quitAndInstall();
    },
  };
}
