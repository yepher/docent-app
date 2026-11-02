// Opt-in: use a disposable SQLite backup of the reported mixed library, never the live library.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/main/store";
import { Retriever } from "../src/main/retrieval";
import { Sidecar, llmArgs, embedderArgs } from "../src/main/sidecar";
import { LlamaServerLlm, LlamaServerEmbedder } from "../src/main/llm";
import { CORE_MODEL_FILES } from "../src/main/models";
import { runTurn } from "../src/main/agent";
import { reviewGrounding } from "../src/main/grounding";
import { documentTools } from "../src/main/analysis-tools";
import { sourceText } from "../src/main/evidence";
import { ToolManager } from "../src/main/tools/manager";
import type { ChatTurn } from "../src/shared/types";

const question = "What is a transformer";
const paper = "1706.03762v7.pdf";
const previous: ChatTurn[] = [
  { role: "user", content: "How many docs do you have access to" },
  {
    role: "assistant",
    content:
      "The sources do not provide information about the number of documents the user has access to. Therefore, this question cannot be answered based on the provided text.",
  },
];
const reportedAnswer =
  "The sources do not contain information about what a transformer is. Therefore, this question cannot be answered based on the provided text.";

describe.skipIf(!process.env.DOCENT_LIBRARY_EVAL_SNAPSHOT)(
  "mixed-library real-model regression",
  () => {
    let store: Store,
      retriever: Retriever,
      llm: LlamaServerLlm,
      manager: ToolManager;
    let sets: number[];
    const servers: Sidecar[] = [];
    beforeAll(async () => {
      const snapshot = resolve(process.env.DOCENT_LIBRARY_EVAL_SNAPSHOT!);
      if (
        snapshot ===
        join(homedir(), "Library/Application Support/docent/library.db")
      )
        throw new Error(
          "Use a disposable SQLite backup, not the live library.",
        );
      store = new Store(snapshot);
      sets = store.listSets().map((s) => s.id);
      expect(sets.length).toBeGreaterThan(1);
      expect(
        sets
          .flatMap((id) => store.documents(id))
          .some((d) => d.title === paper && d.chunkCount > 0),
      ).toBe(true);
      manager = new ToolManager(store);
      const dir =
        process.env.DOCENT_MODEL_DIR ??
        join(homedir(), "Library/Application Support/docent/models");
      const model = (id: string) =>
        join(dir, CORE_MODEL_FILES.find((m) => m.id === id)!.name);
      const binary = resolve(
        "vendor/llama/" +
          process.platform +
          "-" +
          process.arch +
          "/llama-server",
      );
      const main = new Sidecar({
        name: "Mixed-library evaluation",
        binary,
        args: llmArgs(model("llm"), model("mmproj")),
      });
      const embed = new Sidecar({
        name: "Mixed-library embeddings",
        binary,
        args: embedderArgs(model("embedder")),
      });
      servers.push(main, embed);
      const [a, b] = await Promise.all([main.start(), embed.start()]);
      llm = new LlamaServerLlm(a);
      const embedding = new LlamaServerEmbedder(b);
      // Standard search, matching the report; this must work without downloading a reranker.
      retriever = new Retriever(store, (q, signal) =>
        embedding.embedQuery(q, signal),
      );
    }, 180000);
    afterAll(() => {
      servers.forEach((s) => s.stop());
      store?.close();
    });

    it.each([false, true])(
      "answers from the paper among unrelated documents (prior refusal: %s)",
      async (withHistory) => {
        const signal = AbortSignal.timeout(120000);
        const result = await runTurn(
          {
            llm,
            search: (q, ids) => retriever.search(sets, q, 8, ids, { signal }),
            analysis: documentTools(store, sets),
            toolkit: manager.agentTools({ setIds: sets, documentIds: [] }),
            hasSelectedDocuments: true,
            review: (input) => reviewGrounding(llm, input),
          },
          question,
          withHistory ? previous : [],
          { speak: false, signal },
          { delta() {}, audio() {}, status() {} },
        );
        console.log("MIXED LIBRARY ANSWER", {
          withHistory,
          answer: result.text,
          cited: result.citations
            .filter((c) => c.cited)
            .map((c) => ({ title: c.title, page: c.page })),
        });
        expect(result.text).toMatch(/attention/i);
        expect(result.citations.some((c) => c.cited && c.title === paper)).toBe(
          true,
        );
        expect(result.text).not.toMatch(
          /sources do not contain|cannot be answered/i,
        );
      },
      180000,
    );

    it("recovers the reported uncited refusal using the local model and current evidence", async () => {
      const signal = AbortSignal.timeout(120000);
      const hits = await retriever.search(sets, question, 8, [], { signal });
      const answer = await reviewGrounding(llm, {
        question,
        history: previous,
        answer: reportedAnswer,
        sources: hits.map((chunk, i) => ({
          n: i + 1,
          text: sourceText(chunk),
          metadata: chunk,
        })),
        images: [],
        signal,
      });
      console.log("REPAIRED MIXED LIBRARY ANSWER", answer);
      const cited = [...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap(
        (m) => m[1]!.split(",").map(Number),
      );
      expect(answer).toMatch(/attention/i);
      expect(cited.some((n) => hits[n - 1]?.title === paper)).toBe(true);
      expect(answer).not.toMatch(/sources do not contain|cannot be answered/i);
    }, 180000);
  },
);
