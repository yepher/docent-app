import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { VisualSelection, VisualSource } from "../shared/vision";
import { isImagePath, isVisualPath, MAX_IMAGE_BYTES } from "../shared/vision";
import type { Store, StoredChunk } from "./store";
import { imageFormat, renderImage, renderPdfPage } from "./vision-render";
import type { ToolDefinition } from "./llm";

export interface PreparedVisual {
  source: VisualSource;
  chunk: StoredChunk;
  imageUrl: string;
}
type Renderer = (
  bytes: Uint8Array,
  page: number | undefined,
  signal?: AbortSignal,
) => Promise<Uint8Array>;
const dataUrl = (bytes: Uint8Array, format = "png") =>
  `data:image/${format};base64,${Buffer.from(bytes).toString("base64")}`;

export const INSPECT_PAGE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "inspect_document_page",
    description:
      "See the actual PDF page or PNG/JPEG image from a selected document. Use for figures, diagrams, charts, layout, or screenshots that extracted text cannot describe. Returns visual evidence with a citation number. PDF page numbers start at 1.",
    parameters: {
      type: "object",
      properties: {
        documentId: { type: "integer" },
        page: { type: "integer", minimum: 1 },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
};

/** Only indexed originals and explicitly attached images are accepted, never arbitrary paths/URLs. */
export class VisionLibrary {
  constructor(
    private store: Store,
    private render: Renderer = (bytes, page) =>
      page === undefined ? renderImage(bytes) : renderPdfPage(bytes, page),
  ) {}

  async attach(bytes: ArrayBuffer, name: string): Promise<VisualSelection> {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_IMAGE_BYTES)
      throw new Error("Choose an image smaller than 50 MB.");
    const original = new Uint8Array(bytes);
    imageFormat(original);
    const preview = await this.render(original, undefined);
    const id = createHash("sha256").update(original).digest("hex");
    const title =
      typeof name === "string"
        ? basename(name).slice(0, 150) || "Pasted image"
        : "Pasted image";
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO image_attachments(id,title,bytes,preview) VALUES (?,?,?,?)",
      )
      .run(id, title, original, preview);
    const saved = this.store.db
      .prepare("SELECT title FROM image_attachments WHERE id=?")
      .get(id) as { title: string };
    return { source: { attachmentId: id }, title: saved.title };
  }

  async prepare(
    source: VisualSource,
    signal?: AbortSignal,
    allowedDocuments?: number[],
  ): Promise<PreparedVisual> {
    signal?.throwIfAborted();
    if (!source || typeof source !== "object")
      throw new Error("Choose a document page or image.");
    if ("attachmentId" in source) {
      if (allowedDocuments || typeof source.attachmentId !== "string")
        throw new Error("This image is outside the selected documents.");
      const row = this.store.db
        .prepare("SELECT title,preview FROM image_attachments WHERE id=?")
        .get(source.attachmentId) as
        | { title: string; preview: Uint8Array }
        | undefined;
      if (!row) throw new Error("The attached image is no longer available.");
      return {
        source: { attachmentId: source.attachmentId },
        imageUrl: dataUrl(row.preview),
        chunk: {
          id: 0,
          documentId: 0,
          path: "",
          title: row.title,
          setName: "Attached image",
          version: source.attachmentId,
          page: null,
          line: null,
          text: "Image supplied with the question. Inspect the image itself for visual evidence.",
          visual: { attachmentId: source.attachmentId },
        },
      };
    }
    if (
      !Number.isSafeInteger(source.documentId) ||
      (allowedDocuments && !allowedDocuments.includes(source.documentId))
    )
      throw new Error("This document is outside the selected scope.");
    const row = this.store.db
      .prepare(
        "SELECT d.id, d.path, d.title, d.version, d.indexed_at AS indexedAt, d.error AS warning, s.name AS setName FROM documents d JOIN sets s ON s.id=d.set_id WHERE d.id=?",
      )
      .get(source.documentId) as
      | {
          id: number;
          path: string;
          title: string;
          version: string;
          indexedAt: number;
          warning: string | null;
          setName: string;
        }
      | undefined;
    if (!row || !isVisualPath(row.path))
      throw new Error("Choose an indexed PDF, PNG, or JPEG.");
    if (!row.version || (source.version && source.version !== row.version))
      throw new Error(
        "The document has changed since this source was saved. Select its current version to ask a new question.",
      );
    const page = isImagePath(row.path) ? undefined : (source.page ?? 1);
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 1))
      throw new Error("Choose a valid PDF page number.");
    const canonical: VisualSource = {
      documentId: row.id,
      version: row.version,
      ...(page === undefined ? {} : { page }),
    };
    const cacheVersion = `render-v1:${row.version}`;
    const cached = this.store.db
      .prepare(
        "SELECT bytes FROM visual_cache WHERE document_id=? AND version=? AND page=?",
      )
      .get(row.id, cacheVersion, page ?? 0) as
      | { bytes: Uint8Array }
      | undefined;
    let pixels = cached?.bytes;
    if (!pixels) {
      const bytes = this.store.originalBytes(row.id);
      if (!bytes)
        throw new Error(
          "No offline original is available. Rescan this document first.",
        );
      pixels = await this.render(bytes, page, signal);
      signal?.throwIfAborted();
      // The original can be reindexed or removed while a worker renders it.
      const current = this.store.db
        .prepare("SELECT version FROM documents WHERE id=?")
        .get(row.id) as { version: string } | undefined;
      if (current?.version !== row.version)
        throw new Error(
          "The document changed while preparing this page. Try again.",
        );
      this.store.db
        .prepare("DELETE FROM visual_cache WHERE document_id=? AND version<>?")
        .run(row.id, cacheVersion);
      this.store.db
        .prepare("INSERT OR REPLACE INTO visual_cache VALUES (?,?,?,?,?)")
        .run(row.id, cacheVersion, page ?? 0, pixels, Date.now());
      // LRU cache stays bounded; original documents remain in the library.
      this.store.db.exec(
        "DELETE FROM visual_cache WHERE rowid IN (SELECT rowid FROM (SELECT rowid, sum(length(bytes)) OVER (ORDER BY used_at DESC, rowid DESC) AS total FROM visual_cache) WHERE total > 67108864)",
      );
    } else {
      this.store.db
        .prepare(
          "UPDATE visual_cache SET used_at=? WHERE document_id=? AND version=? AND page=?",
        )
        .run(Date.now(), row.id, cacheVersion, page ?? 0);
    }
    const text = (
      this.store.db
        .prepare(
          "SELECT text FROM chunks WHERE document_id=? AND (? IS NULL OR page=?) ORDER BY id LIMIT 20",
        )
        .all(row.id, page ?? null, page ?? null) as { text: string }[]
    )
      .map((c) => c.text)
      .join("\n")
      .slice(0, 6000);
    return {
      source: canonical,
      imageUrl: dataUrl(pixels),
      chunk: {
        ...row,
        id: 0,
        documentId: row.id,
        page: page ?? null,
        line: null,
        visual: canonical,
        text: `Visual evidence: ${page ? `PDF page ${page}` : "image"}. The actual image was supplied to the model.${text ? `\nExtracted text (may be incomplete):\n${text}` : " No extracted text is available."}`,
      },
    };
  }

  async preview(source: VisualSource): Promise<string> {
    const prepared = await this.prepare(source);
    if ("attachmentId" in prepared.source) {
      const row = this.store.db
        .prepare("SELECT bytes FROM image_attachments WHERE id=?")
        .get(prepared.source.attachmentId) as { bytes: Uint8Array };
      return dataUrl(row.bytes, imageFormat(row.bytes));
    }
    if (prepared.chunk.page === null) {
      const bytes = this.store.originalBytes(prepared.chunk.documentId)!;
      return dataUrl(bytes, imageFormat(bytes));
    }
    return prepared.imageUrl;
  }
}
