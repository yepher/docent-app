import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlamaServerEmbedder, LlamaServerLlm } from '../src/main/llm';
import { type ModelFile, installModels, isInstalled } from '../src/main/models';
import { Sidecar, embedderArgs, llmArgs } from '../src/main/sidecar';

const payload = Buffer.alloc(100_000, 'abc');
const sha = createHash('sha256').update(payload).digest('hex');

let server: Server | undefined;
afterEach(() => server?.close());

function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((done) => {
    server = createServer(handler).listen(0, '127.0.0.1', () => {
      const address = server!.address();
      done(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/f`);
    });
  });
}

const file = (url: string, sha256 = sha): ModelFile => ({ id: 'llm', name: 'f.gguf', url, size: payload.length, sha256 });
const noProgress = () => {};
const tmp = () => mkdtempSync(join(tmpdir(), 'docent-models-'));

describe('installModels', () => {
  it('downloads and verifies a file', async () => {
    const url = await serve((_req, res) => res.end(payload));
    const dir = tmp();
    await installModels(dir, noProgress, undefined, [file(url)]);
    expect(readFileSync(join(dir, 'f.gguf')).equals(payload)).toBe(true);
    expect(isInstalled(dir, [file(url)])).toBe(true);
  });

  it('resumes a partial download with a range request', async () => {
    let range: string | undefined;
    const url = await serve((req, res) => {
      range = req.headers.range;
      res.writeHead(206).end(payload.subarray(40_000));
    });
    const dir = tmp();
    writeFileSync(join(dir, 'f.gguf.part'), payload.subarray(0, 40_000));
    await installModels(dir, noProgress, undefined, [file(url)]);
    expect(range).toBe('bytes=40000-');
    expect(readFileSync(join(dir, 'f.gguf')).equals(payload)).toBe(true);
  });

  it('starts over when the server ignores the range', async () => {
    const url = await serve((_req, res) => res.writeHead(200).end(payload));
    const dir = tmp();
    writeFileSync(join(dir, 'f.gguf.part'), payload.subarray(0, 40_000));
    await installModels(dir, noProgress, undefined, [file(url)]);
    expect(readFileSync(join(dir, 'f.gguf')).equals(payload)).toBe(true);
  });

  it('rejects a corrupt file and leaves nothing installed', async () => {
    const url = await serve((_req, res) => res.end(payload));
    const dir = tmp();
    await expect(installModels(dir, noProgress, undefined, [file(url, 'bad')])).rejects.toThrow(/integrity/);
    expect(existsSync(join(dir, 'f.gguf'))).toBe(false);
    expect(existsSync(join(dir, 'f.gguf.part'))).toBe(false);
  });

  it('reports failed downloads', async () => {
    const url = await serve((_req, res) => res.writeHead(404).end());
    await expect(installModels(tmp(), noProgress, undefined, [file(url)])).rejects.toThrow(/404/);
  });
});

describe('Sidecar against the fake server', () => {
  const fake = resolve(import.meta.dirname, 'fake-llama-server.mjs');

  // Windows cannot spawn a script through its shebang line.
  it.skipIf(process.platform === 'win32')('starts, authenticates, streams, embeds, speaks and transcribes', async () => {
    const sidecar = new Sidecar({ name: 'Fake', binary: fake, args: llmArgs('m', 'p') });
    try {
      const endpoint = await sidecar.start();
      expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);

      const denied = await fetch(`${endpoint.baseUrl}/v1/embeddings`, { method: 'POST', body: '{}' });
      expect(denied.status).toBe(401);

      const llm = new LlamaServerLlm(endpoint);
      let text = '';
      for await (const delta of llm.chat([{ role: 'user', content: 'hi' }], [], new AbortController().signal)) {
        if (delta.type === 'text') text += delta.text;
      }
      expect(text).toBe('Hello from the fake model.');

      const chunks = [];
      for await (const chunk of llm.speak('hi')) chunks.push(chunk);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.sampleRate === 24000 && c.samples.byteLength % 4 === 0)).toBe(true);
      expect(chunks.reduce((sum, c) => sum + c.samples.byteLength, 0)).toBe(96000);
      expect(await llm.transcribe(new ArrayBuffer(8))).toBe('What does the report say?');

      const vectors = await new LlamaServerEmbedder(endpoint).embedDocuments(['a b', 'c']);
      expect(vectors).toHaveLength(2);
    } finally {
      sidecar.stop();
    }
  });

  it('reports a binary that cannot start', async () => {
    const sidecar = new Sidecar({ name: 'Missing', binary: '/nonexistent/llama-server', args: embedderArgs('m') });
    await expect(sidecar.start()).rejects.toThrow(/could not start/);
  });
});
