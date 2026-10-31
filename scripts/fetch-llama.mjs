#!/usr/bin/env node
// Downloads the pinned llama.cpp build for one platform into vendor/llama/current,
// verifies its SHA-256, and writes the third-party notices the release must carry.
// Usage: node scripts/fetch-llama.mjs [platform] [arch]   (defaults to this machine)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BUILD = 'b12023';
const ASSETS = {
  'darwin-arm64': ['macos-arm64.tar.gz', 'fc96758435dad27d9308ffd8192a6307766f6460058624d63b2e9937c1791386'],
  'darwin-x64': ['macos-x64.tar.gz', 'bd047fbc0b0924e07fa5f4deef122893ade3a80b61c679e5d6bbb8d7cdcd9eb3'],
  'linux-x64': ['ubuntu-vulkan-x64.tar.gz', 'bead00a00ebca6e521e8cee8b7377e817ba0da295b7ed59a390d108bc206277d'],
  'win32-x64': ['win-vulkan-x64.zip', '99afa5556bbc0206ed1d4d0cc7ac56200c5080cc81e4a2f5a08367ae48b33625'],
};

const key = `${process.argv[2] ?? process.platform}-${process.argv[3] ?? process.arch}`;
const asset = ASSETS[key];
if (!asset) throw new Error(`No llama.cpp build pinned for ${key}`);
const [suffix, sha256] = asset;

const root = resolve(import.meta.dirname, '..');
const name = `llama-${BUILD}-bin-${suffix}`;
const work = join(root, 'vendor', 'llama', `.work-${key}`);
const dest = join(root, 'vendor', 'llama', 'current');
rmSync(work, { recursive: true, force: true });
rmSync(dest, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

console.log(`Fetching ${name}`);
const res = await fetch(`https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${name}`);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const bytes = Buffer.from(await res.arrayBuffer());
const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== sha256) throw new Error(`SHA-256 mismatch for ${name}: ${actual}`);

const archive = join(work, name);
writeFileSync(archive, bytes);
// bsdtar handles .zip on Windows and macOS; on Linux only .tar.gz is ever used.
execFileSync('tar', ['-xf', archive, '-C', work], { stdio: 'inherit' });
rmSync(archive);

// Some builds nest everything in one directory; llama-server's folder is the root we want.
function findServer(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'llama-server' || entry === 'llama-server.exe') return dir;
    if (statSync(path).isDirectory()) {
      const found = findServer(path);
      if (found) return found;
    }
  }
  return null;
}
const serverDir = findServer(work);
if (!serverDir) throw new Error(`llama-server not found in ${name}`);
// Rename, not cpSync: cp rewrites the relative .dylib/.so symlinks as absolute paths into `work`,
// which leaves them dangling once `work` is deleted.
renameSync(serverDir, dest);
rmSync(work, { recursive: true, force: true });

writeFileSync(
  join(root, 'vendor', 'THIRD_PARTY_NOTICES.md'),
  `# Third-party notices

llama.cpp ${BUILD} (MIT License), https://github.com/ggml-org/llama.cpp, ships inside this app.

Downloaded on first run, not included in the app:

- LFM3-Omni-2B, Liquid AI, LFM Open License v1.0:
  https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF
- nomic-embed-text v1.5, Nomic AI, Apache-2.0:
  https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF
`,
);
console.log(`Installed llama.cpp ${BUILD} for ${key} in ${dest}`);
