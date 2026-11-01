import type { DocSet } from "./types";

export interface ImportItem {
  path: string;
  name: string;
  kind: "file" | "folder";
}
export interface PendingImport {
  id: string;
  items: ImportItem[];
}
export type ImportDestination = { setId: number } | { newSetName: string };
export interface ImportsApi {
  /** File objects must originate from a native drop or file picker. Paths are resolved in preload. */
  drop(files: File[]): Promise<void>;
  pending(): Promise<PendingImport[]>;
  confirm(id: string, destination: ImportDestination): Promise<DocSet>;
  dismiss(id: string): Promise<void>;
  onPending(cb: (requests: PendingImport[]) => void): () => void;
}
