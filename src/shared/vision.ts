/** References, never file paths or image bytes, travel with conversations and citations. */
export type VisualSource =
  | { documentId: number; page?: number; version?: string }
  | { attachmentId: string };

export interface VisualSelection {
  source: VisualSource;
  title: string;
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
