import { describe, expect, it } from "vitest";
import { chunkSegments, type Segment } from "../src/main/ingest/chunk";
import { asksForReferences, numberedReferences } from "../src/main/references";
import { Store } from "../src/main/store";
import { documentTools } from "../src/main/analysis-tools";
import { runTurn } from "../src/main/agent";
import type { Llm } from "../src/main/llm";

const stored = (segments: Segment[]) =>
  chunkSegments(segments).map((c, i) => ({
    ...c,
    id: i + 1,
    documentId: 1,
    title: "Paper",
    path: "/paper.pdf",
    setName: "Papers",
  }));

describe("bibliography evidence", () => {
  it("recognizes a bibliography question, not ordinary research questions", () => {
    expect(asksForReferences("What other research is referenced")).toBe(true);
    expect(asksForReferences("List the references in this paper")).toBe(true);
    expect(asksForReferences("What are the research findings?")).toBe(false);
  });

  it("preserves entries spanning overlapping chunks and PDF pages, stopping before the appendix", () => {
    const long =
      "Author One. " + "A long title with important evidence. ".repeat(40);
    const entries = numberedReferences(
      stored([
        { page: 10, text: `Conclusion.\nReferences\n[1] ${long}\n10` },
        {
          page: 11,
          text: "Journal continuation, 2016.\n[2] Author Two. Another paper. 2017.\n11",
        },
        {
          page: 12,
          text: "Attention visualizations\nFigure 5. This is not a reference.",
        },
      ]),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe(long + "Journal continuation, 2016.");
    expect(entries[0]!.chunks.length).toBeGreaterThan(1);
    expect(new Set(entries[0]!.chunks.map((c) => c.page))).toEqual(
      new Set([10, 11]),
    );
    expect(entries[1]!.text).toBe("Author Two. Another paper. 2017.");
    expect(entries.flatMap((e) => e.chunks).every((c) => c.page !== 12)).toBe(
      true,
    );
  });

  it("does not mistake inline citations or incomplete numbering for a bibliography", () => {
    expect(
      numberedReferences(
        stored([{ page: 1, text: "Prior research [1] disagrees with [2]." }]),
      ),
    ).toEqual([]);
    expect(
      numberedReferences(
        stored([
          {
            page: 1,
            text: "References\n[1] Author. First.\n[3] Author. Third.",
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("stops at a same-page appendix heading", () => {
    const entries = numberedReferences(
      stored([
        {
          page: null,
          text: "## References\n[1] Author. First.\n[2] Author. Second.\n## Appendix\nUnrelated content.",
        },
      ]),
    );
    expect(entries[1]!.text).toBe("Author. Second.");
  });

  it("extracts only selected documents and creates passage citations without generating bibliography facts", async () => {
    const store = new Store(":memory:");
    try {
      const forum = store.createSet("Forum").id;
      const papers = store.createSet("Papers").id;
      for (const [setId, name] of [
        [forum, "Unselected"],
        [papers, "Selected"],
      ] as const) {
        store.saveDocument(
          {
            setId,
            path: `/${name}.pdf`,
            title: name,
            mtimeMs: 1,
            size: 1,
            parserVersion: 3,
          },
          [
            {
              page: 10,
              line: null,
              text: `References\n[1] ${name} Author. First work.\n[2] ${name} Author. Second work.`,
              embedding: new Float32Array([1, 0]),
            },
          ],
        );
      }
      const docs = documentTools(store, [papers]);
      expect(
        documentTools(
          store,
          [papers],
          [store.documents(forum)[0]!.id],
        ).references(),
      ).toEqual([]);
      const llm = {
        chat: () => {
          throw new Error("Reference facts must be extracted, not generated.");
        },
      } as unknown as Llm;
      const result = await runTurn(
        {
          llm,
          hasSelectedDocuments: true,
          search: async () => {
            throw new Error("No broad search needed");
          },
          analysis: docs,
        },
        "What other research is referenced",
        [],
        { speak: false, signal: new AbortController().signal },
        { delta() {}, status() {}, audio() {} },
      );
      expect(result.text).toContain("2 numbered bibliography entries");
      expect(result.text).toContain("2. Selected Author. Second work. [1]");
      expect(result.text).not.toContain("Unselected");
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]!.page).toBe(10);
      expect(result.citations[0]!.cited).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      store.close();
    }
  });
});
