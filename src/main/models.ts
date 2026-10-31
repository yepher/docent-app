import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ModelFile {
  id: 'llm' | 'mmproj' | 'embedder';
  name: string;
  url: string;
  size: number;
  sha256: string;
}

const LFM = 'https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/resolve/3d29af2ad166f8299c2d820937e47dc0add20ffc';
const NOMIC = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/0188c9bf409793f810680a5a431e7b899c46104c';

/** Pinned by commit and hash, so a release always runs the exact weights it was tested with. */
export const MODEL_FILES: ModelFile[] = [
  {
    id: 'llm',
    name: 'LFM3-Omni-2B-Q4_K_M.gguf',
    url: `${LFM}/LFM3-Omni-2B-Q4_K_M.gguf`,
    size: 1099630080,
    sha256: '9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2',
  },
  {
    id: 'mmproj',
    name: 'mmproj-LFM3-Omni-2B-Q8_0.gguf',
    url: `${LFM}/mmproj-LFM3-Omni-2B-Q8_0.gguf`,
    size: 506842528,
    sha256: '8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1',
  },
  {
    id: 'embedder',
    name: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
    url: `${NOMIC}/nomic-embed-text-v1.5.Q4_K_M.gguf`,
    size: 84106624,
    sha256: 'd4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac',
  },
];

export type ProgressFn = (p: { file: string; loaded: number; total: number }) => void;

export function isInstalled(dir: string, files = MODEL_FILES): boolean {
  return files.every((f) => existsSync(join(dir, f.name)));
}

export async function missingBytes(dir: string, files = MODEL_FILES): Promise<number> {
  return files.filter((f) => !existsSync(join(dir, f.name))).reduce((sum, f) => sum + f.size, 0);
}

export async function freeBytes(dir: string): Promise<number | null> {
  try {
    await mkdir(dir, { recursive: true });
    const fs = await statfs(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Downloads every missing file. Interrupted downloads resume from the .part file. */
export async function installModels(
  dir: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
  files = MODEL_FILES,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const needed = await missingBytes(dir, files);
  const free = await freeBytes(dir);
  if (free !== null && free < needed) {
    throw new Error(`Not enough disk space: ${needed} bytes needed, ${free} free.`);
  }

  for (const file of files) {
    const target = join(dir, file.name);
    if (existsSync(target)) continue;
    const part = `${target}.part`;
    let start = existsSync(part) ? (await stat(part)).size : 0;
    if (start > file.size) {
      await rm(part);
      start = 0;
    }

    if (start < file.size) {
      const res = await fetchFn(file.url, {
        headers: start > 0 ? { range: `bytes=${start}-` } : {},
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`Could not download ${file.name} (${res.status})`);
      // A server that ignores Range sends the whole file, so start over rather than append.
      if (res.status !== 206) start = 0;
      let loaded = start;
      const meter = new Transform({
        transform(data: Buffer, _enc, done) {
          loaded += data.length;
          onProgress({ file: file.name, loaded, total: file.size });
          done(null, data);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as never),
        meter,
        createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }),
        { signal },
      );
    }

    onProgress({ file: file.name, loaded: file.size, total: file.size });
    const actual = await sha256Of(part);
    if (actual !== file.sha256) {
      await rm(part);
      throw new Error(`${file.name} failed its integrity check. Please try again.`);
    }
    await rename(part, target);
  }
}
