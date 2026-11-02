// Opt-in integration regression against a disposable snapshot of a real indexed library.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Sidecar, llmArgs, embedderArgs } from "../src/main/sidecar";
import { LlamaServerLlm, LlamaServerEmbedder, type Llm } from "../src/main/llm";
import { CORE_MODEL_FILES } from "../src/main/models";
import { Store } from "../src/main/store";
import { Retriever } from "../src/main/retrieval";
import { documentTools } from "../src/main/analysis-tools";
import { ToolManager } from "../src/main/tools/manager";
import { runTurn } from "../src/main/agent";
import {
  historyEvidence,
  sourceText,
  withSourceContext,
} from "../src/main/evidence";
import {
  INCOMPLETE_ANSWER,
  UNVERIFIED,
  reviewGrounding,
  sourceIntegrityIssues,
} from "../src/main/grounding";
import { isReferenceOnly, sourceLocation } from "../src/main/source-metadata";

describe.skipIf(!process.env.DOCENT_FORUM_EVAL_SNAPSHOT)(
  "real forum question (disposable snapshot only)",
  () => {
    const servers: Sidecar[] = [];
    let store: Store, llm: Llm, retriever: Retriever;
    beforeAll(async () => {
      store = new Store(process.env.DOCENT_FORUM_EVAL_SNAPSHOT!);
      const models =
        process.env.DOCENT_MODEL_DIR ??
        join(homedir(), "Library/Application Support/Docent/models");
      const file = (id: string) =>
        join(models, CORE_MODEL_FILES.find((f) => f.id === id)!.name);
      const binary = resolve(
        `vendor/llama/${process.platform}-${process.arch}/llama-server`,
      );
      const main = new Sidecar({
        name: "Forum evaluation model",
        binary,
        args: llmArgs(file("llm"), file("mmproj")),
      });
      const embed = new Sidecar({
        name: "Forum evaluation embeddings",
        binary,
        args: embedderArgs(file("embedder")),
      });
      servers.push(main, embed);
      const [a, b] = await Promise.all([main.start(), embed.start()]);
      const client = new LlamaServerLlm(a);
      llm = {
        transcribe: client.transcribe.bind(client),
        speak: client.speak.bind(client),
        async *chat(messages, tools, signal) {
          let text = "";
          for await (const delta of client.chat(messages, tools, signal)) {
            if (delta.type === "text") text += delta.text;
            else console.log("MODEL TOOL CALLS", JSON.stringify(delta.calls));
            yield delta;
          }
          console.log("MODEL ROUND", { toolCount: tools.length, text });
        },
      };
      const embedding = new LlamaServerEmbedder(b);
      retriever = new Retriever(store, (q, signal) =>
        embedding.embedQuery(q, signal),
      );
    }, 180000);
    afterAll(() => {
      servers.forEach((s) => s.stop());
      store?.close();
    });
    it("recovers the reported source-header-only draft using the real local model", async () => {
      const sets = store
        .listSets()
        .filter((s) => /shapr3d/i.test(s.name))
        .map((s) => s.id);
      const doc = sets
        .flatMap((id) => store.documents(id))
        .find((d) => d.title === "023669-thread-tool.md")!;
      expect(doc).toBeDefined();
      const chunk = store.documentChunks(doc.id).find((c) => c.line === 202)!;
      expect(chunk).toBeDefined();
      const context = withSourceContext(store, [chunk])[0]!;
      const result = await reviewGrounding(llm, {
        question: "Who said we should support thread?",
        history: [],
        answer: `[1] ${sourceLocation(chunk)} (document ID ${chunk.documentId})`,
        sources: [{ n: 1, text: sourceText(context), metadata: chunk }],
        images: [],
        signal: AbortSignal.timeout(90000),
      });
      console.log("HEADER RECOVERY", result);
      expect(result).not.toBe(INCOMPLETE_ANSWER);
      expect(result).not.toBe(UNVERIFIED);
      expect(isReferenceOnly(result, [chunk])).toBe(false);
      expect(result).toContain("[1]");
      expect(result).not.toContain("document ID");
    }, 100000);
    it("keeps the reported date follow-up anchored to its previous source instead of switching to an unrelated quote", async () => {
      const sets = store
        .listSets()
        .filter((s) => /shapr3d/i.test(s.name))
        .map((s) => s.id);
      const saved = store
        .conversations()
        .find((c) =>
          c.messages.some(
            (m) =>
              m.text === "Who has said we should not support threads and why?",
          ),
        );
      if (!saved) return; // Older snapshots predate the follow-up regression.
      const at = saved.messages.findIndex(
        (m) => m.text === "Who has said we should not support threads and why?",
      );
      const history = saved.messages.slice(at, at + 2).map((m) => ({
        role: m.role,
        content: m.text,
        citations: m.citations,
      }));
      expect(historyEvidence(store, history, sets).length).toBeGreaterThan(0);
      const result = await runTurn(
        {
          llm,
          hasSelectedDocuments: true,
          remember: (h) => historyEvidence(store, h, sets),
          review: (input) => reviewGrounding(llm, input),
          search: (q, ids) => retriever.search(sets, q, 8, ids),
          analysis: documentTools(store, sets),
        },
        "When did he say that?",
        history,
        { speak: false, signal: AbortSignal.timeout(180000) },
        { status() {}, delta() {}, audio() {} },
      );
      console.log("REPORTED FOLLOWUP", result.text);
      expect(result.text).toMatch(/correct my previous answer/i);
      expect(result.text).not.toMatch(
        /Joseph DeRuvo|Steve Jobs|stylus|<tool_call/i,
      );
      expect(result.citations.some((c) => /023287/.test(c.title))).toBe(true);
      expect(
        sourceIntegrityIssues(
          result.text,
          result.citations.map((c) => ({ n: c.n, text: c.excerpt })),
        ),
      ).toEqual([]);
    }, 190000);
    it("answers who requested thread support with attributed, cited evidence instead of protocol text", async () => {
      const sets = store
        .listSets()
        .filter((s) => /shapr3d/i.test(s.name))
        .map((s) => s.id);
      expect(sets.length).toBeGreaterThan(0);
      let streamed = "";
      const result = await runTurn(
        {
          llm,
          hasSelectedDocuments: true,
          search: (q) => retriever.search(sets, q),
          analysis: documentTools(store, sets),
          toolkit: new ToolManager(store).agentTools({
            setIds: sets,
            documentIds: [],
          }),
        },
        "Who has requested Thread support",
        [],
        { speak: false, signal: AbortSignal.timeout(180000) },
        {
          status: (text) => console.log("STATUS", text),
          delta: (text) => {
            streamed += text;
          },
          audio() {},
        },
      );
      console.log("FORUM ANSWER", result.text);
      console.log(
        "FORUM EVIDENCE",
        result.citations
          .filter((c) => c.cited)
          .map((c) => ({ n: c.n, title: c.title, text: c.excerpt })),
      );
      expect(streamed).not.toMatch(/<\/?(?:tool_call|function|parameter)[=>]/i);
      expect(result.text).not.toMatch(
        /<\/?(?:tool_call|function|parameter)[=>]/i,
      );
      expect(result.text).toMatch(/Giovanni|Sascha|Sean|Priyank|Jonathan|BKE/i);
      expect(
        result.citations.some((c) => c.cited && /thread/i.test(c.title)),
      ).toBe(true);
    }, 190000);
  },
);
