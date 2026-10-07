import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluate, parseSet } from "../../../../scripts/memory-eval.mjs";
import { MemoryIndex } from "../../dist/memory/memory-index.js";
import { MemorySearch } from "../../dist/memory/memory-search.js";

const fixtures = new URL("../fixtures/memory-eval/", import.meta.url);
const items = parseSet(readFileSync(new URL("set.jsonl", fixtures), "utf8"));
const notes = parseSet(readFileSync(new URL("notes.jsonl", fixtures), "utf8"));

test("metrics match hand-computed values", async () => {
  const set = [
    { question: "a", gold_ids: ["x"], kind: "k1", split: "dev" },          // rank 1 -> R5 1, MRR 1
    { question: "b", gold_ids: ["x", "y"], kind: "k1", split: "dev" },     // x@3, y@8 -> R5 .5, R10 1, MRR 1/3
    { question: "c", gold_ids: ["x"], kind: "k2", split: "holdout" },      // x@7 -> R5 0, R10 1, MRR 1/7
    { question: "d", gold_ids: ["x"], kind: "k2", split: "holdout" },      // miss
  ];
  const ranked = {
    a: ["x"],
    b: ["p", "q", "x", "r", "s", "t", "u", "y"],
    c: ["p", "q", "r", "s", "t", "u", "x"],
    d: ["p"],
  };
  const all = await evaluate(set, async (q) => ranked[q], "all");
  assert.equal(all.all.count, 4);
  assert.ok(Math.abs(all.all.recall_at_5 - 1.5 / 4) < 1e-9);
  assert.ok(Math.abs(all.all.recall_at_10 - 3 / 4) < 1e-9);
  assert.ok(Math.abs(all.all.mrr_at_10 - (1 + 1 / 3 + 1 / 7) / 4) < 1e-9);
  assert.ok(Math.abs(all["kind:k1"].recall_at_5 - 0.75) < 1e-9);
  assert.equal(all["kind:k2"].recall_at_5, 0);
  const dev = await evaluate(set, async (q) => ranked[q], "dev");
  assert.equal(dev.all.count, 2);
  assert.equal(dev["kind:k2"], undefined);
});

test("fixture set has both splits and kinds", () => {
  assert.deepEqual([...new Set(items.map((i) => i.split))].sort(), ["dev", "holdout"]);
  assert.deepEqual([...new Set(items.map((i) => i.kind))].sort(), ["keyword", "natural"]);
});

test("product MemorySearch beats the old word-intersection retriever on natural questions", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-eval-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  for (const n of notes) {
    writeFileSync(join(vault, "notes", `${n.id}.md`), `---\nid: ${n.id}\ntitle: ${n.title}\nsummary: ${n.summary}\ntags: [${n.tags.join(", ")}]\n---\n${n.body}\n`);
  }
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir: join(root, "data"), storage, watch: false });
  try {
    index.open();
    await index.rebuild("test");
    const searcher = new MemorySearch({ index, embedder: { enabled: false } });
    const product = async (query) => (await searcher.search({ query, limit: 10, include_raw: true })).hits.map((h) => h.row.id);
    await compare(product);
  } finally {
    await index.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("path: gold counts as a hit for a note without frontmatter id (FTS only)", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-eval-path-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "works"), { recursive: true });
  writeFileSync(join(vault, "works", "zebra-quartz-note.md"), "---\ntitle: zebra-quartz-note\ntype: reference\nsummary: zebra quartz harbor\nstatus: active\n---\nzebra quartz harbor と別の語\n");
  writeFileSync(join(vault, "works", "other.md"), "---\ntitle: other\ntype: reference\nsummary: x\nstatus: active\n---\nまったく別の話題\n");
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir: join(root, "data"), storage, watch: false });
  try {
    index.open();
    await index.rebuild("test");
    const searcher = new MemorySearch({ index, embedder: { enabled: false } });
    const search = async (query) => (await searcher.search({ query, limit: 10, include_raw: true })).hits.map((h) => h.row.id);
    const set = [{ question: "zebra quartz harbor", gold_ids: ["path:works/zebra-quartz-note.md"], kind: "keyword", split: "dev" }];
    const detail = [];
    const result = await evaluate(set, search, "all", detail);
    assert.equal(detail[0].first_gold_rank, 1);
    assert.equal(result.all.recall_at_5, 1);
    assert.equal(result.all.mrr_at_10, 1);
  } finally {
    await index.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

async function compare(product) {
  const docs = notes.map((n) => ({ id: n.id, title: n.title, tags: n.tags, summary: n.summary, claims: [], project_ids: [], updated: "2026-01-01" }));
  // 旧方式: 単語積集合の点数（タイトル・タグ×2＋要約）。評価の比較基準としてここだけに残す。
  const words = (v) => new Set((v.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1));
  const overlap = (a, b) => [...a].filter((w) => b.has(w)).length;
  const old = async (q) => {
    const query = words(q);
    return docs
      .map((n) => ({ n, score: overlap(query, words(`${n.title} ${n.tags.join(" ")}`)) * 2 + overlap(query, words(n.summary)) }))
      .filter(({ score }) => score >= 1)
      .sort((x, y) => y.score - x.score || y.n.updated.localeCompare(x.n.updated) || x.n.id.localeCompare(y.n.id))
      .slice(0, 10).map(({ n }) => n.id);
  };
  const natural = items.filter((i) => i.kind === "natural");
  const before = (await evaluate(natural, old)).all.recall_at_5;
  const after = (await evaluate(natural, product)).all.recall_at_5;
  assert.ok(after > before, `MemorySearch ${after} should exceed old ${before}`);
}
