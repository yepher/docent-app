import { describe, expect, it, vi } from "vitest";
import { AnswerStream } from "../src/main/answer-stream";
import { runTurn } from "../src/main/agent";
import type {
  ChatMessage,
  Llm,
  ToolCall,
  ToolDefinition,
} from "../src/main/llm";
import { documentTools } from "../src/main/analysis-tools";
import { Store, type StoredChunk } from "../src/main/store";

const raw =
  "<tool_call>\n<function=read_document>\n<parameter=documentId>\n16937\n</parameter>\n<parameter=offset>\n1380\n</parameter>\n<parameter=limit>\n30\n</parameter>\n</function>\n</tool_call>";
const chunk = (id: number): StoredChunk => ({
  id,
  documentId: 16937,
  text: `## Post ${id} — Author ${id}\nPlease add threads.`,
  title: "thread-tool.md",
  path: "/forum/thread-tool.md",
  setName: "Forum",
  page: null,
  line: id * 10,
});
const call = (name: string, args: object): ToolCall => ({
  id: "test-call",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
function fixture(rounds: (string | ToolCall[])[]) {
  const seen: { messages: ChatMessage[]; tools: ToolDefinition[] }[] = [];
  const spoken: string[] = [],
    output: string[] = [];
  const llm: Llm = {
    async *chat(messages, tools) {
      const next = rounds[seen.length] ?? "";
      seen.push({ messages: structuredClone(messages), tools });
      if (typeof next === "string") {
        for (const text of next) yield { type: "text", text };
      } else yield { type: "tool_calls", calls: next };
    },
    transcribe: async () => "",
    async *speak(text) {
      spoken.push(text);
      yield { samples: new ArrayBuffer(4), sampleRate: 24000 };
    },
  };
  const events = {
    status() {},
    delta(text: string) {
      output.push(text);
    },
    audio() {},
  };
  const read = vi.fn((_id: number, _offset?: number, _limit?: number) => [
    chunk(2),
  ]);
  const deps = {
    llm,
    hasSelectedDocuments: true,
    search: async () => [chunk(1)],
    analysis: { list: () => [], read, count: () => ({}), requests: () => [] },
  };
  const run = (
    history: { role: "user" | "assistant"; content: string }[] = [],
  ) =>
    runTurn(
      deps,
      "Who requested threads?",
      history,
      { speak: true, signal: new AbortController().signal },
      events,
    );
  return { run, seen, spoken, output, read, deps };
}

describe("answer stream protocol boundary", () => {
  it.each([1, 2, 7, 9999])(
    "blocks control tags across chunks of %i characters",
    (size) => {
      const stream = new AnswerStream();
      let result = "";
      for (let i = 0; i < raw.length; i += size)
        result += stream.push(raw.slice(i, i + size));
      result += stream.finish();
      expect(result).toBe("");
      expect(stream.blocked).toBe(true);
    },
  );
  it("preserves ordinary text, math, citations and HTML", () => {
    const stream = new AnswerStream();
    const text =
      "Author 1 requested threads [1]. x < 4 and y > 2. <article>Example</article>";
    expect(
      [...text].map((t) => stream.push(t)).join("") + stream.finish(),
    ).toBe(text);
    expect(stream.blocked).toBe(false);
  });
  it("suppresses incomplete control syntax and control syntax after prose", () => {
    const stream = new AnswerStream();
    expect(stream.push("I will check. <tool_ca") + stream.finish()).toBe(
      "I will check. ",
    );
    expect(stream.blocked).toBe(true);
  });
});

describe("agent final answer recovery", () => {
  it("reproduces two native calls followed by the screenshot's raw XML, then recovers without displaying or speaking it", async () => {
    const f = fixture([
      [call("search_documents", { query: "threads" })],
      [call("read_document", { documentId: 16937 })],
      raw,
      "Author 2 requested threads [2].",
    ]);
    const result = await f.run();
    expect(result.text).toBe("Author 2 requested threads [2].");
    expect(result.citations.find((c) => c.n === 2)?.cited).toBe(true);
    expect(f.output.join("")).toBe(result.text);
    expect(f.spoken).toEqual(["Author 2 requested threads."]);
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.seen).toHaveLength(4);
    for (const round of f.seen.slice(2)) {
      expect(round.tools).toEqual([]);
      expect(
        round.messages.some((m) => m.role === "tool" || m.tool_calls?.length),
      ).toBe(false);
      expect(JSON.stringify(round.messages)).toContain("Author 2");
    }
  });
  it("does not execute raw XML and gives a useful failure after one recovery attempt", async () => {
    const f = fixture([raw, raw, "This must never be reached"]);
    const result = await f.run();
    expect(f.seen).toHaveLength(2);
    expect(f.read).not.toHaveBeenCalled();
    expect(result.text).toContain("could not finish a reliable answer");
    expect(result.citations).toHaveLength(1);
    expect(f.output.join("") + f.spoken.join("")).not.toContain("tool_call");
  });
  it("refuses native calls on the final answer round as well", async () => {
    const c = call("read_document", { documentId: 16937 });
    const f = fixture([[c], [c], [c], "Author 2 requested threads [2]."]);
    expect((await f.run()).text).toContain("Author 2");
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("does not claim source evidence when a general chat cannot recover", async () => {
    const f = fixture([raw, raw]);
    f.deps.hasSelectedDocuments = false;
    const result = await f.run();
    expect(result.text).toContain("could not finish a reliable answer");
    expect(result.text).not.toContain("found source");
    expect(result.citations).toEqual([]);
  });
  it("keeps old leaked tool instructions out of assistant history", async () => {
    const f = fixture(["Author 1 requested threads [1]."]);
    await f.run([
      { role: "user", content: "Previous question" },
      { role: "assistant", content: raw },
    ]);
    expect(JSON.stringify(f.seen[0]!.messages)).not.toContain("<tool_call>");
    expect(JSON.stringify(f.seen[0]!.messages)).toContain("Previous question");
  });
  it("passes explicit passage pagination to read_document and returns existing citations again", async () => {
    const f = fixture([
      [call("read_document", { documentId: 16937, offset: 12, limit: 1 })],
      "Author 1 requested threads [1].",
    ]);
    f.read.mockReturnValue([chunk(1)]);
    await f.run();
    expect(f.read).toHaveBeenCalledWith(16937, 12, 1);
    const response = f.seen[1]!.messages.find(
      (m) => m.role === "tool",
    )!.content;
    expect(response).toContain("use offset 13");
    expect(response).toContain("[1] thread-tool.md");
  });
  it("rejects invalid pagination before invoking a document read", async () => {
    const f = fixture([
      [call("read_document", { documentId: 16937, offset: -1, limit: 30 })],
      "Insufficient evidence.",
    ]);
    await f.run();
    expect(f.read).not.toHaveBeenCalled();
  });
});

it("reads later passages within the selected scope without reading another set", () => {
  const store = new Store(":memory:");
  try {
    const set = store.createSet("Selected").id,
      privateSet = store.createSet("Private").id;
    for (const setId of [set, privateSet])
      store.saveDocument(
        {
          setId,
          path: `/manual-${setId}.md`,
          title: "Manual",
          mtimeMs: 1,
          size: 10,
          parserVersion: 3,
        },
        Array.from({ length: 30 }, (_, i) => ({
          text: `Passage ${i}`,
          page: i + 1,
          line: null,
          embedding: new Float32Array([1]),
        })),
      );
    const tools = documentTools(store, [set]);
    expect(
      tools.read(store.documents(set)[0]!.id, 20, 2).map((c) => c.text),
    ).toEqual(["Passage 20", "Passage 21"]);
    expect(tools.read(store.documents(privateSet)[0]!.id, 20, 2)).toEqual([]);
    expect(() => tools.read(store.documents(set)[0]!.id, 0, 30)).toThrow();
  } finally {
    store.close();
  }
});
