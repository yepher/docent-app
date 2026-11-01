import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import type {
  Api,
  ChatTurn,
  Citation,
  DocSet,
  DocumentRow,
  IngestProgress,
  Pronunciation,
  RuntimeState,
  UpdateState,
} from '../../shared/types';
import { isViewable } from '../../shared/files';
import { PdfPage } from './PdfPage';
import { TopicMapView } from './TopicMapView';
import { Pacer, Player, Recorder } from './audio';

declare global {
  interface Window {
    api: Api;
  }
}
const api = window.api;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: string | null;
  citations?: Citation[];
  uncited?: boolean;
  error?: boolean;
  pending?: boolean;
}

interface Selected {
  word: string;
  x: number;
  y: number;
}

const MAX_SELECTED_CHARS = 60;
const POPOVER_WIDTH = 280;

const SIDEBAR_KEY = 'docent.sidebarWidth';
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
const CHAT_MIN = 400;
const SIDEBAR_STEP = 16;

const clampSidebar = (width: number) =>
  Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - CHAT_MIN, width)));

const revealLabel =
  api.platform === 'darwin' ? 'Show in Finder' : api.platform === 'win32' ? 'Show in File Explorer' : 'Show in folder';

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
  if (runtime.phase === 'ready') return <Workspace />;
  return <Setup state={runtime} />;
}

function Setup({ state }: { state: RuntimeState }) {
  return (
    <main className="setup">
      <h1>Docent</h1>
      {state.phase === 'needs-models' && (
        <>
          <p>
            Docent runs entirely on this computer. It needs to download its models once, which takes{' '}
            {gb(state.downloadBytes)} of disk space.
          </p>
          {state.freeBytes !== null && state.freeBytes < state.downloadBytes && (
            <p className="warning">Only {gb(state.freeBytes)} is free on this disk.</p>
          )}
          <p className="fine">
            Downloading means you accept the{' '}
            <strong>LFM Open License v1.0</strong> for LFM3-Omni-2B. Commercial use by organizations with $10M or
            more in annual revenue is not licensed.
          </p>
          <button className="primary" onClick={() => void api.runtime.install()}>
            Download models
          </button>
        </>
      )}
      {state.phase === 'downloading' && (
        <>
          <p>Downloading {state.file}</p>
          <progress value={state.loaded} max={state.total} />
          <p className="fine">
            {gb(state.loaded)} of {gb(state.total)}
          </p>
        </>
      )}
      {state.phase === 'starting' && <p>Loading the models. This can take a minute.</p>}
      {state.phase === 'failed' && (
        <>
          <p className="warning">Something went wrong.</p>
          <pre>{state.message}</pre>
        </>
      )}
    </main>
  );
}

function Workspace() {
  const [sets, setSets] = useState<DocSet[]>([]);
  const [pronunciations, setPronunciations] = useState<Pronunciation[]>([]);
  const [mapSetId, setMapSetId] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebar(Number(localStorage.getItem(SIDEBAR_KEY)) || SIDEBAR_DEFAULT));
  const resizing = useRef(false);
  const resizeSidebar = (width: number) => {
    const next = clampSidebar(width);
    setSidebarWidth(next);
    localStorage.setItem(SIDEBAR_KEY, String(next));
  };
  const refresh = () => void api.sets.list().then(setSets);
  const refreshPronunciations = () => void api.pronunciations.list().then(setPronunciations);
  useEffect(refresh, []);
  useEffect(refreshPronunciations, []);
  const mapSet = sets.find((s) => s.id === mapSetId);
  return (
    <div className="app" style={{ '--sidebar': `${sidebarWidth}px` } as CSSProperties}>
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
          if (e.key === 'ArrowLeft') resizeSidebar(sidebarWidth - SIDEBAR_STEP);
          if (e.key === 'ArrowRight') resizeSidebar(sidebarWidth + SIDEBAR_STEP);
        }}
      />
      <Sidebar
        sets={sets}
        refresh={refresh}
        pronunciations={pronunciations}
        refreshPronunciations={refreshPronunciations}
        onShowTopics={setMapSetId}
      />
      <Chat sets={sets} pronunciations={pronunciations} refreshPronunciations={refreshPronunciations} />
      {mapSet && <TopicMapView key={mapSet.id} set={mapSet} onClose={() => setMapSetId(null)} revealLabel={revealLabel} />}
      <UpdateBanner />
    </div>
  );
}

function Sidebar({
  sets,
  refresh,
  pronunciations,
  refreshPronunciations,
  onShowTopics,
}: {
  sets: DocSet[];
  refresh: () => void;
  pronunciations: Pronunciation[];
  refreshPronunciations: () => void;
  onShowTopics: (setId: number) => void;
}) {
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [name, setName] = useState('');

  useEffect(
    () =>
      api.sets.onProgress((p) => {
        setProgress(p);
        if (p === null || p.current === null) refresh();
      }),
    [],
  );

  const create = async () => {
    if (!name.trim()) return;
    const set = await api.sets.create(name);
    setName('');
    setOpenId(set.id);
    refresh();
  };

  return (
    <aside className="sidebar">
      <h2>Document sets</h2>
      <p className="fine">Answers use the sets you tick.</p>
      <ul className="sets">
        {sets.map((set) => (
          <li key={set.id}>
            <div className="set-row">
              <input
                type="checkbox"
                aria-label={`Use ${set.name}`}
                checked={set.selected}
                onChange={(e) => void api.sets.select(set.id, e.target.checked).then(refresh)}
              />
              <button className="set-name" onClick={() => setOpenId(openId === set.id ? null : set.id)}>
                {set.name}
                <small>
                  {set.documentCount} {set.documentCount === 1 ? 'file' : 'files'}
                  {set.failedCount > 0 && `, ${set.failedCount} failed`}
                </small>
              </button>
            </div>
            {openId === set.id && <SetDetail set={set} refresh={refresh} busy={progress !== null} onShowTopics={() => onShowTopics(set.id)} />}
            {progress?.setId === set.id && (
              <div className="progress">
                <progress value={progress.done} max={Math.max(progress.total, 1)} />
                <small>{progress.current ?? 'Finishing'}</small>
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
        <input placeholder="New set name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()}>Add</button>
      </form>
      {pronunciations.length > 0 && (
        <details className="pronunciations">
          <summary>Pronunciations ({pronunciations.length})</summary>
          <ul>
            {pronunciations.map((p) => (
              <li key={p.word}>
                <span>
                  {p.word} <small>sounds like {p.spoken}</small>
                </span>
                <button
                  aria-label={`Remove pronunciation for ${p.word}`}
                  onClick={() => void api.pronunciations.remove(p.word).then(refreshPronunciations)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </details>
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
  const [openDocument, setOpenDocument] = useState<number | null>(null);
  const load = () => void api.sets.documents(set.id).then(setDocuments);
  const waitHint = busy ? 'Available when indexing finishes' : undefined;
  useEffect(load, [set.id, set.documentCount, set.failedCount, set.chunkCount]);
  return (
    <div className="set-detail">
      <div className="actions">
        <button disabled={busy} title={waitHint} onClick={() => void api.sets.addFiles(set.id)}>Add files</button>
        <button disabled={busy} title={waitHint} onClick={() => void api.sets.addFolder(set.id)}>Add folder</button>
        <button disabled={busy} title={waitHint} onClick={() => void api.sets.rescan(set.id)}>Rescan</button>
        <button disabled={set.chunkCount === 0} onClick={onShowTopics}>Topic map</button>
        <button className="danger" onClick={() => void api.sets.remove(set.id).then(refresh)}>Delete</button>
      </div>
      <ul className="docs">
        {documents.map((doc) => (
          <li key={doc.id} title={doc.error ?? doc.path}>
            <button
              className={`doc-name${doc.error ? ' failed' : ''}`}
              aria-expanded={openDocument === doc.id}
              onClick={() => setOpenDocument(openDocument === doc.id ? null : doc.id)}
            >
              {doc.title}
            </button>
            <button
              aria-label={`Remove ${doc.title}`}
              onClick={() => void api.sets.removeDocument(doc.id).then(() => (load(), refresh()))}
            >
              ×
            </button>
            {doc.error && <small>{doc.error}</small>}
            {openDocument === doc.id && <DocumentActions key={doc.id} document={doc} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Renders answer text as plain text. Citation markers become buttons; nothing is ever parsed as HTML. */
function AnswerText({ message, onCite }: { message: Message; onCite: (c: Citation) => void }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of message.text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    parts.push(message.text.slice(last, match.index));
    for (const n of match[1]!.split(',').map(Number)) {
      const citation = message.citations?.find((c) => c.n === n);
      parts.push(
        citation ? (
          <button key={`${match.index}-${n}`} className="cite" title={citation.title} onClick={() => onCite(citation)}>
            {n}
          </button>
        ) : (
          <sup key={`${match.index}-${n}`}>{n}</sup>
        ),
      );
    }
    last = match.index + match[0].length;
  }
  parts.push(message.text.slice(last));
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
  const [input, setInput] = useState('');
  const [speak, setSpeak] = useState(true);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [detail, setDetail] = useState<Citation | null>(null);
  const recorder = useRef(new Recorder());
  const player = useRef(new Player());
  const pacer = useRef(new Pacer());
  const [selection, setSelection] = useState<Selected | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  useEffect(() => {
    const update = (turnId: string, change: (m: Message) => Message) =>
      setMessages((all) => all.map((m) => (m.id === turnId ? change(m) : m)));
    const append = (turnId: string, text: string) =>
      update(turnId, (m) => ({ ...m, text: m.text + text, status: null }));

    return api.chat.onEvent((event) => {
      const { turnId } = event;
      switch (event.type) {
        case 'status':
          return update(turnId, (m) => ({ ...m, status: event.status }));
        case 'audio': {
          // Each sentence appears as its speech starts, so text and voice run side by side.
          const startsIn = player.current.enqueue(event.samples, event.sampleRate);
          const { text } = event;
          if (text !== null) pacer.current.after(startsIn, () => append(turnId, text));
          return;
        }
        case 'delta':
          return pacer.current.after(0, () => append(turnId, event.text));
        case 'done':
          // Waits for the voice to finish, so the last sentences are not revealed early.
          return pacer.current.after(player.current.remaining(), () => {
            setActiveTurn(null);
            update(turnId, (m) => ({
              ...m,
              text: event.text,
              citations: event.citations,
              uncited: event.uncited,
              status: null,
              pending: false,
            }));
          });
        case 'error':
          setActiveTurn(null);
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
    const history: ChatTurn[] = messages
      .filter((m) => !m.error && !m.pending)
      .map((m) => ({ role: m.role, content: m.text }));
    setInput('');
    setActiveTurn(turnId);
    player.current.stop();
    setMessages((all) => [
      ...all,
      { id: `${turnId}-q`, role: 'user', text: question },
      { id: turnId, role: 'assistant', text: '', status: 'Thinking', pending: true },
    ]);
    await api.chat.send({ turnId, text: question, history, speak: spoken });
  };

  const toggleMic = async () => {
    setMicError(null);
    try {
      if (!recording) {
        player.current.stop();
        await recorder.current.start();
        setRecording(true);
        return;
      }
      setRecording(false);
      const wav = await recorder.current.stop();
      const text = await api.chat.transcribe(wav);
      if (text) await send(text, speak);
      else setMicError('I did not catch that.');
    } catch (err) {
      setRecording(false);
      setMicError(err instanceof Error ? err.message : 'The microphone is not available.');
    }
  };

  const stop = () => {
    if (activeTurn) void api.chat.cancel(activeTurn);
    player.current.stop();
    pacer.current.flush();
    setActiveTurn(null);
    setMessages((all) => all.map((m) => (m.pending ? { ...m, status: null, pending: false } : m)));
  };

  const trackSelection = () => {
    const current = window.getSelection();
    const anchor = current?.anchorNode?.parentElement;
    const word = current
      ?.toString()
      .replace(/\s+/g, ' ')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!current || !word || word.length > MAX_SELECTED_CHARS || !anchor?.closest('.message.assistant .text')) {
      return setSelection(null);
    }
    const rect = current.getRangeAt(0).getBoundingClientRect();
    setSelection({ word, x: rect.left, y: rect.bottom });
  };

  const scope = sets.filter((s) => s.selected && s.chunkCount > 0);

  return (
    <main className="chat">
      <header>
        <span className="scope">
          {scope.length > 0
            ? `Answering from: ${scope.map((s) => s.name).join(', ')}`
            : 'General chat: no document sets selected'}
        </span>
        <button onClick={() => setMessages([])} disabled={Boolean(activeTurn)}>New chat</button>
      </header>

      <div className="body">
      <section className="messages" aria-live="polite" onMouseUp={trackSelection}>
        {messages.length === 0 && <p className="empty">Ask a question, or press the microphone and speak.</p>}
        {messages.map((m) => {
          const cited = m.citations?.filter((c) => c.cited) ?? [];
          return (
            <article key={m.id} className={`message ${m.role}${m.error ? ' error' : ''}`}>
              <AnswerText message={m} onCite={setDetail} />
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
                  <p>This answer did not cite its sources, so check it against these passages:</p>
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

      {detail && <SourceDetail key={detail.documentId} citation={detail} onClose={() => setDetail(null)} />}
      </div>

      {selection && (
        <PronouncePopover
          key={selection.word}
          selected={selection}
          existing={pronunciations.find((p) => p.word.toLowerCase() === selection.word.toLowerCase())}
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
          className={`mic${recording ? ' recording' : ''}`}
          aria-pressed={recording}
          onClick={() => void toggleMic()}
          disabled={Boolean(activeTurn)}
        >
          {recording ? 'Stop' : 'Speak'}
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={recording ? 'Listening…' : 'Ask something'}
          disabled={recording}
        />
        {activeTurn ? (
          <button type="button" onClick={stop}>Stop</button>
        ) : (
          <button className="primary" disabled={!input.trim()}>Send</button>
        )}
        <label className="speak">
          <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> Speak replies
        </label>
      </form>
    </main>
  );
}

function DocumentActions({ document }: { document: DocumentRow }) {
  const [missing, setMissing] = useState(false);
  const run = (action: Promise<boolean>) => void action.then((ok) => setMissing(!ok));
  return (
    <div className="doc-actions">
      {isViewable(document.path) && <button onClick={() => run(api.docs.open(document.id))}>Open</button>}
      <button onClick={() => run(api.docs.reveal(document.id))}>{revealLabel}</button>
      {missing && <small role="alert">This file could not be opened. It may have moved. Rescan to update the set.</small>}
    </div>
  );
}

function SourceDetail({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const [pageFailed, setPageFailed] = useState(false);
  // Only PDFs have page numbers. Text pulled from a PDF is often unreadable, so show the page itself.
  const showPage = citation.page !== null && !pageFailed;
  return (
    <aside className={`source-detail${showPage ? ' pdf' : ''}`}>
      <button className="close" aria-label="Close" onClick={onClose}>×</button>
      <h3>{citation.title}</h3>
      <p className="fine">
        {citation.setName}, {where(citation)}
      </p>
      {showPage ? (
        <PdfPage citation={citation} onFailed={() => setPageFailed(true)} />
      ) : (
        <>
          {pageFailed && <p className="fine">The page could not be shown, so this is the text that was read from it.</p>}
          <blockquote>{citation.excerpt}</blockquote>
        </>
      )}
      <div className="actions">
        <button onClick={() => void api.docs.open(citation.documentId)}>Open file</button>
        <button onClick={() => void api.docs.reveal(citation.documentId)}>{revealLabel}</button>
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
  const [spoken, setSpoken] = useState(existing?.spoken ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
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
        <button type="button" disabled={busy || !spoken.trim()} onClick={() => void preview()}>Preview</button>
        <button className="primary" disabled={busy || !spoken.trim()}>Save</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  useEffect(() => api.update.onState(setState), []);
  if (state.status === 'ready') {
    return (
      <div className="update">
        Version {state.version} is ready.
        <button onClick={() => void api.update.install()}>Restart to update</button>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="update">
        Could not update automatically.
        <button onClick={() => void api.update.openReleases()}>See releases</button>
        <button onClick={() => setState({ status: 'idle' })}>Dismiss</button>
      </div>
    );
  }
  return null;
}
