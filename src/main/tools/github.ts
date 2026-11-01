import type { ToolPackage, ToolRepository } from "../../shared/tools";
import {
  byteHash,
  MAX_PACKAGE_BYTES,
  validateCatalog,
  validatePackage,
} from "./package";

export function githubRepository(input: string): string {
  const url = new URL(input.trim());
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use a public repository URL: https://github.com/owner/repository",
    );
  const match = /^\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    url.pathname,
  );
  if (!match || match[2] === "." || match[2] === "..")
    throw new Error("Use the repository's main GitHub URL.");
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export type Fetcher = typeof fetch;
export async function downloadJson(
  url: string,
  fetcher: Fetcher = fetch,
): Promise<{ value: unknown; bytes: Uint8Array }> {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Docent-Tools",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(
      `GitHub request failed (${response.status}). ${response.status === 403 || response.status === 429 ? "Try again later; the public API may be rate limited." : "Check that the repository and tool collection are public."}`,
    );
  if (Number(response.headers.get("content-length")) > MAX_PACKAGE_BYTES)
    throw new Error("Download exceeds 512 KB.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty GitHub response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PACKAGE_BYTES) throw new Error("Download exceeds 512 KB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  return { value: JSON.parse(bytes.toString("utf8")), bytes };
}

/** Resolve a release tag (or the default branch) once, then fetch every file by immutable commit SHA. */
export async function discoverRepository(
  input: string,
  fetcher: Fetcher = fetch,
): Promise<ToolRepository> {
  const id = githubRepository(input),
    base = `https://api.github.com/repos/${id}`;
  let release: string | undefined;
  try {
    const { value } = await downloadJson(`${base}/releases/latest`, fetcher);
    const tag = (value as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string" || tag.length > 200)
      throw new Error("Invalid GitHub release tag.");
    release = tag;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("(404)"))
      throw error;
  }
  const { value } = await downloadJson(
    `${base}/commits/${encodeURIComponent(release ?? "HEAD")}`,
    fetcher,
  );
  const commit = (value as { sha?: unknown }).sha;
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error("GitHub did not return a commit SHA.");
  const catalog = validateCatalog(
    (
      await downloadJson(
        `https://raw.githubusercontent.com/${id}/${commit}/docent-tools.json`,
        fetcher,
      )
    ).value,
  );
  return {
    id,
    url: `https://github.com/${id}`,
    commit,
    release,
    catalog,
    checkedAt: Date.now(),
  };
}
export async function repositoryPackage(
  repo: ToolRepository,
  id: string,
  fetcher: Fetcher = fetch,
): Promise<ToolPackage> {
  const entry = repo.catalog.tools.find((tool) => tool.id === id);
  if (!entry) throw new Error("Tool is not in this repository's catalog.");
  const { value, bytes } = await downloadJson(
    `https://raw.githubusercontent.com/${repo.id}/${repo.commit}/${entry.file}`,
    fetcher,
  );
  if (byteHash(bytes) !== entry.sha256)
    throw new Error(
      "Package checksum does not match the catalog. Nothing was installed.",
    );
  const pkg = validatePackage(value);
  if (
    pkg.manifest.id !== entry.id ||
    pkg.manifest.version !== entry.version ||
    pkg.manifest.name !== entry.name ||
    pkg.manifest.description !== entry.description
  )
    throw new Error("Package metadata does not match the catalog.");
  return pkg;
}
