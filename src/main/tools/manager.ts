import { randomUUID } from "node:crypto";
import type { Citation } from "../../shared/types";
import type {
  InstalledTool,
  Json,
  PreparedTool,
  ToolOrigin,
  ToolPackage,
  ToolRepository,
  ToolRunRecord,
  ToolRunResult,
  ToolScope,
  ToolTestResult,
} from "../../shared/tools";
import type { Store, StoredChunk } from "../store";
import type { ToolDefinition } from "../llm";
import { chunkSegments } from "../ingest/chunk";
import { BUNDLED_TOOLS } from "./bundled";
import {
  canonical,
  byteHash,
  packageHash,
  validateInput,
  validatePackage,
} from "./package";
import { discoverRepository, repositoryPackage, type Fetcher } from "./github";
import { ScopeHost, storeLibrary, type ToolLibrary } from "./host";
import { runIsolated } from "./sandbox";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_packages (key TEXT NOT NULL, hash TEXT NOT NULL, package TEXT NOT NULL, origin TEXT NOT NULL, installed_at REAL NOT NULL, PRIMARY KEY(key,hash));
CREATE TABLE IF NOT EXISTS tool_installs (key TEXT PRIMARY KEY, active_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tool_repositories (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tool_runs (id TEXT PRIMARY KEY, started_at REAL NOT NULL, result TEXT NOT NULL);
`;
type PackageRow = {
  key: string;
  hash: string;
  package: string;
  origin: string;
  installed_at: number;
  enabled: number;
};
export const toolKey = (pkg: ToolPackage, origin: ToolOrigin) =>
  `${origin.kind === "github" ? `github:${origin.repository}` : origin.kind}:${pkg.manifest.id}`;
const citation = (c: StoredChunk, i: number): Citation => ({
  n: i + 1,
  documentId: c.documentId,
  title: c.title,
  path: c.path,
  setName: c.setName,
  page: c.page,
  line: c.line,
  excerpt: c.text,
  version: c.version,
  indexedAt: c.indexedAt,
  warning: c.warning,
  cited: true,
});

function fixtureLibrary(
  documents: ToolPackage["tests"][number]["documents"],
): ToolLibrary {
  let nextId = 1;
  const chunks: StoredChunk[] = documents.flatMap((d, i) =>
    chunkSegments([{ text: d.text, page: null }]).map((c) => ({
      ...c,
      id: nextId++,
      documentId: i + 1,
      title: d.title,
      path: `/synthetic/${i + 1}`,
      setName: "Tool test fixtures",
    })),
  );
  return {
    documents: documents.map((d, i) => ({
      id: i + 1,
      setId: 1,
      path: `/synthetic/${i + 1}`,
      title: d.title,
      error: null,
      chunkCount: chunks.filter((c) => c.documentId === i + 1).length,
      version: byteHash(d.text),
    })),
    read: (id, offset, limit) =>
      chunks.filter((c) => c.documentId === id).slice(offset, offset + limit),
    search: (query, limit) =>
      chunks
        .filter((c) => c.text.toLowerCase().includes(query.toLowerCase()))
        .slice(0, limit),
    unchanged: () => true,
  };
}

export class ToolManager {
  private pending = new Map<string, PreparedTool>();
  private running = new Map<
    string,
    { key: string; controller: AbortController }
  >();
  constructor(
    private store: Store,
    private options: { workerPath?: string | URL; fetcher?: Fetcher } = {},
  ) {
    store.db.exec(SCHEMA);
    for (const pkg of BUNDLED_TOOLS)
      this.put(validatePackage(pkg), { kind: "bundled" }, true);
  }
  private put(pkg: ToolPackage, origin: ToolOrigin, bundled = false) {
    const key = toolKey(pkg, origin),
      hash = packageHash(pkg);
    const versions = this.store.db
      .prepare("SELECT hash, package FROM tool_packages WHERE key=?")
      .all(key) as { hash: string; package: string }[];
    if (
      versions.some(
        (v) =>
          JSON.parse(v.package).manifest.version === pkg.manifest.version &&
          v.hash !== hash,
      )
    )
      throw new Error(
        "This version already exists with different content. Give the changed tool a new version number.",
      );
    const current = this.store.db
      .prepare("SELECT active_hash,enabled FROM tool_installs WHERE key=?")
      .get(key) as { active_hash: string; enabled: number } | undefined;
    this.store.db.exec("BEGIN");
    try {
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO tool_packages(key,hash,package,origin,installed_at) VALUES(?,?,?,?,?)",
        )
        .run(
          key,
          hash,
          JSON.stringify(pkg),
          JSON.stringify(origin),
          Date.now(),
        );
      this.store.db
        .prepare(
          "INSERT INTO tool_installs(key,active_hash,enabled) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET active_hash=excluded.active_hash,enabled=excluded.enabled",
        )
        .run(
          key,
          bundled && current ? current.active_hash : hash,
          current && (bundled || current.active_hash === hash)
            ? current.enabled
            : Number(bundled),
        );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(): InstalledTool[] {
    const rows = this.store.db
      .prepare(
        "SELECT p.*,i.enabled FROM tool_installs i JOIN tool_packages p ON p.key=i.key AND p.hash=i.active_hash ORDER BY p.key",
      )
      .all() as PackageRow[];
    return rows.map((row) => ({
      key: row.key,
      hash: row.hash,
      enabled: Boolean(row.enabled),
      package: JSON.parse(row.package),
      origin: JSON.parse(row.origin),
      installedAt: row.installed_at,
      versions: (
        this.store.db
          .prepare(
            "SELECT hash, package, installed_at FROM tool_packages WHERE key=? ORDER BY installed_at DESC",
          )
          .all(row.key) as PackageRow[]
      ).map((v) => ({
        hash: v.hash,
        version: JSON.parse(v.package).manifest.version,
        installedAt: v.installed_at,
      })),
    }));
  }
  get(key: string): InstalledTool {
    const tool = this.list().find((t) => t.key === key);
    if (!tool) throw new Error("Tool is not installed.");
    if (packageHash(tool.package) !== tool.hash)
      throw new Error("Stored tool failed its integrity check. Reinstall it.");
    return tool;
  }
  prepare(
    value: unknown,
    origin: ToolOrigin = { kind: "local" },
  ): PreparedTool {
    const pkg = validatePackage(value),
      token = randomUUID();
    const prepared = { token, package: pkg, hash: packageHash(pkg), origin };
    if (this.pending.size >= 20)
      this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(token, prepared);
    return prepared;
  }
  async install(token: string) {
    const prepared = this.pending.get(token);
    if (!prepared) throw new Error("Package preview expired. Open it again.");
    const tests = await this.test(prepared.package);
    const failed = tests.find((t) => !t.passed);
    if (failed)
      throw new Error(
        `Tool was not installed: test “${failed.name}” failed. ${failed.error}`,
      );
    this.put(prepared.package, prepared.origin);
    this.pending.delete(token);
  }
  enable(key: string, enabled: boolean) {
    this.get(key);
    if (
      enabled &&
      this.list().filter((t) => t.enabled && t.key !== key).length >= 12
    )
      throw new Error(
        "Enable at most 12 tools at a time so the local model can choose reliably.",
      );
    this.store.db
      .prepare("UPDATE tool_installs SET enabled=? WHERE key=?")
      .run(Number(enabled), key);
    if (!enabled)
      for (const running of this.running.values())
        if (running.key === key) running.controller.abort();
  }
  rollback(key: string, hash: string) {
    this.get(key);
    const row = this.store.db
      .prepare("SELECT package FROM tool_packages WHERE key=? AND hash=?")
      .get(key, hash) as { package: string } | undefined;
    if (!row || packageHash(validatePackage(JSON.parse(row.package))) !== hash)
      throw new Error(
        "Saved version is missing or failed its integrity check.",
      );
    this.enable(key, false);
    this.store.db
      .prepare("UPDATE tool_installs SET active_hash=? WHERE key=?")
      .run(hash, key);
  }
  remove(key: string) {
    if (this.get(key).origin.kind === "bundled")
      throw new Error("Bundled tools can be disabled, but not removed.");
    this.enable(key, false);
    this.store.db.prepare("DELETE FROM tool_installs WHERE key=?").run(key);
    this.store.db.prepare("DELETE FROM tool_packages WHERE key=?").run(key);
  }
  repositories(): ToolRepository[] {
    return (
      this.store.db
        .prepare("SELECT data FROM tool_repositories ORDER BY id")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  async addRepository(url: string) {
    const repo = await discoverRepository(url, this.options.fetcher);
    this.store.db
      .prepare(
        "INSERT INTO tool_repositories(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(repo.id, JSON.stringify(repo));
    return repo;
  }
  async checkRepository(id: string) {
    const repo = this.repositories().find((r) => r.id === id);
    if (!repo) throw new Error("Repository is not registered.");
    return this.addRepository(repo.url);
  }
  removeRepository(id: string) {
    this.store.db.prepare("DELETE FROM tool_repositories WHERE id=?").run(id);
  }
  async prepareRepository(id: string, toolId: string) {
    const repo = this.repositories().find((r) => r.id === id);
    if (!repo) throw new Error("Repository is not registered.");
    const pkg = await repositoryPackage(repo, toolId, this.options.fetcher);
    return this.prepare(pkg, {
      kind: "github",
      repository: repo.id,
      commit: repo.commit,
      release: repo.release,
    });
  }
  async test(value: unknown): Promise<ToolTestResult[]> {
    const pkg = validatePackage(value),
      results: ToolTestResult[] = [];
    for (const test of pkg.tests) {
      const host = new ScopeHost(fixtureLibrary(test.documents));
      try {
        const result = await runIsolated(pkg.code, test.input, host.call, {
          workerPath: this.options.workerPath,
          timeoutMs: 5000,
        });
        host.evidence(result.evidence);
        if (canonical(result.data) !== canonical(test.expectedData))
          throw new Error(
            `Expected ${JSON.stringify(test.expectedData).slice(0, 500)}; received ${JSON.stringify(result.data).slice(0, 500)}.`,
          );
        results.push({ name: test.name, passed: true });
      } catch (error) {
        results.push({
          name: test.name,
          passed: false,
          error: String(error instanceof Error ? error.message : error),
        });
      }
    }
    return results;
  }
  cancel(id: string) {
    this.running.get(id)?.controller.abort();
  }
  runs(): ToolRunResult[] {
    return (
      this.store.db
        .prepare(
          "SELECT result FROM tool_runs ORDER BY started_at DESC LIMIT 100",
        )
        .all() as { result: string }[]
    ).map((r) => JSON.parse(r.result));
  }

  async run(
    key: string,
    input: Record<string, Json>,
    scope: ToolScope,
    options: { id?: string; signal?: AbortSignal; expectedHash?: string } = {},
  ): Promise<{ result: ToolRunResult; chunks: StoredChunk[] }> {
    const tool = this.get(key);
    if (!tool.enabled)
      throw new Error("Enable this tool before running it on your documents.");
    if (options.expectedHash && options.expectedHash !== tool.hash)
      throw new Error(
        "Tool version changed during the question. Ask again to use the new version.",
      );
    validateInput(input, tool.package.manifest.inputSchema);
    if (
      !scope ||
      !Array.isArray(scope.setIds) ||
      !scope.setIds.length ||
      scope.setIds.length > 100 ||
      !Array.isArray(scope.documentIds) ||
      scope.documentIds.length > 10000 ||
      [...scope.setIds, ...scope.documentIds].some(
        (id) => !Number.isSafeInteger(id) || id < 1,
      )
    )
      throw new Error("Select valid document sets before running a tool.");
    const host = new ScopeHost(storeLibrary(this.store, scope));
    if (!host.coverage().documentsInScope)
      throw new Error("No documents are available in the selected scope.");
    if (this.running.size >= 2)
      throw new Error("Two tools are already running. Wait or cancel a run.");
    const id = options.id ?? randomUUID();
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 100 ||
      this.running.has(id) ||
      this.store.db.prepare("SELECT 1 FROM tool_runs WHERE id=?").get(id)
    )
      throw new Error("Invalid or duplicate tool run ID.");
    const controller = new AbortController();
    this.running.set(id, { key, controller });
    const startedAt = Date.now();
    const record: ToolRunRecord = {
      id,
      toolKey: key,
      name: tool.package.manifest.name,
      version: tool.package.manifest.version,
      hash: tool.hash,
      input,
      setIds: scope.setIds,
      documentIds: scope.documentIds,
      scopeFingerprint: host.fingerprint,
      startedAt,
      durationMs: 0,
      status: "succeeded",
      coverage: host.coverage(),
    };
    let chunks: StoredChunk[] = [],
      data: Json = null;
    try {
      const output = await runIsolated(tool.package.code, input, host.call, {
        workerPath: this.options.workerPath,
        signal: options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
      });
      chunks = host.evidence(output.evidence);
      data = output.data;
    } catch (error) {
      record.status = "failed";
      record.error = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 1000);
    } finally {
      this.running.delete(id);
    }
    record.durationMs = Date.now() - startedAt;
    record.coverage = host.coverage();
    const result = { record, data, citations: chunks.map(citation) };
    this.store.db
      .prepare(
        "INSERT OR REPLACE INTO tool_runs(id,started_at,result) VALUES(?,?,?)",
      )
      .run(id, startedAt, JSON.stringify(result));
    this.store.db
      .prepare(
        "DELETE FROM tool_runs WHERE id NOT IN (SELECT id FROM tool_runs ORDER BY started_at DESC LIMIT 100)",
      )
      .run();
    return { result, chunks };
  }

  agentTools(scope: ToolScope) {
    // Snapshot enabled versions for the turn; an update cannot silently change an in-flight call.
    const enabled = this.list().filter((t) => t.enabled);
    const names = new Map(
      enabled.map((t) => [
        `docent_${t.package.manifest.id.replace(/-/g, "_").slice(0, 32)}_${byteHash(t.key).slice(0, 16)}`,
        t,
      ]),
    );
    const definitions: ToolDefinition[] = [...names].map(([name, t]) => ({
      type: "function",
      function: {
        name,
        description: `${t.package.manifest.name}: ${t.package.manifest.description}`,
        parameters: t.package.manifest.inputSchema,
      },
    }));
    const referenceTool =
      storeLibrary(this.store, scope).documents.length <= 20
        ? [...names].find(([, t]) => t.key === "bundled:bibliography")?.[0]
        : undefined;
    return {
      definitions,
      referenceTool,
      run: async (
        name: string,
        input: Record<string, Json>,
        signal: AbortSignal,
      ) => {
        const tool = names.get(name);
        if (!tool) throw new Error("Tool is not enabled for this question.");
        return this.run(tool.key, input, scope, {
          signal,
          expectedHash: tool.hash,
        });
      },
    };
  }
}
