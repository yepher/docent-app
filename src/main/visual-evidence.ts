import { mapProse, proseOnly } from "../shared/code-text";
import {
  cleanImageExtraction,
  extractionLabel,
  isImagePath,
} from "../shared/vision";
import type { StoredChunk } from "./store";
import { sourceText } from "./evidence";
import { SentenceSplitter } from "./citations";

export interface NumberedSource {
  n: number;
  chunk: StoredChunk;
}

/** Group representations, not claims. Only pixels supplied for this exact version/page qualify. */
export function groupVisualEvidence(entries: NumberedSource[]) {
  const aliases = new Map<number, number>();
  const visual = entries.filter(({ chunk }) => chunk.visual);
  const grouped = new Map<number, StoredChunk[]>();
  for (const entry of entries) {
    if (entry.chunk.visual) continue;
    const image = visual.find(
      ({ chunk }) =>
        chunk.documentId > 0 &&
        chunk.documentId === entry.chunk.documentId &&
        !!chunk.version &&
        chunk.version === entry.chunk.version &&
        chunk.page === entry.chunk.page &&
        (chunk.page !== null || isImagePath(chunk.path)),
    );
    if (!image) continue;
    aliases.set(entry.n, image.n);
    grouped.set(image.n, [...(grouped.get(image.n) ?? []), entry.chunk]);
  }
  const sources = entries
    .filter(({ n }) => !aliases.has(n))
    .map((entry) => {
      const related = grouped.get(entry.n);
      if (!related?.length) return entry;
      const extraction = {
        kind:
          entry.chunk.extraction?.kind ??
          (entry.chunk.page === null
            ? ("ocr" as const)
            : ("document-text" as const)),
        text: [
          ...new Set([
            entry.chunk.extraction?.text ?? "",
            ...related.map((c) =>
              c.page === null
                ? cleanImageExtraction(sourceText(c))
                : sourceText(c),
            ),
          ]),
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
      return {
        ...entry,
        chunk: {
          ...entry.chunk,
          extraction,
          text: `Original ${entry.chunk.page === null ? "image" : "page image"} supplied to the model. Cite [${entry.n}] for this source.\n${extractionLabel(extraction.kind)} (may contain errors or omissions; compare with the image):\n${extraction.text}`,
        },
      };
    });
  return { sources, aliases };
}

/** Old tool/history source numbers remain valid aliases; never modify code or unrelated citations. */
export function mergeVisualCitations(
  text: string,
  aliases: Map<number, number>,
): string {
  return mapProse(text, (prose) =>
    prose.replace(
      /\[(\d+(?:\s*,\s*\d+)*)\]/g,
      (_match, refs: string) =>
        `[${[
          ...new Set(
            refs
              .split(",")
              .map(Number)
              .map((n) => aliases.get(n) ?? n),
          ),
        ].join(", ")}]`,
    ),
  );
}

const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const values = (text: string) =>
  [...text.matchAll(/\b\d+(?:[ \t()+.,:/\u2010-\u2015-]+\d+)*\b/g)]
    .map((m) => m[0])
    .filter((v) => v.replace(/\D/g, "").length >= 4);

/** A text comparison, not a second visual verification or a judgment that either reading is correct. */
export function visualReadingWarnings(
  answer: string,
  sources: NumberedSource[],
): Map<number, string> {
  const warnings = new Map<number, string>();
  const splitter = new SentenceSplitter();
  const sentences = [...splitter.push(proseOnly(answer)), ...splitter.flush()];
  for (const { raw: sentence } of sentences) {
    const refs = [...sentence.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap(
      (m) => m[1]!.split(",").map(Number),
    );
    const cited = sources.filter((s) => refs.includes(s.n));
    const plain = sentence.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "");
    const quotes = [...plain.matchAll(/[“"]([^“”"\n]{8,})[”"]/g)].map(
      (m) => m[1]!,
    );
    for (const source of cited) {
      const extraction = source.chunk.extraction;
      if (
        !source.chunk.visual ||
        !extraction?.text.trim() ||
        warnings.has(source.n)
      )
        continue;
      const candidates = [
        ...quotes,
        ...(values(extraction.text).length ? values(plain) : []),
      ];
      const otherEvidence = cited
        .filter((s) => s.n !== source.n)
        .map((s) => s.chunk.extraction?.text ?? s.chunk.text);
      const missing = candidates.filter(
        (value) =>
          ![extraction.text, ...otherEvidence].some((text) =>
            normalized(text).includes(normalized(value)),
          ),
      );
      if (!missing.length) continue;
      warnings.set(
        source.n,
        `The answer’s reading “${missing[0]!.slice(0, 140)}” is not in the ${extraction.kind === "ocr" ? "automatic text extraction (OCR)" : "extracted document text"} for “${source.chunk.title}”. Compare the original image and extracted text in the citation; either reading may be mistaken.`,
      );
    }
  }
  return warnings;
}
