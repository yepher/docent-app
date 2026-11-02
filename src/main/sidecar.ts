import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { createServer } from 'node:net';
import type { Endpoint } from './llm';

const STARTUP_TIMEOUT_MS = 180_000;

export interface SidecarOptions {
  name: string;
  binary: string;
  args: string[];
  onExit?: (message: string) => void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No port'))));
    });
  });
}

/**
 * Runs llama-server bound to loopback. The key is per-launch and passed by environment, so
 * neither web pages in a browser nor other users' process listings can reach the model.
 */
export class Sidecar {
  private child: ChildProcess | null = null;
  private stopping = false;
  private log = '';
  endpoint: Endpoint | null = null;

  constructor(private options: SidecarOptions) {}

  async start(): Promise<Endpoint> {
    const { binary, args, name, onExit } = this.options;
    const port = await freePort();
    const apiKey = randomBytes(24).toString('hex');
    const libDir = dirname(binary);
    const child = spawn(binary, [...args, '--host', '127.0.0.1', '--port', String(port), '--no-webui'], {
      cwd: libDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        LLAMA_API_KEY: apiKey,
        LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      },
    });
    this.child = child;
    const capture = (data: Buffer) => {
      this.log = (this.log + data.toString()).slice(-4000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let exited: string | null = null;
    child.once('error', (err) => {
      exited = `${name} could not start: ${err.message}`;
    });
    child.once('exit', (code) => {
      this.child = null;
      this.endpoint = null;
      exited ??= `${name} stopped unexpectedly (exit ${code}).\n${this.log.slice(-600)}`;
      if (!this.stopping) onExit?.(exited);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(exited);
      try {
        // /health answers 503 while the model loads and 200 once it is ready.
        if ((await fetch(`${baseUrl}/health`)).ok) {
          this.endpoint = { baseUrl, apiKey };
          return this.endpoint;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.stop();
    throw new Error(`${name} did not become ready in time.\n${this.log.slice(-600)}`);
  }

  stop() {
    this.stopping = true;
    this.child?.kill();
  }
}

export const llmArgs = (model: string, mmproj: string) => [
  '-m', model,
  '--mmproj', mmproj,
  '--reasoning', 'off', // LFM3-Omni is not a reasoning model; the llama.cpp docs require this.
  '-c', '32768',
  '-np', '2', // One slot writes the answer while the other speaks it.
];

export const embedderArgs = (model: string) => [
  '-m', model,
  '--embedding',
  '--pooling', 'mean',
  '-c', '8192',
  '-b', '8192',
  '-ub', '8192',
  '-np', '2',
];

/** Separate causal cross-encoder; it scores query/passage pairs and never generates answers. */
export const rerankerArgs = (model: string) => [
  "-m",
  model,
  "--reranking",
  "--pooling",
  "rank",
  "-c",
  "8192",
  "-np",
  "2",
  "-b",
  "2048",
  "-ub",
  "512",
];
