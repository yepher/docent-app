import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ImportReport, IngestProgress } from "../../shared/types";
import type { Embedder } from "../llm";
import { normalize } from "../retrieval";
import type { Store } from "../store";
import { type Chunk, chunkSegments } from "./chunk";
import { PARSER_VERSION, collectFiles, parseFile, titleOf } from "./parse";

export async function indexSet(
  store: Store,
  embedder: Embedder,
  setId: number,
  onProgress: (p: IngestProgress) => void,
  parse: typeof parseFile = parseFile,
  signal?: AbortSignal,
): Promise<void> {
  const files = new Set<string>();
  const report: ImportReport = {
    setId,
    indexed: 0,
    unchanged: 0,
    failed: 0,
    unavailable: 0,
    skipped: 0,
  };
  for (const source of store.sources(setId)) {
    try {
      for (const file of await collectFiles(source, () => report.skipped++)) {
        if (!store.excluded(setId, file)) files.add(file);
      }
    } catch {
      report.unavailable++;
    }
  }
  store.removeMissing(setId, files);
  let done = 0;
  for (const path of files) {
    signal?.throwIfAborted();
    onProgress({ setId, done, total: files.size, current: titleOf(path) });
    const doc = {
      setId,
      path,
      title: titleOf(path),
      mtimeMs: 0,
      size: 0,
      parserVersion: PARSER_VERSION,
    };
    try {
      const info = await stat(path);
      Object.assign(doc, { mtimeMs: info.mtimeMs, size: info.size });
      if (store.isCurrent(setId, path, info.mtimeMs, info.size, PARSER_VERSION))
        report.unchanged++;
      else {
        const chunks = chunkSegments(await parse(path));
        const embedded: (Chunk & { embedding: Float32Array })[] = [];
        for (let i = 0; i < chunks.length; i += 16) {
          signal?.throwIfAborted();
          const batch = chunks.slice(i, i + 16);
          const vectors = await embedder.embedDocuments(
            batch.map((c) => `${doc.title}\n${c.text}`),
          );
          batch.forEach((c, j) => {
            if (!vectors[j]?.length || !vectors[j]!.every(Number.isFinite))
              throw new Error("Invalid embedding returned");
            embedded.push({ ...c, embedding: normalize(vectors[j]!) });
          });
        }
        const bytes = await readFile(path);
        const after = await stat(path);
        if (info.mtimeMs !== after.mtimeMs || info.size !== after.size)
          throw new Error("File changed while indexing; rescan to retry.");
        store.saveDocument(
          {
            ...doc,
            bytes,
            version: createHash("sha256").update(bytes).digest("hex"),
          },
          embedded,
        );
        report.indexed++;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      store.saveDocument(
        doc,
        [],
        err instanceof Error ? err.message : String(err),
      );
      report.failed++;
    }
    done++;
  }
  store.saveReport(report);
  onProgress({ setId, done, total: files.size, current: null });
}
