import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_EMBEDDER_CONFIG } from "../../dist/memory/embedder.js";
import { MemoryIndex } from "../../dist/memory/memory-index.js";
import { MemorySearch } from "../../dist/memory/memory-search.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "en-eval");
const readJsonl = (name) => readFileSync(join(fixtureDir, name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const ngrams = (query) => {
  const grams = new Set();
  for (const word of query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const chars = [...word];
    for (let i = 0; i + 3 <= chars.length; i += 1) grams.add(chars.slice(i, i + 3).join(""));
  }
  return [...grams];
};

async function indexedNotes(notes, run) {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-en-eval-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "global"), { recursive: true });
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir: join(root, "data"), storage, watch: false });
  try {
    for (const note of notes) {
      writeFileSync(join(vault, "global", `${note.id}.md`), `---\nid: ${note.id}\ntitle: ${note.title}\ntype: lesson\nstatus: active\nsummary: ${note.body.slice(0, 180).replace(/\n/gu, " ")}\n---\n${note.body}\n`);
    }
    await index.start();
    await index.rebuild("manual");
    return await run(index);
  } finally {
    await index.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function rawTrigramSearch(index, query) {
  const terms = ngrams(query);
  if (terms.length === 0) return [];
  const match = terms.map((term) => `"${term.replace(/"/gu, '""')}"`).join(" OR ");
  return index.db().prepare(`SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? AND n.status != 'draft' AND n.type NOT IN ('raw','log','superseded','archived')
      AND n.scope = 'global'
    ORDER BY bm25(notes_fts, 10.0, 5.0, 5.0, 0.1), n.rowid LIMIT 10`).all(match).map((row) => row.id);
}

function scores(queries, rankedIds) {
  const totals = new Map();
  const all = { r5: 0, mrr: 0 };
  for (const query of queries) {
    const ids = rankedIds(query.query).slice(0, 10);
    const relevant = new Set(query.relevant);
    const rank = ids.findIndex((id) => relevant.has(id));
    const hit5 = ids.slice(0, 5).filter((id) => relevant.has(id)).length / relevant.size;
    const group = totals.get(query.type) ?? { count: 0, r5: 0, mrr: 0 };
    group.count += 1;
    group.r5 += hit5;
    group.mrr += rank < 0 ? 0 : 1 / (rank + 1);
    all.r5 += hit5;
    all.mrr += rank < 0 ? 0 : 1 / (rank + 1);
    totals.set(query.type, group);
  }
  const result = {};
  for (const [type, group] of totals) result[type] = { r5: group.r5 / group.count, mrr: group.mrr / group.count };
  result.all = { r5: all.r5 / queries.length, mrr: all.mrr / queries.length };
  return result;
}

test("English evaluation corpus favors the current search path over raw trigram retrieval", async () => {
  const notes = readJsonl("notes.jsonl");
  const queries = readJsonl("queries.jsonl");
  assert.ok(notes.length >= 30);
  assert.ok(queries.length >= 20);
  assert.ok(queries.filter((q) => q.type === "keyword").length >= 8);
  assert.ok(queries.filter((q) => q.type === "paraphrase").length >= 8);
  const metrics = await indexedNotes(notes, async (index) => {
    const search = new MemorySearch({ index, weights: { fts: 1, vec: 0 }, profile: { ...DEFAULT_EMBEDDER_CONFIG.profile, content: true } });
    const current = (query) => search.search({ query, limit: 10 }).then((result) => result.hits.map((hit) => hit.row.id));
    const baseline = (query) => rawTrigramSearch(index, query);
    const currentRankings = new Map();
    const baselineRankings = new Map();
    for (const query of queries) currentRankings.set(query.query, await current(query.query));
    for (const query of queries) baselineRankings.set(query.query, baseline(query.query));
    const currentResult = scores(queries, (query) => currentRankings.get(query) ?? []);
    const baselineResult = scores(queries, (query) => baselineRankings.get(query) ?? []);
    const examples = new Map();
    for (const id of ["q01", "q06", "q08"]) {
      const query = queries.find((item) => item.id === id);
      examples.set(id, currentRankings.get(query.query).slice(0, 5));
    }
    const caseVariant = queries.find((item) => item.id === "q02");
    examples.set("q02", (await current(caseVariant.query.toUpperCase())).slice(0, 5));
    return { currentResult, baselineResult, currentRankings, baselineRankings, examples, queries };
  });
  assert.ok(metrics.currentResult.all.r5 >= metrics.baselineResult.all.r5, `current R@5 ${metrics.currentResult.all.r5} < raw trigram ${metrics.baselineResult.all.r5}`);
  const mrrRegressions = metrics.queries.filter((query) => {
    const first = (map) => map.get(query.query).findIndex((id) => query.relevant.includes(id));
    return first(metrics.currentRankings) > first(metrics.baselineRankings);
  }).map((query) => query.id);
  assert.ok(metrics.currentResult.all.mrr >= metrics.baselineResult.all.mrr, `current MRR@10 ${metrics.currentResult.all.mrr} < raw trigram ${metrics.baselineResult.all.mrr}; ranks worse on ${mrrRegressions.join(", ")}`);

  const byId = new Map(metrics.queries.map((query) => [query.id, query]));
  for (const [id, label] of [["q01", "multiple words"], ["q06", "a two-character word"], ["q08", "a hyphen"], ["q02", "case-insensitive text"]]) {
    const query = byId.get(id);
    const hits = metrics.examples.get(id);
    assert.ok(query.relevant.some((noteId) => hits.includes(noteId)), `${label} (${id}) failed: ${JSON.stringify(hits)}`);
  }
});
