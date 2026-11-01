import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} from "electron";
import { access, readFile, rename, rm } from "node:fs/promises";
import { backup, DatabaseSync } from "node:sqlite";
import { libraryWork, stopLibraryWorkers } from "./workers";
import type { BuiltTopics } from "./topics";
import type { Segment } from "./ingest/chunk";
import type { Conversation, Citation, SearchRequest } from "../shared/types";
import { extname, join } from "node:path";
import { isViewable } from "../shared/files";
import type { ChatTurn, DocSet, RuntimeState } from "../shared/types";
import { documentTools } from "./analysis-tools";
import { runTurn } from "./agent";
import { indexSet } from "./ingest";
import { PARSER_VERSION } from "./ingest/parse";
import {
  type Embedder,
  LlamaServerEmbedder,
  LlamaServerLlm,
  type Llm,
} from "./llm";
import {
  MODEL_FILES,
  freeBytes,
  installModels,
  isInstalled,
  missingBytes,
} from "./models";
import { applyPronunciations } from "./pronunciation";
import { Retriever } from "./retrieval";
import { Sidecar, embedderArgs, llmArgs } from "./sidecar";
import { Store } from "./store";
import {
  MIN_PASSAGES_FOR_TOPICS,
  TOPIC_MAP_VERSION,
  buildTopics,
  describeTopic,
} from "./topics";
import { startUpdater } from "./updater";
import { ToolManager } from "./tools/manager";
import { registerToolIpc } from "./tools/ipc";
import { stopToolWorkers } from "./tools/sandbox";

const RELEASES_URL = "https://github.com/yepher/docent-app/releases";
const dev = !app.isPackaged;
const MAX_WORD_CHARS = 60;
const MAX_SPOKEN_CHARS = 200;
const DESCRIBE_TIMEOUT_MS = 120_000;

// Test overrides exist only in unpackaged builds, so a shipped app cannot be redirected by its environment.
const fakeBinary = dev ? process.env.DOCENT_LLAMA_BIN : undefined;
const modelsDir = () => join(app.getPath("userData"), "models");

function llamaBinary(): string {
  if (fakeBinary) return fakeBinary;
  const root = app.isPackaged
    ? join(process.resourcesPath, "llama")
    : join(
        app.getAppPath(),
        "vendor",
        "llama",
        `${process.platform}-${process.arch}`,
      );
  return join(
    root,
    process.platform === "win32" ? "llama-server.exe" : "llama-server",
  );
}

let window: BrowserWindow | null = null;
let store: Store;
let toolManager: ToolManager;
let toolsBusy = () => false;
const createToolManager = () =>
  new ToolManager(store, {
    workerPath: join(app.getAppPath(), "out/main/tool-worker.mjs"),
  });
let llm: Llm | null = null;
let embedder: Embedder | null = null;
let retriever: Retriever | null = null;
let state: RuntimeState = { phase: "starting" };
const sidecars: Sidecar[] = [];
const turns = new Map<string, AbortController>();
let ingest = Promise.resolve();
let libraryJobs = 0;
let booting = false;
const topicJobs = new Set<number>();
const indexing = new Map<number, AbortController>();
const databasePath = () => join(app.getPath("userData"), "library.db");
const citationOf = (c: import("./store").StoredChunk, i: number): Citation => ({
  n: i + 1,
  documentId: c.documentId,
  title: c.title,
  path: c.path,
  setName: c.setName,
  page: c.page,
  line: c.line,
  excerpt: c.text,
  cited: false,
  version: c.version,
  indexedAt: c.indexedAt,
  warning: c.warning,
});

const send = (channel: string, payload: unknown) =>
  window?.webContents.send(channel, payload);

function setState(next: RuntimeState) {
  state = next;
  send("runtime:state", next);
}

async function startRuntime() {
  if (booting) return;
  booting = true;
  sidecars.splice(0).forEach((s) => s.stop());
  llm = null;
  embedder = null;
  retriever = null;
  setState({ phase: "starting" });
  const dir = modelsDir();
  const path = (id: string) =>
    join(dir, MODEL_FILES.find((f) => f.id === id)!.name);
  const onExit = (message: string) => {
    llm = null;
    embedder = null;
    retriever = null;
    setState({ phase: "failed", message });
  };
  const binary = llamaBinary();
  const main = new Sidecar({
    name: "Language model",
    binary,
    args: llmArgs(path("llm"), path("mmproj")),
    onExit,
  });
  const embed = new Sidecar({
    name: "Embedding model",
    binary,
    args: embedderArgs(path("embedder")),
    onExit,
  });
  sidecars.push(main, embed);
  try {
    const [mainEndpoint, embedEndpoint] = await Promise.all([
      main.start(),
      embed.start(),
    ]);
    llm = new LlamaServerLlm(mainEndpoint);
    const client = new LlamaServerEmbedder(embedEndpoint);
    embedder = client;
    retriever = new Retriever(
      store,
      (q) => client.embedQuery(q),
      (q, vectors) => libraryWork<number[]>({ kind: "rank", q, vectors }),
    );
    setState({ phase: "ready" });
    maintainLibrary();
  } catch (err) {
    sidecars.splice(0).forEach((s) => s.stop());
    setState({
      phase: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    booting = false;
  }
}

async function boot() {
  if (fakeBinary || isInstalled(modelsDir())) return startRuntime();
  setState({
    phase: "needs-models",
    downloadBytes: await missingBytes(modelsDir()),
    freeBytes: await freeBytes(modelsDir()),
  });
}

function requireWindow(): BrowserWindow {
  if (!window) throw new Error("No window");
  return window;
}

/** Rebuilds a set's topics if its passages changed. Slow on large sets, so it yields as it works. */
async function updateTopics(setId: number) {
  const fingerprint = `${TOPIC_MAP_VERSION}:${store.passageFingerprint(setId)}`;
  if (store.topicFingerprint(setId) !== fingerprint) {
    const passages = store.passages(setId);
    if (passages.length < MIN_PASSAGES_FOR_TOPICS)
      return store.removeTopicMap(setId);
    const { map, centroids } = await libraryWork<BuiltTopics>({
      kind: "topics",
      passages,
      texts: [...store.chunkTexts(passages.map((p) => p.id))],
    });
    store.saveTopicMap(
      setId,
      fingerprint,
      map,
      centroids,
      passages[0]!.vector.length,
    );
    send("topics:changed", setId);
  }
  if (turns.size === 0) await describeTopics(setId);
}

/**
 * Names topics one at a time and saves each, so quitting partway loses nothing and the map
 * improves as it goes. Topics already described are skipped, including after a restart.
 */
async function describeTopics(setId: number) {
  const map = store.topicMap(setId);
  if (!llm || !map) return;
  const waiting = map.topics.filter((t) => t.summary === null);
  for (const [i, topic] of waiting.entries()) {
    if (turns.size > 0 || !llm) break;
    send("sets:progress", {
      setId,
      done: i,
      total: waiting.length,
      current: `Describing topics, ${i + 1} of ${waiting.length}`,
    });
    const description = await describeTopic(
      llm,
      topic,
      AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
    );
    if (!description) continue;
    topic.label = description.name;
    topic.summary = description.summary;
    store.updateTopicMap(map);
    send("topics:changed", setId);
  }
}

function queueLibraryWork(work: () => Promise<void>) {
  libraryJobs++;
  ingest = ingest
    .then(work)
    .catch((err) => {
      console.error("Indexing failed", err);
      send("sets:progress", {
        setId: 0,
        done: 0,
        total: 0,
        current: null,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      libraryJobs--;
      send("sets:progress", null);
    });
  return ingest;
}

function reindex(setId: number) {
  return queueLibraryWork(async () => {
    if (!embedder) throw new Error("The embedding model is not running.");
    const controller = new AbortController();
    indexing.set(setId, controller);
    try {
      await indexSet(
        store,
        embedder,
        setId,
        (p) => send("sets:progress", p),
        (path) =>
          libraryWork<Segment[]>({ kind: "parse", path }, controller.signal),
        controller.signal,
      );
    } finally {
      indexing.delete(setId);
    }
  });
}

/** Brings every set up to date at launch: files read by an older parser, then missing topics. */
function maintainLibrary() {
  for (const set of store.listSets()) {
    if (store.needsReindex(set.id, PARSER_VERSION)) void reindex(set.id);
  }
}

function registerIpc(update: { install(): void; check(): void }) {
  ipcMain.handle("runtime:restart", () => {
    if (libraryJobs || turns.size)
      throw new Error("Wait for current work to finish.");
    return boot();
  });
  ipcMain.handle("runtime:state", () => state);
  ipcMain.handle("runtime:install", async () => {
    try {
      await installModels(modelsDir(), (p) =>
        setState({ phase: "downloading", ...p }),
      );
      await startRuntime();
    } catch (err) {
      setState({
        phase: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ipcMain.handle("sets:list", () => store.listSets());
  ipcMain.handle(
    "sets:create",
    (_e, name: string): DocSet =>
      store.createSet(String(name).trim() || "Untitled"),
  );
  ipcMain.handle("sets:rename", (_e, id: number, name: string) =>
    store.renameSet(id, name),
  );
  ipcMain.handle("sets:remove", (_e, id: number) => store.removeSet(id));
  ipcMain.handle("sets:select", (_e, id: number, selected: boolean) =>
    store.selectSet(id, selected),
  );
  ipcMain.handle("sets:documents", (_e, id: number) => store.documents(id));
  ipcMain.handle("sets:removeDocument", (_e, id: number) => {
    const setId = store.documentSet(id);
    store.excludeDocument(id);
    if (setId !== null) store.removeTopicMap(setId);
  });
  ipcMain.handle("sets:report", (_e, id: number) => store.report(id));
  ipcMain.handle("topics:get", (_e, setId: number) => {
    if (
      !topicJobs.has(setId) &&
      store
        .listSets()
        .some(
          (s) => s.id === setId && s.chunkCount >= MIN_PASSAGES_FOR_TOPICS,
        ) &&
      store.topicFingerprint(setId) !==
        `${TOPIC_MAP_VERSION}:${store.passageFingerprint(setId)}`
    ) {
      topicJobs.add(setId);
      void queueLibraryWork(() => updateTopics(setId)).finally(() =>
        topicJobs.delete(setId),
      );
    }
    return store.topicMap(setId);
  });
  ipcMain.handle("sets:cancel", (_e, id: number) => indexing.get(id)?.abort());
  ipcMain.handle("sets:rescan", (_e, id: number) => reindex(id));

  const pick = async (id: number, property: "openFile" | "openDirectory") => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      properties: [property, "multiSelections"],
    });
    if (result.canceled) return;
    for (const path of result.filePaths) store.addSource(id, path);
    await reindex(id);
  };
  ipcMain.handle("sets:addFiles", (_e, id: number) => pick(id, "openFile"));
  ipcMain.handle("sets:addFolder", (_e, id: number) =>
    pick(id, "openDirectory"),
  );

  ipcMain.handle("chat:transcribe", async (_e, wav: ArrayBuffer) => {
    if (!llm) throw new Error("The model is not ready.");
    return llm.transcribe(wav);
  });
  ipcMain.handle("chat:cancel", (_e, turnId: string) =>
    turns.get(turnId)?.abort(),
  );
  ipcMain.handle(
    "chat:send",
    async (
      _e,
      req: {
        turnId: string;
        text: string;
        history: ChatTurn[];
        speak: boolean;
        mode?: "documents" | "general";
        setIds?: number[];
        documentIds?: number[];
      },
    ) => {
      const { turnId, text, history, speak } = req;
      const controller = new AbortController();
      turns.set(turnId, controller);
      try {
        if (!llm || !retriever) throw new Error("The model is not ready.");
        const search = retriever;
        const setIds = (req.setIds ?? store.selectedSetIds()).filter((id) =>
          store.listSets().some((s) => s.id === id),
        );
        const hasDocuments = req.mode !== "general";
        if (hasDocuments && !setIds.length)
          throw new Error(
            "Select a document set, or explicitly choose General chat.",
          );
        if (
          hasDocuments &&
          !setIds.some((id) =>
            store.listSets().some((s) => s.id === id && s.chunkCount > 0),
          )
        )
          throw new Error(
            "No searchable documents are ready in these sets. Wait for indexing or check the import report.",
          );
        const result = await runTurn(
          {
            llm,
            analysis: documentTools(store, setIds, req.documentIds),
            toolkit: hasDocuments
              ? toolManager.agentTools({
                  setIds,
                  documentIds: req.documentIds ?? [],
                })
              : undefined,
            search: (q) => search.search(setIds, q, 8, req.documentIds),
            survey: (question) =>
              req.documentIds?.length ? null : search.survey(setIds, question),
            hasSelectedDocuments: hasDocuments,
            // Read per sentence, so a new pronunciation applies from the next sentence on.
            pronounce: (t) => applyPronunciations(t, store.pronunciations()),
          },
          text,
          history,
          { speak, signal: controller.signal },
          {
            evidence: (result) =>
              send("chat:event", { type: "evidence", turnId, ...result }),
            status: (status) =>
              send("chat:event", { type: "status", turnId, status }),
            delta: (t) =>
              send("chat:event", { type: "delta", turnId, text: t }),
            audio: (samples, sampleRate, t) =>
              send("chat:event", {
                type: "audio",
                turnId,
                samples,
                sampleRate,
                text: t,
              }),
          },
        );
        send("chat:event", { type: "done", turnId, ...result });
      } catch (err) {
        const message = controller.signal.aborted
          ? "Stopped."
          : err instanceof Error
            ? err.message
            : String(err);
        send("chat:event", { type: "error", turnId, message });
      } finally {
        turns.delete(turnId);
      }
    },
  );

  ipcMain.handle("chat:conversations", () => store.conversations());
  ipcMain.handle("chat:save", (_e, c: Conversation) => {
    if (typeof c.id !== "string" || !Array.isArray(c.messages))
      throw new Error("Invalid conversation");
    store.saveConversation(c);
  });
  ipcMain.handle("chat:remove", (_e, id: string) =>
    store.removeConversation(id),
  );
  ipcMain.handle("docs:passages", (_e, id: number) =>
    store.documentChunks(id).map(citationOf),
  );
  ipcMain.handle("library:search", (_e, req: SearchRequest) => {
    const setIds = req.setIds.length
      ? req.setIds
      : store.listSets().map((s) => s.id);
    return store
      .chunksById(store.keywordSearch(setIds, req.query, 100, req.documentIds))
      .filter(
        (c) =>
          !req.documentIds?.length || req.documentIds.includes(c.documentId),
      )
      .slice(0, 40)
      .map(citationOf);
  });
  ipcMain.handle("library:backup", async () => {
    const result = await dialog.showSaveDialog(requireWindow(), {
      defaultPath: "Docent-library.db",
      filters: [{ name: "Docent library", extensions: ["db"] }],
    });
    if (result.canceled || !result.filePath) return false;
    if (result.filePath === databasePath())
      throw new Error("Choose a different backup location.");
    await backup(store.db, result.filePath);
    return true;
  });
  ipcMain.handle("library:restore", async () => {
    if (libraryJobs || turns.size || toolsBusy())
      throw new Error(
        "Wait for indexing and answers to finish before restoring.",
      );
    const picked = await dialog.showOpenDialog(requireWindow(), {
      properties: ["openFile"],
      filters: [{ name: "Docent library", extensions: ["db"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return false;
    const source = new DatabaseSync(picked.filePaths[0], { readOnly: true });
    const stage = databasePath() + ".restore";
    try {
      const check = source.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (check.integrity_check !== "ok")
        throw new Error("This backup is damaged.");
      for (const table of ["sets", "sources", "documents", "chunks"])
        source.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
      const confirm = await dialog.showMessageBox(requireWindow(), {
        type: "question",
        buttons: ["Cancel", "Restore library"],
        defaultId: 0,
        cancelId: 0,
        message: "Replace this library with the backup?",
        detail:
          "A safety copy of the current library will be kept on this computer. Models are unchanged.",
      });
      if (confirm.response !== 1) return false;
      await rm(stage, { force: true });
      await backup(source, stage);
    } finally {
      source.close();
    }
    const path = databasePath();
    await backup(store.db, path + ".before-restore-" + Date.now() + ".db");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    store.close();
    try {
      await rename(stage, path);
    } finally {
      store = new Store(path);
      toolManager = createToolManager();
      retriever = embedder
        ? new Retriever(store, (q) => embedder!.embedQuery(q))
        : null;
    }
    window?.reload();
    return true;
  });

  ipcMain.handle("pronunciations:list", () => store.pronunciations());
  ipcMain.handle("pronunciations:remove", (_e, word: string) =>
    store.removePronunciation(String(word)),
  );
  ipcMain.handle("pronunciations:set", (_e, word: string, spoken: string) => {
    const w = String(word).trim().replace(/\s+/g, " ");
    const s = String(spoken).trim();
    if (!w || !s || w.length > MAX_WORD_CHARS || s.length > MAX_SPOKEN_CHARS) {
      throw new Error("Enter a word and how it should sound.");
    }
    store.setPronunciation(w, s);
  });
  ipcMain.handle("pronunciations:preview", async (_e, spoken: string) => {
    if (!llm) throw new Error("The model is not ready.");
    const chunks: Buffer[] = [];
    let sampleRate = 24000;
    for await (const chunk of llm.speak(
      String(spoken).slice(0, MAX_SPOKEN_CHARS),
    )) {
      chunks.push(Buffer.from(chunk.samples));
      sampleRate = chunk.sampleRate;
    }
    const all = Buffer.concat(chunks);
    return {
      samples: all.buffer.slice(
        all.byteOffset,
        all.byteOffset + all.byteLength,
      ),
      sampleRate,
    };
  });

  // Only files already in the index can be opened, and only types that open in a viewer.
  // Anything else, such as a script, is revealed in its folder rather than run.
  const existingPath = async (id: number) => {
    const path = store.documentPath(id);
    if (!path) return null;
    return access(path).then(
      () => path,
      () => null,
    );
  };
  ipcMain.handle("docs:open", async (_e, id: number) => {
    const path = await existingPath(id);
    if (!path) return false;
    if (isViewable(path)) return (await shell.openPath(path)) === "";
    shell.showItemInFolder(path);
    return true;
  });
  ipcMain.handle("docs:reveal", async (_e, id: number) => {
    const path = await existingPath(id);
    if (path) shell.showItemInFolder(path);
    return path !== null;
  });

  // Same rule as above: the renderer names an indexed document and never a path.
  ipcMain.handle("docs:pdf", async (_e, id: number, version?: string) => {
    if (version && store.documentChunks(id)[0]?.version !== version)
      throw new Error(
        "The document has changed. Showing the passage saved with this answer.",
      );
    const path = store.documentPath(id);
    if (!path || extname(path).toLowerCase() !== ".pdf")
      throw new Error("Not an indexed PDF.");
    const bytes = store.originalBytes(id) ?? (await readFile(path));
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  });

  ipcMain.handle("update:check", () => update.check());
  ipcMain.handle("update:install", () => update.install());
  ipcMain.handle("update:releases", () => shell.openExternal(RELEASES_URL));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: "Docent",
    icon: join(app.getAppPath(), "build/icon.png"),
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => (window = null));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (dev && devUrl) void window.loadURL(devUrl);
  else
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  // BrowserWindow.icon is not used for the macOS Dock in development builds.
  if (process.platform === "darwin")
    app.dock?.setIcon(
      nativeImage.createFromPath(join(app.getAppPath(), "build/icon.png")),
    );
  store = new Store(databasePath());
  toolManager = createToolManager();
  toolsBusy = registerToolIpc(() => toolManager, requireWindow);

  // Grant the microphone and nothing else.
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback, details) => {
      const audioOnly =
        permission === "media" &&
        "mediaTypes" in details &&
        details.mediaTypes?.every((t) => t === "audio");
      callback(Boolean(audioOnly));
    },
  );

  const update = startUpdater((s) => send("update:state", s));
  registerIpc(update);
  createWindow();
  await boot();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopLibraryWorkers();
  stopToolWorkers();
  sidecars.forEach((s) => s.stop());
  store?.close();
});
