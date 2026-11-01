#!/usr/bin/env node
// Bump, commit, and push one release tag. GitHub Actions builds and publishes the installers.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const usage = `Usage: npm run release -- [version] [--dry-run]

  npm run release                 Bump the patch version: 0.1.0 -> 0.1.1
  npm run release -- 0.2.0         Release a specific higher version
  npm run release -- --dry-run    Preview without changes or network access

Commit your changes and release notes first. The script runs typecheck, tests,
and build, updates package.json and package-lock.json, commits, tags, and pushes
the current branch and that tag atomically to origin. GitHub Actions publishes
the release after every platform builds successfully.`;

function run(command, args, live = false) {
  try {
    return (
      execFileSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: live ? "inherit" : ["ignore", "pipe", "pipe"],
        // Direct invocation on Windows needs the npm command shim; npm run supplies npm_execpath.
        shell: process.platform === "win32" && command === "npm.cmd",
      }) ?? ""
    ).trim();
  } catch (error) {
    const detail =
      !live && error.stderr ? `\n${String(error.stderr).trim()}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail}`);
  }
}
const git = (...args) => run("git", args);
const npm = (args) =>
  process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], true)
    : run(process.platform === "win32" ? "npm.cmd" : "npm", args, true);
const clean = () => {
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error(
      "Commit or stash all changes, including release notes, before releasing.",
    );
};
function version(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    throw new Error(
      "Use a stable version such as 0.1.1 or 1.0.0 (major.minor.patch).",
    );
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger))
    throw new Error("Version components are too large.");
  return parts;
}
function newer(next, current) {
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

let phase = "preflight",
  tag;
try {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => arg !== "--dry-run");
  if (positional.length > 1 || positional.some((arg) => arg.startsWith("-")))
    throw new Error(usage);
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  );
  const current = version(pkg.version);
  const target =
    positional[0]?.replace(/^v/, "") ??
    `${current[0]}.${current[1]}.${current[2] + 1}`;
  if (!newer(version(target), current))
    throw new Error(`The release version must be higher than ${pkg.version}.`);
  if (
    lock.version !== pkg.version ||
    lock.packages?.[""]?.version !== pkg.version
  )
    throw new Error(
      "package.json and package-lock.json versions disagree. Run npm install and commit the fix first.",
    );
  tag = `v${target}`;
  const branch = git("symbolic-ref", "--quiet", "--short", "HEAD");
  const head = git("rev-parse", "HEAD");
  git("remote", "get-url", "--push", "origin");
  if (git("tag", "--list", tag))
    throw new Error(`Tag ${tag} already exists locally. Choose a new version.`);

  console.log(`Docent ${pkg.version} -> ${target} on ${branch}`);
  if (dryRun) {
    console.log(`Would run typecheck, tests, and build; update both package files;
commit "Release ${tag}"; create annotated tag ${tag}; and atomically push
${branch} and ${tag} to origin to trigger the Release workflow.
Dry run: no files, commits, tags, remote checks, or network requests were made.
An actual release requires a clean checkout and an unused remote tag.`);
    process.exit(0);
  }

  clean();
  git("ls-files", "--error-unmatch", "package.json", "package-lock.json");
  git("var", "GIT_AUTHOR_IDENT");
  git("var", "GIT_COMMITTER_IDENT");
  const refs = git(
    "ls-remote",
    "origin",
    `refs/heads/${branch}`,
    `refs/tags/${tag}`,
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  if (refs.some(([, ref]) => ref === `refs/tags/${tag}`))
    throw new Error(
      `Tag ${tag} already exists on origin. Choose a new version.`,
    );
  const remoteHead = refs.find(
    ([, ref]) => ref === `refs/heads/${branch}`,
  )?.[0];
  if (remoteHead) {
    git("fetch", "--no-tags", "origin", `refs/heads/${branch}`);
    try {
      git("merge-base", "--is-ancestor", "FETCH_HEAD", head);
    } catch {
      throw new Error(
        `Your branch does not include origin/${branch}. Pull/rebase before releasing.`,
      );
    }
  }

  console.log("Checking the release…");
  npm(["run", "typecheck"]);
  npm(["test"]);
  npm(["run", "build"]);
  clean();
  if (
    git("rev-parse", "HEAD") !== head ||
    git("symbolic-ref", "--short", "HEAD") !== branch
  )
    throw new Error(
      "The checkout changed during validation. Run the release again.",
    );

  phase = "writing";
  pkg.version = lock.version = lock.packages[""].version = target;
  writeFileSync(
    resolve(root, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  writeFileSync(
    resolve(root, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );
  phase = "committing";
  run("git", ["add", "--", "package.json", "package-lock.json"], true);
  run(
    "git",
    [
      "commit",
      "-m",
      `Release ${tag}`,
      "--only",
      "--",
      "package.json",
      "package-lock.json",
    ],
    true,
  );
  phase = "tagging";
  run("git", ["tag", "-a", tag, "-m", `Docent ${target}`], true);
  const releaseHead = git("rev-parse", "HEAD");
  phase = "pushing";
  // One atomic push publishes only this branch and tag; never force-push or push unrelated tags.
  run(
    "git",
    [
      "push",
      "--atomic",
      "--no-follow-tags",
      "origin",
      `${releaseHead}:refs/heads/${branch}`,
      `refs/tags/${tag}:refs/tags/${tag}`,
    ],
    true,
  );
  console.log(`Release ${tag} queued. GitHub Actions will publish it after all platform builds pass.
Check the repository's Actions > Release page for progress.`);
} catch (error) {
  console.error(`Release stopped: ${error.message}`);
  if (phase === "pushing")
    console.error(`The local release commit and ${tag} were kept. Check origin before retrying; a lost connection can hide a successful push.
After resolving the push error, retry from this branch with: git push --atomic --no-follow-tags origin HEAD ${tag}`);
  else if (phase === "tagging")
    console.error(
      `The version commit was kept. Resolve the tag error, then create ${tag} and push the branch and tag.`,
    );
  else if (phase === "writing" || phase === "committing")
    console.error(
      "Version edits were kept for review. Inspect git status before retrying; nothing was pushed.",
    );
  process.exitCode = 1;
}
