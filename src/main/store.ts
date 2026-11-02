import { DatabaseSync } from "node:sqlite";
import type {
  Conversation,
  ImportReport,
  DocSet,
  DocumentRow,
  Pronunciation,
  TopicMap,
} from "../shared/types";
import type { Chunk } from "./ingest/chunk";
import { isCommonWord } from "./topics";
import type { VisualSource } from "../shared/vision";

export interface StoredChunk {
  context?: {
    text: string;
    page: number | null;
    line: number | null;
    position: "before" | "after";
  }[];
  visual?: VisualSource;
  id: number;
  documentId: number;
  text: string;
  page: number | null;
  line: number | null;
  title: string;
  path: string;
  setName: string;
  version?: string;
  indexedAt?: number;
  warning?: string | null;
}

export interface VectorRows {
  ids: number[];
  vectors: Float32Array[];
  /** The set each vector belongs to. */
  sets: number[];
}

export interface PassageRow {
  id: number;
  documentId: number;
  title: string;
  page: number | null;
  line: number | null;
  vector: Float32Array;
}

const toVector = (embedding: Uint8Array): Float32Array => {
  // Copy: the driver's buffer may not be aligned for floats.
  const bytes = embedding.slice();
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sources (
  set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY (set_id, path)
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  error TEXT,
  UNIQUE (set_id, path)
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  page INTEGER,
  line INTEGER,
  embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS pronunciations (
  word TEXT PRIMARY KEY COLLATE NOCASE,
  spoken TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_maps (
  set_id INTEGER PRIMARY KEY REFERENCES sets(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  map TEXT NOT NULL,
  centroids BLOB NOT NULL,
  dimensions INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS document_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE IF NOT EXISTS exclusions (set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY(set_id,path));
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_reports (set_id INTEGER PRIMARY KEY REFERENCES sets(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS image_attachments (id TEXT PRIMARY KEY, title TEXT NOT NULL, bytes BLOB NOT NULL, preview BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS visual_cache (document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, version TEXT NOT NULL, page INTEGER NOT NULL, bytes BLOB NOT NULL, used_at REAL NOT NULL, PRIMARY KEY(document_id,version,page));
CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

export class Store {
  readonly db: DatabaseSync;
  /** Bumped on any chunk change so the in-memory vector cache knows to reload. */
  generation = 0;

  rerankingEnabled(): boolean {
    return (
      (
        this.db
          .prepare("SELECT value FROM settings WHERE key='reranking'")
          .get() as { value: string } | undefined
      )?.value !== "off"
    );
  }
  setRerankingEnabled(enabled: boolean) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO settings(key,value) VALUES ('reranking',?)",
      )
      .run(enabled ? "on" : "off");
  }

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const columns = this.db
      .prepare("PRAGMA table_info(documents)")
      .all() as unknown as { name: string }[];
    if (!columns.some((c) => c.name === "parser_version")) {
      this.db.exec(
        "ALTER TABLE documents ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1",
      );
    }
    this.db.exec(
      "INSERT OR IGNORE INTO document_ids(id) SELECT max(id) FROM documents HAVING max(id) IS NOT NULL",
    );
    for (const [name, type] of [
      ["indexed_at", "REAL"],
      ["version", "TEXT"],
      ["original_bytes", "BLOB"],
    ]) {
      if (!columns.some((c) => c.name === name))
        this.db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
    }
  }

  conversations(): Conversation[] {
    return (
      this.db.prepare("SELECT data FROM conversations").all() as {
        data: string;
      }[]
    )
      .map((r) => JSON.parse(r.data))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  saveConversation(c: Conversation) {
    this.db
      .prepare(
        "INSERT INTO conversations(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(c.id, JSON.stringify(c));
  }
  removeConversation(id: string) {
    this.db.prepare("DELETE FROM conversations WHERE id=?").run(id);
  }
  report(id: number): ImportReport | null {
    const row = this.db
      .prepare("SELECT data FROM import_reports WHERE set_id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  saveReport(report: ImportReport) {
    this.db
      .prepare("INSERT OR REPLACE INTO import_reports VALUES (?,?)")
      .run(report.setId, JSON.stringify(report));
  }
  excluded(id: number, path: string) {
    return !!this.db
      .prepare("SELECT 1 FROM exclusions WHERE set_id=? AND path=?")
      .get(id, path);
  }
  excludeDocument(id: number) {
    const d = this.db
      .prepare("SELECT set_id,path FROM documents WHERE id=?")
      .get(id) as { set_id: number; path: string } | undefined;
    if (d)
      this.db
        .prepare("INSERT OR IGNORE INTO exclusions VALUES (?,?)")
        .run(d.set_id, d.path);
    this.removeDocument(id);
  }
  warnDocument(setId: number, path: string, message: string) {
    this.db
      .prepare("UPDATE documents SET error=? WHERE set_id=? AND path=?")
      .run(message, setId, path);
  }
  originalBytes(id: number): Uint8Array | null {
    return (
      (
        this.db
          .prepare("SELECT original_bytes FROM documents WHERE id=?")
          .get(id) as { original_bytes: Uint8Array | null } | undefined
      )?.original_bytes ?? null
    );
  }
  documentChunks(id: number): StoredChunk[] {
    return this.chunksById(
      (
        this.db
          .prepare("SELECT id FROM chunks WHERE document_id=? ORDER BY id")
          .all(id) as { id: number }[]
      ).map((r) => r.id),
    );
  }

  documentChunkPage(id: number, offset: number, limit: number): StoredChunk[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM chunks WHERE document_id=? ORDER BY id LIMIT ? OFFSET ?",
      )
      .all(id, limit, offset) as { id: number }[];
    return this.chunksById(rows.map((r) => r.id));
  }

  close() {
    this.db.close();
  }

  listSets(): DocSet[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.selected,
           (SELECT count(*) FROM documents d WHERE d.set_id = s.id AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id=d.id)) AS documentCount,
           (SELECT count(*) FROM documents d WHERE d.set_id = s.id AND d.error IS NOT NULL) AS failedCount,
           (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.set_id = s.id) AS chunkCount
         FROM sets s ORDER BY s.name COLLATE NOCASE`,
      )
      .all() as unknown as (Omit<DocSet, "selected"> & { selected: number })[];
    return rows.map((r) => ({ ...r, selected: r.selected === 1 }));
  }

  createSet(name: string): DocSet {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO sets(name) VALUES (?)")
      .run(name);
    const set = this.listSets().find((s) => s.id === Number(lastInsertRowid));
    if (!set) throw new Error("Set was not created");
    return set;
  }

  renameSet(id: number, name: string) {
    this.db.prepare("UPDATE sets SET name = ? WHERE id = ?").run(name, id);
  }

  removeSet(id: number) {
    this.transaction(() =>
      this.db.prepare("DELETE FROM sets WHERE id = ?").run(id),
    );
  }

  selectSet(id: number, selected: boolean) {
    this.db
      .prepare("UPDATE sets SET selected = ? WHERE id = ?")
      .run(selected ? 1 : 0, id);
  }

  selectedSetIds(): number[] {
    const rows = this.db
      .prepare("SELECT id FROM sets WHERE selected = 1")
      .all() as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }

  addSource(setId: number, path: string) {
    this.db
      .prepare("DELETE FROM exclusions WHERE set_id=? AND path=?")
      .run(setId, path);
    this.db
      .prepare("INSERT OR IGNORE INTO sources(set_id, path) VALUES (?, ?)")
      .run(setId, path);
  }

  sources(setId: number): string[] {
    const rows = this.db
      .prepare("SELECT path FROM sources WHERE set_id = ?")
      .all(setId) as unknown as { path: string }[];
    return rows.map((r) => r.path);
  }

  documents(setId: number): DocumentRow[] {
    return this.db
      .prepare(
        `SELECT d.id, d.set_id AS setId, d.path, d.title, d.error, d.indexed_at AS indexedAt, d.version, (d.original_bytes IS NOT NULL) AS offline,
           (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS chunkCount
         FROM documents d WHERE d.set_id = ? ORDER BY d.title COLLATE NOCASE`,
      )
      .all(setId) as unknown as DocumentRow[];
  }

  documentPath(id: number): string | null {
    const row = this.db
      .prepare("SELECT path FROM documents WHERE id = ?")
      .get(id) as { path: string } | undefined;
    return row?.path ?? null;
  }

  documentSet(id: number): number | null {
    const row = this.db
      .prepare("SELECT set_id FROM documents WHERE id = ?")
      .get(id) as { set_id: number } | undefined;
    return row?.set_id ?? null;
  }

  /** True when this exact version of the file is already indexed without error. */
  isCurrent(
    setId: number,
    path: string,
    mtimeMs: number,
    size: number,
    parserVersion: number,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM documents
         WHERE set_id = ? AND path = ? AND mtime_ms = ? AND size = ? AND parser_version = ? AND error IS NULL`,
      )
      .get(setId, path, mtimeMs, size, parserVersion);
    return row !== undefined;
  }

  /** True when some of a set's files were read by an older version of the parser. */
  needsReindex(setId: number, parserVersion: number): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM documents WHERE set_id = ? AND parser_version < ? LIMIT 1",
        )
        .get(setId, parserVersion) !== undefined
    );
  }

  saveDocument(
    doc: {
      setId: number;
      path: string;
      title: string;
      mtimeMs: number;
      size: number;
      parserVersion: number;
      version?: string;
      bytes?: Uint8Array;
    },
    chunks: (Chunk & { embedding: Float32Array })[],
    error: string | null = null,
  ) {
    const existing = this.db
      .prepare("SELECT id FROM documents WHERE set_id=? AND path=?")
      .get(doc.setId, doc.path) as { id: number } | undefined;
    if (error && existing) {
      this.warnDocument(doc.setId, doc.path, error);
      return;
    }
    this.transaction(() => {
      const id =
        existing?.id ??
        Number(
          this.db.prepare("INSERT INTO document_ids DEFAULT VALUES").run()
            .lastInsertRowid,
        );
      this.db
        .prepare(
          `INSERT INTO documents(id,set_id,path,title,mtime_ms,size,error,parser_version,indexed_at,version,original_bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(set_id,path) DO UPDATE SET
        title=excluded.title,mtime_ms=excluded.mtime_ms,size=excluded.size,error=excluded.error,parser_version=excluded.parser_version,
        indexed_at=excluded.indexed_at,version=excluded.version,original_bytes=excluded.original_bytes`,
        )
        .run(
          id,
          doc.setId,
          doc.path,
          doc.title,
          doc.mtimeMs,
          doc.size,
          error,
          doc.parserVersion,
          Date.now(),
          doc.version ?? null,
          doc.bytes ?? null,
        );
      this.db.prepare("DELETE FROM chunks WHERE document_id=?").run(id);
      const insert = this.db.prepare(
        "INSERT INTO chunks(document_id,text,page,line,embedding) VALUES (?,?,?,?,?)",
      );
      for (const c of chunks)
        insert.run(
          id,
          c.text,
          c.page,
          c.line,
          new Uint8Array(
            c.embedding.buffer,
            c.embedding.byteOffset,
            c.embedding.byteLength,
          ),
        );
    });
  }

  removeDocument(id: number) {
    this.transaction(() =>
      this.db.prepare("DELETE FROM documents WHERE id = ?").run(id),
    );
  }

  /** Drops documents under a set whose files are no longer found. */
  removeMissing(setId: number, present: Set<string>) {
    for (const doc of this.documents(setId))
      if (!present.has(doc.path))
        this.warnDocument(
          setId,
          doc.path,
          "Source unavailable. Using the last indexed version.",
        );
  }

  vectors(setIds: number[]): VectorRows {
    if (setIds.length === 0) return { ids: [], vectors: [], sets: [] };
    const rows = this.db
      .prepare(
        `SELECT c.id, c.embedding, d.set_id AS setId FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.set_id IN (${placeholders(setIds)})`,
      )
      .all(...setIds) as unknown as {
      id: number;
      embedding: Uint8Array;
      setId: number;
    }[];
    return {
      ids: rows.map((r) => r.id),
      vectors: rows.map((r) => toVector(r.embedding)),
      sets: rows.map((r) => r.setId),
    };
  }

  passages(setId: number): PassageRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id AS documentId, d.title, c.page, c.line, c.embedding
         FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.set_id = ? ORDER BY c.id`,
      )
      .all(setId) as unknown as (Omit<PassageRow, "vector"> & {
      embedding: Uint8Array;
    })[];
    return rows.map(({ embedding, ...r }) => ({
      ...r,
      vector: toVector(embedding),
    }));
  }

  chunkTexts(ids: number[]): Map<number, string> {
    const select = this.db.prepare("SELECT text FROM chunks WHERE id = ?");
    return new Map(
      ids.flatMap((id) => {
        const row = select.get(id) as { text: string } | undefined;
        return row ? [[id, row.text] as const] : [];
      }),
    );
  }

  /** Changes whenever a set's passages do. Includes file versions because SQLite reuses the ids of deleted rows. */
  passageFingerprint(setId: number): string {
    const row = this.db
      .prepare(
        `SELECT count(*) AS total, coalesce(max(c.id), 0) AS newest, total(d.mtime_ms + d.parser_version) AS version
         FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.set_id = ?`,
      )
      .get(setId) as { total: number; newest: number; version: number };
    return `${row.total}:${row.newest}:${row.version}`;
  }

  topicFingerprint(setId: number): string | null {
    const row = this.db
      .prepare("SELECT fingerprint FROM topic_maps WHERE set_id = ?")
      .get(setId) as { fingerprint: string } | undefined;
    return row?.fingerprint ?? null;
  }

  saveTopicMap(
    setId: number,
    fingerprint: string,
    map: Omit<TopicMap, "setId">,
    centroids: Float32Array,
    dimensions: number,
  ) {
    const blob = new Uint8Array(
      centroids.buffer,
      centroids.byteOffset,
      centroids.byteLength,
    );
    this.db
      .prepare(
        `INSERT INTO topic_maps(set_id, fingerprint, map, centroids, dimensions) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(set_id) DO UPDATE SET fingerprint = excluded.fingerprint, map = excluded.map,
           centroids = excluded.centroids, dimensions = excluded.dimensions`,
      )
      .run(setId, fingerprint, JSON.stringify(map), blob, dimensions);
  }

  updateTopicMap(map: TopicMap) {
    this.db
      .prepare("UPDATE topic_maps SET map = ? WHERE set_id = ?")
      .run(JSON.stringify(map), map.setId);
  }

  removeTopicMap(setId: number) {
    this.db.prepare("DELETE FROM topic_maps WHERE set_id = ?").run(setId);
  }

  topicMap(setId: number): TopicMap | null {
    const row = this.db
      .prepare("SELECT map FROM topic_maps WHERE set_id = ?")
      .get(setId) as { map: string } | undefined;
    return row
      ? { setId, ...(JSON.parse(row.map) as Omit<TopicMap, "setId">) }
      : null;
  }

  keywordSearch(
    setIds: number[],
    query: string,
    limit: number,
    documentIds: number[] = [],
  ): number[] {
    // Words like "what" and "the" match nearly everything and would only slow the search.
    const terms =
      query
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((t) => t.length > 1 && !isCommonWord(t)) ?? [];
    if (terms.length === 0 || setIds.length === 0) return [];
    // Quoting makes every term a literal, so user text cannot act as FTS syntax.
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    const rows = this.db
      .prepare(
        // CROSS JOIN fixes the order. Left to choose, SQLite searches the index once per document.
        `SELECT c.id FROM chunks_fts f
         CROSS JOIN chunks c ON c.id = f.rowid
         CROSS JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ? AND d.set_id IN (${placeholders(setIds)}) ${documentIds.length ? `AND d.id IN (${placeholders(documentIds)})` : ""}
         ORDER BY bm25(chunks_fts) LIMIT ?`,
      )
      .all(match, ...setIds, ...documentIds, limit) as unknown as {
      id: number;
    }[];
    const names = this.db
      .prepare(
        `SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id
      WHERE d.set_id IN (${placeholders(setIds)}) ${documentIds.length ? `AND d.id IN (${placeholders(documentIds)})` : ""} AND (${terms.map(() => "instr(lower(d.title),lower(?)) > 0").join(" OR ")})
      GROUP BY d.id ORDER BY d.title LIMIT ?`,
      )
      .all(...setIds, ...documentIds, ...terms, limit) as { id: number }[];
    return [
      ...new Set([...rows.map((r) => r.id), ...names.map((r) => r.id)]),
    ].slice(0, limit);
  }

  documentTotal(setIds: number[]): number {
    if (setIds.length === 0) return 0;
    const row = this.db
      .prepare(
        `SELECT count(*) AS total FROM documents WHERE error IS NULL AND set_id IN (${placeholders(setIds)})`,
      )
      .get(...setIds) as { total: number };
    return row.total;
  }

  /** The document each passage in these sets belongs to. */
  chunkDocuments(setIds: number[]): Map<number, number> {
    if (setIds.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id AS documentId FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.set_id IN (${placeholders(setIds)})`,
      )
      .all(...setIds) as unknown as { id: number; documentId: number }[];
    return new Map(rows.map((r) => [r.id, r.documentId]));
  }

  /** What is needed to place a passage in a set's topics. */
  topicIndex(
    setId: number,
  ): { labels: string[]; centroids: Float32Array; dimensions: number } | null {
    const row = this.db
      .prepare(
        "SELECT map, centroids, dimensions FROM topic_maps WHERE set_id = ?",
      )
      .get(setId) as
      | { map: string; centroids: Uint8Array; dimensions: number }
      | undefined;
    if (!row) return null;
    const { topics } = JSON.parse(row.map) as TopicMap;
    // A name several topics share tells them apart no better than having no name.
    const shared = (label: string) =>
      topics.filter((t) => t.label === label).length > 1;
    const labels = topics.map((t) =>
      shared(t.label) ? t.keywords.slice(0, 3).join(", ") : t.label,
    );
    return {
      labels,
      centroids: toVector(row.centroids),
      dimensions: row.dimensions,
    };
  }

  chunksById(ids: number[]): StoredChunk[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id AS documentId, c.text, c.page, c.line, d.title, d.path, s.name AS setName, d.version, d.indexed_at AS indexedAt, d.error AS warning
         FROM chunks c JOIN documents d ON d.id = c.document_id JOIN sets s ON s.id = d.set_id
         WHERE c.id IN (${placeholders(ids)})`,
      )
      .all(...ids) as unknown as StoredChunk[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  pronunciations(): Pronunciation[] {
    return this.db
      .prepare(
        "SELECT word, spoken FROM pronunciations ORDER BY word COLLATE NOCASE",
      )
      .all() as unknown as Pronunciation[];
  }

  setPronunciation(word: string, spoken: string) {
    this.db
      .prepare(
        `INSERT INTO pronunciations(word, spoken) VALUES (?, ?)
         ON CONFLICT(word) DO UPDATE SET word = excluded.word, spoken = excluded.spoken`,
      )
      .run(word, spoken);
  }

  removePronunciation(word: string) {
    this.db.prepare("DELETE FROM pronunciations WHERE word = ?").run(word);
  }

  private transaction(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
      this.generation++;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
