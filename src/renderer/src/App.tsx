import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  Conversation,
  ImportReport,
  Api,
  ChatTurn,
  Citation,
  DocSet,
  DocumentRow,
  IngestProgress,
  Pronunciation,
  RuntimeState,
  UpdateState,
} from "../../shared/types";
import { isViewable } from "../../shared/files";
import {
  idKey,
  sameQuestionScope,
  type QuestionScope,
} from "../../shared/question-scope";
import { LibrarySearch } from "./LibrarySearch";
import { PronunciationList } from "./PronunciationList";
import { ToolsPanel, ToolRunInfo } from "./ToolsPanel";
import type { ToolRunRecord } from "../../shared/tools";
import { PdfPage } from "./PdfPage";
import { TopicMapView } from "./TopicMapView";
import { Pacer, Player, Recorder } from "./audio";
import { CopyButton } from "./CopyButton";
import { DropImport } from "./DropImport";

declare global {
  interface Window {
    api: Api;
  }
}
const api = window.api;

interface Message {
  toolRuns?: ToolRunRecord[];
  warnings?: string[];
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: string | null;
  citations?: Citation[];
  uncited?: boolean;
  error?: boolean;
  pending?: boolean;
  saved?: boolean;
}

interface Selected {
  word: string;
  x: number;
  y: number;
}

const MAX_SELECTED_CHARS = 60;
const POPOVER_WIDTH = 280;

const SIDEBAR_KEY = "docent.sidebarWidth";
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
const CHAT_MIN = 400;
const SIDEBAR_STEP = 16;

const clampSidebar = (width: number) =>
  Math.round(
    Math.max(
      SIDEBAR_MIN,
      Math.min(SIDEBAR_MAX, window.innerWidth - CHAT_MIN, width),
    ),
  );

const revealLabel =
  api.platform === "darwin"
    ? "Show in Finder"
    : api.platform === "win32"
      ? "Show in File Explorer"
      : "Show in folder";

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

function where(c: Citation): string {
  if (c.page !== null) return `page ${c.page}`;
  if (c.line !== null) return `line ${c.line}`;
  return c.setName;
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  useEffect(() => {
    void api.runtime.state().then(setRuntime);
    return api.runtime.onState(setRuntime);
  }, []);
  if (!runtime) return null;
  return (
    <div className="shell">
      {runtime.phase !== "ready" && (
        <div className="runtime-banner">
          <strong>Library search and saved conversations are available.</strong>
          <details>
            <summary>
              Models: {runtime.phase.replaceAll("-", " ")} · Setup and recovery
            </summary>
            <Setup state={runtime} />
          </details>
        </div>
      )}
      <Workspace ready={runtime.phase === "ready"} />
    </div>
  );
}

function Setup({ state }: { state: RuntimeState }) {
  return (
    <main className="setup">
      <h1>Docent</h1>
      {state.phase === "needs-models" && (
        <>
          <p>
            Docent runs entirely on this computer. It needs to download its
            models once, which takes {gb(state.downloadBytes)} of disk space.
          </p>
          {state.freeBytes !== null &&
            state.freeBytes < state.downloadBytes && (
              <p className="warning">
                Only {gb(state.freeBytes)} is free on this disk.
              </p>
            )}
          <p className="fine">
            Downloading means you accept the{" "}
            <strong>LFM Open License v1.0</strong> for LFM3-Omni-2B. Commercial
            use by organizations with $10M or more in annual revenue is not
            licensed.
          </p>
          <button
            className="primary"
            onClick={() => void api.runtime.install()}
          >
            Download models
          </button>
        </>
      )}
      {state.phase === "downloading" && (
        <>
          <p>Downloading {state.file}</p>
          <progress value={state.loaded} max={state.total} />
          <p className="fine">
            {gb(state.loaded)} of {gb(state.total)}
          </p>
        </>
      )}
      {state.phase === "starting" && (
        <p>Loading the models. This can take a minute.</p>
      )}
      {state.phase === "failed" && (
        <>
          <p className="warning">Something went wrong.</p>
          <pre>{state.message}</pre>
          <button onClick={() => void api.runtime.restart()}>
            Retry models
          </button>
        </>
      )}
    </main>
  );
}

function Workspace({ ready }: { ready: boolean }) {
  const [sets, setSets] = useState<DocSet[]>([]);
  const [pronunciations, setPronunciations] = useState<Pronunciation[]>([]);
  const [mapSetId, setMapSetId] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebar(Number(localStorage.getItem(SIDEBAR_KEY)) || SIDEBAR_DEFAULT),
  );
  const resizing = useRef(false);
  const resizeSidebar = (width: number) => {
    const next = clampSidebar(width);
    setSidebarWidth(next);
    localStorage.setItem(SIDEBAR_KEY, String(next));
  };
  const refresh = () => void api.sets.list().then(setSets);
  const refreshPronunciations = () =>
    void api.pronunciations.list().then(setPronunciations);
  useEffect(refresh, []);
  useEffect(refreshPronunciations, []);
  const mapSet = sets.find((s) => s.id === mapSetId);
  return (
    <div
      className="app"
      style={{ "--sidebar": `${sidebarWidth}px` } as CSSProperties}
    >
      <div
        className="sidebar-handle"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          resizing.current = true;
        }}
        onPointerMove={(e) => {
          if (resizing.current) resizeSidebar(e.clientX);
        }}
        onPointerUp={() => (resizing.current = false)}
        onPointerCancel={() => (resizing.current = false)}
        onDoubleClick={() => resizeSidebar(SIDEBAR_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") resizeSidebar(sidebarWidth - SIDEBAR_STEP);
          if (e.key === "ArrowRight")
            resizeSidebar(sidebarWidth + SIDEBAR_STEP);
        }}
      />
      <Sidebar
        ready={ready}
        sets={sets}
        refresh={refresh}
        pronunciations={pronunciations}
        refreshPronunciations={refreshPronunciations}
        onShowTopics={setMapSetId}
      />
      <Chat
        sets={sets}
        pronunciations={pronunciations}
        refreshPronunciations={refreshPronunciations}
      />
      {mapSet && (
        <TopicMapView
          key={mapSet.id}
          set={mapSet}
          onClose={() => setMapSetId(null)}
          revealLabel={revealLabel}
        />
      )}
      <UpdateBanner />
      <DropImport sets={sets} ready={ready} onImported={refresh} />
    </div>
  );
}

function Sidebar({
  ready,
  sets,
  refresh,
  pronunciations,
  refreshPronunciations,
  onShowTopics,
}: {
  ready: boolean;
  sets: DocSet[];
  refresh: () => void;
  pronunciations: Pronunciation[];
  refreshPronunciations: () => void;
  onShowTopics: (setId: number) => void;
}) {
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [indexError, setIndexError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [name, setName] = useState("");

  useEffect(
    () =>
      api.sets.onProgress((p) => {
        setProgress(p);
        if (p?.error) setIndexError(p.error);
        if (p === null || p.current === null) refresh();
      }),
    [],
  );

  const create = async () => {
    if (!name.trim()) return;
    const set = await api.sets.create(name);
    setName("");
    setOpenId(set.id);
    refresh();
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="./icon.png" alt="" />
        <div>
          <strong>Docent</strong>
          <small>Your offline reference library</small>
        </div>
      </div>
      <h2>Document sets</h2>
      <p className="fine">
        Selected sources apply to your next question. Changing them starts fresh
        context.
      </p>
      {indexError && (
        <p role="alert" className="warning">
          {indexError}
          <button onClick={() => setIndexError("")}>Dismiss</button>
        </p>
      )}
      <ul className="sets">
        {sets.map((set) => (
          <li key={set.id}>
            <div className="set-row">
              <input
                type="checkbox"
                aria-label={`Use ${set.name}`}
                checked={set.selected}
                onChange={(e) =>
                  void api.sets.select(set.id, e.target.checked).then(refresh)
                }
              />
              <button
                className="set-name"
                onClick={() => setOpenId(openId === set.id ? null : set.id)}
              >
                {set.name}
                <small>
                  {set.documentCount}{" "}
                  {set.documentCount === 1 ? "file" : "files"}
                  {set.failedCount > 0 && `, ${set.failedCount} failed`}
                </small>
              </button>
            </div>
            {openId === set.id && (
              <SetDetail
                set={set}
                refresh={refresh}
                busy={progress !== null || !ready}
                onShowTopics={() => onShowTopics(set.id)}
              />
            )}
            {progress?.setId === set.id && (
              <div className="progress">
                <progress
                  value={progress.done}
                  max={Math.max(progress.total, 1)}
                />
                <small>{progress.current ?? "Finishing"}</small>
                <button onClick={() => void api.sets.cancel(set.id)}>
                  Stop indexing
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className="new-set"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          placeholder="New set name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button disabled={!name.trim()}>Add</button>
      </form>
      <LibraryTools />
      {pronunciations.length > 0 && (
        <PronunciationList
          entries={pronunciations}
          onChanged={refreshPronunciations}
        />
      )}
    </aside>
  );
}

function SetDetail({
  set,
  refresh,
  busy,
  onShowTopics,
}: {
  set: DocSet;
  refresh: () => void;
  busy: boolean;
  onShowTopics: () => void;
}) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [openDocument, setOpenDocument] = useState<number | null>(null);
  const load = () => void api.sets.documents(set.id).then(setDocuments);
  const waitHint = busy ? "Available when indexing finishes" : undefined;
  useEffect(() => {
    load();
    void api.sets.report(set.id).then(setReport);
  }, [set.id, set.documentCount, set.failedCount, set.chunkCount, busy]);
  return (
    <div className="set-detail">
      <div className="actions">
        <button
          disabled={busy}
          title={waitHint}
          onClick={() => void api.sets.addFiles(set.id)}
        >
          Add files
        </button>
        <button
          disabled={busy}
          title={waitHint}
          onClick={() => void api.sets.addFolder(set.id)}
        >
          Add folder
        </button>
        <button
          disabled={busy}
          title={waitHint}
          onClick={() => void api.sets.rescan(set.id)}
        >
          Rescan
        </button>
        <button disabled={set.chunkCount === 0} onClick={onShowTopics}>
          Topic map
        </button>
        <button
          className="danger"
          onClick={() => {
            if (
              confirm(
                "Remove this set and its local copies? Original files will remain.",
              )
            )
              void api.sets.remove(set.id).then(refresh);
          }}
        >
          Delete
        </button>
      </div>
      {report && (
        <p className="fine" role="status">
          Last scan: {report.indexed} indexed, {report.unchanged} unchanged,{" "}
          {report.failed} failed, {report.unavailable} unavailable sources,{" "}
          {report.skipped} skipped files.
        </p>
      )}
      <input
        aria-label="Filter documents"
        placeholder="Filter documents"
        value={fileFilter}
        onChange={(e) => setFileFilter(e.target.value)}
      />
      <ul className="docs">
        {documents
          .filter((d) =>
            d.title.toLowerCase().includes(fileFilter.toLowerCase()),
          )
          .map((doc) => (
            <li key={doc.id} title={doc.error ?? doc.path}>
              <button
                className={`doc-name${doc.error ? " failed" : ""}`}
                aria-expanded={openDocument === doc.id}
                onClick={() =>
                  setOpenDocument(openDocument === doc.id ? null : doc.id)
                }
              >
                {doc.title}
              </button>
              <button
                aria-label={`Remove ${doc.title}`}
                onClick={() =>
                  void api.sets
                    .removeDocument(doc.id)
                    .then(() => (load(), refresh()))
                }
              >
                ×
              </button>
              {doc.error && <small>{doc.error}</small>}
              {openDocument === doc.id && (
                <DocumentActions key={doc.id} document={doc} />
              )}
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Renders answer text as plain text. Citation markers become buttons; nothing is ever parsed as HTML. */
function AnswerText({
  message,
  onCite,
}: {
  message: Message;
  onCite: (c: Citation) => void;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of message.text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    parts.push(...strongText(message.text.slice(last, match.index)));
    for (const n of match[1]!.split(",").map(Number)) {
      const citation = message.citations?.find((c) => c.n === n);
      parts.push(
        citation ? (
          <button
            key={`${match.index}-${n}`}
            className="cite"
            title={citation.title}
            onClick={() => onCite(citation)}
          >
            {n}
          </button>
        ) : (
          <sup key={`${match.index}-${n}`}>{n}</sup>
        ),
      );
    }
    last = match.index + match[0].length;
  }
  parts.push(...strongText(message.text.slice(last)));
  return <div className="text">{parts}</div>;
}

function Chat({
  sets,
  pronunciations,
  refreshPronunciations,
}: {
  sets: DocSet[];
  pronunciations: Pronunciation[];
  refreshPronunciations: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [speak, setSpeak] = useState(false);
  const [mode, setMode] = useState<"documents" | "general">("documents");
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
  const [conversationScope, setConversationScope] =
    useState<QuestionScope | null>(null);
  const [documentSelection, setDocumentSelection] = useState({
    setKey: "",
    ids: [] as number[],
  });
  const [scopeDocs, setScopeDocs] = useState<DocumentRow[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [panel, setPanel] = useState<"chat" | "search" | "history" | "tools">(
    "chat",
  );
  const [historyQuery, setHistoryQuery] = useState("");
  const [saveError, setSaveError] = useState("");
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [detail, setDetail] = useState<Citation | null>(null);
  const recorder = useRef(new Recorder());
  const player = useRef(new Player());
  const chatAudioTurn = useRef<string | null>(null);
  const reading = useRef<{ id: string; messageId: string } | null>(null);
  const [readState, setReadState] = useState<{
    messageId: string;
    playing: boolean;
  } | null>(null);
  const [readError, setReadError] = useState<{
    messageId: string;
    text: string;
  } | null>(null);
  const pacer = useRef(new Pacer());
  const cancelledTurns = useRef(new Set<string>());
  const [selection, setSelection] = useState<Selected | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const stopReading = () => {
    const current = reading.current;
    reading.current = null;
    if (current) void api.chat.cancel(current.id).catch(() => {});
    player.current.stop();
    setReadState(null);
  };
  const readAnswer = async (message: Message) => {
    const wasReading = reading.current?.messageId === message.id;
    stopReading();
    setReadError(null);
    if (wasReading) return;
    const id = crypto.randomUUID();
    reading.current = { id, messageId: message.id };
    setReadState({ messageId: message.id, playing: false });
    try {
      await api.chat.readAloud(id, message.text);
      if (reading.current?.id !== id) return;
      await player.current.whenIdle();
    } catch (error) {
      if (reading.current?.id !== id) return;
      player.current.stop();
      setReadError({
        messageId: message.id,
        text:
          error instanceof Error
            ? error.message
            : "Could not read this answer aloud.",
      });
    } finally {
      if (reading.current?.id === id) {
        reading.current = null;
        setReadState(null);
      }
    }
  };
  useEffect(
    () => () => {
      if (reading.current)
        void api.chat.cancel(reading.current.id).catch(() => {});
      reading.current = null;
      player.current.stop();
    },
    [],
  );

  const selectedIds = sets.filter((s) => s.selected).map((s) => s.id);
  const setKey = idKey(selectedIds);
  const documentIds =
    documentSelection.setKey === setKey ? documentSelection.ids : [];
  const nextScope: QuestionScope = { mode, setIds: selectedIds, documentIds };
  const scopeChanged = Boolean(
    conversationScope && !sameQuestionScope(conversationScope, nextScope),
  );
  useEffect(() => {
    // Filters from an earlier set selection must not silently return when switching back.
    setDocumentSelection((current) =>
      current.setKey === setKey ? current : { setKey, ids: [] },
    );
    let cancelled = false;
    setScopeDocs([]);
    void Promise.all(selectedIds.map((id) => api.sets.documents(id))).then(
      (all) => {
        if (!cancelled) setScopeDocs(all.flat());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [setKey, sets]);
  useEffect(() => {
    void api.chat.conversations().then(setConversations);
  }, []);
  useEffect(() => {
    if (!messages.length || !conversationScope) return;
    const save = () =>
      api.chat
        .save({
          id: sessionId,
          title:
            messages.find((m) => m.role === "user")?.text.slice(0, 80) ??
            "Conversation",
          updatedAt: Date.now(),
          ...conversationScope,
          messages: messages.map((m) => ({
            ...m,
            status: null,
            error: m.error || m.pending,
            pending: false,
          })),
        })
        .then(() => api.chat.conversations())
        .then(setConversations)
        .catch((e) => setSaveError(String(e)));
    if (!activeTurn) {
      void save();
      return;
    }
    const timer = setTimeout(() => void save(), 200);
    return () => clearTimeout(timer);
  }, [messages, activeTurn, sessionId, conversationScope]);
  const newChat = () => {
    stopReading();
    chatAudioTurn.current = null;
    setReadError(null);
    setMessages([]);
    setSessionId(crypto.randomUUID());
    setConversationScope(null);
    setDocumentSelection({ setKey, ids: [] });
    setDetail(null);
    setPanel("chat");
  };
  const openChat = (c: Conversation) => {
    stopReading();
    chatAudioTurn.current = null;
    setReadError(null);
    setSessionId(c.id);
    setConversationScope({
      mode: c.mode,
      setIds: c.setIds,
      documentIds: c.documentIds ?? [],
    });
    setDocumentSelection({
      setKey,
      ids: idKey(c.setIds) === setKey ? (c.documentIds ?? []) : [],
    });
    setMode(c.mode);
    setMessages(c.messages);
    setDetail(null);
    setPanel("chat");
  };
  const exportText = () =>
    messages
      .map(
        (m) =>
          `${m.role === "user" ? "Question" : "Answer"}: ${m.text}\n${
            m.citations
              ?.filter((c) => c.cited)
              .map(
                (c) =>
                  `[${c.n}] ${c.title}, ${where(c)}\n${c.excerpt}\nVersion: ${c.version ?? "legacy index"}`,
              )
              .join("\n") ?? ""
          }${m.toolRuns?.length ? `\nTool runs:\n${JSON.stringify(m.toolRuns, null, 2)}` : ""}`,
      )
      .join("\n\n");
  const downloadChat = () => {
    const url = URL.createObjectURL(
      new Blob([exportText()], { type: "text/markdown" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "Docent-conversation.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    const update = (turnId: string, change: (m: Message) => Message) =>
      setMessages((all) => all.map((m) => (m.id === turnId ? change(m) : m)));
    const append = (turnId: string, text: string) =>
      update(turnId, (m) => ({ ...m, text: m.text + text, status: null }));

    return api.chat.onEvent((event) => {
      const { turnId } = event;
      if (cancelledTurns.current.has(turnId)) return;
      switch (event.type) {
        case "status":
          return update(turnId, (m) => ({ ...m, status: event.status }));
        case "audio": {
          if (reading.current?.id === turnId) {
            setReadState({
              messageId: reading.current.messageId,
              playing: true,
            });
          } else if (chatAudioTurn.current !== turnId) return;
          player.current.enqueue(event.samples, event.sampleRate);
          return;
        }
        case "delta":
          return append(turnId, event.text);
        case "evidence":
          return update(turnId, (m) => ({
            ...m,
            text: event.text,
            citations: event.citations,
            warnings: event.warnings,
            toolRuns: event.toolRuns,
            uncited: event.uncited,
            status: null,
          }));
        case "done":
          // Waits for the voice to finish, so the last sentences are not revealed early.
          return (() => {
            setActiveTurn((current) => (current === turnId ? null : current));
            update(turnId, (m) => ({
              ...m,
              text: event.text,
              citations: event.citations,
              warnings: event.warnings,
              toolRuns: event.toolRuns,
              uncited: event.uncited,
              status: null,
              pending: false,
            }));
          })();
        case "error":
          setActiveTurn((current) => (current === turnId ? null : current));
          return update(turnId, (m) => ({
            ...m,
            text: m.text || event.message,
            error: !m.text,
            status: null,
            pending: false,
          }));
      }
    });
  }, []);

  const send = async (text: string, spoken: boolean) => {
    const question = text.trim();
    if (!question || activeTurn) return;
    const turnId = crypto.randomUUID();
    const previousMessages = scopeChanged ? [] : messages;
    const history: ChatTurn[] = previousMessages
      .filter((m) => !m.error && !m.pending)
      .map((m) => ({ role: m.role, content: m.text }));
    setInput("");
    setActiveTurn(turnId);
    stopReading();
    chatAudioTurn.current = turnId;
    setReadError(null);
    if (scopeChanged) {
      setSessionId(crypto.randomUUID());
      setDetail(null);
    }
    setPanel("chat");
    setMessages([
      ...previousMessages,
      { id: `${turnId}-q`, role: "user", text: question },
      {
        id: turnId,
        role: "assistant",
        text: "",
        status: "Thinking",
        pending: true,
      },
    ]);
    setConversationScope(nextScope);
    try {
      await api.chat.send({
        turnId,
        text: question,
        history,
        speak: spoken,
        mode,
        setIds: selectedIds,
        documentIds,
      });
    } catch (e) {
      setActiveTurn(null);
      setSaveError(String(e));
    }
  };

  const toggleMic = async () => {
    setMicError(null);
    try {
      if (!recording) {
        stopReading();
        chatAudioTurn.current = null;
        await recorder.current.start();
        setRecording(true);
        return;
      }
      setRecording(false);
      const wav = await recorder.current.stop();
      const text = await api.chat.transcribe(wav);
      if (text) await send(text, speak);
      else setMicError("I did not catch that.");
    } catch (err) {
      setRecording(false);
      setMicError(
        err instanceof Error ? err.message : "The microphone is not available.",
      );
    }
  };

  const stop = () => {
    if (activeTurn) {
      cancelledTurns.current.add(activeTurn);
      void api.chat.cancel(activeTurn);
    }
    stopReading();
    chatAudioTurn.current = null;
    pacer.current.flush();
    setActiveTurn(null);
    setMessages((all) =>
      all.map((m) => (m.pending ? { ...m, status: null, pending: false } : m)),
    );
  };

  const trackSelection = () => {
    const current = window.getSelection();
    const anchor = current?.anchorNode?.parentElement;
    const word = current
      ?.toString()
      .replace(/\s+/g, " ")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (
      !current ||
      !word ||
      word.length > MAX_SELECTED_CHARS ||
      !anchor?.closest(".message.assistant .text")
    ) {
      return setSelection(null);
    }
    const rect = current.getRangeAt(0).getBoundingClientRect();
    if (reading.current) stopReading();
    setSelection({ word, x: rect.left, y: rect.bottom });
  };

  const scope = sets.filter((s) => selectedIds.includes(s.id));

  return (
    <main className="chat">
      <header>
        <span className="scope">
          {activeTurn && scopeChanged
            ? `Answering from: ${
                conversationScope?.mode === "general"
                  ? "General chat"
                  : sets
                      .filter((s) => conversationScope?.setIds.includes(s.id))
                      .map((s) => s.name)
                      .join(", ")
              }`
            : mode === "general"
              ? "General chat · no document evidence"
              : scope.length
                ? `Answering from: ${scope.map((s) => s.name).join(", ")}`
                : "Select document sets to ask a question"}
        </span>
        <div className="actions">
          <button
            onClick={() => setPanel(panel === "tools" ? "chat" : "tools")}
          >
            Tools
          </button>
          <button
            onClick={() => setPanel(panel === "search" ? "chat" : "search")}
          >
            Search library
          </button>
          <button
            onClick={() => setPanel(panel === "history" ? "chat" : "history")}
          >
            Conversations
          </button>
          <button onClick={newChat} disabled={Boolean(activeTurn)}>
            New chat
          </button>
        </div>
      </header>

      <div className="scope-options">
        <label>
          Answer mode{" "}
          <select
            value={mode}
            disabled={Boolean(activeTurn)}
            onChange={(e) => setMode(e.target.value as "documents" | "general")}
          >
            <option value="documents">My documents only</option>
            <option value="general">General chat</option>
          </select>
        </label>
        {mode === "documents" && (
          <details>
            <summary>
              {documentIds.length
                ? `${documentIds.length} documents selected: ${scopeDocs
                    .filter((d) => documentIds.includes(d.id))
                    .map((d) => d.title)
                    .join(", ")}`
                : "All documents in these sets"}
            </summary>
            <div className="document-picker">
              {scopeDocs.map((d) => (
                <label key={d.id}>
                  <input
                    type="checkbox"
                    disabled={Boolean(activeTurn)}
                    checked={documentIds.includes(d.id)}
                    onChange={(e) =>
                      setDocumentSelection({
                        setKey,
                        ids: e.target.checked
                          ? [...documentIds, d.id]
                          : documentIds.filter((id) => id !== d.id),
                      })
                    }
                  />
                  {d.title}
                </label>
              ))}
            </div>
            <small>
              Select two documents to compare them. Changes apply to your next
              question.
            </small>
          </details>
        )}
        {messages.length > 0 && (
          <>
            <CopyButton
              key={sessionId}
              text={exportText()}
              label="Copy with sources"
            />
            <button onClick={downloadChat}>Export</button>
          </>
        )}
      </div>
      {scopeChanged && (
        <p className="scope-change" role="status">
          Sources changed. Your next question starts a new chat with the current
          selection. This conversation stays saved.
        </p>
      )}
      {saveError && <p role="alert">{saveError}</p>}
      <div className="body">
        {panel === "tools" && (
          <ToolsPanel
            sets={sets}
            scope={{ setIds: selectedIds, documentIds }}
            onCite={setDetail}
          />
        )}
        {panel === "search" && <LibrarySearch sets={sets} onCite={setDetail} />}
        {panel === "history" && (
          <section className="history">
            <h2>Conversations saved on this computer</h2>
            <input
              aria-label="Search conversations"
              placeholder="Search questions and answers"
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
            />
            {conversations
              .filter((c) =>
                JSON.stringify(c.messages)
                  .toLowerCase()
                  .includes(historyQuery.toLowerCase()),
              )
              .map((c) => (
                <div className="history-row" key={c.id}>
                  <button
                    disabled={Boolean(activeTurn)}
                    onClick={() => openChat(c)}
                  >
                    <strong>{c.title}</strong>
                    <small>
                      {new Date(c.updatedAt).toLocaleString()} ·{" "}
                      {c.messages.filter((m) => m.saved).length} saved answers
                    </small>
                  </button>
                  <button
                    aria-label={`Delete conversation ${c.title}`}
                    disabled={Boolean(activeTurn)}
                    onClick={() => {
                      if (confirm("Delete this saved conversation?"))
                        void api.chat.remove(c.id).then(() => {
                          setConversations((all) =>
                            all.filter((x) => x.id !== c.id),
                          );
                          if (c.id === sessionId) newChat();
                        });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
          </section>
        )}
        <section
          style={{ display: panel === "chat" ? undefined : "none" }}
          className="messages"
          aria-live="polite"
          onMouseUp={trackSelection}
        >
          {messages.length === 0 && (
            <p className="empty">
              Ask a question across your documents. Select two documents above
              to compare them, or search your library without AI.
            </p>
          )}
          {messages.map((m) => {
            const cited = m.citations?.filter((c) => c.cited) ?? [];
            return (
              <article
                key={m.id}
                className={`message ${m.role}${m.error ? " error" : ""}`}
              >
                <AnswerText message={m} onCite={setDetail} />
                {m.role === "assistant" && !m.pending && (
                  <div className="actions">
                    <button
                      onClick={() =>
                        setMessages((all) =>
                          all.map((x) =>
                            x.id === m.id ? { ...x, saved: !x.saved } : x,
                          ),
                        )
                      }
                    >
                      {m.saved ? "★ Saved" : "☆ Save answer"}
                    </button>
                    <CopyButton text={m.text} />
                    {!m.error && m.text.trim() && (
                      <button
                        className="read-aloud"
                        title={
                          readState?.messageId === m.id
                            ? "Stop reading"
                            : "Read aloud"
                        }
                        aria-label={
                          readState?.messageId === m.id
                            ? "Stop reading"
                            : "Read aloud"
                        }
                        aria-pressed={readState?.messageId === m.id}
                        disabled={Boolean(activeTurn) || recording}
                        onClick={() => void readAnswer(m)}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          {readState?.messageId === m.id ? (
                            <rect
                              x="6"
                              y="6"
                              width="12"
                              height="12"
                              rx="1"
                              fill="currentColor"
                              stroke="none"
                            />
                          ) : (
                            <>
                              <path d="M11 5 6 9H3v6h3l5 4V5Z" />
                              <path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" />
                            </>
                          )}
                        </svg>
                      </button>
                    )}
                    {readState?.messageId === m.id && (
                      <small className="read-status" role="status">
                        {readState.playing
                          ? "Reading aloud…"
                          : "Preparing voice…"}
                      </small>
                    )}
                  </div>
                )}
                {readError?.messageId === m.id && (
                  <p className="warning" role="alert">
                    {readError.text}
                  </p>
                )}
                {!!m.citations?.length && (
                  <p className="fine">
                    Evidence links identify retrieved passages. Check the
                    wording below; a citation alone does not verify a claim.
                  </p>
                )}
                {m.warnings?.map((w) => (
                  <p key={w} className="evidence-warning">
                    {w}
                  </p>
                ))}
                {m.toolRuns?.map((record) => (
                  <ToolRunInfo key={record.id} record={record} />
                ))}
                {m.status && <div className="status">{m.status}…</div>}
                {cited.length > 0 && (
                  <ol className="sources">
                    {cited.map((c) => (
                      <li key={c.n}>
                        <button onClick={() => setDetail(c)}>
                          <b>{c.n}</b> {c.title} <small>{where(c)}</small>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                {m.uncited && (
                  <div className="uncited">
                    <p>
                      This answer did not cite its sources, so check it against
                      these passages:
                    </p>
                    <ul>
                      {m.citations?.map((c) => (
                        <li key={c.n}>
                          <button onClick={() => setDetail(c)}>
                            {c.title} <small>{where(c)}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            );
          })}
          <div ref={end} />
        </section>

        {detail && (
          <SourceDetail
            key={detail.documentId}
            citation={detail}
            onClose={() => setDetail(null)}
          />
        )}
      </div>

      {selection && (
        <PronouncePopover
          key={selection.word}
          selected={selection}
          existing={pronunciations.find(
            (p) => p.word.toLowerCase() === selection.word.toLowerCase(),
          )}
          player={player.current}
          onClose={() => setSelection(null)}
          onSaved={refreshPronunciations}
        />
      )}
      {micError && <p className="mic-error">{micError}</p>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input, speak);
        }}
      >
        <button
          type="button"
          className={`mic${recording ? " recording" : ""}`}
          aria-pressed={recording}
          onClick={() => void toggleMic()}
          disabled={Boolean(activeTurn)}
        >
          {recording ? "Stop" : "Speak"}
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={recording ? "Listening…" : "Ask something"}
          disabled={recording}
        />
        {activeTurn ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!input.trim()}>
            Send
          </button>
        )}
        <label className="speak">
          <input
            type="checkbox"
            checked={speak}
            onChange={(e) => setSpeak(e.target.checked)}
          />{" "}
          Speak replies
        </label>
      </form>
    </main>
  );
}

function DocumentActions({ document }: { document: DocumentRow }) {
  const [missing, setMissing] = useState(false);
  const [passages, setPassages] = useState<Citation[]>([]);
  const run = (action: Promise<boolean>) =>
    void action.then((ok) => setMissing(!ok));
  return (
    <div className="doc-actions">
      <button
        onClick={() => void api.docs.passages(document.id).then(setPassages)}
      >
        Read offline
      </button>
      {document.offline && (
        <small>Original and indexed text saved offline</small>
      )}
      {passages.length > 0 && (
        <details open>
          <summary>Indexed text</summary>
          {passages.map((c, i) => (
            <p key={i}>{c.excerpt}</p>
          ))}
        </details>
      )}
      {isViewable(document.path) && (
        <button onClick={() => run(api.docs.open(document.id))}>Open</button>
      )}
      <button onClick={() => run(api.docs.reveal(document.id))}>
        {revealLabel}
      </button>
      {missing && (
        <small role="alert">
          This file could not be opened. It may have moved. Rescan to update the
          set.
        </small>
      )}
    </div>
  );
}

function SourceDetail({
  citation,
  onClose,
}: {
  citation: Citation;
  onClose: () => void;
}) {
  const [pageFailed, setPageFailed] = useState(false);
  const [passages, setPassages] = useState<Citation[]>([]);
  const [find, setFind] = useState("");
  useEffect(() => {
    void api.docs.passages(citation.documentId).then(setPassages);
  }, [citation.documentId]);
  // Only PDFs have page numbers. Text pulled from a PDF is often unreadable, so show the page itself.
  const showPage = citation.page !== null && !pageFailed;
  return (
    <aside className={`source-detail${showPage ? " pdf" : ""}`}>
      <button className="close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <h3>{citation.title}</h3>
      <p className="fine">
        {citation.setName}, {where(citation)}
      </p>
      {citation.indexedAt && (
        <p className="fine">
          Indexed {new Date(citation.indexedAt).toLocaleString()} · Version{" "}
          {citation.version?.slice(0, 10) ?? "legacy"}
        </p>
      )}
      {citation.warning && <p className="warning">{citation.warning}</p>}
      <details open className="evidence">
        <summary>Passage used for this answer</summary>
        <blockquote>
          <Highlighted text={citation.excerpt} query={find} />
        </blockquote>
      </details>
      <input
        aria-label="Find in source"
        placeholder="Highlight a word or phrase"
        value={find}
        onChange={(e) => setFind(e.target.value)}
      />
      {showPage ? (
        <PdfPage citation={citation} onFailed={() => setPageFailed(true)} />
      ) : (
        <>
          {pageFailed && (
            <p className="fine">
              The page could not be shown, so this is the text that was read
              from it.
            </p>
          )}
          <details>
            <summary>Read indexed document</summary>
            {passages.map((c, i) => (
              <p className="indexed-passage" key={i}>
                <small>{where(c)}</small>
                <Highlighted text={c.excerpt} query={find} />
              </p>
            ))}
          </details>
        </>
      )}
      <div className="actions">
        <button onClick={() => void api.docs.open(citation.documentId)}>
          Open file
        </button>
        <button onClick={() => void api.docs.reveal(citation.documentId)}>
          {revealLabel}
        </button>
      </div>
    </aside>
  );
}

function PronouncePopover({
  selected,
  existing,
  player,
  onClose,
  onSaved,
}: {
  selected: Selected;
  existing: Pronunciation | undefined;
  player: Player;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [spoken, setSpoken] = useState(existing?.spoken ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const preview = () =>
    attempt(async () => {
      const { samples, sampleRate } = await api.pronunciations.preview(spoken);
      player.stop();
      player.enqueue(samples, sampleRate);
    });
  const save = () =>
    attempt(async () => {
      await api.pronunciations.set(selected.word, spoken);
      onSaved();
      onClose();
    });

  const style = {
    left: Math.min(selected.x, window.innerWidth - POPOVER_WIDTH - 12),
    top: Math.min(selected.y + 6, window.innerHeight - 170),
  };
  if (!editing) {
    return (
      <div className="pronounce compact" style={style}>
        <button onClick={() => setEditing(true)}>Set pronunciation</button>
      </div>
    );
  }
  return (
    <form
      className="pronounce"
      style={{ ...style, width: POPOVER_WIDTH }}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        How should <strong>{selected.word}</strong> sound?
        <input
          autoFocus
          value={spoken}
          maxLength={200}
          placeholder="Spell it how it sounds"
          onChange={(e) => setSpoken(e.target.value)}
        />
      </label>
      {error && <p className="warning">{error}</p>}
      <div className="actions">
        <button
          type="button"
          disabled={busy || !spoken.trim()}
          onClick={() => void preview()}
        >
          Preview
        </button>
        <button className="primary" disabled={busy || !spoken.trim()}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  useEffect(() => api.update.onState(setState), []);
  if (state.status === "ready") {
    return (
      <div className="update">
        Version {state.version} is ready.
        <button onClick={() => void api.update.install()}>
          Restart to update
        </button>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="update">
        Could not update automatically.
        <button onClick={() => void api.update.openReleases()}>
          See releases
        </button>
        <button onClick={() => setState({ status: "idle" })}>Dismiss</button>
      </div>
    );
  }
  return null;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const parts: ReactNode[] = [];
  let from = 0;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  for (
    let at = lower.indexOf(needle);
    at >= 0;
    at = lower.indexOf(needle, from)
  ) {
    parts.push(
      text.slice(from, at),
      <mark key={at}>{text.slice(at, at + needle.length)}</mark>,
    );
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
function LibraryTools() {
  const [status, setStatus] = useState("");
  const run = async (action: () => Promise<boolean>) => {
    try {
      setStatus("Working…");
      const ok = await action();
      setStatus(ok ? "Done." : "Cancelled.");
    } catch (e) {
      setStatus(String(e));
    }
  };
  return (
    <details className="library-tools">
      <summary>Library backup & recovery</summary>
      <p className="fine">
        Backups include offline documents, conversations, and sources. Keep them
        somewhere private.
      </p>
      <div className="actions">
        <button onClick={() => void run(api.library.backup)}>
          Back up library
        </button>
        <button onClick={() => void run(api.library.restore)}>
          Restore backup
        </button>
      </div>
      <button onClick={() => void api.update.check()}>
        Check for updates (online)
      </button>
      <p role="status" className="fine">
        {status}
      </p>
    </details>
  );
}

function strongText(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}
