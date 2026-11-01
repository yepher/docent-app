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

export interface TopicLink {
  topic: number;
  /** Documents with passages in both topics. */
  sharedDocuments: number;
  /** Passages that sit between the two topics by meaning. */
  passages: number;
}

export interface TopicPassage {
  documentId: number;
  title: string;
  page: number | null;
  line: number | null;
  /** The start of the passage, tidied for reading. */
  snippet: string;
}

export interface Topic {
  id: number;
  /** A plain name from the model once it has run, keywords until then. */
  label: string;
  /** One sentence from the model. Null until it has run, or if it could not. */
  summary: string | null;
  keywords: string[];
  /** The passages most typical of this topic. */
  examples: TopicPassage[];
  passageCount: number;
  documentCount: number;
  position: [number, number, number];
  related: TopicLink[];
  /** The documents with the most passages in this topic. */
  titles: string[];
}

export interface TopicPoint extends TopicPassage {
  position: [number, number, number];
  topic: number;
}

export interface TopicMap {
  setId: number;
  topics: Topic[];
  points: TopicPoint[];
  passageCount: number;
}

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
    topics(id: number): Promise<TopicMap | null>;
    onTopicsChanged(cb: (setId: number) => void): () => void;
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
  /** The operating system, for naming its file manager. */
  platform: string;
  docs: {
    /** Each resolves false when the file could not be found or opened. */
    open(documentId: number): Promise<boolean>;
    reveal(documentId: number): Promise<boolean>;
    pdf(documentId: number): Promise<ArrayBuffer>;
  };
  update: {
    onState(cb: (s: UpdateState) => void): () => void;
    install(): Promise<void>;
    openReleases(): Promise<void>;
  };
}
