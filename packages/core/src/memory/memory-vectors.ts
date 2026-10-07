import type Database from "better-sqlite3";

import type { Embedder, RetrievalProfile } from "./embedder.js";

/** note_chunks maps a vec0 rowid (chunk_id) to its note; it exists on every index, notes_vec only once something was embedded. */
export const CHUNKS_DDL = `
CREATE TABLE IF NOT EXISTS note_chunks (chunk_id INTEGER PRIMARY KEY, note_rowid INTEGER NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS note_chunks_note ON note_chunks(note_rowid);
`;

const BATCH = 4;
const KNN_K = 200;

/** sqlite-vec is optional: without it (or its prebuilt binary) the index still works with FTS only. */
export function loadVec(db: Database.Database): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("sqlite-vec") as { load(db: Database.Database): void }).load(db);
    return null;
  } catch (error) {
    return `${(error as Error).message} (埋め込みを使うには pnpm install が必要)`;
  }
}

const vecTableExists = (db: Database.Database): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'notes_vec'").get() !== undefined;

export function hasVectors(db: Database.Database): boolean {
  return vecTableExists(db) && db.prepare("SELECT 1 FROM note_chunks LIMIT 1").get() !== undefined;
}

export function removeVectors(db: Database.Database, noteRowid: number): void {
  const ids = db.prepare("SELECT chunk_id FROM note_chunks WHERE note_rowid = ?").all(noteRowid) as { chunk_id: number }[];
  if (ids.length === 0) return;
  if (vecTableExists(db)) for (const { chunk_id } of ids) db.prepare("DELETE FROM notes_vec WHERE rowid = ?").run(BigInt(chunk_id));
  db.prepare("DELETE FROM note_chunks WHERE note_rowid = ?").run(noteRowid);
}

/**
 * Heading-delimited chunks of at most `chunkChars` body characters, each led by the title (and the summary when `prefix`).
 * The first chunk always carries title and summary. With `headVec` a title+summary-only text comes first (stored with seq -1).
 */
export function chunkNote(title: string, summary: string, body: string, profile: Pick<RetrievalProfile, "chunkChars" | "maxChunks" | "prefix" | "headVec">): string[] {
  const head = `${title}\n${summary}\n`;
  const lead = profile.prefix ? head : `${title}\n`;
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => { if (current.trim()) chunks.push(`${chunks.length === 0 ? head : lead}${current.trim()}`); current = ""; };
  for (const section of body.split(/^(?=#{1,6}\s)/mu)) {
    for (let i = 0; i < section.length; i += profile.chunkChars) {
      const piece = section.slice(i, i + profile.chunkChars);
      if (current.length + piece.length > profile.chunkChars) flush();
      current += piece;
    }
    if (current.length >= profile.chunkChars) flush();
  }
  flush();
  if (chunks.length === 0) chunks.push(head);
  return [...(profile.headVec > 0 ? [head.trim()] : []), ...chunks.slice(0, profile.maxChunks)];
}

const toBlob = (vector: Float32Array): Buffer => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

/** Embeds every note that has no chunks yet. Returns the number of notes embedded. */
export async function embedPending(db: Database.Database, embedder: Embedder, profile: RetrievalProfile, meta: Record<string, string>, setMeta: (key: string, value: string) => void): Promise<number> {
  const current = (db.prepare("SELECT value FROM meta WHERE key = 'embed_model'").get() as { value: string } | undefined)?.value;
  const currentProfile = (db.prepare("SELECT value FROM meta WHERE key = 'profile'").get() as { value: string } | undefined)?.value;
  const chunking = JSON.stringify([profile.chunkChars, profile.maxChunks, profile.prefix, profile.headVec > 0, profile.maxTokens]);
  if ((current !== undefined && current !== embedder.model) || (currentProfile !== undefined && (JSON.parse(currentProfile) as { chunking: string }).chunking !== chunking)) {
    db.exec("DROP TABLE IF EXISTS notes_vec; DELETE FROM note_chunks;");
  }
  const pending = db.prepare(
    "SELECT n.rowid, n.title, n.summary, n.body FROM notes n WHERE NOT EXISTS (SELECT 1 FROM note_chunks c WHERE c.note_rowid = n.rowid) ORDER BY n.path",
  ).all() as { rowid: number; title: string; summary: string; body: string }[];
  let done = 0;
  for (const note of pending) {
    const texts = chunkNote(note.title, note.summary, note.body, profile);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) vectors.push(...await embedder.embed("passage", texts.slice(i, i + BATCH), { maxTokens: profile.maxTokens }));
    const dim = vectors[0]?.length ?? 0;
    if (dim === 0) continue;
    if (!vecTableExists(db)) db.exec(`CREATE VIRTUAL TABLE notes_vec USING vec0(embedding float[${dim}] distance_metric=cosine)`);
    db.transaction(() => {
      removeVectors(db, note.rowid);
      vectors.forEach((vector, i) => {
        const seq = profile.headVec > 0 ? i - 1 : i;
        const { lastInsertRowid } = db.prepare("INSERT INTO note_chunks (note_rowid, seq) VALUES (?, ?)").run(note.rowid, seq);
        db.prepare("INSERT INTO notes_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(lastInsertRowid), toBlob(vector));
      });
    })();
    done += 1;
  }
  for (const [key, value] of Object.entries({ ...meta, profile: JSON.stringify({ ...profile, chunking }), embed_model: embedder.model ?? "", embed_at: new Date().toISOString() })) setMeta(key, value);
  return done;
}

/** Notes nearest to `query`, nearest first: by best body chunk, and by the title+summary vector (seq -1). */
export function knn(db: Database.Database, query: Float32Array): { body: number[]; head: number[]; similarity: Map<number, number> } {
  const select = (k: number): { note_rowid: number; seq: number; distance: number }[] => db.prepare(
    `SELECT c.note_rowid AS note_rowid, c.seq AS seq, v.distance AS distance FROM (SELECT rowid, distance FROM notes_vec WHERE embedding MATCH ? AND k = ${k}) v
     JOIN note_chunks c ON c.chunk_id = v.rowid ORDER BY v.distance, (SELECT path FROM notes WHERE rowid = c.note_rowid), c.seq`,
  ).all(toBlob(query)) as { note_rowid: number; seq: number; distance: number }[];
  let rows = select(KNN_K + 1);
  if (rows.length > KNN_K && rows[KNN_K]!.distance === rows[KNN_K - 1]!.distance) {
    // vec0 cuts ties at the limit by chunk_id, which depends on insert history; rank every chunk by distance, then path, then seq.
    rows = db.prepare(
      `SELECT c.note_rowid AS note_rowid, c.seq AS seq, vec_distance_cosine(v.embedding, ?) AS distance FROM notes_vec v JOIN note_chunks c ON c.chunk_id = v.rowid
       ORDER BY distance, (SELECT path FROM notes WHERE rowid = c.note_rowid), c.seq LIMIT ${KNN_K}`,
    ).all(toBlob(query)) as typeof rows;
  } else rows = rows.slice(0, KNN_K);
  // Rows come nearest first, so a note's first row holds its smallest distance; notes_vec is cosine, so similarity = 1 - distance.
  const similarity = new Map<number, number>();
  for (const r of rows) if (!similarity.has(r.note_rowid)) similarity.set(r.note_rowid, 1 - r.distance);
  const ids = (keep: (seq: number) => boolean): number[] => [...new Set(rows.filter((r) => keep(r.seq)).map((r) => r.note_rowid))];
  return { body: ids((seq) => seq >= 0), head: ids((seq) => seq < 0), similarity };
}
