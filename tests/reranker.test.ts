import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LlamaServerReranker,
  parseRerankScores,
  RERANK_CANDIDATES,
} from "../src/main/reranker";
import { Retriever, type Rerank } from "../src/main/retrieval";
import { Store } from "../src/main/store";
import {
  CORE_MODEL_FILES,
  MODEL_FILES,
  RERANKER_MODEL,
} from "../src/main/models";

const dbs: Store[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  dbs.splice(0).forEach((s) => s.close());
});
const endpoint = { baseUrl: "http://127.0.0.1:9999", apiKey: "test-secret" };
function fixture() {
  const store = new Store(":memory:");
  dbs.push(store);
  const setId = store.createSet("Selected manuals").id;
  const add = (title: string, texts: string[], set = setId) => {
    store.saveDocument(
      {
        setId: set,
        title,
        path: `/${set}/${title}.md`,
        parserVersion: 3,
        mtimeMs: 1,
        size: 10,
        version: `${title}-v1`,
      },
      texts.map((text, i) => ({
        text,
        page: i + 1,
        line: null,
        embedding: new Float32Array([1, 0]),
      })),
    );
    return store.documents(set).find((d) => d.title === title)!.id;
  };
  const retriever = (rerank?: Rerank) =>
    new Retriever(
      store,
      async () => new Float32Array([1, 0]),
      undefined,
      rerank,
    );
  return { store, setId, add, retriever };
}

describe("local reranker client", () => {
  it("maps out-of-order response indices to the supplied passages and authenticates locally", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const scores = await new LlamaServerReranker(endpoint).score("question", [
      "A",
      "B",
    ]);
    expect(scores).toEqual([0.1, 0.9]);
    const [url, req] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${endpoint.baseUrl}/v1/rerank`);
    expect(req.headers).toMatchObject({ authorization: "Bearer test-secret" });
    expect(JSON.parse(req.body as string)).toEqual({
      query: "question",
      documents: ["A", "B"],
      top_n: 2,
    });
  });
  it.each([
    { results: [] },
    {
      results: [
        { index: 0, relevance_score: 0.5 },
        { index: 0, relevance_score: 0.7 },
      ],
    },
    {
      results: [
        { index: 0, relevance_score: 0.5 },
        { index: 2, relevance_score: 0.7 },
      ],
    },
    {
      results: [
        { index: 0, relevance_score: "0.5" },
        { index: 1, relevance_score: 0.7 },
      ],
    },
    {
      results: [
        { index: 0, relevance_score: NaN },
        { index: 1, relevance_score: 0.7 },
      ],
    },
    {
      results: [
        { index: 0, relevance_score: 2 },
        { index: 1, relevance_score: 0.7 },
      ],
    },
  ])(
    "rejects malformed scores instead of losing source identity: %j",
    (body) => {
      expect(() => parseRerankScores(body, 2)).toThrow();
    },
  );
  it("caches scores by query and exact candidate content, returning copies", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ results: [{ index: 0, relevance_score: 0.8 }] }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new LlamaServerReranker(endpoint);
    const first = await client.score("q", ["original"]);
    first[0] = 0;
    expect(await client.score("q", ["original"])).toEqual([0.8]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.score("q", ["revised"]);
    await client.score("different q", ["revised"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("times out and aborts the HTTP request", async () => {
    let requestSignal: AbortSignal;
    vi.stubGlobal(
      "fetch",
      (_url: string, req: RequestInit) =>
        new Promise((_resolve, reject) => {
          requestSignal = req.signal as AbortSignal;
          requestSignal.addEventListener(
            "abort",
            () => reject(requestSignal.reason),
            { once: true },
          );
        }),
    );
    await expect(
      new LlamaServerReranker(endpoint, 20).score("q", ["doc"]),
    ).rejects.toThrow();
    expect(requestSignal!.aborted).toBe(true);
  });
  it("respects Stop before starting a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new LlamaServerReranker(endpoint).score(
        "q",
        ["doc"],
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects an oversized batch and reports HTTP failures", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const client = new LlamaServerReranker(endpoint);
    await expect(
      client.score("q", new Array(RERANK_CANDIDATES + 1).fill("doc")),
    ).rejects.toThrow("budget");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.score("q", ["doc"])).rejects.toThrow("503");
  });
  it("keeps the relevance model optional for existing installations and pins its integrity", () => {
    expect(CORE_MODEL_FILES).toHaveLength(3);
    expect(MODEL_FILES).toHaveLength(4);
    expect(CORE_MODEL_FILES).not.toContain(RERANKER_MODEL);
    expect(RERANKER_MODEL.url).toMatch(/\/resolve\/[a-f0-9]{40}\//);
    expect(RERANKER_MODEL.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("reranked retrieval", () => {
  it("promotes relevant passages even when both come from one document, keeping locations and versions", async () => {
    const { add, retriever, setId } = fixture();
    add("Distractor", ["Reset means erasing projects."]);
    const wanted = add("Manual", [
      "Keep projects using a safe restart.",
      "Hold the power button for ten seconds.",
    ]);
    const score = vi.fn<Rerank>(async (_q, passages) =>
      passages.map((p) =>
        p.documentId === wanted ? (p.page === 1 ? 0.99 : 0.98) : 0.01,
      ),
    );
    const hits = await retriever(score).search([setId], "reset projects", 2);
    expect(hits.map((h) => h.documentId)).toEqual([wanted, wanted]);
    expect(hits.map((h) => h.page)).toEqual([1, 2]);
    expect(hits[0]!.version).toBe("Manual-v1");
  });
  it("never sends unselected sets or documents to the relevance model", async () => {
    const { store, add, retriever, setId } = fixture();
    const allowed = add("Visible", [
      "Visible passage one.",
      "Visible passage two.",
    ]);
    add("Unselected document", ["PRIVATE_A"]);
    add("Unselected set", ["PRIVATE_B"], store.createSet("Private").id);
    const score = vi.fn<Rerank>(async (_q, p) => p.map(() => 0.5));
    const hits = await retriever(score).search([setId], "passage", 8, [
      allowed,
    ]);
    expect(score).toHaveBeenCalledOnce();
    expect(score.mock.calls[0]![1].every((p) => p.documentId === allowed)).toBe(
      true,
    );
    expect(hits.every((p) => p.documentId === allowed)).toBe(true);
  });
  it("bounds the batch before reranking and selects the final passages afterward", async () => {
    const { add, retriever, setId } = fixture();
    for (let i = 0; i < 45; i++) add(`File ${i}`, [`Distinct passage ${i}.`]);
    const score = vi.fn<Rerank>(async (_q, p) => p.map((_, i) => i / p.length));
    const hits = await retriever(score).search([setId], "passage", 3);
    const supplied = score.mock.calls[0]![1];
    expect(supplied).toHaveLength(30);
    expect(hits.map((h) => h.id)).toEqual(
      supplied
        .slice(-3)
        .reverse()
        .map((h) => h.id),
    );
  });
  it.each(["missing", "failure", "malformed"])(
    "falls back without dropping evidence when the reranker is %s",
    async (kind) => {
      const { add, retriever, setId } = fixture();
      add("One", ["Passage alpha."]);
      add("Two", ["Passage beta."]);
      const baseline = await retriever().search([setId], "passage");
      const onFallback = vi.fn();
      const result = await retriever(async () => {
        if (kind === "missing") return null;
        if (kind === "malformed") return [NaN];
        throw new Error("Unavailable");
      }).search([setId], "passage", 8, [], { onFallback });
      expect(result).toEqual(baseline);
      expect(onFallback).toHaveBeenCalledTimes(kind === "missing" ? 0 : 1);
    },
  );
  it("cancellation stops retrieval rather than falling back and answering anyway", async () => {
    const { add, retriever, setId } = fixture();
    add("One", ["Passage alpha."]);
    add("Two", ["Passage beta."]);
    const controller = new AbortController(),
      onFallback = vi.fn();
    await expect(
      retriever(async () => {
        controller.abort();
        throw controller.signal.reason;
      }).search([setId], "passage", 8, [], {
        signal: controller.signal,
        onFallback,
      }),
    ).rejects.toThrow();
    expect(onFallback).not.toHaveBeenCalled();
  });
  it("rejects a library change during reranking instead of mixing source versions", async () => {
    const { store, add, retriever, setId } = fixture();
    const id = add("One", ["Passage alpha."]);
    add("Two", ["Passage beta."]);
    await expect(
      retriever(async (_q, p) => {
        store.removeDocument(id);
        return p.map(() => 0.5);
      }).search([setId], "passage"),
    ).rejects.toThrow("library changed");
  });
  it("keeps strong text matches ahead of broad filename matches in the candidate pool", () => {
    const { store, add, setId } = fixture();
    for (let i = 0; i < 35; i++)
      add(`reset notes ${i}`, [`Unrelated topic ${i}.`]);
    const correct = add("Repair manual", [
      "To reset the device safely, hold the power button.",
    ]);
    const hits = store.chunksById(store.keywordSearch([setId], "reset", 30));
    expect(hits[0]!.documentId).toBe(correct);
  });
  it("allows unrelated background imports while scoring existing evidence", async () => {
    const { add, retriever, setId } = fixture();
    const first = add("One", ["Passage alpha."]);
    const second = add("Two", ["Passage beta."]);
    const hits = await retriever(async (_q, p) => {
      add("New document", ["Different information."]);
      return p.map(() => 0.5);
    }).search([setId], "passage");
    expect(hits.map((h) => h.documentId)).toEqual([first, second]);
  });
  it("persists the choice of standard search", () => {
    const { store } = fixture();
    expect(store.rerankingEnabled()).toBe(true);
    store.setRerankingEnabled(false);
    expect(store.rerankingEnabled()).toBe(false);
    store.setRerankingEnabled(true);
    expect(store.rerankingEnabled()).toBe(true);
  });
});
