/** References, never file paths or image bytes, travel with conversations and citations. */
export type VisualSource =
  | { documentId: number; page?: number; version?: string }
  | { attachmentId: string };

export interface VisualSelection {
  source: VisualSource;
  title: string;
}

export interface TextExtraction {
  kind: "ocr" | "document-text";
  text: string;
}

export const extractionLabel = (kind: TextExtraction["kind"]) =>
  kind === "ocr"
    ? "Automatic text extraction (OCR)"
    : "Extracted document text";

export const cleanImageExtraction = (text: string) =>
  text.replace(/^Image: [^\r\n]*\r?\n/, "");

/** Saved answers predate structured extraction metadata; keep their original OCR readable too. */
export function citationExtraction(citation: {
  extraction?: TextExtraction;
  visual?: VisualSource;
  page: number | null;
  path: string;
  excerpt: string;
}): TextExtraction | undefined {
  if (citation.extraction) return citation.extraction;
  if (citation.visual) {
    const legacy = /\nExtracted text \(may be incomplete\):\n([\s\S]*)/.exec(
      citation.excerpt,
    );
    if (legacy)
      return {
        kind: citation.page === null ? "ocr" : "document-text",
        text: cleanImageExtraction(legacy[1]!),
      };
  } else if (isImagePath(citation.path)) {
    return { kind: "ocr", text: cleanImageExtraction(citation.excerpt) };
  }
  return undefined;
}

export const MAX_VISUALS = 3;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const isImagePath = (path: string) => /\.(png|jpe?g)$/i.test(path);
export const isVisualPath = (path: string) => /\.(pdf|png|jpe?g)$/i.test(path);
export const visualKey = (sources: VisualSource[]) =>
  sources
    .map((s) =>
      "attachmentId" in s
        ? `image:${s.attachmentId}`
        : `doc:${s.documentId}:${s.version ?? ""}:${s.page ?? 0}`,
    )
    .join("|");
