import type { StoredChunk } from "./store";
import { OVERLAP_CHARS } from "./ingest/chunk";

export interface ReferenceEntry {
  number: number;
  text: string;
  chunks: StoredChunk[];
}

const HEADING =
  /^(?:[ \t]*#{1,6}[ \t]+)?[ \t]*(?:\d+[.]?[ \t]+)?(?:References|Bibliography|Works cited)[ \t]*$/im;
const ENTRY = /^[ \t]*\[(\d{1,4})\][ \t]+/gm;
const END =
  /^(?:[ \t]*#{1,6}[ \t]+)?[ \t]*(?:Appendix|Appendices|Supplementary material|Acknowledg[e]?ments)\b.*$/im;

export function asksForReferences(question: string): boolean {
  return (
    /\b(what|which|list|show|name)\b/i.test(question) &&
    (/\b(references|bibliography|works cited)\b/i.test(question) ||
      /\b(research|papers?|studies|works?)\b.{0,60}\b(referenced|cited)\b/i.test(
        question,
      ))
  );
}

/** Extract a numbered bibliography, retaining the exact passages behind each entry.
 * Unsupported formats return no result and use normal retrieval instead.
 */
export function numberedReferences(chunks: StoredChunk[]): ReferenceEntry[] {
  const pages = new Map<number | null, StoredChunk[]>();
  for (const chunk of chunks)
    pages.set(chunk.page, [...(pages.get(chunk.page) ?? []), chunk]);
  let text = "";
  const spans: { start: number; end: number; chunk: StoredChunk }[] = [];
  let started = false;
  for (const page of pages.values()) {
    const pageText = page.map((c) => c.text).join("\n");
    if (!started && !HEADING.test(pageText)) continue;
    // Do not absorb figures or appendix pages after the bibliography ends.
    if (
      started &&
      page[0]!.page !== null &&
      !/^[ \t]*\[\d{1,4}\][ \t]+/m.test(pageText)
    )
      break;
    started = true;
    let previous: StoredChunk | undefined;
    for (const chunk of page) {
      let overlap = 0;
      if (previous) {
        for (let n = Math.min(OVERLAP_CHARS, chunk.text.length); n >= 20; n--) {
          if (text.endsWith(chunk.text.slice(0, n))) {
            overlap = n;
            break;
          }
        }
      }
      if (!overlap) text += "\n\n";
      const start = text.length - overlap;
      text += chunk.text.slice(overlap);
      spans.push({ start, end: text.length, chunk });
      previous = chunk;
    }
  }
  const heading = HEADING.exec(text);
  if (!heading) return [];
  const start = heading.index + heading[0].length;
  const ending = END.exec(text.slice(start));
  const end = ending ? start + ending.index : text.length;
  const body = text.slice(start, end);
  const entries = [...body.matchAll(ENTRY)];
  if (
    entries.length < 2 ||
    entries.some((entry, i) => Number(entry[1]) !== i + 1)
  )
    return [];
  return entries
    .map((entry, i) => {
      const from = start + entry.index + entry[0].length;
      const to = entries[i + 1] ? start + entries[i + 1]!.index : end;
      return {
        number: Number(entry[1]),
        text: text
          .slice(from, to)
          .replace(/^[ \t]*\d+[ \t]*$/gm, "") // PDF page footers
          .replace(/\s+/g, " ")
          .trim(),
        chunks: spans
          .filter((s) => s.start < to && s.end > from)
          .map((s) => s.chunk),
      };
    })
    .filter((entry) => entry.text.length > 0);
}
