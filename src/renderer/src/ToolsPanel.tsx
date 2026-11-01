import { useEffect, useRef, useState } from "react";
import type { Citation, DocSet, DocumentRow } from "../../shared/types";
import type {
  InstalledTool,
  Json,
  PreparedTool,
  ToolPackage,
  ToolRepository,
  ToolRunRecord,
  ToolRunResult,
  ToolScope,
  ToolTestResult,
} from "../../shared/tools";

const api = window.api.tools;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const originLabel = (tool: Pick<InstalledTool, "origin">) =>
  tool.origin.kind === "bundled"
    ? "Bundled with Docent"
    : tool.origin.kind === "local"
      ? "Personal tool"
      : `Community · ${tool.origin.repository}`;

export function ToolRunInfo({ record }: { record: ToolRunRecord }) {
  const c = record.coverage;
  return (
    <details className="tool-run-info">
      <summary>
        {record.name} · v{record.version} ·{" "}
        {record.status === "failed" ? "Failed" : "Completed"}
      </summary>
      <p>
        {c.documentsRead} of {c.documentsInScope} documents read ·{" "}
        {c.passagesRead} of {c.passagesInScope} passages read ·{" "}
        {c.documentsListed} documents listed.
      </p>
      <p>
        {c.complete
          ? "All indexed passages in the selected scope were read."
          : "This run did not read every passage in the selected scope."}
        {c.unavailableDocuments > 0 &&
          ` ${c.unavailableDocuments} documents have no indexed passages.`}
        {c.staleDocuments > 0 &&
          ` ${c.staleDocuments} documents use an earlier saved version.`}
      </p>
      {record.error && <p className="warning">{record.error}</p>}
      <small>
        {new Date(record.startedAt).toLocaleString()} ·{" "}
        {(record.durationMs / 1000).toFixed(1)} seconds
      </small>
      <details>
        <summary>Inputs and exact version</summary>
        <pre>
          {pretty({
            input: record.input,
            packageHash: record.hash,
            setIds: record.setIds,
            documentIds: record.documentIds,
            libraryFingerprint: record.scopeFingerprint,
          })}
        </pre>
      </details>
    </details>
  );
}

function RunResult({
  result,
  onCite,
}: {
  result: ToolRunResult;
  onCite: (c: Citation) => void;
}) {
  return (
    <section className="tool-result">
      <ToolRunInfo record={result.record} />
      {result.record.status === "succeeded" && (
        <pre aria-label="Tool result">{pretty(result.data)}</pre>
      )}
      {!!result.citations.length && (
        <div className="tool-evidence">
          <strong>Supporting passages</strong>
          {result.citations.map((c) => (
            <button key={c.n} onClick={() => onCite(c)}>
              {c.title} · {c.page ? `page ${c.page}` : `line ${c.line ?? 1}`}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function draft(): ToolPackage {
  return {
    format: "docent-tool",
    formatVersion: 1,
    manifest: {
      id: `my-tool-${crypto.randomUUID().slice(0, 8)}`,
      name: "My document tool",
      version: "0.1.0",
      description: "Count the documents in the current selection.",
      author: "Local author",
      license: "MIT",
      apiVersion: 1,
      permissions: ["documents:read"],
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      examples: [{ name: "Count documents", input: {} }],
    },
    code: "function run(input, library) {\n  return { data: { documents: library.documents().total }, evidence: [] };\n}",
    tests: [
      {
        name: "Counts one synthetic document",
        input: {},
        documents: [{ title: "Example", text: "Example text." }],
        expectedData: { documents: 1 },
      },
    ],
  };
}

export function ToolsPanel({
  sets,
  scope,
  onCite,
}: {
  sets: DocSet[];
  scope: ToolScope;
  onCite: (c: Citation) => void;
}) {
  const [tools, setTools] = useState<InstalledTool[]>([]);
  const [repos, setRepos] = useState<ToolRepository[]>([]);
  const [runs, setRuns] = useState<ToolRunResult[]>([]);
  const [tab, setTab] = useState<"installed" | "repositories" | "history">(
    "installed",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<PreparedTool | null>(null);
  const [editor, setEditor] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<ToolTestResult[]>([]);
  const [input, setInput] = useState("{}");
  const [result, setResult] = useState<ToolRunResult | null>(null);
  const [scopeDocs, setScopeDocs] = useState<DocumentRow[]>([]);
  const runningId = useRef<string | null>(null);
  const refresh = async () => {
    const [a, b, c] = await Promise.all([
      api.list(),
      api.repositories(),
      api.runs(),
    ]);
    setTools(a);
    setRepos(b);
    setRuns(c);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    return () => {
      if (runningId.current) void api.cancel(runningId.current);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(scope.setIds.map((id) => window.api.sets.documents(id)))
      .then((all) => {
        if (!cancelled)
          setScopeDocs(
            all
              .flat()
              .filter(
                (d) =>
                  !scope.documentIds.length || scope.documentIds.includes(d.id),
              ),
          );
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [JSON.stringify(scope)]);
  const act = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const choose = (tool: InstalledTool) => {
    const values = { ...(tool.package.manifest.examples[0]?.input ?? {}) };
    let documentIndex = 0;
    for (const [name, field] of Object.entries(
      tool.package.manifest.inputSchema.properties ?? {},
    ))
      if (field.format === "document-id")
        values[name] = scopeDocs[documentIndex++]?.id ?? 0;
    setSelected(tool.key);
    setInput(pretty(values));
    setResult(null);
    setTestResults([]);
    setEditor(null);
    setPrepared(null);
    setError("");
  };
  const preview = (value: PreparedTool | null) => {
    if (value) {
      setPrepared(value);
      setEditor(null);
      setTestResults([]);
    }
  };
  const copy = (tool: InstalledTool) => {
    const pkg = structuredClone(tool.package);
    if (tool.origin.kind === "local") {
      const parts = pkg.manifest.version.split(".");
      parts[2] = String(Number(parts[2]) + 1);
      pkg.manifest.version = parts.join(".");
    } else pkg.manifest.name = `${pkg.manifest.name.slice(0, 64)} (local copy)`;
    setEditor(pretty(pkg));
    setPrepared(null);
    setTestResults([]);
  };
  const current = tools.find((t) => t.key === selected);
  const scopeNames = sets
    .filter((s) => scope.setIds.includes(s.id))
    .map((s) => s.name)
    .join(", ");
  const busyNow = Boolean(busy);
  let inputValues: Record<string, Json> | null = null;
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      inputValues = parsed;
  } catch {}
  const simpleInputs =
    current &&
    inputValues &&
    Object.values(current.package.manifest.inputSchema.properties ?? {}).every(
      (p) => !["object", "array"].includes(p.type),
    );
  const inputEditor = (
    <label>
      Inputs (JSON)
      <textarea
        aria-label="Tool inputs"
        className="tool-inputs"
        value={input}
        spellCheck={false}
        disabled={busyNow}
        onChange={(e) => setInput(e.target.value)}
      />
    </label>
  );

  return (
    <section className="tools-panel" aria-label="Tools">
      <div className="tools-title">
        <div>
          <h2>Tools for your library</h2>
          <p>
            Run tools locally, share useful scripts, and keep versions that
            work.
          </p>
        </div>
        <div className="actions">
          <button
            disabled={busyNow}
            onClick={() => {
              setEditor(pretty(draft()));
              setPrepared(null);
              setTestResults([]);
            }}
          >
            Create a tool
          </button>
          <button
            disabled={busyNow}
            onClick={() =>
              void act("Opening package…", async () =>
                preview(await api.importPackage()),
              )
            }
          >
            Import package
          </button>
        </div>
      </div>
      <p className="fine">
        Tools can read the selected documents. They have no network, shell, or
        file-writing access. Installed tools run offline; adding repositories
        and checking updates use the internet.
      </p>
      <nav className="actions tool-tabs" aria-label="Tool sections">
        <button
          aria-pressed={tab === "installed"}
          onClick={() => setTab("installed")}
        >
          Installed ({tools.length})
        </button>
        <button
          aria-pressed={tab === "repositories"}
          onClick={() => setTab("repositories")}
        >
          Repositories ({repos.length})
        </button>
        <button
          aria-pressed={tab === "history"}
          onClick={() => setTab("history")}
        >
          Run history
        </button>
      </nav>
      {busy && <p role="status">{busy}</p>}
      {status && <p role="status">{status}</p>}
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}

      {editor !== null && (
        <section className="tool-editor">
          <h3>Edit a personal tool package</h3>
          <p className="fine">
            Define <code>run(input, library)</code>, its inputs, and tests using
            synthetic text. Keep the license and author attribution when
            adapting shared code. Existing versions stay available.
          </p>
          <details>
            <summary>JavaScript tool API</summary>
            <pre>{`function run(input, library) {\n  const page = library.documents();\n  // page.documents: IDs, titles, versions, passage counts\n  // page.nextOffset: next page, or null\n  const passages = library.read(page.documents[0].id);\n  return { data: { example: passages.passages[0].text },\n           evidence: [passages.passages[0].id] };\n}\n\nlibrary.documents(offset = 0, limit = 200)\nlibrary.read(documentId, offset = 0, limit = 50)\nlibrary.search(query, limit = 20)\nlibrary.references(documentId)\n\nAPI 1: synchronous JavaScript; JSON output under 64 KB;\n32 MB interpreter memory; 30 seconds per library run.\nTests use only their synthetic documents. No imports or async run().`}</pre>
          </details>
          <label>
            Package JSON
            <textarea
              aria-label="Tool package editor"
              spellCheck={false}
              value={editor}
              onChange={(e) => {
                setEditor(e.target.value);
                setTestResults([]);
              }}
              disabled={busyNow}
            />
          </label>
          <div className="actions">
            <button
              disabled={busyNow}
              onClick={() =>
                void act("Running example tests…", async () =>
                  setTestResults(await api.testPackage(JSON.parse(editor))),
                )
              }
            >
              Test draft
            </button>
            <button
              disabled={busyNow}
              onClick={() =>
                void act("Checking package…", async () =>
                  preview(await api.prepareLocal(JSON.parse(editor))),
                )
              }
            >
              Review package
            </button>
            <button
              disabled={busyNow}
              onClick={() => {
                setEditor(null);
                setTestResults([]);
              }}
            >
              Cancel editing
            </button>
          </div>
        </section>
      )}

      {prepared && (
        <section className="tool-preview">
          <h3>Review {prepared.package.manifest.name}</h3>
          <p>{prepared.package.manifest.description}</p>
          <p>
            {originLabel(prepared)} · v{prepared.package.manifest.version} ·{" "}
            {prepared.package.manifest.author} ·{" "}
            {prepared.package.manifest.license}
          </p>
          <p>
            <strong>Permission:</strong> read selected documents. Installation
            runs the included tests using synthetic text. The tool starts
            disabled.
          </p>
          {prepared.origin.commit && (
            <p className="fine">
              Pinned commit: <code>{prepared.origin.commit}</code>
            </p>
          )}
          <details>
            <summary>Code and package details</summary>
            <pre>{pretty(prepared.package)}</pre>
          </details>
          {tools.some(
            (t) =>
              t.package.manifest.id === prepared.package.manifest.id &&
              t.origin.kind === prepared.origin.kind &&
              t.origin.repository === prepared.origin.repository,
          ) && (
            <details>
              <summary>Compare with the installed package</summary>
              <pre>
                {pretty(
                  tools.find(
                    (t) =>
                      t.package.manifest.id === prepared.package.manifest.id &&
                      t.origin.kind === prepared.origin.kind &&
                      t.origin.repository === prepared.origin.repository,
                  )?.package,
                )}
              </pre>
            </details>
          )}
          <div className="actions">
            <button
              disabled={busyNow}
              onClick={() =>
                void act("Running included tests…", async () =>
                  setTestResults(await api.testPackage(prepared.package)),
                )
              }
            >
              Test package
            </button>
            <button
              className="primary"
              disabled={busyNow}
              onClick={() =>
                void act("Testing and installing…", async () => {
                  await api.install(prepared.token);
                  setPrepared(null);
                  setTestResults([]);
                  setTab("installed");
                  await refresh();
                  setStatus(
                    "Installed. Enable the tool when you want it available to the agent.",
                  );
                })
              }
            >
              Install disabled
            </button>
            <button
              disabled={busyNow}
              onClick={() => {
                setPrepared(null);
                setTestResults([]);
              }}
            >
              Cancel install
            </button>
          </div>
        </section>
      )}
      {!!testResults.length && (
        <ul className="tool-tests" aria-label="Tool test results">
          {testResults.map((t, i) => (
            <li key={i} className={t.passed ? "" : "warning"}>
              {t.passed ? "✓" : "×"} {t.name}
              {t.error && <pre>{t.error}</pre>}
            </li>
          ))}
        </ul>
      )}

      {tab === "repositories" && (
        <div className="tool-repositories">
          <h3>Add a shared tool collection</h3>
          <form
            className="tool-repo-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act("Reading repository catalog…", async () => {
                await api.addRepository(url);
                setUrl("");
                await refresh();
                setStatus(
                  "Repository added. Review and install the tools you want.",
                );
              });
            }}
          >
            <input
              aria-label="GitHub repository URL"
              placeholder="https://github.com/owner/tool-collection"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busyNow}
            />
            <button disabled={busyNow || !url.trim()}>Add repository</button>
          </form>
          <p className="fine">
            Public repositories need a <code>docent-tools.json</code> catalog at
            the root. Docent uses the latest published release, or the default
            branch when no release exists, and pins downloads to its commit.
            Adding a collection does not install or enable its tools.
          </p>
          {repos.map((repo) => (
            <article className="tool-card" key={repo.id}>
              <h3>{repo.catalog.name}</h3>
              <p>{repo.url}</p>
              <small>
                {repo.release ?? "Default branch snapshot"} ·{" "}
                {repo.commit.slice(0, 12)} · Checked{" "}
                {new Date(repo.checkedAt).toLocaleString()}
              </small>
              <div className="actions">
                <button
                  disabled={busyNow}
                  onClick={() =>
                    void act("Checking repository updates…", async () => {
                      await api.checkRepository(repo.id);
                      await refresh();
                      setStatus(
                        "Catalog refreshed. Installed versions are unchanged until you install an update.",
                      );
                    })
                  }
                >
                  Check updates
                </button>
                <button
                  disabled={busyNow}
                  onClick={() =>
                    void act("Removing repository…", async () => {
                      await api.removeRepository(repo.id);
                      await refresh();
                      setStatus(
                        "Repository removed. Installed tools remain available offline.",
                      );
                    })
                  }
                >
                  Remove repository
                </button>
              </div>
              {repo.catalog.tools.map((entry) => {
                const installed = tools.find(
                  (t) => t.key === `github:${repo.id}:${entry.id}`,
                );
                return (
                  <div className="catalog-tool" key={entry.id}>
                    <strong>
                      {entry.name} · v{entry.version}
                    </strong>
                    <p>{entry.description}</p>
                    {installed && (
                      <small>
                        Installed: v{installed.package.manifest.version}
                      </small>
                    )}
                    <button
                      disabled={busyNow}
                      onClick={() =>
                        void act("Downloading package for review…", async () =>
                          preview(
                            await api.prepareRepository(repo.id, entry.id),
                          ),
                        )
                      }
                    >
                      {installed ? "Review available version" : "Review tool"}
                    </button>
                  </div>
                );
              })}
            </article>
          ))}
        </div>
      )}

      {tab === "installed" && (
        <div className="tool-workspace">
          <div className="tool-list">
            {tools.map((tool) => (
              <article
                className={`tool-card${selected === tool.key ? " active" : ""}`}
                key={tool.key}
              >
                <button
                  className="tool-name"
                  disabled={busyNow}
                  onClick={() => choose(tool)}
                >
                  <strong>{tool.package.manifest.name}</strong>
                  <small>
                    {originLabel(tool)} · v{tool.package.manifest.version}
                  </small>
                </button>
                <p>{tool.package.manifest.description}</p>
                <label className="tool-enable">
                  <input
                    type="checkbox"
                    aria-label={`Enable ${tool.package.manifest.name}`}
                    checked={tool.enabled}
                    disabled={busyNow}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setTools((all) =>
                        all.map((item) =>
                          item.key === tool.key ? { ...item, enabled } : item,
                        ),
                      );
                      void act("Updating tool access…", async () => {
                        try {
                          await api.enable(tool.key, enabled);
                        } finally {
                          await refresh();
                        }
                      });
                    }}
                  />
                  Available to the agent
                </label>
              </article>
            ))}
          </div>
          {current && (
            <section className="tool-detail" key={current.key}>
              <h3>{current.package.manifest.name}</h3>
              <p className="fine">
                {current.package.manifest.author} ·{" "}
                {current.package.manifest.license} · API{" "}
                {current.package.manifest.apiVersion}
              </p>
              <p>
                <strong>Run on:</strong>{" "}
                {scopeNames || "Select document sets in the sidebar"}
                {scope.documentIds.length
                  ? ` · ${scope.documentIds.length} selected documents`
                  : ""}
              </p>
              <label>
                Example inputs
                <select
                  aria-label="Tool example"
                  disabled={busyNow}
                  value=""
                  onChange={(e) =>
                    setInput(
                      pretty(
                        current.package.manifest.examples[
                          Number(e.target.value)
                        ]!.input,
                      ),
                    )
                  }
                >
                  <option value="" disabled>
                    Choose an example
                  </option>
                  {current.package.manifest.examples.map((e, i) => (
                    <option key={i} value={i}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              {simpleInputs ? (
                <div className="tool-fields">
                  {Object.entries(
                    current.package.manifest.inputSchema.properties ?? {},
                  ).map(([name, field]) => {
                    const value = inputValues![name];
                    const update = (value: Json) =>
                      setInput(pretty({ ...inputValues, [name]: value }));
                    return (
                      <label key={name}>
                        {field.description ?? name}
                        {field.format === "document-id" ? (
                          <select
                            aria-label={field.description ?? name}
                            disabled={busyNow}
                            value={
                              scopeDocs.some((d) => d.id === value)
                                ? String(value)
                                : ""
                            }
                            onChange={(e) => update(Number(e.target.value))}
                          >
                            <option value="" disabled>
                              Choose a document
                            </option>
                            {scopeDocs.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.title}
                              </option>
                            ))}
                          </select>
                        ) : field.enum ? (
                          <select
                            aria-label={field.description ?? name}
                            value={JSON.stringify(value)}
                            disabled={busyNow}
                            onChange={(e) => update(JSON.parse(e.target.value))}
                          >
                            {field.enum.map((v, i) => (
                              <option key={i} value={JSON.stringify(v)}>
                                {String(v)}
                              </option>
                            ))}
                          </select>
                        ) : field.type === "boolean" ? (
                          <input
                            type="checkbox"
                            checked={Boolean(value)}
                            disabled={busyNow}
                            onChange={(e) => update(e.target.checked)}
                          />
                        ) : (
                          <input
                            aria-label={field.description ?? name}
                            type={field.type === "string" ? "text" : "number"}
                            value={String(value ?? "")}
                            disabled={busyNow}
                            onChange={(e) =>
                              update(
                                field.type === "string"
                                  ? e.target.value
                                  : Number(e.target.value),
                              )
                            }
                          />
                        )}
                      </label>
                    );
                  })}
                  <details>
                    <summary>Edit inputs as JSON</summary>
                    {inputEditor}
                  </details>
                </div>
              ) : (
                inputEditor
              )}
              <details>
                <summary>Input fields</summary>
                <pre>{pretty(current.package.manifest.inputSchema)}</pre>
              </details>
              <div className="actions">
                <button
                  className="primary"
                  disabled={busyNow || !current.enabled || !scope.setIds.length}
                  onClick={() =>
                    void act("Running on selected documents…", async () => {
                      const parsed = JSON.parse(input) as Record<string, Json>;
                      const id = crypto.randomUUID();
                      runningId.current = id;
                      try {
                        setResult(
                          await api.run({
                            id,
                            key: current.key,
                            input: parsed,
                            scope,
                          }),
                        );
                        await refresh();
                      } finally {
                        runningId.current = null;
                      }
                    })
                  }
                >
                  Run tool
                </button>
                {runningId.current && (
                  <button onClick={() => void api.cancel(runningId.current!)}>
                    Stop tool
                  </button>
                )}
                <button
                  disabled={busyNow}
                  onClick={() =>
                    void act("Running example tests…", async () =>
                      setTestResults(await api.testPackage(current.package)),
                    )
                  }
                >
                  Test examples
                </button>
              </div>
              {!current.enabled && (
                <p className="fine">
                  Enable this tool to run it on your selected documents.
                </p>
              )}
              {result && <RunResult result={result} onCite={onCite} />}
              <details>
                <summary>Code and sharing</summary>
                <pre>{current.package.code}</pre>
                <div className="actions">
                  <button disabled={busyNow} onClick={() => copy(current)}>
                    {current.origin.kind === "local"
                      ? "Edit new version"
                      : "Make a local copy"}
                  </button>
                  <button
                    disabled={busyNow}
                    onClick={() =>
                      void act("Exporting tool…", async () => {
                        const exported = await api.exportPackage(current.key);
                        setStatus(
                          exported
                            ? "Exported the tool and synthetic tests. Library documents and run history are not included."
                            : "Export cancelled.",
                        );
                      })
                    }
                  >
                    Export package
                  </button>
                </div>
              </details>
              {current.versions.length > 1 && (
                <details>
                  <summary>Installed versions and rollback</summary>
                  {current.versions.map((v) => (
                    <div className="tool-version" key={v.hash}>
                      <span>
                        v{v.version} · {v.hash.slice(0, 12)}
                      </span>
                      <button
                        disabled={busyNow || v.hash === current.hash}
                        onClick={() =>
                          void act("Restoring saved version…", async () => {
                            await api.rollback(current.key, v.hash);
                            await refresh();
                            setStatus(
                              "Version restored. Enable it when you are ready to use it.",
                            );
                          })
                        }
                      >
                        {v.hash === current.hash
                          ? "Current"
                          : "Use this version"}
                      </button>
                    </div>
                  ))}
                </details>
              )}
              {current.origin.kind !== "bundled" && (
                <button
                  className="danger"
                  disabled={busyNow}
                  onClick={() => {
                    if (
                      confirm(
                        `Remove ${current.package.manifest.name} and its installed versions?`,
                      )
                    )
                      void act("Removing tool…", async () => {
                        await api.remove(current.key);
                        setSelected(null);
                        await refresh();
                      });
                  }}
                >
                  Remove tool
                </button>
              )}
            </section>
          )}
        </div>
      )}
      {tab === "history" && (
        <div className="tool-history">
          <h3>Recent runs on this computer</h3>
          <p className="fine">
            The latest 100 runs retain their tool version, inputs, coverage, and
            evidence. Runs are included in library backups.
          </p>
          {runs.length ? (
            runs.map((r) => (
              <RunResult key={r.record.id} result={r} onCite={onCite} />
            ))
          ) : (
            <p>No tools have run on your library yet.</p>
          )}
        </div>
      )}
    </section>
  );
}
