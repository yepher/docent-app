import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron';
import { access, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { isViewable } from '../shared/files';
import type { ChatTurn, DocSet, RuntimeState } from '../shared/types';
import { runTurn } from './agent';
import { indexSet } from './ingest';
import { PARSER_VERSION } from './ingest/parse';
import { type Embedder, LlamaServerEmbedder, LlamaServerLlm, type Llm } from './llm';
import { MODEL_FILES, freeBytes, installModels, isInstalled, missingBytes } from './models';
import { applyPronunciations } from './pronunciation';
import { Retriever } from './retrieval';
import { Sidecar, embedderArgs, llmArgs } from './sidecar';
import { Store } from './store';
import { MIN_PASSAGES_FOR_TOPICS, TOPIC_MAP_VERSION, buildTopics, describeTopic } from './topics';
import { startUpdater } from './updater';

const RELEASES_URL = 'https://github.com/yepher/docent-app/releases';
const dev = !app.isPackaged;
const MAX_WORD_CHARS = 60;
const MAX_SPOKEN_CHARS = 200;
const DESCRIBE_TIMEOUT_MS = 120_000;

// Test overrides exist only in unpackaged builds, so a shipped app cannot be redirected by its environment.
const fakeBinary = dev ? process.env.DOCENT_LLAMA_BIN : undefined;
const modelsDir = () => join(app.getPath('userData'), 'models');

function llamaBinary(): string {
  if (fakeBinary) return fakeBinary;
  const root = app.isPackaged ? join(process.resourcesPath, 'llama') : join(app.getAppPath(), 'vendor', 'llama', `${process.platform}-${process.arch}`);
  return join(root, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
}

let window: BrowserWindow | null = null;
let store: Store;
let llm: Llm | null = null;
let embedder: Embedder | null = null;
let retriever: Retriever | null = null;
let state: RuntimeState = { phase: 'starting' };
const sidecars: Sidecar[] = [];
const turns = new Map<string, AbortController>();
let ingest = Promise.resolve();

const send = (channel: string, payload: unknown) => window?.webContents.send(channel, payload);

function setState(next: RuntimeState) {
  state = next;
  send('runtime:state', next);
}

async function startRuntime() {
  setState({ phase: 'starting' });
  const dir = modelsDir();
  const path = (id: string) => join(dir, MODEL_FILES.find((f) => f.id === id)!.name);
  const onExit = (message: string) => setState({ phase: 'failed', message });
  const binary = llamaBinary();
  const main = new Sidecar({ name: 'Language model', binary, args: llmArgs(path('llm'), path('mmproj')), onExit });
  const embed = new Sidecar({ name: 'Embedding model', binary, args: embedderArgs(path('embedder')), onExit });
  sidecars.push(main, embed);
  try {
    const [mainEndpoint, embedEndpoint] = await Promise.all([main.start(), embed.start()]);
    llm = new LlamaServerLlm(mainEndpoint);
    const client = new LlamaServerEmbedder(embedEndpoint);
    embedder = client;
    retriever = new Retriever(store, (q) => client.embedQuery(q));
    setState({ phase: 'ready' });
    maintainLibrary();
  } catch (err) {
    setState({ phase: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}

async function boot() {
  if (fakeBinary || isInstalled(modelsDir())) return startRuntime();
  setState({
    phase: 'needs-models',
    downloadBytes: await missingBytes(modelsDir()),
    freeBytes: await freeBytes(modelsDir()),
  });
}

function requireWindow(): BrowserWindow {
  if (!window) throw new Error('No window');
  return window;
}

/** Rebuilds a set's topics if its passages changed. Slow on large sets, so it yields as it works. */
async function updateTopics(setId: number) {
  const fingerprint = `${TOPIC_MAP_VERSION}:${store.passageFingerprint(setId)}`;
  if (store.topicFingerprint(setId) !== fingerprint) {
    const passages = store.passages(setId);
    if (passages.length < MIN_PASSAGES_FOR_TOPICS) return store.removeTopicMap(setId);
    const { map, centroids } = await buildTopics(
      passages,
      (ids) => store.chunkTexts(ids),
      (stage) => send('sets:progress', { setId, done: 1, total: 1, current: stage }),
    );
    store.saveTopicMap(setId, fingerprint, map, centroids, passages[0]!.vector.length);
    send('topics:changed', setId);
  }
  await describeTopics(setId);
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
    send('sets:progress', { setId, done: i, total: waiting.length, current: `Describing topics, ${i + 1} of ${waiting.length}` });
    const description = await describeTopic(llm, topic, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS));
    if (!description) continue;
    topic.label = description.name;
    topic.summary = description.summary;
    store.updateTopicMap(map);
    send('topics:changed', setId);
  }
}

function queueLibraryWork(work: () => Promise<void>) {
  ingest = ingest
    .then(work)
    .catch((err) => console.error('Indexing failed', err))
    .finally(() => send('sets:progress', null));
  return ingest;
}

function reindex(setId: number) {
  return queueLibraryWork(async () => {
    if (!embedder) throw new Error('The embedding model is not running.');
    await indexSet(store, embedder, setId, (p) => send('sets:progress', p));
    await updateTopics(setId);
  });
}

/** Brings every set up to date at launch: files read by an older parser, then missing topics. */
function maintainLibrary() {
  for (const set of store.listSets()) {
    if (store.needsReindex(set.id, PARSER_VERSION)) void reindex(set.id);
    else void queueLibraryWork(() => updateTopics(set.id));
  }
}

function registerIpc(update: { install(): void }) {
  ipcMain.handle('runtime:state', () => state);
  ipcMain.handle('runtime:install', async () => {
    try {
      await installModels(modelsDir(), (p) => setState({ phase: 'downloading', ...p }));
      await startRuntime();
    } catch (err) {
      setState({ phase: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  ipcMain.handle('sets:list', () => store.listSets());
  ipcMain.handle('sets:create', (_e, name: string): DocSet => store.createSet(String(name).trim() || 'Untitled'));
  ipcMain.handle('sets:rename', (_e, id: number, name: string) => store.renameSet(id, name));
  ipcMain.handle('sets:remove', (_e, id: number) => store.removeSet(id));
  ipcMain.handle('sets:select', (_e, id: number, selected: boolean) => store.selectSet(id, selected));
  ipcMain.handle('sets:documents', (_e, id: number) => store.documents(id));
  ipcMain.handle('sets:removeDocument', (_e, id: number) => {
    const setId = store.documentSet(id);
    store.removeDocument(id);
    if (setId !== null) void queueLibraryWork(() => updateTopics(setId));
  });
  ipcMain.handle('topics:get', (_e, setId: number) => store.topicMap(setId));
  ipcMain.handle('sets:rescan', (_e, id: number) => reindex(id));

  const pick = async (id: number, property: 'openFile' | 'openDirectory') => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      properties: [property, 'multiSelections'],
    });
    if (result.canceled) return;
    for (const path of result.filePaths) store.addSource(id, path);
    await reindex(id);
  };
  ipcMain.handle('sets:addFiles', (_e, id: number) => pick(id, 'openFile'));
  ipcMain.handle('sets:addFolder', (_e, id: number) => pick(id, 'openDirectory'));

  ipcMain.handle('chat:transcribe', async (_e, wav: ArrayBuffer) => {
    if (!llm) throw new Error('The model is not ready.');
    return llm.transcribe(wav);
  });
  ipcMain.handle('chat:cancel', (_e, turnId: string) => turns.get(turnId)?.abort());
  ipcMain.handle(
    'chat:send',
    async (_e, req: { turnId: string; text: string; history: ChatTurn[]; speak: boolean }) => {
      const { turnId, text, history, speak } = req;
      const controller = new AbortController();
      turns.set(turnId, controller);
      try {
        if (!llm || !retriever) throw new Error('The model is not ready.');
        const search = retriever;
        const setIds = store.selectedSetIds();
        const hasDocuments = store.listSets().some((s) => s.selected && s.chunkCount > 0);
        const result = await runTurn(
          {
            llm,
            search: (q) => search.search(setIds, q),
            survey: (question) => search.survey(setIds, question),
            hasSelectedDocuments: hasDocuments,
            // Read per sentence, so a new pronunciation applies from the next sentence on.
            pronounce: (t) => applyPronunciations(t, store.pronunciations()),
          },
          text,
          history,
          { speak, signal: controller.signal },
          {
            status: (status) => send('chat:event', { type: 'status', turnId, status }),
            delta: (t) => send('chat:event', { type: 'delta', turnId, text: t }),
            audio: (samples, sampleRate, t) => send('chat:event', { type: 'audio', turnId, samples, sampleRate, text: t }),
          },
        );
        send('chat:event', { type: 'done', turnId, ...result });
      } catch (err) {
        const message = controller.signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err);
        send('chat:event', { type: 'error', turnId, message });
      } finally {
        turns.delete(turnId);
      }
    },
  );

  ipcMain.handle('pronunciations:list', () => store.pronunciations());
  ipcMain.handle('pronunciations:remove', (_e, word: string) => store.removePronunciation(String(word)));
  ipcMain.handle('pronunciations:set', (_e, word: string, spoken: string) => {
    const w = String(word).trim().replace(/\s+/g, ' ');
    const s = String(spoken).trim();
    if (!w || !s || w.length > MAX_WORD_CHARS || s.length > MAX_SPOKEN_CHARS) {
      throw new Error('Enter a word and how it should sound.');
    }
    store.setPronunciation(w, s);
  });
  ipcMain.handle('pronunciations:preview', async (_e, spoken: string) => {
    if (!llm) throw new Error('The model is not ready.');
    const chunks: Buffer[] = [];
    let sampleRate = 24000;
    for await (const chunk of llm.speak(String(spoken).slice(0, MAX_SPOKEN_CHARS))) {
      chunks.push(Buffer.from(chunk.samples));
      sampleRate = chunk.sampleRate;
    }
    const all = Buffer.concat(chunks);
    return { samples: all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength), sampleRate };
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
  ipcMain.handle('docs:open', async (_e, id: number) => {
    const path = await existingPath(id);
    if (!path) return false;
    if (isViewable(path)) return (await shell.openPath(path)) === '';
    shell.showItemInFolder(path);
    return true;
  });
  ipcMain.handle('docs:reveal', async (_e, id: number) => {
    const path = await existingPath(id);
    if (path) shell.showItemInFolder(path);
    return path !== null;
  });

  // Same rule as above: the renderer names an indexed document and never a path.
  ipcMain.handle('docs:pdf', async (_e, id: number) => {
    const path = store.documentPath(id);
    if (!path || extname(path).toLowerCase() !== '.pdf') throw new Error('Not an indexed PDF.');
    const bytes = await readFile(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });

  ipcMain.handle('update:install', () => update.install());
  ipcMain.handle('update:releases', () => shell.openExternal(RELEASES_URL));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Docent',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => (window = null));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (dev && devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  store = new Store(join(app.getPath('userData'), 'library.db'));

  // Grant the microphone and nothing else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const audioOnly = permission === 'media' && 'mediaTypes' in details && details.mediaTypes?.every((t) => t === 'audio');
    callback(Boolean(audioOnly));
  });

  const update = startUpdater((s) => send('update:state', s));
  registerIpc(update);
  createWindow();
  await boot();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  sidecars.forEach((s) => s.stop());
  store?.close();
});
