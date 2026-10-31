import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateState } from '../shared/types';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Downloads new GitHub releases in the background and installs them on quit or restart. */
export function startUpdater(onState: (s: UpdateState) => void): { install(): void } {
  const { autoUpdater } = electronUpdater;
  if (!app.isPackaged) return { install() {} };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('download-progress', (p) => onState({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => onState({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => onState({ status: 'error', message: err.message }));

  const check = () => void autoUpdater.checkForUpdates().catch(() => {}); // Failures reach the 'error' listener.
  check();
  setInterval(check, CHECK_INTERVAL_MS);
  return { install: () => autoUpdater.quitAndInstall() };
}
