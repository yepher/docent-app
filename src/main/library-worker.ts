import { parentPort, workerData } from "node:worker_threads";
import { parseFile } from "./ingest/parse";
import { buildTopics } from "./topics";
import { renderImage, renderPdfPage } from "./vision-render";
async function run() {
  if (workerData.kind === "vision")
    return workerData.page == null
      ? renderImage(workerData.bytes)
      : renderPdfPage(workerData.bytes, workerData.page);
  if (workerData.kind === "parse") return parseFile(workerData.path);
  if (workerData.kind === "rank")
    return workerData.vectors.map((v: Float32Array) =>
      v.reduce((sum, x, i) => sum + x * workerData.q[i], 0),
    );
  const texts = new Map<number, string>(workerData.texts);
  return buildTopics(
    workerData.passages,
    (ids) => new Map(ids.map((id) => [id, texts.get(id) ?? ""])),
  );
}
run().then(
  (value) => parentPort?.postMessage({ value }),
  (error) =>
    parentPort?.postMessage({ error: String(error?.message ?? error) }),
);
