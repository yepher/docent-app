import type { ToolRunRecord, ToolsApi } from "./tools";

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
  indexedAt?: number;
  version?: string;
  offline?: boolean;
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
  version?: string;
  indexedAt?: number;
  warning?: string | null;
  /** False when the passage was retrieved and shown to the model but the answer never cited it. */
  cited: boolean;
}

export interface Pronunciation {
  word: string;
  spoken: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type ChatEvent =
  | { type: "status"; turnId: string; status: string }
  | { type: "delta"; turnId: string; text: string }
  /** `text` is the sentence this audio begins, shown when it starts playing. Null for later chunks. */
  | {
      type: "audio";
      turnId: string;
      samples: ArrayBuffer;
      sampleRate: number;
      text: string | null;
    }
  | {
      type: "evidence";
      toolRuns?: ToolRunRecord[];
      warnings?: string[];
      turnId: string;
      text: string;
      citations: Citation[];
      uncited: boolean;
    }
  | {
      type: "done";
      toolRuns?: ToolRunRecord[];
      warnings?: string[];
      turnId: string;
      text: string;
      citations: Citation[];
      uncited: boolean;
    }
  | { type: "error"; turnId: string; message: string };

export type RuntimeState =
  | { phase: "needs-models"; downloadBytes: number; freeBytes: number | null }
  | { phase: "downloading"; file: string; loaded: number; total: number }
  | { phase: "starting" }
  | { phase: "ready" }
  | { phase: "failed"; message: string };

export interface IngestProgress {
  error?: string;
  setId: number;
  done: number;
  total: number;
  current: string | null;
}

export type UpdateState =
  | { status: "idle" }
  | { status: "downloading"; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

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

export interface SavedMessage {
  toolRuns?: ToolRunRecord[];
  warnings?: string[];
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  uncited?: boolean;
  error?: boolean;
  saved?: boolean;
}
export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  setIds: number[];
  documentIds: number[];
  mode: "documents" | "general";
  messages: SavedMessage[];
}
export interface SearchRequest {
  query: string;
  setIds: number[];
  documentIds?: number[];
}
export interface ImportReport {
  setId: number;
  indexed: number;
  unchanged: number;
  failed: number;
  unavailable: number;
  skipped: number;
}
export interface Api {
  clipboard: { writeText(text: string): Promise<void> };
  tools: ToolsApi;
  runtime: {
    state(): Promise<RuntimeState>;
    install(): Promise<void>;
    restart(): Promise<void>;
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
    cancel(id: number): Promise<void>;
    documents(id: number): Promise<DocumentRow[]>;
    removeDocument(id: number): Promise<void>;
    report(id: number): Promise<ImportReport | null>;
    topics(id: number): Promise<TopicMap | null>;
    onTopicsChanged(cb: (setId: number) => void): () => void;
    onProgress(cb: (p: IngestProgress | null) => void): () => void;
  };
  chat: {
    conversations(): Promise<Conversation[]>;
    save(conversation: Conversation): Promise<void>;
    remove(id: string): Promise<void>;
    send(req: {
      turnId: string;
      text: string;
      history: ChatTurn[];
      speak: boolean;
      mode?: "documents" | "general";
      setIds?: number[];
      documentIds?: number[];
    }): Promise<void>;
    transcribe(wav: ArrayBuffer): Promise<string>;
    readAloud(playbackId: string, text: string): Promise<void>;
    cancel(turnId: string): Promise<void>;
    onEvent(cb: (e: ChatEvent) => void): () => void;
  };
  pronunciations: {
    list(): Promise<Pronunciation[]>;
    set(word: string, spoken: string): Promise<void>;
    remove(word: string): Promise<void>;
    preview(
      spoken: string,
    ): Promise<{ samples: ArrayBuffer; sampleRate: number }>;
  };
  /** The operating system, for naming its file manager. */
  platform: string;
  library: {
    search(req: SearchRequest): Promise<Citation[]>;
    backup(): Promise<boolean>;
    restore(): Promise<boolean>;
  };
  docs: {
    passages(documentId: number): Promise<Citation[]>;
    /** Each resolves false when the file could not be found or opened. */
    open(documentId: number): Promise<boolean>;
    reveal(documentId: number): Promise<boolean>;
    pdf(documentId: number, version?: string): Promise<ArrayBuffer>;
  };
  update: {
    check(): Promise<void>;
    onState(cb: (s: UpdateState) => void): () => void;
    install(): Promise<void>;
    openReleases(): Promise<void>;
  };
}
