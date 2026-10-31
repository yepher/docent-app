import type { Store, StoredChunk } from './store';

const CANDIDATES = 30;
const RRF_K = 60;
/**
 * Below this cosine similarity, and with no keyword hit, a passage is treated as unrelated.
 * nomic-embed-text scores related passages well above it; tune it against real documents.
 */
const MIN_SIMILARITY = 0.35;

export type EmbedQuery = (text: string) => Promise<Float32Array>;

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function normalize(v: Float32Array): Float32Array {
  const length = Math.sqrt(dot(v, v));
  return length === 0 ? v : v.map((x) => x / length);
}

export class Retriever {
  private cache: { key: string; ids: number[]; vectors: Float32Array[] } | null = null;

  constructor(
    private store: Store,
    private embedQuery: EmbedQuery,
  ) {}

  /** Hybrid search: exact keywords and meaning, merged by reciprocal rank fusion. */
  async search(setIds: number[], query: string, limit = 6): Promise<StoredChunk[]> {
    if (setIds.length === 0) return [];
    const { ids, vectors } = this.load(setIds);
    if (ids.length === 0) return [];

    const q = normalize(await this.embedQuery(query));
    const byMeaning = ids
      .map((id, i) => ({ id, score: dot(q, vectors[i]!) }))
      .filter((r) => r.score >= MIN_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES)
      .map((r) => r.id);
    const byKeyword = this.store.keywordSearch(setIds, query, CANDIDATES);

    const scores = new Map<number, number>();
    for (const list of [byMeaning, byKeyword]) {
      list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    const top = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
    return this.store.chunksById(top);
  }

  private load(setIds: number[]) {
    const key = `${this.store.generation}:${[...setIds].sort((a, b) => a - b).join(',')}`;
    if (this.cache?.key !== key) this.cache = { key, ...this.store.vectors(setIds) };
    return this.cache;
  }
}
