import { describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { ToolManager } from "../src/main/tools/manager";
import { BUNDLED_TOOLS } from "../src/main/tools/bundled";
import { runIsolated } from "../src/main/tools/sandbox";
import {
  byteHash,
  packageHash,
  validatePackage,
} from "../src/main/tools/package";
import {
  discoverRepository,
  githubRepository,
  repositoryPackage,
} from "../src/main/tools/github";
import type { ToolPackage, ToolRepository } from "../src/shared/tools";
import { NO_MATCH, runTurn } from "../src/main/agent";
import type { Llm } from "../src/main/llm";

const localPackage = (): ToolPackage => structuredClone(BUNDLED_TOOLS[0]!);
const noHost = () => {
  throw new Error("No host access was granted.");
};
function library() {
  const s = new Store(":memory:");
  const a = s.createSet("Selected").id,
    b = s.createSet("Private unselected").id;
  [a, b].forEach((setId) =>
    s.saveDocument(
      {
        setId,
        path: `/test/${setId}.txt`,
        title: `Document ${setId}`,
        mtimeMs: 1,
        size: 1,
        parserVersion: 3,
      },
      [
        {
          text: setId === a ? "A filter is needed." : "Secret filter details.",
          page: null,
          line: 1,
          embedding: new Float32Array([1, 0]),
        },
      ],
    ),
  );
  return { s, a, b, manager: new ToolManager(s) };
}
describe("isolated tool execution", () => {
  it("does not expose Node, network, Electron, or the filesystem, including through Function", async () => {
    const result = await runIsolated(
      'function run() { return { data: [typeof process, typeof require, typeof fetch, typeof WebSocket, typeof Buffer, typeof globalThis.electron, Function("return typeof process")()], evidence: [] }; }',
      {},
      noHost,
    );
    expect(result.data).toEqual(Array(7).fill("undefined"));
  });
  it("terminates infinite loops and rejects oversized output", async () => {
    await expect(
      runIsolated("function run() { while(true) {} }", {}, noHost, {
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/interrupt|time limit/i);
    await expect(
      runIsolated(
        'function run() { return { data: "x".repeat(70000), evidence: [] }; }',
        {},
        noHost,
      ),
    ).rejects.toThrow(/64 KB/);
  });
  it("enforces interpreter memory limits and cancellation", async () => {
    await expect(
      runIsolated(
        "function run() { return {data:new ArrayBuffer(64 * 1024 * 1024), evidence:[]}; }",
        {},
        noHost,
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow(/memory|alloc|limit/i);
    const controller = new AbortController();
    const running = runIsolated("function run() { for(;;) {} }", {}, noHost, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/);
  });
});

describe("tool packages and library scope", () => {
  it("runs all bundled examples in the same sandbox as community scripts", async () => {
    const { s, manager } = library();
    try {
      for (const pkg of BUNDLED_TOOLS)
        expect(await manager.test(pkg), pkg.manifest.name).toEqual(
          pkg.tests.map((t) => ({ name: t.name, passed: true })),
        );
    } finally {
      s.close();
    }
  });
  it("counts selected documents with validated evidence and records reproducible settings", async () => {
    const { s, a, manager } = library();
    try {
      const { result } = await manager.run(
        "bundled:count-mentions",
        { phrase: "filter" },
        { setIds: [a], documentIds: [] },
      );
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.data).toEqual({
        phrase: "filter",
        unit: "distinct documents",
        count: 1,
      });
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]!.excerpt).not.toContain("Secret");
      expect(result.record.coverage.complete).toBe(true);
      expect(result.record.hash).toBe(packageHash(BUNDLED_TOOLS[0]!));
      expect(manager.runs()[0]!.record.input).toEqual({ phrase: "filter" });
    } finally {
      s.close();
    }
  });
  it("lets the agent call an enabled script even without initial search hits and attaches the run", async () => {
    const { s, a, manager } = library();
    try {
      const toolkit = manager.agentTools({ setIds: [a], documentIds: [] });
      const name = toolkit.definitions.find((d) =>
        d.function.description.startsWith("Count documents mentioning"),
      )!.function.name;
      let calls = 0;
      const llm: Llm = {
        async *chat(messages) {
          if (!calls++)
            yield {
              type: "tool_calls",
              calls: [
                {
                  id: "count",
                  type: "function",
                  function: { name, arguments: '{"phrase":"filter"}' },
                },
              ],
            };
          else {
            expect(JSON.stringify(messages.at(-1))).toContain(
              "distinct documents",
            );
            expect(messages.at(-1)!.content).toContain(
              "[1] Document 1, line 1\nA filter is needed.",
            );
            yield { type: "text", text: "One document mentions filter [1]." };
          }
        },
        async *speak() {},
        async transcribe() {
          return "";
        },
      };
      const result = await runTurn(
        { llm, hasSelectedDocuments: true, search: async () => [], toolkit },
        "Count documents containing filter",
        [],
        { speak: false, signal: AbortSignal.timeout(10000) },
        { delta() {}, status() {}, audio() {} },
      );
      expect(result.toolRuns).toHaveLength(1);
      expect(result.toolRuns![0]!.status).toBe("succeeded");
      expect(result.citations[0]!.cited).toBe(true);
      expect(result.text).toContain("One document");
    } finally {
      s.close();
    }
  });
  it("scans beyond the first page of documents and passages", async () => {
    const { s, a, manager } = library();
    try {
      for (let i = 0; i < 210; i++)
        s.saveDocument(
          {
            setId: a,
            path: `/bulk/${i}`,
            title: `Bulk ${i}`,
            mtimeMs: 1,
            size: 1,
            parserVersion: 3,
          },
          [
            {
              text: "Another filter.",
              page: null,
              line: 1,
              embedding: new Float32Array([1, 0]),
            },
          ],
        );
      s.saveDocument(
        {
          setId: a,
          path: "/long",
          title: "Long document",
          mtimeMs: 1,
          size: 1,
          parserVersion: 3,
        },
        Array.from({ length: 61 }, (_, i) => ({
          text: i === 60 ? "A filter on the last page." : "Unrelated text.",
          page: null,
          line: i + 1,
          embedding: new Float32Array([1, 0]),
        })),
      );
      const { result } = await manager.run(
        "bundled:count-mentions",
        { phrase: "filter" },
        { setIds: [a], documentIds: [] },
      );
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.data).toEqual({
        phrase: "filter",
        unit: "distinct documents",
        count: 212,
      });
      expect(result.record.coverage.passagesRead).toBe(272);
      expect(result.record.coverage.complete).toBe(true);
    } finally {
      s.close();
    }
  });

  it("does not stream unsupported claims when no passages or tool results exist", async () => {
    const { s, a, manager } = library();
    try {
      const deltas: string[] = [],
        spoken: string[] = [];
      const llm: Llm = {
        async *chat() {
          yield { type: "text", text: "An unsupported answer." };
        },
        async *speak(text) {
          spoken.push(text);
        },
        async transcribe() {
          return "";
        },
      };
      const result = await runTurn(
        {
          llm,
          search: async () => [],
          hasSelectedDocuments: true,
          toolkit: manager.agentTools({ setIds: [a], documentIds: [] }),
        },
        "Something unknown",
        [],
        { speak: true, signal: AbortSignal.timeout(10000) },
        { delta: (text) => deltas.push(text), status() {}, audio() {} },
      );
      expect(result.text).toBe(NO_MATCH);
      expect(deltas).toEqual([NO_MATCH]);
      expect(spoken.join(" ")).not.toContain("unsupported answer");
    } finally {
      s.close();
    }
  });

  it("preserves a bundled rollback across restarts and rejects reused run IDs", async () => {
    const { s, a, manager } = library();
    try {
      const old = localPackage();
      old.manifest.version = "0.9.0";
      const hash = packageHash(old),
        key = "bundled:count-mentions";
      s.db
        .prepare("INSERT INTO tool_packages VALUES(?,?,?,?,?)")
        .run(key, hash, JSON.stringify(old), '{"kind":"bundled"}', 1);
      manager.rollback(key, hash);
      const restarted = new ToolManager(s);
      expect(restarted.get(key).hash).toBe(hash);
      expect(restarted.get(key).enabled).toBe(false);
      restarted.enable(key, true);
      const scope = { setIds: [a], documentIds: [] };
      await restarted.run(key, { phrase: "filter" }, scope, {
        id: "recorded-run",
      });
      await expect(
        restarted.run(key, { phrase: "another" }, scope, {
          id: "recorded-run",
        }),
      ).rejects.toThrow(/duplicate/);
      expect(restarted.runs()[0]!.record.input.phrase).toBe("filter");
    } finally {
      s.close();
    }
  });

  it("denies forged document access and invented evidence IDs", async () => {
    const { s, a, b, manager } = library();
    try {
      const other = s.documents(b)[0]!.id;
      const pkg = localPackage();
      pkg.code = `function run(input, library) { library.read(${other}); return {data: {},evidence:[]}; }`;
      expect((await manager.test(pkg))[0]!.passed).toBe(false);
      // Bypass package install tests only to exercise the execution boundary with adversarial code.
      for (const code of [
        pkg.code,
        'function run(){return {data:{},evidence:["p999999"]};}',
      ]) {
        const tool = { ...pkg, code };
        const hash = packageHash(tool);
        s.db
          .prepare("INSERT INTO tool_packages VALUES(?,?,?,?,?)")
          .run(
            "local:adversarial",
            hash,
            JSON.stringify(tool),
            '{"kind":"local"}',
            1,
          );
        s.db
          .prepare("INSERT OR REPLACE INTO tool_installs VALUES(?,?,1)")
          .run("local:adversarial", hash);
        const { result } = await manager.run(
          "local:adversarial",
          { phrase: "x" },
          { setIds: [a], documentIds: [] },
        );
        expect(result.record.status).toBe("failed");
        expect(result.record.error).toMatch(
          /outside the selected scope|did not read/,
        );
        expect(result.citations).toEqual([]);
      }
    } finally {
      s.close();
    }
  });
  it("installs disabled, preserves versions, rejects mutable releases, and supports rollback", async () => {
    const { s, a, manager } = library();
    try {
      const pkg = localPackage();
      const preview = manager.prepare(pkg);
      await manager.install(preview.token);
      expect(manager.get("local:count-mentions").enabled).toBe(false);
      await expect(
        manager.run(
          "local:count-mentions",
          { phrase: "filter" },
          { setIds: [a], documentIds: [] },
        ),
      ).rejects.toThrow(/Enable/);
      manager.enable("local:count-mentions", true);
      const updated = structuredClone(pkg);
      updated.manifest.description += " Improved documentation.";
      await expect(
        manager.install(manager.prepare(updated).token),
      ).rejects.toThrow(/new version number/);
      updated.manifest.version = "1.0.1";
      await manager.install(manager.prepare(updated).token);
      expect(manager.get("local:count-mentions").versions).toHaveLength(2);
      expect(manager.get("local:count-mentions").enabled).toBe(false);
      manager.rollback("local:count-mentions", preview.hash);
      expect(manager.get("local:count-mentions").package.manifest.version).toBe(
        "1.0.0",
      );
      const reopened = new ToolManager(s);
      expect(reopened.get("local:count-mentions").hash).toBe(preview.hash);
      expect(reopened.get("bundled:count-mentions").origin.kind).toBe(
        "bundled",
      );
    } finally {
      s.close();
    }
  });
  it("rejects unsupported permissions, input schemas, and failing package tests", async () => {
    const { s, manager } = library();
    try {
      const pkg = localPackage();
      expect(() =>
        validatePackage({
          ...pkg,
          manifest: { ...pkg.manifest, permissions: ["network"] },
        }),
      ).toThrow(/permission/);
      expect(() =>
        validatePackage({
          ...pkg,
          manifest: {
            ...pkg.manifest,
            inputSchema: { type: "object", $ref: "https://example.com" },
          },
        }),
      ).toThrow(/Unsupported/);
      pkg.tests[0]!.expectedData = "wrong result";
      await expect(manager.install(manager.prepare(pkg).token)).rejects.toThrow(
        /test .*failed/,
      );
      expect(manager.list().every((t) => t.origin.kind === "bundled")).toBe(
        true,
      );
    } finally {
      s.close();
    }
  });
});

describe("GitHub tool collections", () => {
  it("accepts repository URLs and rejects alternate hosts, credentials, paths, and traversal", () => {
    expect(githubRepository("https://github.com/Example/Tools.git")).toBe(
      "example/tools",
    );
    for (const url of [
      "http://github.com/x/y",
      "https://github.com.evil/x/y",
      "https://name@github.com/x/y",
      "https://github.com/x/y/tree/main",
      "https://github.com/x/y?q=x",
    ])
      expect(() => githubRepository(url)).toThrow();
  });
  it("pins discovery and package fetches to one commit and verifies the catalog digest", async () => {
    const pkg = localPackage(),
      encoded = JSON.stringify(pkg),
      sha = "a".repeat(40);
    const catalog = {
      format: "docent-tool-collection",
      formatVersion: 1,
      name: "Examples",
      tools: [
        {
          id: pkg.manifest.id,
          name: pkg.manifest.name,
          description: pkg.manifest.description,
          version: pkg.manifest.version,
          file: "tools/count.docent-tool.json",
          sha256: byteHash(encoded),
        },
      ],
    };
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      return new Response(
        url.endsWith("releases/latest")
          ? '{"tag_name":"v1.0.0"}'
          : url.includes("/commits/")
            ? JSON.stringify({ sha })
            : url.endsWith("docent-tools.json")
              ? JSON.stringify(catalog)
              : encoded,
      );
    };
    const repo = await discoverRepository(
      "https://github.com/example/tools",
      fetcher,
    );
    expect(repo.commit).toBe(sha);
    expect(await repositoryPackage(repo, pkg.manifest.id, fetcher)).toEqual(
      pkg,
    );
    expect(
      requests
        .filter((r) => r.includes("raw.githubusercontent.com"))
        .every((r) => r.includes(sha)),
    ).toBe(true);
    const damaged: ToolRepository = structuredClone(repo);
    damaged.catalog.tools[0]!.sha256 = "0".repeat(64);
    await expect(
      repositoryPackage(damaged, pkg.manifest.id, fetcher),
    ).rejects.toThrow(/checksum/);
  });
});
