import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_EMBEDDER_CONFIG } from "../../dist/memory/embedder.js";
import { MemoryService } from "../../dist/memory/memory-service.js";
import { buildFtsQueryPlan } from "../../dist/memory/memory-search.js";
import { CHUNKS_DDL, chunkNote, knn, loadVec } from "../../dist/memory/memory-vectors.js";

const PROFILE = DEFAULT_EMBEDDER_CONFIG.profile;

test("default profile is the dev-chosen one", () => {
  assert.deepEqual(PROFILE, { chunkChars: 1500, maxChunks: 20, prefix: true, headVec: 1, ftsHead: 0.5, content: false, queryChars: 60, ftsTop: 20, maxTokens: 384 });
  assert.deepEqual(DEFAULT_EMBEDDER_CONFIG.weights, { fts: 1, vec: 1.5 });
});

test("chunks: every chunk starts with title and summary when prefix is on; headVec adds a title+summary-only text first", () => {
  const body = `# A\n${"あ".repeat(1000)}\n# B\n${"い".repeat(1000)}`;
  const chunks = chunkNote("T", "S", body, { chunkChars: 1500, maxChunks: 20, prefix: true, headVec: 1 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0], "T\nS");
  assert.ok(chunks[1].startsWith("T\nS\n# A") && chunks[2].startsWith("T\nS\n# B"));
  const plain = chunkNote("T", "S", body, { chunkChars: 1500, maxChunks: 20, prefix: false, headVec: 0 });
  assert.equal(plain.length, 2);
  assert.ok(plain[0].startsWith("T\nS\n# A") && plain[1].startsWith("T\n# B"));
});

test("chunks: shorter chunkChars splits a 1200-char section into pieces of at most 500", () => {
  const chunks = chunkNote("T", "S", "x".repeat(1200), { chunkChars: 500, maxChunks: 20, prefix: true, headVec: 0 });
  assert.deepEqual(chunks.map((c) => c.length), [4 + 500, 4 + 500, 4 + 200]);
});

test("query processing: content mode cuts at hiragana, so particles stop making trigrams", () => {
  const q = "Nimbus探査隊が蒼星基地へ通信を送信する";
  assert.equal(buildFtsQueryPlan(q).trigramMatch.split(" OR ").length, 20);
  assert.ok(buildFtsQueryPlan(q).trigramMatch.includes('"探査隊"'));
  const cut = buildFtsQueryPlan(q, true);
  assert.equal(cut.trigramMatch, '"us探" OR "s探査" OR "探査隊" OR "蒼星基" OR "星基地" OR "nim" OR "imb" OR "mbu" OR "bus"');
  assert.deepEqual(cut.phrases, ["nimbus探査隊", "蒼星基地"]);
  assert.deepEqual(cut.likeTerms, ["通信", "送信"]);
});

test("knn: best body chunk per note, nearest first; head vectors (seq -1) form their own list", () => {
  const db = new Database(":memory:");
  assert.equal(loadVec(db), null);
  db.exec(CHUNKS_DDL);
  db.exec("CREATE TABLE notes (rowid INTEGER PRIMARY KEY, path TEXT)");
  for (const [rowid, path] of [[10, "a"], [20, "b"], [30, "c"]]) db.prepare("INSERT INTO notes (rowid, path) VALUES (?, ?)").run(rowid, path);
  db.exec("CREATE VIRTUAL TABLE notes_vec USING vec0(embedding float[2] distance_metric=cosine)");
  const add = (chunkId, note, seq, v) => {
    db.prepare("INSERT INTO note_chunks (chunk_id, note_rowid, seq) VALUES (?, ?, ?)").run(chunkId, note, seq);
    db.prepare("INSERT INTO notes_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(chunkId), Buffer.from(Float32Array.from(v).buffer));
  };
  add(1, 10, -1, [0, 1]);
  add(2, 10, 0, [1, 0.1]);
  add(3, 10, 1, [1, 0]);
  add(4, 20, 0, [1, 1]);
  add(5, 30, -1, [1, 0]);
  const near = knn(db, Float32Array.from([1, 0]));
  assert.deepEqual(near.body, [10, 20]);
  assert.deepEqual(near.head, [30, 10]);
});

test("queryChars: only the first 60 characters of a long query reach the embedder (with maxTokens)", async () => {
  const sent = [];
  const limits = [];
  const embedder = { model: "m", embed: async (_kind, texts, options) => { sent.push(...texts); limits.push(options.maxTokens); return texts.map(() => Float32Array.from([1, 0])); } };
  const db = new Database(":memory:");
  assert.equal(loadVec(db), null);
  db.exec(CHUNKS_DDL);
  db.exec("CREATE VIRTUAL TABLE notes_vec USING vec0(embedding float[2] distance_metric=cosine)");
  db.prepare("INSERT INTO note_chunks (chunk_id, note_rowid, seq) VALUES (1, 1, 0)").run();
  db.prepare("INSERT INTO notes_vec (rowid, embedding) VALUES (1, ?)").run(Buffer.from(Float32Array.from([1, 0]).buffer));
  db.exec("CREATE TABLE notes (rowid INTEGER PRIMARY KEY, status TEXT, type TEXT, scope TEXT, project_ids_json TEXT)");
  db.prepare("INSERT INTO notes (rowid, status, type, scope) VALUES (1, 'active', 'lesson', 'global')").run();
  const index = { hasVectors: () => true, nearest: (q) => knn(db, q), db: () => db, status: () => ({ stale: false, last_scan_at: null }), getByRowid: () => undefined };
  const { MemorySearch } = await import("../../dist/memory/memory-search.js");
  await new MemorySearch({ index, embedder, weights: { fts: 0, vec: 1 }, profile: PROFILE }).search({ query: "あ".repeat(100) });
  assert.deepEqual(sent, ["あ".repeat(60)]);
  assert.deepEqual(limits, [384]);
});

test("ftsHead: a note whose title matches earns a second list entry; a body-only match does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-profile-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  mkdirSync(join(root, "data"));
  writeFileSync(join(vault, "notes", "a.md"), "---\ntitle: 庭\ntype: lesson\n---\n## Summary\n庭の手入れ\n\n## Claims\n- キウイの蔓は成長が早い\n");
  writeFileSync(join(vault, "notes", "b.md"), "---\ntitle: キウイ\ntype: lesson\n---\n甘くて緑色\n");
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir: join(root, "data"), storage, weights: { fts: 1, vec: 0 }, profile: { ...PROFILE, ftsHead: 1 }, indexOptions: { watch: false } });
  try {
    await service.start();
    await service.reindex({ mode: "full" });
    const { hits } = await service.searcher.search({ query: "キウイ" });
    assert.deepEqual(hits.map((h) => h.row.title), ["キウイ", "庭"]);
    assert.ok(Math.abs(hits[0].rrf - 2 / 61) < 1e-12, `${hits[0].rrf}`);
    assert.ok(Math.abs(hits[1].rrf - 1 / 62) < 1e-12, `${hits[1].rrf}`);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsTop: each list contributes only its first ftsTop notes to RRF (rank 1 only: 1/61)", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-profile-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  mkdirSync(join(root, "data"));
  writeFileSync(join(vault, "notes", "a.md"), "---\ntitle: キウイ\ntype: lesson\n---\n甘くて緑色\n");
  writeFileSync(join(vault, "notes", "b.md"), "---\ntitle: 庭\ntype: lesson\n---\nキウイの蔓は成長が早い\n");
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir: join(root, "data"), storage, weights: { fts: 1, vec: 0 }, profile: { ...PROFILE, ftsHead: 0, ftsTop: 1 }, indexOptions: { watch: false } });
  try {
    await service.start();
    await service.reindex({ mode: "full" });
    const { hits } = await service.searcher.search({ query: "キウイ" });
    assert.deepEqual(hits.map((h) => h.row.title), ["キウイ"]);
    assert.ok(Math.abs(hits[0].rrf - 1 / 61) < 1e-12, `${hits[0].rrf}`);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
