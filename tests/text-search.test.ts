import { describe, expect, it } from "vitest";
import { textMatches, documentTextBlocks } from "../src/shared/text-search";

describe("citation text search", () => {
  it("finds every case-insensitive literal occurrence without interpreting regex or HTML", () => {
    const text = "A+B, a+b, aab. <script> is document text.";
    expect(
      textMatches(text, " A+B ").map((m) => text.slice(m.start, m.end)),
    ).toEqual(["A+B", "a+b"]);
    expect(textMatches(text, "<script>")).toEqual([{ start: 15, end: 23 }]);
    expect(textMatches(text, "[not regex")).toEqual([]);
    expect(textMatches(text, " ")).toEqual([]);
  });
  it("preserves offsets after Unicode characters and finds phrases across wrapped lines", () => {
    const text = "İstanbul 😀 Café. CAfÉ. Heat\n  exchanger.";
    expect(
      textMatches(text, "café").map((m) => text.slice(m.start, m.end)),
    ).toEqual(["Café", "CAfÉ"]);
    expect(
      textMatches(text, "heat exchanger").map((m) =>
        text.slice(m.start, m.end),
      ),
    ).toEqual(["Heat\n  exchanger"]);
  });
  it("does not count retrieval overlap twice or discard repeats on different PDF pages", () => {
    const tail = "The amber signal marks the ready state.";
    const passages = [
      { excerpt: `Start here. ${tail}`, page: 1 },
      { excerpt: `${tail}\n\nA second amber signal is on the panel.`, page: 1 },
      { excerpt: tail, page: 2 },
    ];
    const blocks = documentTextBlocks(passages);
    expect(blocks.map((p) => p.excerpt)).toEqual([
      passages[0]!.excerpt + "\n\nA second amber signal is on the panel.",
      tail,
    ]);
    expect(blocks.flatMap((p) => textMatches(p.excerpt, "amber"))).toHaveLength(
      3,
    );
    expect(passages[1]!.excerpt).toContain(tail);
  });
  it("finds a phrase across an indexing boundary without searching page labels", () => {
    const blocks = documentTextBlocks([
      { excerpt: "A long introduction describes a heat", page: null },
      {
        excerpt:
          "A long introduction describes a heat\n\nexchanger in the next paragraph.",
        page: null,
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(textMatches(blocks[0]!.excerpt, "heat exchanger")).toHaveLength(1);
  });
});
