import { randomUUID } from "node:crypto";
import { stat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type {
  ImportDestination,
  ImportItem,
  PendingImport,
} from "../shared/imports";
import type { Store } from "./store";
import { isSupported } from "./ingest/parse";

/** Holds drops until the user chooses a destination. Staging never changes the library. */
export class ImportInbox {
  private requests = new Map<string, PendingImport>();
  constructor(private changed: (requests: PendingImport[]) => void) {}
  list() {
    return [...this.requests.values()];
  }
  async stage(paths: unknown) {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 1000 ||
      paths.some((p) => typeof p !== "string" || !isAbsolute(p))
    )
      throw new Error(
        "Drop up to 1,000 local files or folders. For larger collections, drop their folder.",
      );
    const items = new Map<string, ImportItem>();
    for (const candidate of paths) {
      let path: string, info: Awaited<ReturnType<typeof stat>>;
      try {
        path = await realpath(candidate);
        info = await stat(path);
      } catch {
        throw new Error(
          `Cannot access “${basename(candidate)}”. Check that it is still available.`,
        );
      }
      if (!info.isDirectory() && (!info.isFile() || !isSupported(path)))
        throw new Error(
          `“${basename(path)}” is not a supported document. Drop a PDF, PNG, JPEG, DOCX, text document, or folder.`,
        );
      items.set(path, {
        path,
        name: basename(path),
        kind: info.isDirectory() ? "folder" : "file",
      });
    }
    if (this.requests.size >= 20)
      throw new Error(
        "Finish or cancel the pending imports before dropping more items.",
      );
    const request = { id: randomUUID(), items: [...items.values()] };
    this.requests.set(request.id, request);
    this.changed(this.list());
    return request;
  }
  dismiss(id: string) {
    this.requests.delete(id);
    this.changed(this.list());
  }
  confirm(id: string, destination: ImportDestination, store: Store) {
    const request = this.requests.get(id);
    if (!request)
      throw new Error(
        "This import is no longer pending. Drop the items again.",
      );
    if (!destination || typeof destination !== "object")
      throw new Error("Choose a document set.");
    const existing =
      "setId" in destination
        ? store.listSets().find((s) => s.id === destination.setId)
        : undefined;
    const name =
      "newSetName" in destination && typeof destination.newSetName === "string"
        ? destination.newSetName.trim()
        : "";
    if ("setId" in destination ? !existing : !name || name.length > 100)
      throw new Error(
        "Choose an existing set or enter a new set name (up to 100 characters).",
      );
    store.db.exec("BEGIN");
    let set;
    try {
      set = existing ?? store.createSet(name);
      for (const item of request.items) store.addSource(set.id, item.path);
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    this.dismiss(id);
    return set;
  }
}
