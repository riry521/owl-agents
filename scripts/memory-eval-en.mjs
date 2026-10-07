#!/usr/bin/env node
// Re-run from the repository root with: node scripts/memory-eval-en.mjs
// Builds only under the OS temp directory; reads the fictional en-eval JSONL fixtures.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/core/test/memory/fixtures/en-eval");
const parseJsonl = (file) => readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));

function validate(notes, queries) {
  assert.ok(notes.length >= 1, "notes.jsonl is empty");
  assert.ok(queries.length >= 1, "queries.jsonl is empty");
  for (const [i, note] of notes.entries()) {
    assert.equal(typeof note.id, "string", `note ${i + 1} has no id`);
    assert.equal(typeof note.title, "string", `note ${i + 1} has no title`);
    assert.equal(typeof note.body, "string", `note ${i + 1} has no body`);
  }
  for (const [i, query] of queries.entries()) {
    assert.equal(typeof query.id, "string", `query ${i + 1} has no id`);
    assert.ok(query.type === "keyword" || query.type === "paraphrase", `query ${query.id} has invalid type`);
    assert.equal(typeof query.query, "string", `query ${query.id} has no text`);
    assert.ok(Array.isArray(query.relevant) && query.relevant.length > 0, `query ${query.id} has no relevant note ids`);
    for (const id of query.relevant) assert.ok(notes.some((note) => note.id === id), `query ${query.id} refers to missing note ${id}`);
  }
  for (const type of ["keyword", "paraphrase"]) assert.ok(queries.filter((query) => query.type === type).length >= 1, `no ${type} queries`);
}

const ngrams = (query) => {
  const grams = new Set();
  const normalized = query.normalize("NFKC").toLowerCase();
  for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const chars = [...word];
    for (let i = 0; i + 3 <= chars.length; i += 1) grams.add(chars.slice(i, i + 3).join(""));
  }
  return [...grams];
};

function rawTrigramSearch(index, query) {
  const grams = ngrams(query);
  if (grams.length === 0) return [];
  const match = grams.map((gram) => `"${gram.replace(/"/gu, '""')}"`).join(" OR ");
  return index.db().prepare(`SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? AND n.status != 'draft' AND n.type NOT IN ('raw','log','superseded','archived')
      AND n.scope = 'global'
    ORDER BY bm25(notes_fts, 10.0, 5.0, 5.0, 0.1), n.rowid LIMIT 10`).all(match).map((row) => row.id);
}

async function evaluate(queries, rank) {
  const groups = new Map();
  for (const query of queries) {
    const ids = (await rank(query.query)).slice(0, 10);
    const relevant = new Set(query.relevant);
    const first = ids.findIndex((id) => relevant.has(id));
    const metrics = groups.get(query.type) ?? { count: 0, recall: 0, mrr: 0 };
    metrics.count += 1;
    metrics.recall += ids.slice(0, 5).filter((id) => relevant.has(id)).length / relevant.size;
    metrics.mrr += first < 0 ? 0 : 1 / (first + 1);
    groups.set(query.type, metrics);
  }
  const result = {};
  const all = { count: 0, recall: 0, mrr: 0 };
  for (const [type, group] of groups) {
    result[type] = { count: group.count, recall_at_5: group.recall / group.count, mrr_at_10: group.mrr / group.count };
    all.count += group.count; all.recall += group.recall; all.mrr += group.mrr;
  }
  result.all = { count: all.count, recall_at_5: all.recall / all.count, mrr_at_10: all.mrr / all.count };
  return result;
}

async function run() {
  const notes = parseJsonl(join(fixtureDir, "notes.jsonl"));
  const queries = parseJsonl(join(fixtureDir, "queries.jsonl"));
  validate(notes, queries);

  const base = new URL("../packages/core/dist/memory/", import.meta.url);
  const [{ MemoryIndex }, { MemorySearch }, { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG }] = await Promise.all([
    import(new URL("memory-index.js", base)), import(new URL("memory-search.js", base)), import(new URL("embedder.js", base)),
  ]);
  const root = mkdtempSync(join(tmpdir(), "owl-memory-en-eval-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(join(vault, "global"), { recursive: true });
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir, storage, watch: false });
  let embedder;
  try {
    for (const note of notes) {
      const summary = note.body.split(/\s+/u).slice(0, 30).join(" ").replace(/[\r\n]/gu, " ");
      const body = note.body.replace(/\r\n?/gu, "\n");
      writeFileSync(join(vault, "global", `${encodeURIComponent(note.id)}.md`), `---\nid: ${note.id}\ntitle: ${note.title}\ntype: lesson\nstatus: active\nsummary: ${summary}\n---\n${body}\n`);
    }
    await index.start();
    await index.rebuild("eval");
    const profile = { ...DEFAULT_EMBEDDER_CONFIG.profile, content: true };
    const currentSearch = new MemorySearch({ index, weights: { fts: 1, vec: 0 }, profile });
    const currentRank = async (query) => (await currentSearch.search({ query, limit: 10 })).hits.map((hit) => hit.row.id);
    const current = await evaluate(queries, (query) => currentRank(query));
    const raw = await evaluate(queries, (query) => rawTrigramSearch(index, query));

    const model = process.env.OWL_MEMORY_EMBED_MODEL ?? DEFAULT_EMBEDDER_CONFIG.model;
    const modelDirs = [process.env.OWL_MEMORY_MODELS_DIR, join(dataDir, "models"), join(homedir(), ".owl", "models")].filter(Boolean);
    const modelAvailable = modelDirs.some((dir) => existsSync(join(dir, model, "config.json")));
    let hybrid = null;
    if (modelAvailable) {
      // The hybrid evaluation explicitly opts in for this run.
      embedder = new ChildEmbedder({ ...DEFAULT_EMBEDDER_CONFIG, enabled: true, model, modelsDirs: modelDirs });
      await embedder.embed("query", ["warmup"], { timeoutMs: DEFAULT_EMBEDDER_CONFIG.requestTimeoutMs });
      await index.embedPending(embedder, profile, { rrf_w_fts: String(DEFAULT_EMBEDDER_CONFIG.weights.fts), rrf_w_vec: String(DEFAULT_EMBEDDER_CONFIG.weights.vec) });
      const hybridSearch = new MemorySearch({ index, embedder, weights: DEFAULT_EMBEDDER_CONFIG.weights, profile });
      const hybridRank = async (query) => (await hybridSearch.search({ query, limit: 10 })).hits.map((hit) => hit.row.id);
      hybrid = await evaluate(queries, (query) => hybridRank(query));
    }

    console.log(`English memory retrieval evaluation (notes=${notes.length}, queries=${queries.length}, model=${modelAvailable ? model : "none"})`);
    console.log("path\tgroup\tn\tRecall@5\tMRR@10");
    for (const [name, metrics] of [["current FTS+LIKE", current], ["raw trigram", raw], ...(hybrid ? [["hybrid", hybrid]] : [])]) {
      for (const group of ["all", "keyword", "paraphrase"]) {
        const m = metrics[group];
        console.log(`${name}\t${group}\t${m.count}\t${m.recall_at_5.toFixed(3)}\t${m.mrr_at_10.toFixed(3)}`);
      }
    }
    if (!modelAvailable) console.log(`hybrid\tskipped\tmodel not found (${model})`);
  } finally {
    await embedder?.stop();
    await index.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
