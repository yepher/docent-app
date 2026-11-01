import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { backup } from "node:sqlite";
import { Store } from "../src/main/store";
import { indexSet } from "../src/main/ingest";
import { Retriever } from "../src/main/retrieval";
import {
  documentTools,
  requestExamples,
  tallyRequests,
  validRules,
} from "../src/main/analysis-tools";
import { evidenceIssues } from "../src/main/citations";
import { parseFile } from "../src/main/ingest/parse";
const embed = {
  embedDocuments: async (texts: string[]) =>
    texts.map(() => new Float32Array([1, 0])),
  embedQuery: async () => new Float32Array([1, 0]),
};
async function fixture(
  run: (s: Store, id: number, path: string, dir: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "docent-offline-"));
  const s = new Store(":memory:");
  try {
    const path = join(dir, "manual.txt");
    writeFileSync(path, "The replacement filter is F19.");
    const id = s.createSet("Manuals").id;
    s.addSource(id, path);
    await indexSet(s, embed, id, () => {});
    await run(s, id, path, dir);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
describe("offline durability", () => {
  it("keeps indexed content and original bytes when a source is unavailable", async () =>
    fixture(async (s, id, path) => {
      const d = s.documents(id)[0]!;
      renameSync(path, path + ".away");
      await indexSet(s, embed, id, () => {});
      expect(s.documents(id)[0]!.chunkCount).toBe(1);
      expect(s.documents(id)[0]!.error).toContain("unavailable");
      expect(Buffer.from(s.originalBytes(d.id)!).toString()).toContain("F19");
    }));
  it("preserves the last good version on embedding failure", async () =>
    fixture(async (s, id, path) => {
      const before = s.documents(id)[0]!;
      writeFileSync(path, "New filter F20 replacement instructions.");
      await indexSet(
        s,
        {
          ...embed,
          embedDocuments: async () => {
            throw new Error("model stopped");
          },
        },
        id,
        () => {},
      );
      expect(s.documents(id)[0]!.version).toBe(before.version);
      expect(s.documentChunks(before.id)[0]!.text).toContain("F19");
      expect(s.documents(id)[0]!.error).toBe("model stopped");
    }));
  it("keeps document identities on refresh and never reuses deleted IDs", async () =>
    fixture(async (s, id, path) => {
      const before = s.documents(id)[0]!.id;
      writeFileSync(path, "Changed instructions with replacement F20.");
      await indexSet(s, embed, id, () => {});
      expect(s.documents(id)[0]!.id).toBe(before);
      s.removeDocument(before);
      await indexSet(s, embed, id, () => {});
      expect(s.documents(id)[0]!.id).toBeGreaterThan(before);
    }));
  it("keeps explicitly removed documents excluded on rescan", async () =>
    fixture(async (s, id) => {
      s.excludeDocument(s.documents(id)[0]!.id);
      await indexSet(s, embed, id, () => {});
      expect(s.documents(id)).toEqual([]);
    }));
  it("falls back to keyword search if the embedder is unavailable", async () =>
    fixture(async (s, id) => {
      const r = new Retriever(s, async () => {
        throw new Error("offline");
      });
      expect((await r.search([id], "F19"))[0]!.text).toContain("F19");
    }));
  it("backs up offline documents and conversations together", async () =>
    fixture(async (s, id, path, dir) => {
      s.saveConversation({
        id: "chat",
        title: "Filter",
        updatedAt: 1,
        setIds: [id],
        documentIds: [],
        mode: "documents",
        messages: [{ id: "q", role: "user", text: "Which filter?" }],
      });
      const file = join(dir, "backup.db");
      await backup(s.db, file);
      const restored = new Store(file);
      try {
        expect(restored.conversations()[0]!.title).toBe("Filter");
        expect(
          restored.originalBytes(restored.documents(id)[0]!.id),
        ).not.toBeNull();
      } finally {
        restored.close();
      }
    }));
  it("restricts analysis tools to selected documents", async () =>
    fixture(async (s, id) => {
      const tools = documentTools(s, [id], [999]);
      expect(tools.list()).toEqual([]);
      expect(tools.read(s.documents(id)[0]!.id)).toEqual([]);
      expect(tools.count("F19").count).toBe(0);
    }));
});
const chunk = (id: number, text: string) => ({
  id,
  documentId: id,
  text,
  path: `/doc${id}`,
  title: `doc${id}`,
  setName: "Forum",
  page: null,
  line: 1,
});
describe("auditable feature counts", () => {
  it("groups by explicit feature rules, not broad embedding topics; excludes vague endorsements", () => {
    const examples = requestExamples([
      chunk(1, "Please add a dedicated thread tool for screws."),
      chunk(2, "It would be nice to have a thread tool for fasteners."),
      chunk(3, "It would be great if this feature is available in Shapr3D."),
      chunk(4, "I too would like to see this implemented."),
    ]);
    const groups = tallyRequests(
      examples,
      validRules([{ label: "Thread creation", terms: ["thread tool"] }]),
    );
    expect(examples).toHaveLength(2);
    expect(groups[0]!.documents).toBe(2);
    expect(groups[0]!.quotes).toHaveLength(2);
  });
  it("counts repeated requests in one document only once and rejects generic rules", () => {
    const a = chunk(1, "Please add a thread tool for screws.");
    const b = {
      ...chunk(2, "I would love to have a thread tool for bolts."),
      path: a.path,
    };
    expect(
      tallyRequests(requestExamples([a, b]), [
        { label: "Threads", terms: ["thread tool"] },
      ])[0]!.documents,
    ).toBe(1);
    expect(
      validRules([
        { label: "Everything", terms: ["feature", "request", "tool"] },
      ]),
    ).toEqual([]);
  });
});
it("reads a scanned PDF with bundled local OCR", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(900, 200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 900, 200);
  ctx.fillStyle = "black";
  ctx.font = "48px Arial";
  ctx.fillText("Replacement filter F19", 30, 110);
  const jpg = canvas.toBuffer("image/jpeg");
  const stream = "q 600 0 0 134 0 0 cm /Im0 Do Q";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 134] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    ),
    Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 900 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`,
      ),
      jpg,
      Buffer.from("\nendstream"),
    ]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((o, i) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      o,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    length += part.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`,
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), "docent-ocr-"));
  try {
    const file = join(dir, "scan.pdf");
    writeFileSync(file, Buffer.concat(parts));
    const result = await parseFile(file);
    expect(result[0]!.text).toMatch(/Replacement filter F19/i);
  } finally {
    rmSync(dir, { recursive: true });
  }
}, 30000);

it("flags an unsupported number even when the source number is valid", () => {
  expect(
    evidenceIssues(
      "The deadline is 30 days [1].",
      new Map([[1, "The deadline is 7 days."]]),
    )[0],
  ).toContain("30");
  expect(
    evidenceIssues(
      "The deadline is 7 days [1].",
      new Map([[1, "The deadline is 7 days."]]),
    ),
  ).toEqual([]);
});
