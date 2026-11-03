import { describe, expect, it } from "vitest";
import {
  groupVisualEvidence,
  mergeVisualCitations,
  visualReadingWarnings,
  type NumberedSource,
} from "../src/main/visual-evidence";
import { citationExtraction } from "../src/shared/vision";

const ocr: NumberedSource = {
  n: 2,
  chunk: {
    id: 10,
    documentId: 7,
    title: "note.png",
    path: "/note.png",
    setName: "Notes",
    version: "v1",
    page: null,
    line: 1,
    text: "Image: note.png\nHansen Hom Tuspections\n620 661-0097",
  },
};
const pixels: NumberedSource = {
  n: 1,
  chunk: {
    ...ocr.chunk,
    id: -1,
    line: null,
    text: "Original image supplied",
    visual: { documentId: 7, version: "v1" },
    extraction: { kind: "ocr", text: "Hansen Hom Tuspections\n620 661-0097" },
  },
};

describe("image and extracted-text evidence", () => {
  it("combines the exact image version without discarding its extracted text or context", () => {
    const extra = {
      ...ocr,
      n: 3,
      chunk: {
        ...ocr.chunk,
        id: 11,
        text: "More writing",
        context: [
          {
            text: "Adjacent writing",
            page: null,
            line: 5,
            position: "after" as const,
          },
        ],
      },
    };
    const grouped = groupVisualEvidence([pixels, ocr, extra]);
    expect(grouped.sources).toHaveLength(1);
    expect(grouped.aliases).toEqual(
      new Map([
        [2, 1],
        [3, 1],
      ]),
    );
    expect(grouped.sources[0]!.chunk.extraction?.text).toContain(
      "620 661-0097",
    );
    expect(grouped.sources[0]!.chunk.extraction?.text).toContain(
      "Adjacent writing",
    );
    expect(grouped.sources[0]!.chunk.extraction?.text).not.toContain(
      "Image: note.png",
    );
  });
  it("never treats extracted text as visual evidence without pixels of the same document/version/page", () => {
    expect(groupVisualEvidence([ocr]).aliases.size).toBe(0);
    for (const changes of [
      { documentId: 8 },
      { version: "v2" },
      { version: undefined },
      { page: 2 },
    ]) {
      expect(
        groupVisualEvidence([
          pixels,
          { ...ocr, chunk: { ...ocr.chunk, ...changes } },
        ]).aliases.size,
      ).toBe(0);
    }
    const page = {
      ...pixels,
      chunk: {
        ...pixels.chunk,
        path: "/manual.pdf",
        page: 3,
        visual: { documentId: 7, version: "v1", page: 3 },
      },
    };
    expect(
      groupVisualEvidence([
        page,
        { ...ocr, chunk: { ...ocr.chunk, page: 3 } },
      ]).aliases.get(2),
    ).toBe(1);
    expect(
      groupVisualEvidence([page, { ...ocr, chunk: { ...ocr.chunk, page: 4 } }])
        .aliases.size,
    ).toBe(0);
    expect(
      groupVisualEvidence([
        {
          ...pixels,
          chunk: {
            ...pixels.chunk,
            documentId: 0,
            visual: { attachmentId: "hash" },
          },
        },
        ocr,
      ]).aliases.size,
    ).toBe(0);
  });
  it("merges duplicate references without touching code or unrelated numbers", () => {
    expect(
      mergeVisualCitations(
        "The number [2, 1, 3]. `a[2]`\n```js\na[2]\n```",
        new Map([[2, 1]]),
      ),
    ).toBe("The number [1, 3]. `a[2]`\n```js\na[2]\n```");
  });
  it("reports one clear text-comparison notice for wrong OCR digits and quoted wording", () => {
    const answer =
      'The phone number is **630 661-0897** [1]. It reads "Hansen Home Inspections" [1].';
    const warnings = visualReadingWarnings(answer, [pixels]);
    expect(warnings.size).toBe(1);
    expect(warnings.get(1)).toContain("630 661-0897");
    expect(warnings.get(1)).toContain("automatic text extraction (OCR)");
    expect(warnings.get(1)).toContain("either reading may be mistaken");
    expect(
      visualReadingWarnings('It reads "Hansen Home Inspections" [1].', [pixels])
        .size,
    ).toBe(1);
  });
  it("ignores formatting differences, code, absent OCR, and values supported by another cited source", () => {
    expect(
      visualReadingWarnings("The number is 620-661-0097 [1].", [pixels]).size,
    ).toBe(0);
    expect(visualReadingWarnings("There are 2 boxes [1].", [pixels]).size).toBe(
      0,
    );
    expect(
      visualReadingWarnings("`12345` [1]\n```\n99999 [1]\n```", [pixels]).size,
    ).toBe(0);
    expect(
      visualReadingWarnings("The number is 630 661-0897 [1].", [
        { ...pixels, chunk: { ...pixels.chunk, extraction: undefined } },
      ]).size,
    ).toBe(0);
    const other = {
      ...ocr,
      n: 3,
      chunk: { ...ocr.chunk, documentId: 8, text: "Phone 630 661-0897" },
    };
    expect(
      visualReadingWarnings("The number is 630 661-0897 [1, 3].", [
        pixels,
        other,
      ]).size,
    ).toBe(0);
    expect(
      visualReadingWarnings("The number is 630 661-0897 [3].", [pixels, other])
        .size,
    ).toBe(0);
  });
  it("labels old saved visual and OCR-only citations without claiming their images were inspected", () => {
    const citation = {
      ...pixels.chunk,
      excerpt:
        "Visual evidence: image.\nExtracted text (may be incomplete):\nImage: note.png\n620 661-0097",
      extraction: undefined,
    };
    expect(citationExtraction(citation)).toEqual({
      kind: "ocr",
      text: "620 661-0097",
    });
    expect(
      citationExtraction({ ...ocr.chunk, excerpt: ocr.chunk.text })?.kind,
    ).toBe("ocr");
    expect(citationExtraction({ ...citation, page: 1 })?.kind).toBe(
      "document-text",
    );
  });
});
