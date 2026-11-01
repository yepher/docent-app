import { Worker } from "node:worker_threads";
import { join } from "node:path";
const workers = new Set<Worker>();
export function libraryWork<T>(data: object, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(join(import.meta.dirname, "library-worker.js"), {
      workerData: data,
    });
    workers.add(worker);
    const abort = () => {
      reject(new Error("Stopped."));
      void worker.terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => {
        reject(new Error("Library processing timed out."));
        void worker.terminate();
      },
      10 * 60 * 1000,
    );
    worker.once("message", (result) => {
      result.error ? reject(new Error(result.error)) : resolve(result.value);
      void worker.terminate();
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      clearTimeout(timer);
      workers.delete(worker);
      signal?.removeEventListener("abort", abort);
      if (code) reject(new Error("Library worker stopped."));
    });
  });
}
export function stopLibraryWorkers() {
  for (const worker of workers) void worker.terminate();
}
