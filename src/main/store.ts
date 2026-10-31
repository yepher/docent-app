import { DatabaseSync } from 'node:sqlite';
import type { DocSet, DocumentRow, Pronunciation } from '../shared/types';
import type { Chunk } from './ingest/chunk';

export interface StoredChunk {
  id: number;
  documentId: number;
  text: string;
  page: number | null;
  line: number | null;
  title: string;
  path: string;
  setName: string;
}

export interface VectorRows {
  ids: number[];
  vectors: Float32Array[];
}

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
  return values.map(() => '?').join(',');
}

export class Store {
  readonly db: DatabaseSync;
  /** Bumped on any chunk change so the in-memory vector cache knows to reload. */
  generation = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  listSets(): DocSet[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.selected,
           (SELECT count(*) FROM documents d WHERE d.set_id = s.id AND d.error IS NULL) AS documentCount,
           (SELECT count(*) FROM documents d WHERE d.set_id = s.id AND d.error IS NOT NULL) AS failedCount,
           (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.set_id = s.id) AS chunkCount
         FROM sets s ORDER BY s.name COLLATE NOCASE`,
      )
      .all() as unknown as (Omit<DocSet, 'selected'> & { selected: number })[];
    return rows.map((r) => ({ ...r, selected: r.selected === 1 }));
  }

  createSet(name: string): DocSet {
    const { lastInsertRowid } = this.db.prepare('INSERT INTO sets(name) VALUES (?)').run(name);
    const set = this.listSets().find((s) => s.id === Number(lastInsertRowid));
    if (!set) throw new Error('Set was not created');
    return set;
  }

  renameSet(id: number, name: string) {
    this.db.prepare('UPDATE sets SET name = ? WHERE id = ?').run(name, id);
  }

  removeSet(id: number) {
    this.transaction(() => this.db.prepare('DELETE FROM sets WHERE id = ?').run(id));
  }

  selectSet(id: number, selected: boolean) {
    this.db.prepare('UPDATE sets SET selected = ? WHERE id = ?').run(selected ? 1 : 0, id);
  }

  selectedSetIds(): number[] {
    const rows = this.db.prepare('SELECT id FROM sets WHERE selected = 1').all() as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }

  addSource(setId: number, path: string) {
    this.db.prepare('INSERT OR IGNORE INTO sources(set_id, path) VALUES (?, ?)').run(setId, path);
  }

  sources(setId: number): string[] {
    const rows = this.db.prepare('SELECT path FROM sources WHERE set_id = ?').all(setId) as unknown as { path: string }[];
    return rows.map((r) => r.path);
  }

  documents(setId: number): DocumentRow[] {
    return this.db
      .prepare(
        `SELECT d.id, d.set_id AS setId, d.path, d.title, d.error,
           (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS chunkCount
         FROM documents d WHERE d.set_id = ? ORDER BY d.title COLLATE NOCASE`,
      )
      .all(setId) as unknown as DocumentRow[];
  }

  documentPath(id: number): string | null {
    const row = this.db.prepare('SELECT path FROM documents WHERE id = ?').get(id) as { path: string } | undefined;
    return row?.path ?? null;
  }

  /** True when this exact version of the file is already indexed without error. */
  isCurrent(setId: number, path: string, mtimeMs: number, size: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM documents WHERE set_id = ? AND path = ? AND mtime_ms = ? AND size = ? AND error IS NULL')
      .get(setId, path, mtimeMs, size);
    return row !== undefined;
  }

  saveDocument(
    doc: { setId: number; path: string; title: string; mtimeMs: number; size: number },
    chunks: (Chunk & { embedding: Float32Array })[],
    error: string | null = null,
  ) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM documents WHERE set_id = ? AND path = ?').run(doc.setId, doc.path);
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO documents(set_id, path, title, mtime_ms, size, error) VALUES (?, ?, ?, ?, ?, ?)')
        .run(doc.setId, doc.path, doc.title, doc.mtimeMs, doc.size, error);
      const insert = this.db.prepare('INSERT INTO chunks(document_id, text, page, line, embedding) VALUES (?, ?, ?, ?, ?)');
      for (const c of chunks) {
        const blob = new Uint8Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength);
        insert.run(lastInsertRowid, c.text, c.page, c.line, blob);
      }
    });
  }

  removeDocument(id: number) {
    this.transaction(() => this.db.prepare('DELETE FROM documents WHERE id = ?').run(id));
  }

  /** Drops documents under a set whose files are no longer found. */
  removeMissing(setId: number, present: Set<string>) {
    for (const doc of this.documents(setId)) if (!present.has(doc.path)) this.removeDocument(doc.id);
  }

  vectors(setIds: number[]): VectorRows {
    if (setIds.length === 0) return { ids: [], vectors: [] };
    const rows = this.db
      .prepare(
        `SELECT c.id, c.embedding FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.set_id IN (${placeholders(setIds)})`,
      )
      .all(...setIds) as unknown as { id: number; embedding: Uint8Array }[];
    return {
      ids: rows.map((r) => r.id),
      vectors: rows.map((r) => {
        // Copy: the driver's buffer may not be aligned for floats.
        const bytes = r.embedding.slice();
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      }),
    };
  }

  keywordSearch(setIds: number[], query: string, limit: number): number[] {
    const terms = query.match(/[\p{L}\p{N}]+/gu)?.filter((t) => t.length > 1) ?? [];
    if (terms.length === 0 || setIds.length === 0) return [];
    // Quoting makes every term a literal, so user text cannot act as FTS syntax.
    const match = terms.map((t) => `"${t}"`).join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT c.id FROM chunks_fts f
         JOIN chunks c ON c.id = f.rowid
         JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ? AND d.set_id IN (${placeholders(setIds)})
         ORDER BY bm25(chunks_fts) LIMIT ?`,
      )
      .all(match, ...setIds, limit) as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }

  chunksById(ids: number[]): StoredChunk[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id AS documentId, c.text, c.page, c.line, d.title, d.path, s.name AS setName
         FROM chunks c JOIN documents d ON d.id = c.document_id JOIN sets s ON s.id = d.set_id
         WHERE c.id IN (${placeholders(ids)})`,
      )
      .all(...ids) as unknown as StoredChunk[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  pronunciations(): Pronunciation[] {
    return this.db
      .prepare('SELECT word, spoken FROM pronunciations ORDER BY word COLLATE NOCASE')
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
    this.db.prepare('DELETE FROM pronunciations WHERE word = ?').run(word);
  }

  private transaction(fn: () => void) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
      this.generation++;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
