import { dialog, ipcMain, type BrowserWindow } from "electron";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { ToolManager } from "./manager";
import { MAX_PACKAGE_BYTES } from "./package";
import type { ToolPackage, ToolsApi } from "../../shared/tools";

export function registerToolIpc(
  manager: () => ToolManager,
  window: () => BrowserWindow,
) {
  let jobs = 0;
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`tools:${name}`, async (_event, ...args) => {
      jobs++;
      try {
        return await fn(...args);
      } finally {
        jobs--;
      }
    });
  handle("list", () => manager().list());
  handle("repositories", () => manager().repositories());
  handle("addRepository", (url: string) => manager().addRepository(url));
  handle("checkRepository", (id: string) => manager().checkRepository(id));
  handle("removeRepository", (id: string) => manager().removeRepository(id));
  handle("prepareRepository", (id: string, toolId: string) =>
    manager().prepareRepository(id, toolId),
  );
  handle("prepareLocal", (pkg: ToolPackage) => manager().prepare(pkg));
  handle("install", (token: string) => manager().install(token));
  handle("enable", (key: string, enabled: boolean) =>
    manager().enable(key, enabled),
  );
  handle("rollback", (key: string, hash: string) =>
    manager().rollback(key, hash),
  );
  handle("remove", (key: string) => manager().remove(key));
  handle("testPackage", (pkg: ToolPackage) => manager().test(pkg));
  handle(
    "run",
    async (request: Parameters<ToolsApi["run"]>[0]) =>
      (
        await manager().run(request.key, request.input, request.scope, {
          id: request.id,
        })
      ).result,
  );
  handle("cancel", (id: string) => manager().cancel(id));
  handle("runs", () => manager().runs());
  handle("importPackage", async () => {
    const picked = await dialog.showOpenDialog(window(), {
      properties: ["openFile"],
      filters: [{ name: "Docent tool package", extensions: ["json"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const path = picked.filePaths[0];
    if ((await stat(path)).size > MAX_PACKAGE_BYTES)
      throw new Error("Tool package exceeds 512 KB.");
    return manager().prepare(JSON.parse(await readFile(path, "utf8")));
  });
  handle("exportPackage", async (key: string) => {
    const tool = manager().get(key);
    const picked = await dialog.showSaveDialog(window(), {
      defaultPath: `${tool.package.manifest.id}-${tool.package.manifest.version}.docent-tool.json`,
      filters: [{ name: "Docent tool package", extensions: ["json"] }],
    });
    if (picked.canceled || !picked.filePath) return false;
    // Export only the shareable package, never library data, inputs, or execution history.
    await writeFile(
      picked.filePath,
      JSON.stringify(tool.package, null, 2) + "\n",
    );
    return true;
  });
  return () => jobs > 0;
}
