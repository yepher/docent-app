import { withoutSourceMetadata, type SourceMetadata } from "./source-metadata";

const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/**
 * Finds the sources an answer really cites. Models sometimes invent a number, so a marker
 * for a source that was never supplied is removed instead of being shown as a citation.
 */
export function resolveCitations(
  text: string,
  sourceCount: number,
): { text: string; cited: Set<number> } {
  const cited = new Set<number>();
  const cleaned = text.replace(MARKER, (_, list: string) => {
    const valid = list
      .split(",")
      .map((n) => Number(n.trim()))
      .filter((n) => n >= 1 && n <= sourceCount);
    valid.forEach((n) => cited.add(n));
    return valid.length > 0 ? `[${valid.join(", ")}]` : "";
  });
  return {
    text: cleaned
      .replace(/ +([.,;:!?])/g, "$1")
      .replace(/ {2,}/g, " ")
      .trim(),
    cited,
  };
}

export interface SpeechPart {
  /** The text as written, citations included, for display. */
  raw: string;
  /** The same text with citations and markdown removed. Empty when nothing is speakable. */
  spoken: string;
}

// A marker only joins the sentence before it on the same line. One on a new line opens a reference.
const SENTENCE_END =
  /[.!?。！？]["')\]]*(?:[ \t]*\[\d+(?:\s*,\s*\d+)*\])*\s+|\n+/;
const REFERENCE_LINE = /^[\s>*_•-]*\[\d+(?:\s*,\s*\d+)*\]/;
const SOURCES_HEADING =
  /^[^\p{L}]*(?:sources?|references?|citations?)[^\p{L}]*$/iu;

/**
 * Cuts streamed answer text into sentences that can be shown and spoken together. Models often
 * end with their own list of sources, so those lines are shown but never spoken.
 */
export class SentenceSplitter {
  private buffer = "";
  private atLineStart = true;
  private inReference = false;

  push(delta: string): SpeechPart[] {
    this.buffer += delta;
    const parts: SpeechPart[] = [];
    for (;;) {
      const match = SENTENCE_END.exec(this.buffer);
      if (!match) return parts;
      const end = match.index + match[0].length;
      parts.push(this.part(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end);
    }
  }

  flush(): SpeechPart[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? [this.part(rest)] : [];
  }

  private part(raw: string): SpeechPart {
    const reference =
      this.inReference ||
      (this.atLineStart &&
        (REFERENCE_LINE.test(raw) || SOURCES_HEADING.test(raw)));
    this.atLineStart = raw.endsWith("\n");
    // A reference can hold a full stop ("Smith et al. 2017"), so it runs to the end of its line.
    this.inReference = reference && !this.atLineStart;
    return { raw, spoken: reference ? "" : speakable(raw.replace(MARKER, "")) };
  }
}

function speakable(text: string): string {
  return text
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
}

/** Conservative checks, not a semantic proof. Derived quantities are flagged for review. */
export function evidenceIssues(
  answer: string,
  sources: Map<number, string>,
  visualSources = new Set<number>(),
  metadata: SourceMetadata[] = [],
): string[] {
  if (!sources.size) return [];
  const splitter = new SentenceSplitter();
  const sentences = [
    ...splitter.push(withoutSourceMetadata(answer, metadata)),
    ...splitter.flush(),
  ].map((p) => p.raw.trim());
  const issues = new Set<string>();
  for (const sentence of sentences) {
    if (sentence.length < 25 || sentence.endsWith(":")) continue;
    const refs = [...sentence.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap(
      (m) => m[1]!.split(",").map(Number),
    );
    if (!refs.length) {
      issues.add(
        "Some statements have no attached citation. Check them against the source passages.",
      );
      continue;
    }
    const evidence = refs.map((n) => sources.get(n) ?? "").join(" ");
    // Values seen in pixels need not appear in OCR. The linked original is the evidence.
    if (refs.some((n) => visualSources.has(n))) continue;
    const numbers =
      sentence
        .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
        .match(/\b\d+(?:\.\d+)?\b/g) ?? [];
    for (const n of numbers)
      if (!new RegExp(`\\b${n.replace(".", "\\.")}\\b`).test(evidence))
        issues.add(
          `The number ${n} does not appear verbatim in its cited passages; verify any calculation or interpretation.`,
        );
  }
  return [...issues].slice(0, 5);
}
