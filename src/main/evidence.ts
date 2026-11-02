import type { ChatTurn, Citation } from "../shared/types";
import type { Store, StoredChunk } from "./store";

/** Keep source boundaries and locations visible. No document-format assumptions. */
export function withSourceContext(
  store: Store,
  chunks: StoredChunk[],
): StoredChunk[] {
  const documents = new Map<number, StoredChunk[]>();
  return chunks.map((chunk) => {
    if (chunk.visual || chunk.id < 1) return chunk;
    let neighbors = documents.get(chunk.documentId);
    if (!neighbors) {
      neighbors = store.documentChunks(chunk.documentId);
      documents.set(chunk.documentId, neighbors);
    }
    const index = neighbors.findIndex((n) => n.id === chunk.id);
    if (index < 0) return chunk;
    return {
      ...chunk,
      context: [index - 1, index + 1].flatMap((i) => {
        const neighbor = neighbors![i];
        if (!neighbor || neighbor.page !== chunk.page) return [];
        const before = i < index;
        const overlap = sharedOverlap(
          before ? neighbor.text : chunk.text,
          before ? chunk.text : neighbor.text,
        );
        const text = before
          ? neighbor.text.slice(0, neighbor.text.length - overlap)
          : neighbor.text.slice(overlap);
        return text.trim()
          ? [
              {
                text: text.trim(),
                page: neighbor.page,
                line: neighbor.line,
                position: before ? ("before" as const) : ("after" as const),
              },
            ]
          : [];
      }),
    };
  });
}

function sharedOverlap(left: string, right: string): number {
  // Indexed overlap is an exact suffix/prefix; avoid treating short repeated words as overlap.
  for (let n = Math.min(left.length, right.length); n >= 30; n--) {
    if (left.endsWith(right.slice(0, n))) return n;
  }
  return 0;
}

export function sourceText(chunk: StoredChunk): string {
  const context = (position: "before" | "after") =>
    (chunk.context ?? [])
      .filter((c) => c.position === position)
      .map(
        (c) =>
          `[${position === "before" ? "Preceding" : "Following"} context${c.page !== null ? `, page ${c.page}` : c.line !== null ? `, line ${c.line}` : ""}]\n${c.text}`,
      );
  if (!chunk.context?.length) return chunk.text;
  return [
    ...context("before"),
    `[Matched passage]\n${chunk.text}`,
    ...context("after"),
  ].join("\n\n");
}

export function isFollowUp(question: string, history: ChatTurn[]): boolean {
  return (
    history.some((t) => t.role === "user") &&
    (/\b(he|she|him|her|his|hers|they|them|their|it|its|that|those|these|this|earlier|previous|above|first|second|other|instead|more)\b/i.test(
      question,
    ) ||
      /^(?:and|also|why\??$|when\??$|where\??$|how so|what else)\b/i.test(
        question.trim(),
      ))
  );
}

/** Re-read evidence in the current scope, never accept a renderer-supplied excerpt as fact. */
export function historyEvidence(
  store: Store,
  history: ChatTurn[],
  setIds: number[],
  documentIds: number[] = [],
): { citation: Citation; chunk: StoredChunk }[] {
  const previous = history.findLast((t) => t.role === "assistant");
  const allowed = new Map(
    setIds
      .flatMap((id) => store.documents(id))
      .filter((d) => !documentIds.length || documentIds.includes(d.id))
      .map((d) => [d.id, d]),
  );
  const result: { citation: Citation; chunk: StoredChunk }[] = [];
  for (const citation of (previous?.citations ?? [])
    .filter((c) => c.cited)
    .slice(0, 8)) {
    const doc = allowed.get(citation.documentId);
    if (
      !doc ||
      !citation.version ||
      doc.version !== citation.version ||
      citation.visual
    )
      continue;
    const candidates =
      citation.passageId && citation.passageId > 0
        ? store.chunksById([citation.passageId])
        : store
            .documentChunks(doc.id)
            .filter(
              (c) => c.page === citation.page && c.line === citation.line,
            );
    // Older saved answers have no passage ID. Only restore an unambiguous location.
    if (candidates.length !== 1) continue;
    const chunk = candidates[0]!;
    if (chunk.documentId !== doc.id || chunk.version !== citation.version)
      continue;
    result.push({ citation, chunk: withSourceContext(store, [chunk])[0]! });
  }
  return result;
}

/** Old citation numbers must never silently refer to new passages. */
export function remapHistory(
  history: ChatTurn[],
  mapping: Map<number, number>,
): ChatTurn[] {
  const lastAssistant = history.findLastIndex((t) => t.role === "assistant");
  return history.map((turn, i) => ({
    role: turn.role,
    content:
      turn.role === "user"
        ? turn.content
        : turn.content.replace(
            /\[(\d+(?:\s*,\s*\d+)*)\]/g,
            (_match, numbers: string) => {
              const valid =
                i === lastAssistant
                  ? numbers
                      .split(",")
                      .map(Number)
                      .flatMap((n) => (mapping.has(n) ? [mapping.get(n)!] : []))
                  : [];
              return valid.length
                ? `[${valid.join(", ")}]`
                : "(prior citation unavailable)";
            },
          ),
  }));
}
