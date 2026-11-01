import { Worker } from "node:worker_threads";
import type { Json } from "../../shared/tools";

export type DocumentHost = (
  method: string,
  args: unknown[],
) => unknown | Promise<unknown>;
const workers = new Set<Worker>();
export function stopToolWorkers() {
  for (const worker of workers) void worker.terminate();
}

export function runIsolated(
  code: string,
  input: Record<string, Json>,
  host: DocumentHost,
  options: {
    signal?: AbortSignal;
    workerPath?: string | URL;
    timeoutMs?: number;
  } = {},
): Promise<{ data: Json; evidence: string[] }> {
  options.signal?.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(input)) > 64000)
    throw new Error("Tool input is too large.");
  const timeoutMs = options.timeoutMs ?? 30000;
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      options.workerPath ?? new URL("./worker.mjs", import.meta.url),
      {
        workerData: { code, input, timeoutMs },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      },
    );
    workers.add(worker);
    let settled = false;
    const finish = (
      error?: Error,
      value?: { data: Json; evidence: string[] },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      workers.delete(worker);
      void worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(new Error("Tool run cancelled."));
    const timer = setTimeout(
      () => finish(new Error("Tool exceeded its time limit.")),
      timeoutMs + 1000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.on("message", async (message) => {
      if (settled) return;
      if (message.type === "request") {
        try {
          if (!Array.isArray(message.args))
            throw new Error("Invalid tool API request.");
          const result = JSON.stringify(
            await host(String(message.method), message.args),
          );
          if (Buffer.byteLength(result) > 2 * 1024 * 1024)
            throw new Error(
              "Document API response is too large; use smaller pages.",
            );
          if (!settled) worker.postMessage({ id: message.id, value: result });
        } catch (error) {
          if (!settled)
            worker.postMessage({
              id: message.id,
              error: String(
                error instanceof Error ? error.message : error,
              ).slice(0, 1000),
            });
        }
      } else if (message.type === "error") finish(new Error(message.error));
      else if (message.type === "result") {
        try {
          if (typeof message.value !== "string" || message.value.length > 65536)
            throw new Error("Invalid tool output.");
          const result = JSON.parse(message.value);
          if (
            !result ||
            typeof result !== "object" ||
            result.data === undefined ||
            !Array.isArray(result.evidence) ||
            result.evidence.length > 100 ||
            result.evidence.some(
              (id: unknown) => typeof id !== "string" || !/^p\d+$/.test(id),
            )
          )
            throw new Error(
              "Return { data: JSON, evidence: passageIDs[] } with at most 100 evidence links.",
            );
          finish(undefined, {
            data: result.data,
            evidence: [...new Set<string>(result.evidence)],
          });
        } catch (error) {
          finish(error as Error);
        }
      }
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => {
      if (!settled)
        finish(new Error("Tool worker stopped before returning a result."));
    });
  });
}
