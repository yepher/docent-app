import type { DocumentRow } from "../../shared/types";
import type { ToolCoverage, ToolScope } from "../../shared/tools";
import type { Store, StoredChunk } from "../store";
import { numberedReferences } from "../references";
import { byteHash, canonical } from "./package";

function integer(value: unknown, min: number, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Expected an integer between ${min} and ${max}.`);
  return value;
}
export interface ToolLibrary {
  documents: DocumentRow[];
  read(id: number, offset: number, limit: number): StoredChunk[];
  search(query: string, limit: number): StoredChunk[];
  unchanged(): boolean;
}
export function storeLibrary(store: Store, scope: ToolScope): ToolLibrary {
  const load = () =>
    [...new Set(scope.setIds)]
      .flatMap((id) => store.documents(id))
      .filter(
        (d) => !scope.documentIds.length || scope.documentIds.includes(d.id),
      );
  const documents = load();
  const before = canonical(documents);
  return {
    documents,
    read: (id, offset, limit) => store.documentChunkPage(id, offset, limit),
    search: (query, limit) =>
      store.chunksById(
        store.keywordSearch(scope.setIds, query, limit, scope.documentIds),
      ),
    unchanged: () => canonical(load()) === before,
  };
}

export class ScopeHost {
  readonly fingerprint: string;
  private allowed: Map<number, DocumentRow>;
  private listed = new Set<number>();
  private seen = new Map<string, StoredChunk>();
  constructor(private library: ToolLibrary) {
    this.allowed = new Map(library.documents.map((d) => [d.id, d]));
    this.fingerprint = byteHash(
      canonical(
        library.documents.map((d) => [
          d.id,
          d.version ?? null,
          d.indexedAt ?? null,
          d.chunkCount,
        ]),
      ),
    );
  }
  private passages(chunks: StoredChunk[]) {
    return chunks.map((c) => {
      if (!this.allowed.has(c.documentId))
        throw new Error("Document is outside the selected scope.");
      const id = `p${c.id}`;
      this.seen.set(id, c);
      return {
        id,
        documentId: c.documentId,
        text: c.text,
        page: c.page,
        line: c.line,
      };
    });
  }
  call = (method: string, args: unknown[]): unknown => {
    if (method === "documents") {
      const offset = integer(args[0], 0, 10000000),
        limit = integer(args[1], 1, 200);
      const docs = this.library.documents.slice(offset, offset + limit);
      docs.forEach((d) => this.listed.add(d.id));
      return {
        total: this.allowed.size,
        nextOffset:
          offset + docs.length < this.allowed.size
            ? offset + docs.length
            : null,
        documents: docs.map((d) => ({
          id: d.id,
          title: d.title,
          version: d.version ?? null,
          passageCount: d.chunkCount,
          warning: d.error,
        })),
      };
    }
    if (method === "read" || method === "references") {
      const id = integer(args[0], 1, Number.MAX_SAFE_INTEGER);
      const doc = this.allowed.get(id);
      if (!doc) throw new Error("Document is outside the selected scope.");
      if (method === "references") {
        if (doc.chunkCount > 5000)
          throw new Error(
            "Document is too large for bibliography extraction; use read with paging.",
          );
        const chunks = this.library.read(id, 0, 5000);
        this.passages(chunks);
        return {
          entries: numberedReferences(chunks).map((entry) => ({
            number: entry.number,
            text: entry.text,
            evidence: entry.chunks.map((c) => `p${c.id}`),
          })),
        };
      }
      const offset = integer(args[1], 0, 10000000),
        limit = integer(args[2], 1, 50);
      const chunks = this.library.read(id, offset, limit);
      return {
        total: doc.chunkCount,
        nextOffset:
          offset + chunks.length < doc.chunkCount
            ? offset + chunks.length
            : null,
        passages: this.passages(chunks),
      };
    }
    if (method === "search") {
      if (
        typeof args[0] !== "string" ||
        !args[0].trim() ||
        args[0].length > 500
      )
        throw new Error("Supply a search query of 1–500 characters.");
      return {
        passages: this.passages(
          this.library.search(args[0], integer(args[1], 1, 50)),
        ),
      };
    }
    throw new Error("Unsupported document API method.");
  };
  evidence(ids: string[]) {
    if (!this.library.unchanged())
      throw new Error(
        "The selected library changed during this run. Try again after indexing finishes.",
      );
    return ids.map((id) => {
      const chunk = this.seen.get(id);
      if (!chunk)
        throw new Error(`Tool returned an evidence ID it did not read: ${id}.`);
      return chunk;
    });
  }
  coverage(): ToolCoverage {
    const docs = this.library.documents;
    const total = docs.reduce((n, d) => n + d.chunkCount, 0);
    const unavailable = docs.filter((d) => !d.chunkCount).length;
    return {
      documentsInScope: docs.length,
      documentsListed: this.listed.size,
      documentsRead: new Set([...this.seen.values()].map((c) => c.documentId))
        .size,
      passagesRead: this.seen.size,
      passagesInScope: total,
      unavailableDocuments: unavailable,
      staleDocuments: docs.filter((d) => d.error && d.chunkCount).length,
      complete:
        docs.length > 0 && unavailable === 0 && this.seen.size === total,
    };
  }
}
