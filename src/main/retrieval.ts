import type { Store, StoredChunk } from "./store";
import { nearestTopic } from "./topics";
import { type VoiceKind, voiceKind, voiceSentences } from "./voices";

const CANDIDATES = 30;
const RRF_K = 60;
/**
 * Below this cosine similarity, and with no keyword hit, a passage is treated as unrelated.
 * nomic-embed-text scores related passages well above it; tune it against real documents.
 */
const MIN_SIMILARITY = 0.35;

const SURVEY_GROUPS = 6;
const SURVEY_GROUP_QUOTES = 2;
const SURVEY_UNGROUPED_QUOTES = 6;

export interface SurveyQuote {
  sentence: string;
  chunk: StoredChunk;
}

export interface SurveyGroup {
  /** The topic, or null if the set has no topics yet. */
  label: string | null;
  documents: number;
  quotes: SurveyQuote[];
}

export interface Survey {
  kind: VoiceKind;
  /** Documents in which someone says this kind of thing. */
  documents: number;
  /** All documents searched. */
  total: number;
  groups: SurveyGroup[];
}

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
  private cache: {
    key: string;
    ids: number[];
    vectors: Float32Array[];
    sets: number[];
  } | null = null;

  constructor(
    private store: Store,
    private embedQuery: EmbedQuery,
    private rank?: (
      q: Float32Array,
      vectors: Float32Array[],
    ) => Promise<number[]>,
  ) {}

  /** Hybrid search: exact keywords and meaning, merged by reciprocal rank fusion. */
  async search(
    setIds: number[],
    query: string,
    limit = 8,
    documentIds: number[] = [],
  ): Promise<StoredChunk[]> {
    if (setIds.length === 0) return [];
    const loaded = this.load(setIds);
    const owners = documentIds.length
      ? this.store.chunkDocuments(setIds)
      : null;
    const offsets = loaded.ids
      .map((_, i) => i)
      .filter(
        (i) => !owners || documentIds.includes(owners.get(loaded.ids[i]!)!),
      );
    const ids = offsets.map((i) => loaded.ids[i]!);
    const vectors = offsets.map((i) => loaded.vectors[i]!);
    if (ids.length === 0) return [];

    let byMeaning: number[] = [];
    try {
      const q = normalize(await this.embedQuery(query));
      const values = this.rank
        ? await this.rank(q, vectors)
        : vectors.map((v) => dot(q, v));
      byMeaning = ids
        .map((id, i) => ({ id, score: values[i]! }))
        .filter((r) => r.score >= MIN_SIMILARITY)
        .sort((a, b) => b.score - a.score)
        .slice(0, CANDIDATES)
        .map((r) => r.id);
    } catch {
      /* The on-disk keyword index remains useful without a model. */
    }
    const byKeyword = this.store.keywordSearch(
      setIds,
      query,
      CANDIDATES,
      documentIds,
    );

    const scores = new Map<number, number>();
    for (const list of [byMeaning, byKeyword]) {
      list.forEach((id, rank) =>
        scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)),
      );
    }
    const top = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const candidates = this.store
      .chunksById(top)
      .filter((c) => !documentIds.length || documentIds.includes(c.documentId));
    const seen = new Set<string>();
    const unique = candidates.filter((c) => {
      const key = c.text.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const documents = new Set<number>();
    const diverse = unique.filter(
      (c) => !documents.has(c.documentId) && documents.add(c.documentId),
    );
    const chosen = [
      ...diverse,
      ...unique.filter((c) => !diverse.includes(c)),
    ].slice(0, limit);
    return chosen.map((c) => {
      const neighbors = this.store.documentChunks(c.documentId);
      const i = neighbors.findIndex((n) => n.id === c.id);
      return {
        ...c,
        text: neighbors
          .slice(Math.max(0, i - 1), i + 2)
          .filter((n) => n.page === c.page)
          .map((n) => n.text)
          .join("\n\n"),
        line: neighbors[Math.max(0, i - 1)]?.line ?? c.line,
      };
    });
  }

  /**
   * Finds where people ask for or complain about things, across every passage, and groups them by
   * topic. Word counts and passage embeddings cannot say what is being asked for, so this counts
   * documents and quotes people rather than naming a single winner.
   */
  survey(setIds: number[], question: string): Survey | null {
    const kind = voiceKind(question);
    if (!kind) return null;
    const { ids, vectors, sets } = this.load(setIds);
    const texts = this.store.chunkTexts(ids);
    const owners = this.store.chunkDocuments(setIds);
    const topics = new Map(setIds.map((id) => [id, this.store.topicIndex(id)]));

    interface Hit {
      id: number;
      document: number;
      sentence: string;
      closeness: number;
    }
    const groups = new Map<
      string,
      { label: string | null; documents: Set<number>; hits: Hit[] }
    >();
    const everyone = new Set<number>();
    const repeated = new Set<string>();

    ids.forEach((id, i) => {
      const fresh = voiceSentences(texts.get(id) ?? "", kind).filter(
        (s) => !repeated.has(s.toLowerCase()),
      );
      const sentence = fresh[0];
      if (!sentence) return;
      fresh.forEach((s) => repeated.add(s.toLowerCase()));
      const document = owners.get(id)!;
      const index = topics.get(sets[i]!);
      const usable = index?.dimensions === vectors[i]!.length ? index : null;
      const topic = usable
        ? nearestTopic(vectors[i]!, usable.centroids, usable.dimensions)
        : null;
      const key = topic === null ? "none" : `${sets[i]}:${topic}`;
      const group = groups.get(key) ?? {
        label: topic === null ? null : usable!.labels[topic]!,
        documents: new Set(),
        hits: [],
      };
      const closeness =
        topic === null
          ? 0
          : dot(
              vectors[i]!,
              usable!.centroids.subarray(
                topic * usable!.dimensions,
                (topic + 1) * usable!.dimensions,
              ),
            );
      group.documents.add(document);
      group.hits.push({ id, document, sentence, closeness });
      groups.set(key, group);
      everyone.add(document);
    });
    if (everyone.size === 0) return null;

    const largest = [...groups.values()]
      .sort((a, b) => b.documents.size - a.documents.size)
      .slice(0, SURVEY_GROUPS);
    const chosen = largest.map((group) => {
      const quotes =
        group.label === null ? SURVEY_UNGROUPED_QUOTES : SURVEY_GROUP_QUOTES;
      const seen = new Set<number>();
      return [...group.hits]
        .sort((a, b) => b.closeness - a.closeness)
        .filter((hit) => !seen.has(hit.document) && seen.add(hit.document))
        .slice(0, quotes);
    });
    const chunks = new Map(
      this.store
        .chunksById(chosen.flat().map((h) => h.id))
        .map((c) => [c.id, c]),
    );
    return {
      kind,
      documents: everyone.size,
      total: this.store.documentTotal(setIds),
      groups: largest.map((group, g) => ({
        label: group.label,
        documents: group.documents.size,
        quotes: chosen[g]!.map((hit) => ({
          sentence: hit.sentence,
          chunk: chunks.get(hit.id)!,
        })),
      })),
    };
  }

  private load(setIds: number[]) {
    const key = `${this.store.generation}:${[...setIds].sort((a, b) => a - b).join(",")}`;
    if (this.cache?.key !== key)
      this.cache = { key, ...this.store.vectors(setIds) };
    return this.cache;
  }
}
