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
import { createCanvas } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import { VisionLibrary } from "../src/main/vision";
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
  it("vision reads labeled image regions and cites the attached pixels", async () => {
    const canvas = createCanvas(1000, 400),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 1000, 400);
    ctx.fillStyle = "#2464d8";
    ctx.fillRect(50, 80, 320, 220);
    ctx.fillStyle = "#168848";
    ctx.fillRect(630, 80, 320, 220);
    ctx.fillStyle = "white";
    ctx.font = "bold 48px sans-serif";
    ctx.fillText("FILTER", 105, 205);
    ctx.fillText("PUMP", 710, 205);
    ctx.strokeStyle = "black";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(395, 190);
    ctx.lineTo(605, 190);
    ctx.lineTo(570, 160);
    ctx.moveTo(605, 190);
    ctx.lineTo(570, 220);
    ctx.stroke();
    const library = new VisionLibrary(s);
    const selection = await library.attach(
      Uint8Array.from(canvas.toBuffer("image/png")).buffer,
      "flow-diagram.png",
    );
    const result = await runTurn(
      {
        llm,
        hasSelectedDocuments: false,
        search: async () => [],
        vision: { initial: [await library.prepare(selection.source)] },
      },
      "What word is inside the blue box, what word is inside the green box, and which way does the arrow point? Cite the image.",
      [],
      { speak: false, signal: AbortSignal.timeout(90000) },
      { status() {}, delta() {}, audio() {} },
    );
    console.log("REAL MODEL VISION:", result.text);
    expect(result.text).toMatch(/filter/i);
    expect(result.text).toMatch(/pump/i);
    expect(result.text).toMatch(/right|filter to (?:the )?pump/i);
    expect(result.citations[0]?.cited).toBe(true);
    expect(result.citations[0]?.visual).toEqual(selection.source);
  }, 100000);
  it.skipIf(!process.env.DOCENT_VISION_SCREENSHOT)(
    "vision reads the version from a real screenshot",
    async () => {
      const library = new VisionLibrary(s);
      const selection = await library.attach(
        Uint8Array.from(readFileSync(process.env.DOCENT_VISION_SCREENSHOT!))
          .buffer,
        "installer-screenshot.png",
      );
      const result = await runTurn(
        {
          llm,
          hasSelectedDocuments: false,
          search: async () => [],
          vision: { initial: [await library.prepare(selection.source)] },
        },
        "What Docent version number is shown in the installer window title? Cite the image.",
        [],
        { speak: false, signal: AbortSignal.timeout(90000) },
        { status() {}, delta() {}, audio() {} },
      );
      console.log("REAL MODEL SCREENSHOT:", result.text);
      expect(result.text).toContain("0.1.0");
      expect(result.citations[0]?.cited).toBe(true);
    },
    100000,
  );
  it.skipIf(!process.env.DOCENT_ATTENTION_PDF)(
    "vision inspects the research paper's architecture figure through the native tool",
    async () => {
      const papers = s.createSet("Visual research paper").id;
      s.addSource(papers, process.env.DOCENT_ATTENTION_PDF!);
      await indexSet(s, embedder, papers, () => {});
      const doc = s.documents(papers)[0]!;
      const library = new VisionLibrary(s);
      let inspected = false;
      const result = await runTurn(
        {
          llm,
          hasSelectedDocuments: true,
          search: async () =>
            s
              .documentChunks(doc.id)
              .filter((c) => c.page === 3)
              .slice(0, 3),
          analysis: documentTools(s, [papers]),
          vision: {
            initial: [],
            inspect: async (documentId, page, signal) => {
              inspected = true;
              return library.prepare({ documentId, page }, signal, [doc.id]);
            },
          },
        },
        `Use inspect_document_page to look at document ID ${doc.id}, page 3. In Figure 1, which side is the encoder and which side is the decoder? Cite the visual source.`,
        [],
        { speak: false, signal: AbortSignal.timeout(90000) },
        { status() {}, delta() {}, audio() {} },
      );
      console.log("REAL MODEL PDF VISION:", result.text);
      expect(inspected).toBe(true);
      expect(result.text).toMatch(/encoder/i);
      expect(result.text).toMatch(/decoder/i);
      expect(result.text).toMatch(/left/i);
      expect(result.text).toMatch(/right/i);
      expect(
        result.citations.some(
          (c) => c.visual && c.cited && c.documentId === doc.id && c.page === 3,
        ),
      ).toBe(true);
    },
    180000,
  );
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
