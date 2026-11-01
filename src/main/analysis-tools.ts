import type { StoredChunk, Store } from "./store";
import { voiceSentences } from "./voices";
import { numberedReferences } from "./references";

export interface RequestExample {
  sentence: string;
  chunk: StoredChunk;
}
export interface FeatureRule {
  label: string;
  terms: string[];
}
const GENERIC = new Set([
  "feature",
  "features",
  "request",
  "requests",
  "tool",
  "tools",
  "option",
  "support",
  "please",
  "add",
  "this",
  "that",
  "it",
  "shapr3d",
]);
export function requestExamples(chunks: StoredChunk[]): RequestExample[] {
  const seen = new Set<string>();
  return chunks.flatMap((chunk) =>
    voiceSentences(chunk.text, "requests")
      .filter((sentence) => {
        if (
          /\b(this|it|that) (feature|implemented|available)|bumping this|i too would|would be great to have\s*$/i.test(
            sentence,
          )
        )
          return false;
        const key = chunk.path + "\0" + sentence.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((sentence) => ({ sentence, chunk })),
  );
}
export function validRules(value: unknown): FeatureRule[] {
  if (!Array.isArray(value)) return [];
  const rules: FeatureRule[] = value.slice(0, 20).flatMap((r) => {
    if (!r || typeof r.label !== "string" || !Array.isArray(r.terms)) return [];
    const terms: string[] = [
      ...new Set<string>(
        r.terms
          .filter(
            (t: unknown): t is string =>
              typeof t === "string" && t.length >= 3 && t.length <= 60,
          )
          .map((t: string) => t.toLowerCase().trim()),
      ),
    ].filter((t) => !GENERIC.has(t));
    return terms.length
      ? [{ label: r.label.slice(0, 80), terms: terms.slice(0, 8) }]
      : [];
  });
  // Small models often split one capability by its use case ("thread tool for screws"
  // versus "thread tool for bolts"). Merge only identical, meaningful capability
  // prefixes; retain the original literal matching terms so counting stays auditable.
  const groups = new Map<string, FeatureRule[]>();
  for (const rule of rules) {
    const prefix = rule.terms[0]!.split(/\s+for\s+/)[0]!;
    const words = prefix.split(/\s+/);
    const key =
      words.length >= 2 &&
      words.some(
        (w) =>
          !GENERIC.has(w) && !["the", "a", "to", "of", "ability"].includes(w),
      )
        ? prefix
        : rule.label;
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  return [...groups.entries()].map(([key, group]) =>
    group.length === 1
      ? group[0]!
      : {
          label: key[0]!.toUpperCase() + key.slice(1),
          terms: [...new Set(group.flatMap((r) => r.terms))],
        },
  );
}
export function tallyRequests(
  examples: RequestExample[],
  rules: FeatureRule[],
) {
  return rules
    .map((rule) => {
      const matches = examples.filter((e) =>
        rule.terms.some((term) => {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(
            `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
            "iu",
          ).test(e.sentence);
        }),
      );
      const documents = new Set(matches.map((e) => e.chunk.path));
      const seen = new Set<string>();
      const quotes = matches
        .filter((e) => !seen.has(e.chunk.path) && seen.add(e.chunk.path))
        .slice(0, 2);
      return { ...rule, documents: documents.size, quotes };
    })
    .filter((g) => g.documents > 0)
    .sort((a, b) => b.documents - a.documents);
}

/** Restricted, read-only tools. No model output is executed as code or SQL. */
export function documentTools(
  store: Store,
  setIds: number[],
  documentIds: number[] = [],
) {
  const allowed = () =>
    setIds
      .flatMap((id) => store.documents(id))
      .filter((d) => !documentIds.length || documentIds.includes(d.id));
  return {
    references: () => {
      const documents = allowed();
      // Broad collections use search; full bibliography extraction is for a small scope.
      if (documents.length > 20) return [];
      return documents
        .map((d) => ({
          title: d.title,
          entries: numberedReferences(store.documentChunks(d.id)),
        }))
        .filter((d) => d.entries.length > 0);
    },
    list: () =>
      allowed().map((d) => ({
        id: d.id,
        title: d.title,
        indexedAt: d.indexedAt,
        warning: d.error,
      })),
    read: (id: number) =>
      allowed().some((d) => d.id === id) ? store.documentChunks(id) : [],
    count: (phrase: string) => {
      const needle = phrase.toLowerCase().trim();
      if (!needle || needle.length > 200)
        throw new Error("Supply a phrase between 1 and 200 characters.");
      const hits = allowed().filter((d) =>
        store
          .documentChunks(d.id)
          .some((c) => c.text.toLowerCase().includes(needle)),
      );
      return {
        unit: "distinct indexed documents",
        phrase,
        total: allowed().length,
        count: hits.length,
        examples: hits.slice(0, 5).map((d) => ({ id: d.id, title: d.title })),
      };
    },
    requests: async () => {
      const result: RequestExample[] = [];
      let scanned = 0;
      for (const d of allowed()) {
        result.push(...requestExamples(store.documentChunks(d.id)));
        if (++scanned % 50 === 0)
          await new Promise((resolve) => setImmediate(resolve));
      }
      return result;
    },
  };
}
