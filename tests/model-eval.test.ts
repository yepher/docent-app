import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Sidecar, llmArgs, embedderArgs } from "../src/main/sidecar";
import { LlamaServerLlm, LlamaServerEmbedder } from "../src/main/llm";
import { MODEL_FILES } from "../src/main/models";
import { Store } from "../src/main/store";
import { Retriever, normalize } from "../src/main/retrieval";
import { documentTools, requestExamples } from "../src/main/analysis-tools";
import { runTurn } from "../src/main/agent";
import { indexSet } from "../src/main/ingest";
import { ToolManager } from "../src/main/tools/manager";
const enabled = process.env.DOCENT_REAL_MODEL_EVAL === "1";
describe.skipIf(!enabled)("real local model evaluation (opt in)", () => {
  let s: Store;
  let llm: LlamaServerLlm;
  let retriever: Retriever;
  let embedder: LlamaServerEmbedder;
  let setId: number;
  const servers: Sidecar[] = [];
  beforeAll(async () => {
    const dir =
      process.env.DOCENT_MODEL_DIR ??
      join(homedir(), "Library/Application Support/docent/models");
    const file = (id: string) =>
      join(dir, MODEL_FILES.find((f) => f.id === id)!.name);
    const binary = resolve(
      `vendor/llama/${process.platform}-${process.arch}/llama-server`,
    );
    const main = new Sidecar({
      name: "Evaluation model",
      binary,
      args: llmArgs(file("llm"), file("mmproj")),
    });
    const embed = new Sidecar({
      name: "Evaluation embeddings",
      binary,
      args: embedderArgs(file("embedder")),
    });
    servers.push(main, embed);
    const [a, b] = await Promise.all([main.start(), embed.start()]);
    llm = new LlamaServerLlm(a);
    embedder = new LlamaServerEmbedder(b);
    s = new Store(":memory:");
    setId = s.createSet("Evaluation manuals").id;
    const texts = [
      "The Ardent pump uses replacement filter F19. Replace it every 90 days.",
      "The revised Ardent pump manual specifies filter F20. Replace it every 60 days.",
    ];
    const vectors = await embedder.embedDocuments(texts);
    texts.forEach((text, i) =>
      s.saveDocument(
        {
          setId,
          path: `/eval/manual-${i}.txt`,
          title: i ? "Revised manual" : "Original manual",
          mtimeMs: 1,
          size: text.length,
          parserVersion: 3,
        },
        [{ text, page: null, line: 1, embedding: normalize(vectors[i]!) }],
      ),
    );
    retriever = new Retriever(s, (q) => embedder.embedQuery(q));
  }, 180000);
  afterAll(() => {
    servers.forEach((x) => x.stop());
    s?.close();
  });
  it("retrieves both versions and cites a cross-document comparison", async () => {
    const result = await runTurn(
      {
        llm,
        search: (q) => retriever.search([setId], q),
        hasSelectedDocuments: true,
      },
      "Compare the replacement filter and maintenance intervals in the original and revised Ardent pump manuals.",
      [],
      { speak: false, signal: AbortSignal.timeout(90000) },
      { status() {}, delta() {}, audio() {} },
    );
    console.log("REAL MODEL COMPARISON:", result.text);
    expect(result.text).toContain("F19");
    expect(result.text).toContain("F20");
    expect(
      result.citations.filter((c) => c.cited).length,
    ).toBeGreaterThanOrEqual(2);
  }, 100000);
  it("chooses an enabled script to count documents and retains its evidence record", async () => {
    const manager = new ToolManager(s);
    const result = await runTurn(
      {
        llm,
        hasSelectedDocuments: true,
        search: (q) => retriever.search([setId], q),
        analysis: documentTools(s, [setId]),
        toolkit: manager.agentTools({ setIds: [setId], documentIds: [] }),
      },
      "Use the Count documents mentioning a phrase tool to count selected documents containing the literal phrase filter. Report the count and source evidence.",
      [],
      { speak: false, signal: AbortSignal.timeout(90000) },
      { status() {}, delta() {}, audio() {} },
    );
    console.log(
      "REAL MODEL SCRIPT CALL:",
      result.text,
      result.toolRuns?.map((r) => ({
        key: r.toolKey,
        status: r.status,
        input: r.input,
      })),
    );
    expect(
      result.toolRuns?.some(
        (r) =>
          r.toolKey === "bundled:count-mentions" &&
          r.status === "succeeded" &&
          r.input.phrase === "filter",
      ),
    ).toBe(true);
    expect(result.text).toMatch(/\b(2|two)\b/i);
    expect(result.citations.filter((c) => c.cited)).toHaveLength(2);
    for (const filter of ["F19", "F20"]) {
      const source = result.citations.find((c) => c.excerpt.includes(filter))!;
      const claim = result.text
        .split("\n")
        .find((line) => line.includes(filter));
      if (claim) expect(claim).toContain(`[${source.n}]`);
    }
  }, 100000);

  it("proposes auditable feature rules for explicit requests", async () => {
    const rows = [
      "Please add a dedicated thread tool for screws.",
      "It would be nice to have a thread tool for bolts.",
      "Please add animation tools for moving model parts.",
      "I would love to have animation tools for assemblies.",
    ].map((text, i) => ({
      id: 100 + i,
      documentId: 100 + i,
      title: `Thread ${i}`,
      path: `/forum/${i}`,
      setName: "Requests",
      page: null,
      line: 1,
      text,
    }));
    const result = await runTurn(
      {
        llm,
        hasSelectedDocuments: true,
        search: async () => rows,
        analysis: {
          list: () => [],
          read: () => [],
          count: () => ({}),
          requests: () => requestExamples(rows),
        },
      },
      "What are the most common feature requests?",
      [],
      { speak: false, signal: AbortSignal.timeout(90000) },
      { status() {}, delta() {}, audio() {} },
    );
    console.log("REAL MODEL FEATURE RULES:", result.text);
    expect(result.text).toContain("Matched phrases:");
    expect(result.text).toContain("2 matching documents");
    expect(result.citations.some((c) => c.cited)).toBe(true);
  }, 100000);

  // Opt-in fixture: the user's Attention Is All You Need PDF, kept outside the repo.
  it.skipIf(!process.env.DOCENT_ATTENTION_PDF)(
    "answers the reported research question from the selected PDF",
    async () => {
      const papers = s.createSet("Research paper").id;
      s.addSource(papers, process.env.DOCENT_ATTENTION_PDF!);
      await indexSet(s, embedder, papers, () => {});
      expect(s.documents(papers)[0]!.chunkCount).toBeGreaterThan(20);
      const result = await runTurn(
        {
          llm,
          search: (q) => retriever.search([papers], q),
          analysis: documentTools(s, [papers]),
          toolkit: new ToolManager(s).agentTools({
            setIds: [papers],
            documentIds: [],
          }),
          hasSelectedDocuments: true,
        },
        "What other research is referenced",
        [],
        { speak: false, signal: AbortSignal.timeout(90000) },
        { status() {}, delta() {}, audio() {} },
      );
      console.log("REAL MODEL PAPER REFERENCES:", result.text);
      console.log(
        "CITED PAGES:",
        result.citations.filter((c) => c.cited).map((c) => c.page),
      );
      expect(result.text).toMatch(
        /layer normalization|neural machine translation|sequence.to.sequence/i,
      );
      expect(result.text).toContain("40 numbered bibliography entries");
      expect(result.toolRuns?.[0]?.toolKey).toBe("bundled:bibliography");
      expect(result.text).toContain(
        "37. Vinyals & Kaiser, Koo, Petrov, Sutskever, and Hinton. Grammar as a foreign language.",
      );
      expect(result.text).not.toMatch(
        /no (?:specific )?research|feature requests|roadmap/i,
      );
      expect(
        result.citations.some(
          (c) => c.cited && c.page !== null && c.page >= 10 && c.page <= 12,
        ),
      ).toBe(true);
      expect(
        result.citations.every(
          (c) =>
            c.path === process.env.DOCENT_ATTENTION_PDF &&
            c.page !== null &&
            c.page >= 10 &&
            c.page <= 12,
        ),
      ).toBe(true);
    },
    180000,
  );
});
