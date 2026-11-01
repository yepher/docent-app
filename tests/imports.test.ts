import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportInbox } from "../src/main/imports";
import { Store } from "../src/main/store";
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "docent-import-"));
  roots.push(root);
  const file = join(root, "manual.txt"),
    folder = join(root, "Research");
  writeFileSync(file, "Private fixture text.");
  mkdirSync(folder);
  return { file, folder, root };
}
describe("drop import staging", () => {
  it("stages files and folders without changing the library and deduplicates paths", async () => {
    const { file, folder } = fixture(),
      store = new Store(":memory:");
    const inbox = new ImportInbox(() => {});
    try {
      const request = await inbox.stage([file, folder, file]);
      expect(request.items.map((i) => i.kind)).toEqual(["file", "folder"]);
      expect(store.listSets()).toEqual([]);
      inbox.dismiss(request.id);
      expect(inbox.list()).toEqual([]);
      expect(store.listSets()).toEqual([]);
    } finally {
      store.close();
    }
  });
  it("imports only into the chosen set and can create a new group", async () => {
    const { file, folder } = fixture(),
      store = new Store(":memory:");
    const inbox = new ImportInbox(() => {});
    try {
      const existing = store.createSet("Existing"),
        other = store.createSet("Other");
      const request = await inbox.stage([file, folder]);
      inbox.confirm(request.id, { setId: existing.id }, store);
      expect(store.sources(existing.id).sort()).toEqual(
        request.items.map((i) => i.path).sort(),
      );
      expect(store.sources(other.id)).toEqual([]);
      expect(() =>
        inbox.confirm(request.id, { setId: existing.id }, store),
      ).toThrow(/no longer pending/);
      const second = await inbox.stage([file]);
      const added = inbox.confirm(
        second.id,
        { newSetName: "  New research  " },
        store,
      );
      expect(added.name).toBe("New research");
      expect(store.sources(added.id)).toEqual(second.items.map((i) => i.path));
      expect(inbox.list()).toEqual([]);
    } finally {
      store.close();
    }
  });
  it("rejects invalid destinations without losing the pending drop", async () => {
    const { file } = fixture(),
      store = new Store(":memory:");
    const inbox = new ImportInbox(() => {});
    try {
      const request = await inbox.stage([file]);
      expect(() => inbox.confirm(request.id, { setId: 999 }, store)).toThrow(
        /Choose an existing/,
      );
      expect(() =>
        inbox.confirm(request.id, { newSetName: " " }, store),
      ).toThrow(/Choose an existing/);
      expect(inbox.list()).toHaveLength(1);
      expect(store.listSets()).toEqual([]);
    } finally {
      store.close();
    }
  });
  it("rejects unsupported or missing files and non-native paths before staging any items", async () => {
    const { file, root } = fixture(),
      inbox = new ImportInbox(() => {});
    const unsupported = join(root, "archive.zip");
    writeFileSync(unsupported, "fake");
    await expect(inbox.stage([file, unsupported])).rejects.toThrow(
      /not a supported/,
    );
    await expect(inbox.stage([join(root, "missing.txt")])).rejects.toThrow(
      /Cannot access/,
    );
    await expect(inbox.stage([""])).rejects.toThrow(/local files/);
    await expect(inbox.stage(["relative.txt"])).rejects.toThrow(/local files/);
    expect(inbox.list()).toEqual([]);
  });
});
