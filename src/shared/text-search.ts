export interface TextMatch {
  start: number;
  end: number;
}

/** Literal, case-insensitive find. Whitespace can span a line break in extracted text. */
export function textMatches(text: string, query: string): TextMatch[] {
  const words = query.trim().split(/\s+/u);
  if (!words[0]) return [];
  const pattern = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return [...text.matchAll(new RegExp(pattern, "giu"))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Reassemble each page for reading/find, removing the short tail repeated by the indexer. */
export function documentTextBlocks<
  T extends { excerpt: string; page: number | null },
>(passages: T[]): T[] {
  const blocks: T[] = [];
  passages.forEach((passage, i) => {
    const previous = passages[i - 1];
    if (!previous || previous.page !== passage.page) {
      blocks.push({ ...passage });
      return;
    }
    let text = passage.excerpt;
    for (
      let length = Math.min(
        150,
        previous.excerpt.length,
        passage.excerpt.length,
      );
      length >= 30;
      length--
    ) {
      if (previous.excerpt.endsWith(passage.excerpt.slice(0, length))) {
        text = passage.excerpt.slice(length).trimStart();
        break;
      }
    }
    if (text) blocks.at(-1)!.excerpt += `\n\n${text}`;
  });
  return blocks;
}
