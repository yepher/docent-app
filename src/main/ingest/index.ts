import { stat } from 'node:fs/promises';
import type { IngestProgress } from '../../shared/types';
import type { Embedder } from '../llm';
import { normalize } from '../retrieval';
import type { Store } from '../store';
import { type Chunk, chunkSegments } from './chunk';
import { collectFiles, parseFile, titleOf } from './parse';

const EMBED_BATCH = 16;

export async function indexSet(
  store: Store,
  embedder: Embedder,
  setId: number,
  onProgress: (p: IngestProgress) => void,
): Promise<void> {
  const files = new Set<string>();
  for (const source of store.sources(setId)) {
    try {
      for (const file of await collectFiles(source)) files.add(file);
    } catch {
      // A removed source leaves its files out of `files`, and removeMissing cleans them up.
    }
  }
  store.removeMissing(setId, files);

  let done = 0;
  for (const path of files) {
    onProgress({ setId, done, total: files.size, current: titleOf(path) });
    const info = await stat(path);
    if (!store.isCurrent(setId, path, info.mtimeMs, info.size)) {
      const doc = { setId, path, title: titleOf(path), mtimeMs: info.mtimeMs, size: info.size };
      try {
        const chunks = chunkSegments(await parseFile(path));
        const embedded: (Chunk & { embedding: Float32Array })[] = [];
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
          const batch = chunks.slice(i, i + EMBED_BATCH);
          const vectors = await embedder.embedDocuments(batch.map((c) => c.text));
          batch.forEach((c, j) => embedded.push({ ...c, embedding: normalize(vectors[j]!) }));
        }
        store.saveDocument(doc, embedded);
      } catch (err) {
        store.saveDocument(doc, [], err instanceof Error ? err.message : String(err));
      }
    }
    done++;
  }
  onProgress({ setId, done, total: files.size, current: null });
}
