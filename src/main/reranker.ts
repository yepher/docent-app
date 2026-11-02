import { createHash } from "node:crypto";
import type { Endpoint } from "./llm";

export const RERANK_CANDIDATES = 30;
const TIMEOUT_MS = 20_000;
const CACHE_ENTRIES = 64;

/** Reject incomplete/malformed scores rather than silently dropping or misattributing a source. */
export function parseRerankScores(body: unknown, count: number): number[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results) || results.length !== count)
    throw new Error("Incomplete reranking result.");
  const scores = new Array<number>(count);
  const seen = new Set<number>();
  for (const item of results) {
    if (
      !item ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      item.index >= count ||
      seen.has(item.index) ||
      typeof item.relevance_score !== "number" ||
      !Number.isFinite(item.relevance_score) ||
      item.relevance_score < 0 ||
      item.relevance_score > 1
    )
      throw new Error("Invalid reranking scores.");
    seen.add(item.index);
    scores[item.index] = item.relevance_score;
  }
  return scores;
}

export class LlamaServerReranker {
  private cache = new Map<string, number[]>();
  constructor(
    private endpoint: Endpoint,
    private timeoutMs = TIMEOUT_MS,
  ) {}

  async score(
    query: string,
    documents: string[],
    signal?: AbortSignal,
  ): Promise<number[]> {
    signal?.throwIfAborted();
    if (
      !query.trim() ||
      query.length > 2000 ||
      documents.length > RERANK_CANDIDATES ||
      documents.some((d) => d.length > 2400)
    )
      throw new Error("Reranking input exceeds the local model budget.");
    if (!documents.length) return [];
    const key = createHash("sha256")
      .update(JSON.stringify([query, documents]))
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return [...cached];
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.endpoint.baseUrl}/v1/rerank`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.endpoint.apiKey}`,
      },
      body: JSON.stringify({ query, documents, top_n: documents.length }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok)
      throw new Error(`Local reranker failed (${response.status}).`);
    const scores = parseRerankScores(await response.json(), documents.length);
    signal?.throwIfAborted();
    this.cache.set(key, scores);
    if (this.cache.size > CACHE_ENTRIES)
      this.cache.delete(this.cache.keys().next().value!);
    return [...scores];
  }
}
