import Database from "better-sqlite3";
import { existsSync } from "node:fs";

import type { Embedder, RetrievalProfile } from "./embedder.js";
import { MEMORY_INDEX_SCHEMA_VERSION, getMeta, setMeta } from "./memory-index.js";
import { CHUNKS_DDL, embedPending, loadVec } from "./memory-vectors.js";

/** Embeds the pending notes of an index file directly (for `owl embeddings`), without a running MemoryService. */
export async function embedIndexFile(input: {
  indexPath: string; embedder: Embedder; profile: RetrievalProfile; pageTypes: readonly string[]; meta: Record<string, string>;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ status: "done"; embedded: number; pending: number; elapsedMs: number } | { status: "no_index" } | { status: "schema_mismatch" }> {
  if (!existsSync(input.indexPath)) return { status: "no_index" };
  const db = new Database(input.indexPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 3000");
    if (getMeta(db, "schema_version") !== String(MEMORY_INDEX_SCHEMA_VERSION)) return { status: "schema_mismatch" };
    const vecError = loadVec(db);
    if (vecError) throw new Error(`sqlite-vec unavailable: ${vecError}`);
    db.exec(CHUNKS_DDL);
    const started = Date.now();
    let pending = 0;
    const embedded = await embedPending(db, input.embedder, input.profile, input.meta, (key, value) => setMeta(db, key, value), {
      pageTypes: input.pageTypes, onProgress: (done, total) => { pending = total; input.onProgress?.(done, total); },
    });
    return { status: "done", embedded, pending, elapsedMs: Date.now() - started };
  } finally {
    db.close();
  }
}
