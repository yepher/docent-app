import {
  app,
  dialog,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { join } from "node:path";

export const PROJECT_URL = "https://github.com/yepher/docent-app";
export const REPORT_ISSUE_URL = `${PROJECT_URL}/issues/new`;

/** Native labels and About should identify the product, while retaining the existing library path. */
export function setApplicationIdentity() {
  const userData = app.getPath("userData");
  app.setName("Docent");
  app.setPath("userData", userData);
}

export function installApplicationMenu(
  importDocuments: (folder: boolean) => Promise<void>,
  checkUpdates: () => Promise<void>,
) {
  const mac = process.platform === "darwin";
  const perform = (action: () => Promise<unknown>, message: string) => () => {
    void action().catch((error) =>
      dialog.showMessageBox({
        type: "error",
        title: "Docent",
        message,
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  app.setAboutPanelOptions({
    applicationName: "Docent",
    applicationVersion: app.getVersion(),
    version: "",
    credits: "Your offline reference library",
    website: PROJECT_URL,
    iconPath: join(app.getAppPath(), "build/icon.png"),
  });
  const about: MenuItemConstructorOptions = {
    id: "about-docent",
    label: "About Docent",
    role: "about",
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: "Docent",
            role: "appMenu" as const,
            submenu: [
              about,
              {
                id: "check-updates",
                label: "Check for Updates…",
                click: perform(checkUpdates, "Could not check for updates"),
              },
              { type: "separator" as const },
              { role: "hide" as const, label: "Hide Docent" },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const, label: "Quit Docent" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          id: "import-documents",
          label: "Import Documents…",
          accelerator: "CmdOrCtrl+O",
          click: perform(
            () => importDocuments(false),
            "Could not prepare the import",
          ),
        },
        {
          id: "import-folder",
          label: "Import Folder…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: perform(
            () => importDocuments(true),
            "Could not prepare the import",
          ),
        },
        { type: "separator" },
        { role: "close", label: "Close Window" },
        ...(!mac
          ? [
              { type: "separator" as const },
              { role: "quit" as const, label: "Quit Docent" },
            ]
          : []),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom", label: "Actual Size" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(mac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : []),
      ],
    },
    {
      label: "Help",
      role: "help",
      submenu: [
        {
          id: "help-project",
          label: "Docent on GitHub",
          click: perform(
            () => shell.openExternal(PROJECT_URL),
            "Could not open the project page",
          ),
        },
        {
          id: "help-report-issue",
          label: "Report an Issue…",
          click: perform(
            () => shell.openExternal(REPORT_ISSUE_URL),
            "Could not open GitHub Issues",
          ),
        },
        {
          id: "help-releases",
          label: "View Releases",
          click: perform(
            () => shell.openExternal(`${PROJECT_URL}/releases`),
            "Could not open the releases page",
          ),
        },
        ...(!mac
          ? [
              { type: "separator" as const },
              {
                id: "check-updates",
                label: "Check for Updates…",
                click: perform(checkUpdates, "Could not check for updates"),
              },
              about,
            ]
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
