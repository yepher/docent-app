// This host worker never evaluates package JavaScript in Node. Only QuickJS/WASM sees it.
import { parentPort, workerData } from "node:worker_threads";
import { newAsyncContext } from "quickjs-emscripten";

const pending = new Map();
let sequence = 0;
parentPort.on("message", ({ id, value, error }) => {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  error ? request.reject(new Error(error)) : request.resolve(value);
});
const request = (method, args) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    if (id > 50000)
      return reject(new Error("Tool exceeded its document API call limit."));
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "request", id, method, args });
  });

let vm;
try {
  vm = await newAsyncContext();
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + workerData.timeoutMs;
  vm.runtime.setInterruptHandler(() => Date.now() > deadline);
  const bridge = vm.newAsyncifiedFunction(
    "documentApi",
    async (method, args) => {
      const name = vm.getString(method);
      const json = vm.getString(args);
      if (json.length > 20000)
        throw new Error("Document API arguments are too large.");
      const result = await request(name, JSON.parse(json));
      return vm.newString(result);
    },
  );
  vm.setProp(vm.global, "__docentCall", bridge);
  bridge.dispose();
  const input = vm.newString(JSON.stringify(workerData.input));
  vm.setProp(vm.global, "__docentInput", input);
  input.dispose();
  const source = `(() => {
    "use strict";
    const call = __docentCall;
    const input = JSON.parse(__docentInput);
    delete globalThis.__docentCall;
    delete globalThis.__docentInput;
    const library = Object.freeze({
      documents: (offset = 0, limit = 200) => JSON.parse(call("documents", JSON.stringify([offset, limit]))),
      read: (id, offset = 0, limit = 50) => JSON.parse(call("read", JSON.stringify([id, offset, limit]))),
      search: (query, limit = 20) => JSON.parse(call("search", JSON.stringify([query, limit]))),
      references: (id) => JSON.parse(call("references", JSON.stringify([id])))
    });
    ${workerData.code}
    if (typeof run !== "function") throw new Error("Define function run(input, library).");
    const output = run(input, library);
    if (output && typeof output.then === "function") throw new Error("run must be synchronous; the document API handles paging internally.");
    const encoded = JSON.stringify(output);
    if (typeof encoded !== "string" || encoded.length > 65536) throw new Error("Tool output must be JSON under 64 KB.");
    return encoded;
  })()`;
  const result = await vm.evalCodeAsync(source, "tool.js");
  if (result.error) {
    const error = vm.dump(result.error);
    result.error.dispose();
    throw new Error(error?.message ?? String(error));
  }
  const output = vm.getString(result.value);
  result.value.dispose();
  parentPort.postMessage({ type: "result", value: output });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    error: String(error?.message ?? error).slice(0, 1000),
  });
} finally {
  try {
    vm?.dispose();
  } catch {
    /* The outer worker is terminated after every run. */
  }
  parentPort.close();
}
