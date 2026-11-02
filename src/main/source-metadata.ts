/** Navigation fields supplied by Docent, distinct from facts in a passage. */
export interface SourceMetadata {
  title: string;
  documentId: number;
  page: number | null;
  line: number | null;
}

export function sourceLocation(source: SourceMetadata): string {
  if (source.page !== null) return `${source.title}, page ${source.page}`;
  if (source.line !== null) return `${source.title}, line ${source.line}`;
  return source.title;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strip only known, explicitly labeled navigation values, never a bare matching number. */
export function withoutSourceMetadata(
  text: string,
  sources: SourceMetadata[],
): string {
  let result = text;
  for (const source of sources) {
    const title = escape(source.title);
    const formattedTitle = "[*_`]*" + title + "[*_`]*";
    const location =
      source.page !== null
        ? `page\\s+${source.page}`
        : source.line !== null
          ? `line\\s+${source.line}`
          : null;
    if (location) {
      result = result.replace(
        new RegExp(
          `${formattedTitle}[,\\s]+${location}(?![\\p{L}\\p{N}])`,
          "giu",
        ),
        " ",
      );
      result = result.replace(
        new RegExp(`\\b${location}(?![\\p{L}\\p{N}])`, "giu"),
        " ",
      );
    }
    result = result.replace(
      new RegExp(
        `\\(\\s*document\\s+ID\\s*:?\\s*${source.documentId}\\s*\\)`,
        "giu",
      ),
      " ( ) ",
    );
    // Filenames can contain years and identifiers; bare numeric titles are ambiguous.
    if (/\.[a-z0-9]{1,10}$/i.test(source.title)) {
      result = result.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${title}(?![\\p{L}\\p{N}])`, "giu"),
        " ",
      );
    } else {
      result = result.replace(
        new RegExp(
          `(^|\\n)([\\s>*•-]*\\[\\d+(?:\\s*,\\s*\\d+)*\\]\\s*)${formattedTitle}(?=\\s*(?:\\(\\s*\\))?\\s*$)`,
          "gim",
        ),
        "$1$2",
      );
    }
  }
  return result;
}

export function isReferenceOnly(
  answer: string,
  sources: SourceMetadata[],
): boolean {
  if (!answer.trim()) return true;
  const remaining = withoutSourceMetadata(answer, sources)
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/^[\s#>*-]*(?:sources?|references?|citations?)\s*:?\s*$/gim, "")
    .replace(/^\s*\d+[.)]\s*/gm, "");
  return !/[\p{L}\p{N}]/u.test(remaining);
}

/** A reference list is a valid answer when the user explicitly asks for one. */
export function asksForSourceLocations(question: string): boolean {
  return (
    /\b(?:which|what)(?:\s+(?:is|are))?\s+(?:the\s+)?(?:sources?|files?|documents?|pages?|citations?|references?)\b/i.test(
      question,
    ) ||
    /^\s*(?:list|show|give|return|where)\b.{0,45}\b(?:sources?|files?|documents?|pages?|citations?|references?)\b/i.test(
      question,
    )
  );
}
