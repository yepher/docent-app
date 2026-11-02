import { describe, expect, it } from "vitest";
import {
  attributedRequests,
  findRequesters,
  requesterTerms,
} from "../src/main/forum-requests";
import { Store } from "../src/main/store";

const posts = `# Thread Tool

## Post 1 — Alice
- Posted: 2024-01-01
- Source: https://example.test/thread/1
<p>Please add a thread tool for bolts.</p>

## Post 2 — Staff
<aside class="quote"><blockquote>Please add a thread tool for bolts.</blockquote></aside>
<p>Threads are planned but we have no release date.</p>

## Post 3 — Bob
<p>+1 for the feature request</p>

## Post 4 — Carol
<p>I would love threads for screws.</p>

## Post 5 — Dana
<aside class="quote"><blockquote><aside>+1 for thread tool</aside></blockquote></aside>
<p>I use a workaround instead.</p>

## Post 6 — Alice
<p>Another vote for threads.</p>`;

describe("attributed forum requests", () => {
  it("recognizes the reported question without hardcoding its topic", () => {
    expect(requesterTerms("Who has requested Thread support")).toEqual([
      "thread",
      "threads",
    ]);
    expect(requesterTerms("Which users asked for animation tools?")).toEqual([
      "animation",
      "animations",
    ]);
    expect(requesterTerms("Who wrote the paper?")).toBeNull();
    expect(requesterTerms("Who requested this?")).toBeNull();
  });
  it("associates a request with its own author and excludes quotations and staff replies", () => {
    const result = attributedRequests(posts, "023669-thread-tool.md", [
      "thread",
      "threads",
    ]);
    expect(result.map((r) => r.author)).toEqual([
      "Alice",
      "Bob",
      "Carol",
      "Alice",
    ]);
    expect(result[0]!.quote).toBe("Please add a thread tool for bolts.");
    expect(result[0]!.line).toBe(3);
    expect(result[0]!.excerpt).toContain("Post 1 — Alice");
  });
  it("does not assign a vague endorsement from a general discussion to a specific feature", () => {
    expect(
      attributedRequests(posts, "Any feature ideas", ["thread", "threads"]).map(
        (r) => r.author,
      ),
    ).not.toContain("Bob");
  });
  it("excludes Markdown quotations and unterminated quoted content", () => {
    expect(
      attributedRequests(
        "## Post 1 — Staff\n> Please add threads.\nThis is a quote.",
        "Thread tool",
        ["threads"],
      ),
    ).toEqual([]);
    expect(
      attributedRequests(
        "## Post 1 — Staff\n<aside>Please add threads.",
        "Thread tool",
        ["threads"],
      ),
    ).toEqual([]);
  });
  it("excludes staff clarification, workaround narration and need for help", () => {
    for (const text of [
      "What I’d like to understand is why you need the threads to be modeled.",
      "I use the database to download the size of the thread I need, then import it.",
      "I need M6 threads and I don’t know how to make them.",
      "I don’t want a thread tool.",
    ]) {
      expect(
        attributedRequests(`## Post 1 — Example\n${text}`, "Thread tool", [
          "thread",
          "threads",
        ]),
      ).toEqual([]);
    }
  });
  it("requires every feature word, allowing singular and plural variants", () => {
    expect(
      attributedRequests(
        "## Post 1 — Example\nPlease add a mode tool.",
        "Mode tool",
        ["dark", "darks", "mode", "modes"],
      ),
    ).toEqual([]);
  });
  it("does not count an off-topic endorsement inside a feature discussion", () => {
    expect(
      attributedRequests(
        "## Post 1 — Example\nAnother vote for animation tools.",
        "Thread tool",
        ["thread", "threads"],
      ),
    ).toEqual([]);
  });
  it("uses saved originals, deduplicates display names and respects both set and document scope", async () => {
    const store = new Store(":memory:");
    try {
      const set = store.createSet("Selected").id,
        other = store.createSet("Private").id;
      for (const [setId, text] of [
        [set, posts],
        [other, posts.replaceAll("Alice", "Secret Person")],
      ] as const)
        store.saveDocument(
          {
            setId,
            title: "thread-tool.md",
            path: `/forum-${setId}.md`,
            version: `version-${setId}`,
            bytes: Buffer.from(text),
            mtimeMs: 1,
            size: text.length,
            parserVersion: 3,
          },
          [{ text, page: null, line: 1, embedding: new Float32Array([1]) }],
        );
      const allowed = store.documents(set)[0]!.id,
        forbidden = store.documents(other)[0]!.id;
      const result = await findRequesters(
        store,
        [set],
        [allowed],
        "Who has requested Thread support",
      );
      expect(result?.examples.map((e) => e.author)).toEqual([
        "Alice",
        "Bob",
        "Carol",
      ]);
      expect(
        result?.examples.every(
          (e) =>
            e.chunk.documentId === allowed &&
            e.chunk.version === `version-${set}`,
        ),
      ).toBe(true);
      expect(new Set(result?.examples.map((e) => e.chunk.id)).size).toBe(3);
      expect(
        await findRequesters(
          store,
          [set],
          [forbidden],
          "Who has requested Thread support",
        ),
      ).toBeNull();
      await expect(
        findRequesters(
          store,
          [set],
          [],
          "Who has requested Thread support",
          AbortSignal.abort(),
        ),
      ).rejects.toThrow();
    } finally {
      store.close();
    }
  });
});
