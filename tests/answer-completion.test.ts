import { describe, expect, it } from "vitest";
import { runTurn } from "../src/main/agent";
import { evidenceIssues } from "../src/main/citations";
import {
  INCOMPLETE_ANSWER,
  repairQuotedReferences,
  reviewGrounding,
} from "../src/main/grounding";
import {
  asksForSourceLocations,
  isReferenceOnly,
  type SourceMetadata,
} from "../src/main/source-metadata";
import type { StoredChunk } from "../src/main/store";
import type { Llm } from "../src/main/llm";

const source: StoredChunk = {
  id: 11,
  documentId: 16937,
  title: "023669-thread-tool.md",
  path: "/023669-thread-tool.md",
  setName: "Notes",
  page: null,
  line: 202,
  text: "Maya recommended adding thread support to make manufacturing easier.",
};
const header = "[1] 023669-thread-tool.md, line 202 (document ID 16937)";

describe("answer completion across document formats", () => {
  it("repairs a content number used as a citation only with unambiguous exact quote evidence", () => {
    const quote =
      "Maya recommended adding thread support to make manufacturing easier.";
    const text = `Maya said, “${quote}” [19]`;
    expect(repairQuotedReferences(text, [{ n: 1, text: quote }])).toBe(
      text.replace("[19]", "[1]"),
    );
    expect(
      repairQuotedReferences(text, [
        { n: 1, text: quote },
        { n: 2, text: quote },
      ]),
    ).toBe(text);
    expect(
      repairQuotedReferences(text, [{ n: 1, text: "An unrelated quotation" }]),
    ).toBe(text);
    expect(
      repairQuotedReferences(text, [
        { n: 19, text: "Different text" },
        { n: 1, text: quote },
      ]),
    ).toBe(text);
    expect(
      repairQuotedReferences("Maya recommended support [19]", [
        { n: 1, text: quote },
      ]),
    ).toBe("Maya recommended support [19]");
  });
  it.each([
    [header, source],
    [
      "Sources:\n- [1] 1706.03762v7.pdf, page 3 (document ID 42)",
      { title: "1706.03762v7.pdf", page: 3, line: null, documentId: 42 },
    ],
    [
      "[1] Meeting notes (document ID 2)",
      { title: "Meeting notes", page: null, line: null, documentId: 2 },
    ],
    [
      "[1] **Meeting notes** (document ID 2)",
      { title: "Meeting notes", page: null, line: null, documentId: 2 },
    ],
    [
      "[1] Guide (2023)+draft.docx, line 9",
      { title: "Guide (2023)+draft.docx", page: null, line: 9, documentId: 3 },
    ],
  ] as [string, SourceMetadata][])(
    "recognizes reference-only output: %s",
    (text, metadata) => {
      expect(isReferenceOnly(text, [metadata])).toBe(true);
      expect(
        evidenceIssues(text, new Map([[1, "Source content."]]), new Set(), [
          metadata,
        ]),
      ).toEqual([]);
    },
  );
  it.each([
    "Maya [1].",
    "202 [1].",
    "No [1].",
    "Maya recommended thread support [1].",
  ])("preserves substantive short answers: %s", (text) => {
    expect(isReferenceOnly(text, [source])).toBe(false);
  });
  it("allows explicit source requests without treating all who/what questions as lookups", () => {
    expect(
      asksForSourceLocations("Which document mentions thread support?"),
    ).toBe(true);
    expect(asksForSourceLocations("Show me the sources")).toBe(true);
    expect(asksForSourceLocations("What are the sources for that?")).toBe(true);
    expect(asksForSourceLocations("Who said we should support thread?")).toBe(
      false,
    );
    expect(asksForSourceLocations("What did Maya say?")).toBe(false);
  });
  it("does not hide a real unsupported quantity equal to a metadata number", () => {
    const result = evidenceIssues(
      "The report contains 202 requests, see 023669-thread-tool.md, line 202 (document ID 16937) [1].",
      new Map([[1, source.text]]),
      new Set(),
      [source],
    );
    expect(result).toEqual([
      "The number 202 does not appear verbatim in its cited passages; verify any calculation or interpretation.",
    ]);
    expect(
      evidenceIssues(
        "The report contains 16937 requests [1].",
        new Map([[1, source.text]]),
        new Set(),
        [source],
      )[0],
    ).toContain("16937");
    expect(
      evidenceIssues(
        "The record requires document ID 16937 [1].",
        new Map([[1, source.text]]),
        new Set(),
        [source],
      )[0],
    ).toContain("16937");
  });
});

async function run(
  repair: string,
  question = "Who said we should support thread?",
) {
  const output: string[] = [],
    spoken: string[] = [];
  let calls = 0;
  const llm: Llm = {
    async *chat(messages, tools) {
      calls++;
      if (calls > 1) {
        expect(tools).toEqual([]);
        expect(JSON.stringify(messages)).toContain(
          "does not answer the question",
        );
      }
      for (const text of calls === 1 ? header : repair)
        yield { type: "text", text };
    },
    async transcribe() {
      return "";
    },
    async *speak(text) {
      spoken.push(text);
    },
  };
  const result = await runTurn(
    {
      llm,
      search: async () => [source],
      hasSelectedDocuments: true,
      review: (input) => reviewGrounding(llm, input),
    },
    question,
    [],
    { speak: true, signal: new AbortController().signal },
    {
      status() {},
      delta(t) {
        output.push(t);
      },
      audio() {},
    },
  );
  return { result, output, spoken, calls };
}

it("retries the reported header-only answer before display or speech", async () => {
  const answer =
    "Maya recommended adding thread support to make manufacturing easier [1].";
  const { result, output, spoken, calls } = await run(answer);
  expect(calls).toBe(2);
  expect(result.text).toBe(answer);
  expect(output.join("")).toBe(answer);
  expect(spoken.join(" ")).toContain("Maya");
  expect(spoken.join(" ")).not.toContain("document ID");
  expect(result.warnings).toEqual([]);
});

it("stops after one failed repair, keeps the passages and avoids metadata warnings", async () => {
  const { result, output, calls } = await run(header);
  expect(calls).toBe(2);
  expect(result.text).toBe(INCOMPLETE_ANSWER);
  expect(output.join("")).toBe(INCOMPLETE_ANSWER);
  expect(result.citations).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

it("keeps a requested source location and does not warn about its filename or IDs", async () => {
  const { result, calls } = await run(
    "must not be requested",
    "Which source mentions thread support?",
  );
  expect(calls).toBe(1);
  expect(result.text).toBe(header);
  expect(result.warnings).toEqual([]);
});
