import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { VisionLibrary } from "../src/main/vision";
import { renderImage, renderPdfPage } from "../src/main/vision-render";
import { isSupported, parseFile } from "../src/main/ingest/parse";
import { runTurn } from "../src/main/agent";
import type { ChatMessage, Llm, ToolCall } from "../src/main/llm";
import { sameQuestionScope } from "../src/shared/question-scope";
import { visualKey } from "../src/shared/vision";

function png() {
  const canvas = createCanvas(600, 300),
    c = canvas.getContext("2d");
  c.fillStyle = "white";
  c.fillRect(0, 0, 600, 300);
  c.fillStyle = "blue";
  c.fillRect(30, 60, 200, 160);
  c.fillStyle = "green";
  c.fillRect(370, 60, 200, 160);
  return canvas.toBuffer("image/png");
}
function pdf() {
  const stream = "1 0 0 rg 20 20 100 60 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((s, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${s}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 5\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
const arrayBuffer = (b: Uint8Array) => Uint8Array.from(b).buffer;
const databases: Store[] = [];
function fixture(bytes = png(), extension = "png") {
  const store = new Store(":memory:");
  databases.push(store);
  const set = store.createSet("Pictures");
  const version = createHash("sha256").update(bytes).digest("hex");
  store.saveDocument(
    {
      setId: set.id,
      path: `/unavailable/diagram.${extension}`,
      title: `diagram.${extension}`,
      mtimeMs: 1,
      size: bytes.length,
      bytes,
      version,
      parserVersion: 3,
    },
    [
      {
        text: "Indexed text",
        page: extension === "pdf" ? 1 : null,
        line: null,
        embedding: new Float32Array([1, 0]),
      },
    ],
  );
  const doc = store.documents(set.id)[0]!;
  return { store, doc, source: { documentId: doc.id, version }, bytes };
}
afterEach(() => {
  databases.splice(0).forEach((s) => s.close());
});
const events = { status() {}, delta() {}, audio() {} };
const options = () => ({ speak: false, signal: AbortSignal.timeout(10000) });
function scripted(rounds: (string | ToolCall[])[]) {
  const seen: ChatMessage[][] = [];
  const llm: Llm = {
    async *chat(messages) {
      seen.push(structuredClone(messages));
      const value = rounds[seen.length - 1]!;
      if (typeof value === "string") yield { type: "text", text: value };
      else yield { type: "tool_calls", calls: value };
    },
    transcribe: async () => "",
    async *speak() {},
  };
  return { llm, seen };
}

describe("offline visual evidence", () => {
  it("keeps PNG/JPEG imports searchable even with no OCR text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docent-visual-"));
    try {
      const path = join(dir, "colors.PNG");
      writeFileSync(path, png());
      expect(isSupported(path)).toBe(true);
      expect(isSupported("photo.jpeg")).toBe(true);
      const segments = await parseFile(path);
      expect(segments[0]!.text).toContain("Image: colors.PNG");
      expect(segments[0]!.text).toContain("Ask about this image");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("renders actual PDF graphics and rejects invalid pages", async () => {
    const image = await renderPdfPage(pdf(), 1);
    expect(image.subarray(1, 4).toString()).toBe("PNG");
    await expect(renderPdfPage(pdf(), 2)).rejects.toThrow("1 pages");
    await expect(renderPdfPage(pdf(), -1)).rejects.toThrow("valid PDF page");
  });
  it("uses saved originals offline, caches by version/page, and enforces the tool scope before returning cached data", async () => {
    const { store, source } = fixture(pdf(), "pdf");
    const render = vi.fn(async () => png());
    const library = new VisionLibrary(store, render);
    const result = await library.prepare({ ...source, page: 1 }, undefined, [
      source.documentId,
    ]);
    expect(result.chunk.page).toBe(1);
    expect(result.chunk.visual).toEqual({ ...source, page: 1 });
    await library.prepare({ ...source, page: 1 });
    expect(render).toHaveBeenCalledTimes(1);
    await expect(library.prepare(source, undefined, [])).rejects.toThrow(
      "outside the selected scope",
    );
    await expect(
      library.prepare({ ...source, version: "changed" }),
    ).rejects.toThrow("has changed");
    expect(
      store.db.prepare("SELECT count(*) AS n FROM visual_cache").get(),
    ).toEqual({ n: 1 });
    store.removeDocument(source.documentId);
    expect(
      store.db.prepare("SELECT count(*) AS n FROM visual_cache").get(),
    ).toEqual({ n: 0 });
    await expect(library.prepare(source)).rejects.toThrow("indexed PDF");
  });
  it("persists attachments by content hash with full original pixels and rejects scripts/corrupt data", async () => {
    const { store } = fixture();
    const library = new VisionLibrary(store);
    const first = await library.attach(arrayBuffer(png()), "screenshot.png");
    const again = await library.attach(arrayBuffer(png()), "renamed.png");
    expect(again).toEqual(first);
    expect(await library.preview(first.source)).toBe(
      `data:image/png;base64,${png().toString("base64")}`,
    );
    await expect(
      library.attach(
        arrayBuffer(Buffer.from("<svg onload='alert(1)'/>")),
        "evil.png",
      ),
    ).rejects.toThrow("Only PNG and JPEG");
    await expect(library.prepare(first.source, undefined, [])).rejects.toThrow(
      "outside",
    );
    const stopped = AbortSignal.abort();
    await expect(library.prepare(first.source, stopped)).rejects.toThrow();
  });
  it("does not cache a page if its document changed while rendering", async () => {
    const { store, source } = fixture();
    const library = new VisionLibrary(store, async () => {
      store.db
        .prepare("UPDATE documents SET version='new' WHERE id=?")
        .run(source.documentId);
      return png();
    });
    await expect(library.prepare(source)).rejects.toThrow(
      "changed while preparing",
    );
    expect(
      store.db.prepare("SELECT count(*) AS n FROM visual_cache").get(),
    ).toEqual({ n: 0 });
  });
  it("bounds the model's image resolution", async () => {
    const canvas = createCanvas(3200, 800);
    const result = await renderImage(canvas.toBuffer("image/png"));
    expect(result.readUInt32BE(16)).toBe(1600);
    expect(result.readUInt32BE(20)).toBe(400);
  });
});

describe("vision in questions", () => {
  it("sends pixels even without text matches and retains an exact visual citation", async () => {
    const { store, source } = fixture();
    const visual = await new VisionLibrary(store).prepare(source);
    const { llm, seen } = scripted(["The image shows 2 colored boxes [1]."]);
    const result = await runTurn(
      {
        llm,
        hasSelectedDocuments: true,
        search: async () => [],
        vision: { initial: [visual] },
      },
      "What is visible?",
      [],
      options(),
      events,
    );
    expect(JSON.stringify(seen[0])).toContain('"type":"image_url"');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.visual).toEqual(source);
    expect(result.citations[0]!.cited).toBe(true);
    expect(result.warnings).toEqual([]);
  });
  it("lets the native inspector add page pixels and numbered evidence after tool results", async () => {
    const { store, source } = fixture(pdf(), "pdf");
    const library = new VisionLibrary(store);
    const { llm, seen } = scripted([
      [
        {
          id: "inspect",
          type: "function",
          function: {
            name: "inspect_document_page",
            arguments: JSON.stringify({
              documentId: source.documentId,
              page: 1,
            }),
          },
        },
      ],
      "A red rectangle is on the page [1].",
    ]);
    const result = await runTurn(
      {
        llm,
        search: async () => [],
        hasSelectedDocuments: true,
        vision: {
          initial: [],
          inspect: (documentId, page, signal) =>
            library.prepare({ documentId, page }, signal, [source.documentId]),
        },
      },
      "Explain the figure",
      [],
      options(),
      events,
    );
    expect(seen[1]!.at(-2)!.role).toBe("tool");
    expect(seen[1]!.at(-1)!.role).toBe("user");
    expect(JSON.stringify(seen[1]!.at(-1))).toContain("image_url");
    expect(result.citations[0]!.page).toBe(1);
    expect(result.citations[0]!.cited).toBe(true);
  });
  it("does not send unselected pixels or manufacture citations after a rejected tool call", async () => {
    const { store, source } = fixture();
    const library = new VisionLibrary(store);
    const { llm, seen } = scripted([
      [
        {
          id: "inspect",
          type: "function",
          function: {
            name: "inspect_document_page",
            arguments: JSON.stringify({ documentId: source.documentId }),
          },
        },
      ],
      "No evidence [1].",
    ]);
    const result = await runTurn(
      {
        llm,
        search: async () => [],
        hasSelectedDocuments: true,
        vision: {
          initial: [],
          inspect: (documentId, page, signal) =>
            library.prepare({ documentId, page }, signal, []),
        },
      },
      "What is visible?",
      [],
      options(),
      events,
    );
    expect(JSON.stringify(seen[1])).not.toContain("image_url");
    expect(result.citations).toEqual([]);
    expect(result.text).not.toContain("[1]");
  });
  it("resets history when the image, page, or version changes", () => {
    const scope = { mode: "documents" as const, setIds: [1], documentIds: [2] };
    expect(
      sameQuestionScope(
        {
          ...scope,
          visualKey: visualKey([{ documentId: 2, page: 1, version: "old" }]),
        },
        {
          ...scope,
          visualKey: visualKey([{ documentId: 2, page: 2, version: "old" }]),
        },
      ),
    ).toBe(false);
    expect(
      sameQuestionScope(
        { ...scope, visualKey: "image:a" },
        { ...scope, visualKey: "image:b" },
      ),
    ).toBe(false);
  });
});
