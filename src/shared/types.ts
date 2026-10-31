export interface DocSet {
  id: number;
  name: string;
  selected: boolean;
  documentCount: number;
  chunkCount: number;
  failedCount: number;
}

export interface DocumentRow {
  id: number;
  setId: number;
  path: string;
  title: string;
  error: string | null;
  chunkCount: number;
}

export interface Citation {
  n: number;
  documentId: number;
  title: string;
  path: string;
  setName: string;
  page: number | null;
  line: number | null;
  excerpt: string;
  /** False when the passage was retrieved and shown to the model but the answer never cited it. */
  cited: boolean;
}

export interface Pronunciation {
  word: string;
  spoken: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatEvent =
  | { type: 'status'; turnId: string; status: string }
  | { type: 'delta'; turnId: string; text: string }
  /** `text` is the sentence this audio begins, shown when it starts playing. Null for later chunks. */
  | { type: 'audio'; turnId: string; samples: ArrayBuffer; sampleRate: number; text: string | null }
  | { type: 'done'; turnId: string; text: string; citations: Citation[]; uncited: boolean }
  | { type: 'error'; turnId: string; message: string };

export type RuntimeState =
  | { phase: 'needs-models'; downloadBytes: number; freeBytes: number | null }
  | { phase: 'downloading'; file: string; loaded: number; total: number }
  | { phase: 'starting' }
  | { phase: 'ready' }
  | { phase: 'failed'; message: string };

export interface IngestProgress {
  setId: number;
  done: number;
  total: number;
  current: string | null;
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'downloading'; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

export interface Api {
  runtime: {
    state(): Promise<RuntimeState>;
    install(): Promise<void>;
    onState(cb: (s: RuntimeState) => void): () => void;
  };
  sets: {
    list(): Promise<DocSet[]>;
    create(name: string): Promise<DocSet>;
    rename(id: number, name: string): Promise<void>;
    remove(id: number): Promise<void>;
    select(id: number, selected: boolean): Promise<void>;
    addFiles(id: number): Promise<void>;
    addFolder(id: number): Promise<void>;
    rescan(id: number): Promise<void>;
    documents(id: number): Promise<DocumentRow[]>;
    removeDocument(id: number): Promise<void>;
    onProgress(cb: (p: IngestProgress | null) => void): () => void;
  };
  chat: {
    send(req: { turnId: string; text: string; history: ChatTurn[]; speak: boolean }): Promise<void>;
    transcribe(wav: ArrayBuffer): Promise<string>;
    cancel(turnId: string): Promise<void>;
    onEvent(cb: (e: ChatEvent) => void): () => void;
  };
  pronunciations: {
    list(): Promise<Pronunciation[]>;
    set(word: string, spoken: string): Promise<void>;
    remove(word: string): Promise<void>;
    preview(spoken: string): Promise<{ samples: ArrayBuffer; sampleRate: number }>;
  };
  docs: { open(documentId: number): Promise<void>; pdf(documentId: number): Promise<ArrayBuffer> };
  update: {
    onState(cb: (s: UpdateState) => void): () => void;
    install(): Promise<void>;
    openReleases(): Promise<void>;
  };
}
