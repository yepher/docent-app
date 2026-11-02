import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Api } from "../shared/types";

function subscribe<T>(channel: string, cb: (value: T) => void) {
  const listener = (_e: unknown, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.off(channel, listener);
}

const api: Api = {
  reranker: {
    state: () => ipcRenderer.invoke("reranker:state"),
    install: () => ipcRenderer.invoke("reranker:install"),
    enable: (enabled) => ipcRenderer.invoke("reranker:enable", enabled),
    onState: (cb) => subscribe("reranker:state", cb),
  },
  vision: {
    attach: (bytes, name) => ipcRenderer.invoke("vision:attach", bytes, name),
    preview: (source) => ipcRenderer.invoke("vision:preview", source),
  },
  imports: {
    drop: (files) =>
      ipcRenderer.invoke(
        "imports:drop",
        files.map((file) => webUtils.getPathForFile(file)),
      ),
    pending: () => ipcRenderer.invoke("imports:pending"),
    confirm: (id, destination) =>
      ipcRenderer.invoke("imports:confirm", id, destination),
    dismiss: (id) => ipcRenderer.invoke("imports:dismiss", id),
    onPending: (cb) => subscribe("imports:pending", cb),
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  },
  tools: {
    list: () => ipcRenderer.invoke("tools:list"),
    repositories: () => ipcRenderer.invoke("tools:repositories"),
    addRepository: (url) => ipcRenderer.invoke("tools:addRepository", url),
    checkRepository: (id) => ipcRenderer.invoke("tools:checkRepository", id),
    removeRepository: (id) => ipcRenderer.invoke("tools:removeRepository", id),
    prepareRepository: (id, toolId) =>
      ipcRenderer.invoke("tools:prepareRepository", id, toolId),
    importPackage: () => ipcRenderer.invoke("tools:importPackage"),
    prepareLocal: (pkg) => ipcRenderer.invoke("tools:prepareLocal", pkg),
    install: (token) => ipcRenderer.invoke("tools:install", token),
    enable: (key, enabled) => ipcRenderer.invoke("tools:enable", key, enabled),
    rollback: (key, hash) => ipcRenderer.invoke("tools:rollback", key, hash),
    remove: (key) => ipcRenderer.invoke("tools:remove", key),
    exportPackage: (key) => ipcRenderer.invoke("tools:exportPackage", key),
    testPackage: (pkg) => ipcRenderer.invoke("tools:testPackage", pkg),
    run: (req) => ipcRenderer.invoke("tools:run", req),
    cancel: (id) => ipcRenderer.invoke("tools:cancel", id),
    runs: () => ipcRenderer.invoke("tools:runs"),
  },
  platform: process.platform,
  runtime: {
    restart: () => ipcRenderer.invoke("runtime:restart"),
    state: () => ipcRenderer.invoke("runtime:state"),
    install: () => ipcRenderer.invoke("runtime:install"),
    onState: (cb) => subscribe("runtime:state", cb),
  },
  sets: {
    list: () => ipcRenderer.invoke("sets:list"),
    create: (name) => ipcRenderer.invoke("sets:create", name),
    rename: (id, name) => ipcRenderer.invoke("sets:rename", id, name),
    remove: (id) => ipcRenderer.invoke("sets:remove", id),
    select: (id, selected) => ipcRenderer.invoke("sets:select", id, selected),
    addFiles: (id) => ipcRenderer.invoke("sets:addFiles", id),
    addFolder: (id) => ipcRenderer.invoke("sets:addFolder", id),
    cancel: (id) => ipcRenderer.invoke("sets:cancel", id),
    rescan: (id) => ipcRenderer.invoke("sets:rescan", id),
    documents: (id) => ipcRenderer.invoke("sets:documents", id),
    removeDocument: (id) => ipcRenderer.invoke("sets:removeDocument", id),
    report: (id) => ipcRenderer.invoke("sets:report", id),
    topics: (id) => ipcRenderer.invoke("topics:get", id),
    onTopicsChanged: (cb) => subscribe("topics:changed", cb),
    onProgress: (cb) => subscribe("sets:progress", cb),
  },
  chat: {
    conversations: () => ipcRenderer.invoke("chat:conversations"),
    save: (c) => ipcRenderer.invoke("chat:save", c),
    remove: (id) => ipcRenderer.invoke("chat:remove", id),
    send: (req) => ipcRenderer.invoke("chat:send", req),
    transcribe: (wav) => ipcRenderer.invoke("chat:transcribe", wav),
    readAloud: (id, text) => ipcRenderer.invoke("chat:readAloud", id, text),
    cancel: (turnId) => ipcRenderer.invoke("chat:cancel", turnId),
    onEvent: (cb) => subscribe("chat:event", cb),
  },
  pronunciations: {
    list: () => ipcRenderer.invoke("pronunciations:list"),
    set: (word, spoken) =>
      ipcRenderer.invoke("pronunciations:set", word, spoken),
    remove: (word) => ipcRenderer.invoke("pronunciations:remove", word),
    preview: (spoken) => ipcRenderer.invoke("pronunciations:preview", spoken),
  },
  library: {
    search: (req) => ipcRenderer.invoke("library:search", req),
    backup: () => ipcRenderer.invoke("library:backup"),
    restore: () => ipcRenderer.invoke("library:restore"),
  },
  docs: {
    passages: (id) => ipcRenderer.invoke("docs:passages", id),
    open: (id) => ipcRenderer.invoke("docs:open", id),
    reveal: (id) => ipcRenderer.invoke("docs:reveal", id),
    pdf: (id, version) => ipcRenderer.invoke("docs:pdf", id, version),
  },
  update: {
    check: () => ipcRenderer.invoke("update:check"),
    onState: (cb) => subscribe("update:state", cb),
    install: () => ipcRenderer.invoke("update:install"),
    openReleases: () => ipcRenderer.invoke("update:releases"),
  },
};

contextBridge.exposeInMainWorld("api", api);
