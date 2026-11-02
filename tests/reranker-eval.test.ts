import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { Sidecar, rerankerArgs, embedderArgs } from "../src/main/sidecar";
import { RERANKER_MODEL, CORE_MODEL_FILES } from "../src/main/models";
import { LlamaServerReranker } from "../src/main/reranker";
import { LlamaServerEmbedder } from "../src/main/llm";
import { Retriever, normalize } from "../src/main/retrieval";
import { Store } from "../src/main/store";

const enabled = process.env.DOCENT_REAL_RERANK_EVAL === "1";
describe.skipIf(!enabled)("real local reranker (opt in)", () => {
  const servers: Sidecar[] = [];
  let reranker: LlamaServerReranker;
  let embedder: LlamaServerEmbedder;
  beforeAll(async () => {
    const binary = resolve(
      `vendor/llama/${process.platform}-${process.arch}/llama-server`,
    );
    const rerank = new Sidecar({
      name: "Evaluation reranker",
      binary,
      args: rerankerArgs(
        join(
          process.env.DOCENT_RERANKER_MODEL_DIR ?? resolve("vendor/models"),
          RERANKER_MODEL.name,
        ),
      ),
    });
    const embed = new Sidecar({
      name: "Evaluation embeddings",
      binary,
      args: embedderArgs(
        join(
          process.env.DOCENT_MODEL_DIR ??
            join(homedir(), "Library/Application Support/docent/models"),
          CORE_MODEL_FILES.find((f) => f.id === "embedder")!.name,
        ),
      ),
    });
    servers.push(rerank, embed);
    const [r, e] = await Promise.all([rerank.start(), embed.start()]);
    reranker = new LlamaServerReranker(r);
    embedder = new LlamaServerEmbedder(e);
  }, 180000);
  afterAll(() => servers.forEach((s) => s.stop()));

  it("scores relevance rather than shared keywords, and caches identical requests", async () => {
    const query =
      "How do I restart the device without deleting my saved projects?";
    const docs = [
      "Factory reset: deletes all saved projects from the device. Choose Erase all content to reset.",
      "To restart safely, hold the power button for ten seconds. This restarts the device and keeps your saved projects intact.",
      "Export projects to another device using the Share menu.",
    ];
    const start = performance.now();
    const scores = await reranker.score(query, docs);
    console.log(
      "REAL RERANK SCORES",
      scores,
      "ms",
      Math.round(performance.now() - start),
    );
    expect(scores[1]).toBeGreaterThan(scores[0]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
    expect(await reranker.score(query, docs)).toEqual(scores);
  }, 30000);
  it("compares hybrid retrieval with reranking on a small adversarial document-QA set", async () => {
    const cases = [
      {
        q: "How can I restart the device without deleting saved projects?",
        good: "Hold the power button for ten seconds to restart safely. Your saved designs remain intact.",
        bad: [
          "Factory reset deletes all saved projects. Select Erase all content to reset the device.",
          "To delete a saved project, select it and click the trash icon.",
        ],
      },
      {
        q: "Which export format keeps solid geometry editable in another CAD program?",
        good: "Use STEP to transfer editable solid geometry between CAD applications.",
        bad: [
          "STL exports a triangular mesh for 3D printing. It does not retain editable solid geometry.",
          "PNG export creates a flat preview image of the CAD model.",
        ],
      },
      {
        q: "How do I change the displayed measurement units without resizing the model?",
        good: "Choose millimeters or inches in the Units menu. This changes measurement display without changing physical size.",
        bad: [
          "The Scale tool resizes model geometry by the entered factor.",
          "To change the overall size of a model, select all bodies and apply Scale.",
        ],
      },
      {
        q: "How can I temporarily hide a body without deleting it?",
        good: "Click the eye icon next to a body in the Items panel to hide it. Click again to show it.",
        bad: [
          "Select a body and press Delete to permanently remove it from the design.",
          "Delete hidden bodies to reduce the number of objects in your project.",
        ],
      },
      {
        q: "Can I keep working when my internet connection is unavailable?",
        good: "After sign-in, a cached license permits offline editing for seven days. Locally saved designs remain accessible.",
        bad: [
          "An internet connection is required for initial sign-in and cloud synchronization.",
          "Connect to the internet to install updates and download new models.",
        ],
      },
      {
        q: "How do I cancel renewal but keep access for the time I already paid for?",
        good: "Turn off auto-renewal in subscription settings. Access continues until the end of the paid billing period.",
        bad: [
          "Deleting your account permanently removes access and stored files immediately.",
          "To renew a subscription early, update your payment method and choose Renew.",
        ],
      },
      {
        q: "Why can the decoder not attend to tokens that come later in the sequence?",
        good: "The decoder masks future positions in self-attention so predictions depend only on earlier output tokens.",
        bad: [
          "Encoder self-attention allows each input token to attend to every other input position.",
          "Multi-head attention runs multiple attention operations in parallel.",
        ],
      },
      {
        q: "How do I recover work after the application crashes?",
        good: "On restart after a crash, open Recovery and restore the latest autosaved version of your project.",
        bad: [
          "To uninstall the application, remove it from the Applications folder.",
          "Export a finished project using the Share menu before sending it to a colleague.",
        ],
      },
      {
        q: "What is the minimum memory requirement, rather than the recommended amount?",
        good: "The application requires at least 8 GB RAM. We recommend 16 GB for large assemblies.",
        bad: [
          "For best performance, the recommended workstation has 32 GB RAM and a discrete GPU.",
          "Free storage requirements grow as more project files are saved.",
        ],
      },
      {
        q: "What should I do if the printer feeds paper but the printed page is blank?",
        good: "For blank printed pages, remove the protective tape from the new ink cartridge and run a nozzle check.",
        bad: [
          "If paper will not feed, clean the pickup rollers and remove jammed sheets.",
          "Load blank paper face down in the input tray before printing.",
        ],
      },
      {
        q: "How can I copy a project while leaving the original unchanged?",
        good: "Use Duplicate project to create an independent copy. Editing the copy does not change the original.",
        bad: [
          "Rename project changes the name of the existing project; it does not create a copy.",
          "Move project relocates the existing project to another folder.",
        ],
      },
      {
        q: "Which filter does the revised Ardent pump manual specify?",
        good: "The revised Ardent pump manual specifies replacement filter F20 with a 60-day replacement interval.",
        bad: [
          "The original Ardent pump manual specifies replacement filter F19 with a 90-day replacement interval.",
          "The Boreal pump uses replacement filter B12, changed once a year.",
        ],
      },
    ];
    const store = new Store(":memory:");
    try {
      const set = store.createSet("Retrieval evaluation").id;
      const texts = cases.flatMap((c) => [...c.bad, c.good]);
      const vectors = await embedder.embedDocuments(texts);
      texts.forEach((text, i) =>
        store.saveDocument(
          {
            setId: set,
            path: `/eval/${i}.md`,
            title: `Manual ${i}`,
            mtimeMs: 1,
            size: text.length,
            parserVersion: 3,
          },
          [{ text, page: 1, line: null, embedding: normalize(vectors[i]!) }],
        ),
      );
      const base = new Retriever(store, (q, s) => embedder.embedQuery(q, s));
      const enhanced = new Retriever(
        store,
        (q, s) => embedder.embedQuery(q, s),
        undefined,
        (q, p, signal) =>
          reranker.score(
            q,
            p.map((c) => `${c.title}\n${c.text}`),
            signal,
          ),
      );
      const rows: {
        question: string;
        before: number;
        after: number;
        ms: number;
      }[] = [];
      let fallbacks = 0;
      for (const c of cases) {
        const baseline = await base.search([set], c.q);
        const start = performance.now();
        const ranked = await enhanced.search([set], c.q, 8, [], {
          onFallback: () => {
            fallbacks++;
          },
        });
        rows.push({
          question: c.q,
          before: baseline.findIndex((p) => p.text === c.good) + 1,
          after: ranked.findIndex((p) => p.text === c.good) + 1,
          ms: Math.round(performance.now() - start),
        });
      }
      const before = rows.filter((r) => r.before === 1).length,
        after = rows.filter((r) => r.after === 1).length;
      const mrr = (key: "before" | "after") =>
        rows.reduce((sum, row) => sum + (row[key] ? 1 / row[key] : 0), 0) /
        rows.length;
      console.log(
        "REAL RETRIEVAL EVALUATION",
        JSON.stringify(
          {
            cases: rows.length,
            top1Before: before,
            top1After: after,
            mrrBefore: mrr("before"),
            mrrAfter: mrr("after"),
            averageMs: Math.round(
              rows.reduce((sum, r) => sum + r.ms, 0) / rows.length,
            ),
            fallbacks,
            rows,
          },
          null,
          2,
        ),
      );
      expect(fallbacks).toBe(0);
      expect(after).toBeGreaterThanOrEqual(before);
      expect(after).toBeGreaterThanOrEqual(9);
      expect(mrr("after")).toBeGreaterThanOrEqual(mrr("before"));
    } finally {
      store.close();
    }
  }, 180000);
});
