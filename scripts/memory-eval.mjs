#!/usr/bin/env node
// Retrieval eval: Recall@5 / Recall@10 / MRR@10, overall and per kind.
// Usage: node scripts/memory-eval.mjs --set <jsonl> (--index <memory-index.sqlite> | --vault <dir>) [--mode fts|vec|hybrid] [--split dev|holdout|all] [--page-types clipping,theme,...] [--lines <json of pass lines for health>] [--detail] [--json]
//   vec/hybrid: [--model <id>] [--models-dir <dir>] [--w-fts <n>] [--w-vec <n>] [--grid] [--profile <json overriding the retrieval profile>]; results are saved to $OWL_DATA_DIR/memory-eval/<ts>.json.
//   --vault <dir> builds a fresh index (and embeddings) in $OWL_DATA_DIR from a copy of the vault; never point it at the production data dir.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseSet(text) {
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** "clipping,theme" -> ["clipping", "theme"]; null when not given (every page kind is searched). */
const parsePageTypes = (text) => (text ? text.split(",").map((t) => t.trim()).filter(Boolean) : null);

const ratio = (sum, n) => (n === 0 ? 0 : sum / n);

/** search(question) -> ranked ids (best first). Pure apart from calling `search`. */
export async function evaluate(items, search, split = "all", detail = null) {
  const picked = items.filter((item) => split === "all" || item.split === split);
  const groups = new Map();
  const add = (key, m) => {
    const g = groups.get(key) ?? { n: 0, r5: 0, r10: 0, mrr: 0 };
    g.n += 1; g.r5 += m.r5; g.r10 += m.r10; g.mrr += m.mrr;
    groups.set(key, g);
  };
  for (const item of picked) {
    const ranked = await search(item.question);
    const ids = ranked.slice(0, 10);
    const gold = new Set(item.gold_ids);
    const firstHit = ids.findIndex((id) => gold.has(id));
    const deepHit = ranked.findIndex((id) => gold.has(id));
    // Recall@k: share of gold ids found in the top k.
    const recall = (k) => ratio(ids.slice(0, k).filter((id) => gold.has(id)).length, gold.size);
    const m = { r5: recall(5), r10: recall(10), mrr: firstHit < 0 ? 0 : 1 / (firstHit + 1) };
    detail?.push({ id: item.id, kind: item.kind, question: item.question, gold: item.gold_ids, first_gold_rank: firstHit < 0 ? null : firstHit + 1, deep_gold_rank: deepHit < 0 ? null : deepHit + 1, gold_ranks: item.gold_ids.map((g) => ranked.indexOf(g) + 1 || null), top: ids });
    add("all", m);
    add(`kind:${item.kind ?? "unknown"}`, m);
  }
  const out = {};
  for (const [key, g] of groups) {
    out[key] = { count: g.n, recall_at_5: ratio(g.r5, g.n), recall_at_10: ratio(g.r10, g.n), mrr_at_10: ratio(g.mrr, g.n) };
  }
  return out;
}

const GRID = [0.5, 0.75, 1, 1.5, 2];
/** null when ps cannot run (setuid /bin/ps is not executable under sandbox-exec). */
const rssMb = (pid) => {
  try { return pid ? Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024 : null; } catch { return null; }
};

async function openSearch(values, dataDir) {
  const base = new URL("../packages/core/dist/memory/", import.meta.url);
  const { MemoryIndex, MEMORY_INDEX_FILE } = await import(new URL("memory-index.js", base));
  const { MemorySearch } = await import(new URL("memory-search.js", base));
  const { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG } = await import(new URL("embedder.js", base));
  const vault = values.vault;
  if (!vault && !existsSync(values.index)) throw new Error(`index not found: ${values.index}`);
  // MemoryIndex only opens <dataDir>/memory-index.sqlite, so evaluate a scratch copy of the given file (the original is never modified).
  if (!vault) for (const ext of ["", "-wal", "-shm"]) if (existsSync(values.index + ext)) copyFileSync(values.index + ext, join(dataDir, MEMORY_INDEX_FILE + ext));
  const index = new MemoryIndex({
    dataDir,
    storage: vault
      ? { isAvailable: () => true, activeDir: () => vault, withRead: (op) => op(), status: () => ({ available: true, dir: vault, since: null }) }
      : { isAvailable: () => false, activeDir: () => { throw new Error("eval: no vault"); }, withRead: (op) => op(), status: () => ({ available: false, dir: null, since: null }) },
    watch: false,
  });
  index.open();
  const timing = {};
  const profile = { ...DEFAULT_EMBEDDER_CONFIG.profile, ...(values.profile ? JSON.parse(values.profile) : {}) };
  let embedder;
  if (values.mode !== "fts") {
    embedder = new ChildEmbedder({
      ...DEFAULT_EMBEDDER_CONFIG,
      enabled: true, // --mode vec/hybrid is an explicit opt-in for this run
      model: values.model ?? DEFAULT_EMBEDDER_CONFIG.model,
      modelsDirs: values["models-dir"] ? [values["models-dir"]] : [join(dataDir, "models"), join(homedir(), ".owl", "models")],
    });
    // ps polling: RSS at the end of a run misses the peak during passage embedding (the 1.2GB limit is on the peak).
    let peak = 0;
    const poll = setInterval(() => { peak = Math.max(peak, rssMb(embedder.health().pid) ?? 0); }, 100);
    poll.unref();
    timing.peak = () => { peak = Math.max(peak, rssMb(embedder.health().pid) ?? 0); return peak || null; };
    let t = Date.now();
    await embedder.embed("query", ["warmup"]);
    timing.model_load_ms = Date.now() - t;
    t = Date.now();
    if (vault) await (existsSync(join(dataDir, MEMORY_INDEX_FILE)) && index.status().built_at ? index.refreshChanged() : index.rebuild("eval"));
    timing.scan_ms = Date.now() - t;
    t = Date.now();
    const weights = { fts: Number(values["w-fts"] ?? DEFAULT_EMBEDDER_CONFIG.weights.fts), vec: Number(values["w-vec"] ?? DEFAULT_EMBEDDER_CONFIG.weights.vec) };
    timing.embedded_notes = await index.embedPending(embedder, profile, { rrf_w_fts: String(weights.fts), rrf_w_vec: String(weights.vec) });
    timing.index_ms = Date.now() - t;
    timing.rss_after_index_mb = rssMb(embedder.health().pid);
  } else if (vault) await index.rebuild("eval");
  const pageTypes = parsePageTypes(values["page-types"]);
  const searcherFor = (weights) => {
    const searcher = new MemorySearch({ index, embedder, weights, profile });
    return async (query) => {
      const t = Date.now();
      const ids = (await searcher.search({ query, limit: 50, include_raw: true, include_archived: true, include_superseded: true, ...(pageTypes ? { page_types: pageTypes } : {}) })).hits.map((h) => h.row.id);
      (timing.queries ??= []).push(Date.now() - t);
      return ids;
    };
  };
  return { searcherFor, embedder, index, timing, profile, defaults: DEFAULT_EMBEDDER_CONFIG.weights };
}

/** 旧 KnowledgeRetriever の自然文検索は 0.000。FTS の値を §5.3 の比較基準に使わない。 */
const LEGACY_RECALL5 = { dev: 0, holdout: 0, all: 0 };

const sameList = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/** 評価セットの内容の識別情報。ファイル名が同じでも内容が違えば別の評価として扱う。 */
export const setHash = (text) => createHash("sha256").update(text).digest("hex");

/** 同じ内容の評価セット (set_sha256)・split・mode・page_types の直前の記録の全体 R@5 (§5.3 の退行判定用)。識別情報のない記録とは比べない。 */
export function previousRecall5(outDir, { split, mode, setSha256, pageTypes }) {
  try {
    const dir = join(outDir, "memory-eval");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort().reverse()) {
      const r = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (r.split === split && r.mode === mode && typeof setSha256 === "string" && r.set_sha256 === setSha256 && sameList(r.page_types, pageTypes) && Number.isFinite(r.metrics?.all?.recall_at_5)) return r.metrics.all.recall_at_5;
    }
  } catch { /* 記録なし */ }
  return null;
}

async function main() {
  const { values } = (await import("node:util")).parseArgs({
    options: {
      set: { type: "string" }, index: { type: "string" }, vault: { type: "string" }, mode: { type: "string", default: "fts" }, split: { type: "string", default: "all" },
      model: { type: "string" }, "page-types": { type: "string" }, lines: { type: "string" }, "models-dir": { type: "string" }, "w-fts": { type: "string" }, "w-vec": { type: "string" }, profile: { type: "string" }, grid: { type: "boolean", default: false },
      json: { type: "boolean", default: false }, detail: { type: "boolean", default: false },
    },
  });
  if (!values.set || (!values.index && !values.vault)) throw new Error("--set and --index (or --vault) are required");
  if (!["fts", "vec", "hybrid"].includes(values.mode)) throw new Error("--mode must be fts|vec|hybrid");
  if (!["dev", "holdout", "all"].includes(values.split)) throw new Error("--split must be dev|holdout|all");
  const outDir = process.env.OWL_DATA_DIR;
  if ((values.vault || values.mode !== "fts") && !outDir) throw new Error("OWL_DATA_DIR (a temporary one) is required for --vault and vec/hybrid");
  const dataDir = values.vault ? outDir : mkdtempSync(join(tmpdir(), "memory-eval-"));
  mkdirSync(dataDir, { recursive: true });
  let report;
  let ctx;
  try {
    ctx = await openSearch(values, dataDir);
    const setText = readFileSync(values.set, "utf8");
    const items = parseSet(setText);
    const weights = (fts, vec) => ({ fts: values.mode === "vec" ? 0 : fts, vec: values.mode === "fts" ? 0 : vec });
    const detail = values.detail ? [] : null;
    const run = (fts, vec) => evaluate(items, ctx.searcherFor(weights(fts, vec)), values.split, detail);
    const w = { fts: Number(values["w-fts"] ?? ctx.defaults.fts), vec: Number(values["w-vec"] ?? ctx.defaults.vec) };
    report = { set: basename(values.set), set_sha256: setHash(setText), mode: values.mode, split: values.split, page_types: parsePageTypes(values["page-types"]), ...(values.lines ? { lines: JSON.parse(readFileSync(values.lines, "utf8")) } : {}), model: ctx.embedder?.model ?? null, weights: w, profile: ctx.profile, metrics: await run(w.fts, w.vec) };
    if (detail) report.detail = detail.splice(0);
    if (values.grid && values.mode === "hybrid") {
      report.grid = [];
      for (const fts of GRID) for (const vec of GRID) report.grid.push({ w_fts: fts, w_vec: vec, metrics: (await run(fts, vec)).all });
    }
    const q = [...(ctx.timing.queries ?? [])].sort((a, b) => a - b);
    report.timing = { ...ctx.timing, peak: undefined, queries: undefined, query_ms_median: q[Math.floor(q.length / 2)] ?? null, query_ms_mean: q.length ? q.reduce((a, b) => a + b, 0) / q.length : null };
    report.child_rss_mb = rssMb(ctx.embedder?.health().pid);
    report.child_peak_rss_mb = ctx.timing.peak?.() ?? null;
    report.baseline_recall_at_5 = LEGACY_RECALL5[values.split] ?? null;
    report.previous_recall_at_5 = outDir ? previousRecall5(outDir, { ...values, setSha256: report.set_sha256, pageTypes: parsePageTypes(values["page-types"]) }) : null;
    report.finished_at = new Date().toISOString();
  } finally {
    await ctx?.embedder?.stop();
    ctx?.index.stop().catch(() => undefined);
    if (!values.vault) rmSync(dataDir, { recursive: true, force: true });
  }
  if (outDir && values.mode !== "fts") {
    mkdirSync(join(outDir, "memory-eval"), { recursive: true });
    writeFileSync(join(outDir, "memory-eval", `${report.finished_at.replace(/[:.]/gu, "-")}.json`), JSON.stringify(report, null, 2));
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else for (const [key, m] of Object.entries(report.metrics)) console.log(`${key}\tn=${m.count}\tR@5=${m.recall_at_5.toFixed(3)}\tR@10=${m.recall_at_10.toFixed(3)}\tMRR@10=${m.mrr_at_10.toFixed(3)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
