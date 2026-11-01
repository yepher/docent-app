import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtures = [];
afterEach(() =>
  fixtures
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function fixture({ failingTests = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "docent-release-"));
  fixtures.push(dir);
  const repo = join(dir, "app"),
    remote = join(dir, "remote.git");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  cpSync(
    resolve(import.meta.dirname, "../scripts/release.mjs"),
    join(repo, "scripts/release.mjs"),
  );
  const check = (name, fail = false) =>
    `node -e "require('node:fs').appendFileSync('checks.log', '${name}\\n'); process.exit(${fail ? 1 : 0});"`;
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      {
        name: "release-fixture",
        version: "0.1.0",
        scripts: {
          typecheck: check("typecheck"),
          test: check("test", failingTests),
          build: check("build"),
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify(
      {
        name: "release-fixture",
        version: "0.1.0",
        lockfileVersion: 3,
        packages: { "": { name: "release-fixture", version: "0.1.0" } },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(repo, ".gitignore"), "checks.log\n");
  git(repo, "init", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Release test"],
    ["user.email", "release@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", join(dir, "no-hooks")],
  ])
    git(repo, "config", key, value);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Initial fixture");
  git(dir, "init", "--bare", remote);
  git(remote, "config", "user.name", "Release test");
  git(remote, "config", "user.email", "release@example.invalid");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  const head = git(repo, "rev-parse", "HEAD");
  const release = (...args) =>
    spawnSync(process.execPath, ["scripts/release.mjs", ...args], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30000,
    });
  const pkg = () =>
    JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  return { repo, remote, head, release, pkg };
}
const passed = (result) =>
  expect(result.status, result.stdout + result.stderr).toBe(0);

describe("release command (temporary local Git remotes only)", () => {
  it("previews a patch bump without changes, checks, or a reachable remote", () => {
    const f = fixture();
    git(f.repo, "remote", "set-url", "origin", join(f.repo, "nonexistent.git"));
    writeFileSync(join(f.repo, "unfinished.txt"), "work in progress");
    const result = f.release("--dry-run");
    passed(result);
    expect(result.stdout).toContain("0.1.0 -> 0.1.1");
    expect(f.pkg().version).toBe("0.1.0");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
    expect(git(f.repo, "tag", "--list")).toBe("");
  });
  it("defaults to patch, updates all version fields, and pushes the matching commit and annotated tag", () => {
    const f = fixture();
    git(
      f.repo,
      "tag",
      "-a",
      "unrelated-local-tag",
      "-m",
      "Keep this tag local",
    );
    git(f.repo, "config", "push.followTags", "true");
    passed(f.release());
    expect(f.pkg().version).toBe("0.1.1");
    const lock = JSON.parse(
      readFileSync(join(f.repo, "package-lock.json"), "utf8"),
    );
    expect([lock.version, lock.packages[""].version]).toEqual([
      "0.1.1",
      "0.1.1",
    ]);
    expect(readFileSync(join(f.repo, "checks.log"), "utf8")).toBe(
      "typecheck\ntest\nbuild\n",
    );
    const commit = git(f.repo, "rev-parse", "HEAD");
    expect(git(f.remote, "rev-parse", "refs/heads/main")).toBe(commit);
    expect(git(f.remote, "rev-parse", "v0.1.1^{commit}")).toBe(commit);
    expect(git(f.remote, "cat-file", "-t", "v0.1.1")).toBe("tag");
    expect(git(f.remote, "tag", "--list")).toBe("v0.1.1");
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  }, 30000);
  it("accepts an explicit version with an optional v prefix", () => {
    const f = fixture();
    passed(f.release("v1.2.3"));
    expect(f.pkg().version).toBe("1.2.3");
    expect(git(f.remote, "tag", "--list")).toBe("v1.2.3");
  }, 30000);
  it("rejects malformed, equal, or older versions and extra arguments", () => {
    const f = fixture();
    for (const args of [
      ["0.1.0"],
      ["0.0.9"],
      ["01.2.3"],
      ["1.0.0-beta.1"],
      ["1.2"],
      ["--unknown"],
      ["1.0.0", "2.0.0"],
    ]) {
      expect(f.release(...args).status).not.toBe(0);
    }
    expect(f.pkg().version).toBe("0.1.0");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
  });
  it("requires clean work and an unused local/remote tag", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "unfinished.txt"), "work");
    expect(f.release().stderr).toContain("Commit or stash");
    rmSync(join(f.repo, "unfinished.txt"));
    git(f.repo, "tag", "v0.1.1");
    expect(f.release().stderr).toContain("already exists locally");
    git(f.repo, "tag", "-d", "v0.1.1");
    git(f.remote, "tag", "v0.1.1", "refs/heads/main");
    expect(f.release().stderr).toContain("already exists on origin");
    expect(f.pkg().version).toBe("0.1.0");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
  });
  it("rejects a branch that is behind origin before changing the version", () => {
    const f = fixture();
    const tree = git(f.remote, "rev-parse", "main^{tree}");
    const advanced = git(
      f.remote,
      "commit-tree",
      tree,
      "-p",
      f.head,
      "-m",
      "Remote change",
    );
    git(f.remote, "update-ref", "refs/heads/main", advanced);
    expect(f.release().stderr).toContain("Pull/rebase");
    expect(f.pkg().version).toBe("0.1.0");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
  });
  it("does not bump or publish when a validation command fails", () => {
    const f = fixture({ failingTests: true });
    expect(f.release().status).not.toBe(0);
    expect(f.pkg().version).toBe("0.1.0");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
    expect(git(f.remote, "tag", "--list")).toBe("");
    expect(readFileSync(join(f.repo, "checks.log"), "utf8")).toBe(
      "typecheck\ntest\n",
    );
  }, 30000);
  it("keeps local recovery work without pushing when the server cannot perform atomic updates", () => {
    const f = fixture();
    git(f.remote, "config", "receive.advertiseAtomic", "false");
    const result = f.release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "local release commit and v0.1.1 were kept",
    );
    expect(f.pkg().version).toBe("0.1.1");
    expect(git(f.repo, "tag", "--list")).toBe("v0.1.1");
    expect(git(f.remote, "rev-parse", "refs/heads/main")).toBe(f.head);
    expect(git(f.remote, "tag", "--list")).toBe("");
  }, 30000);
});
