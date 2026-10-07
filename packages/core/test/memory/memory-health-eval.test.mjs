import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryService } from "../../dist/memory/memory-service.js";

const m = (r5, r10, mrr) => ({ count: 10, recall_at_5: r5, recall_at_10: r10, mrr_at_10: mrr });
const report = (all, keyword, paraphrase, finished_at = "2026-10-02T10:00:00.000Z", extra = {}) =>
  JSON.stringify({ ...extra, mode: "hybrid", split: "holdout", model: "Xenova/multilingual-e5-small", metrics: { all, "kind:keyword": keyword, "kind:paraphrase": paraphrase }, finished_at });

async function healthWith(files) {
  const root = mkdtempSync(join(tmpdir(), "owl-health-eval-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(vault, { recursive: true });
  mkdirSync(join(dataDir, "memory-eval"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dataDir, "memory-eval", name), text);
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir, storage, embedder: { enabled: false, model: null, health: () => ({}), stop: async () => {} }, indexOptions: { watch: false } });
  try {
    await service.start();
    return (await service.health()).eval;
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test("eval passes when all section 5.3 lines are met", async () => {
  const e = await healthWith({ "a.json": report(m(0.72, 0.8, 0.6), m(0.7, 0.8, 0.6), m(0.65, 0.7, 0.55), undefined, { baseline_recall_at_5: 0.306, previous_recall_at_5: 0.71 }) });
  assert.equal(e.passed, true);
  assert.deepEqual(e.checks, { overall_recall5: true, overall_mrr10: true, paraphrase_recall5: true, keyword_recall5: true, vs_baseline: true, no_regression: true });
  assert.equal(e.measured_at, "2026-10-02T10:00:00.000Z");
  assert.equal(e.model, "Xenova/multilingual-e5-small");
  assert.equal(e.mode, "hybrid");
  assert.equal(e.split, "holdout");
  assert.deepEqual(e.overall, { recall_at_5: 0.72, recall_at_10: 0.8, mrr_at_10: 0.6 });
});

test("eval fails with the holdout numbers recorded for e5-small, and the newest file wins", async () => {
  const e = await healthWith({
    "2026-10-01T00-00-00-000Z.json": report(m(0.9, 0.9, 0.9), m(0.9, 0.9, 0.9), m(0.9, 0.9, 0.9), "2026-10-01T00:00:00.000Z"),
    "2026-10-02T00-00-00-000Z.json": report(m(0.583, 0.676, 0.492), m(0.611, 0.722, 0.485), m(0.556, 0.63, 0.5), "2026-10-02T00:00:00.000Z", { baseline_recall_at_5: 0.306, previous_recall_at_5: 0.602 }),
  });
  assert.equal(e.passed, false);
  assert.deepEqual(e.checks, { overall_recall5: false, overall_mrr10: false, paraphrase_recall5: false, keyword_recall5: true, vs_baseline: false, no_regression: true });
  assert.equal(e.overall.recall_at_5, 0.583);
});

const good = [m(0.72, 0.8, 0.6), m(0.7, 0.8, 0.6), m(0.65, 0.7, 0.55)];

test("eval fails when absolute lines pass but the gain over the legacy method is under +0.4", async () => {
  const e = await healthWith({ "a.json": report(...good, undefined, { baseline_recall_at_5: 0.35, previous_recall_at_5: 0.72 }) });
  assert.equal(e.checks.overall_recall5, true);
  assert.equal(e.checks.vs_baseline, false);
  assert.equal(e.passed, false);
});

test("eval fails when absolute lines pass but overall R@5 regressed by more than 0.03", async () => {
  const e = await healthWith({ "a.json": report(...good, undefined, { baseline_recall_at_5: 0.306, previous_recall_at_5: 0.76 }) });
  assert.equal(e.checks.no_regression, false);
  assert.equal(e.passed, false);
});

test("eval never passes without baseline values", async () => {
  const e = await healthWith({ "a.json": report(...good) });
  assert.equal(e.checks.vs_baseline, false);
  assert.equal(e.checks.no_regression, false);
  assert.equal(e.passed, false);
});

test("eval boundaries: +0.4 over legacy and -0.03 vs previous pass, anything beyond fails", async () => {
  const run = async (all5, baseline, previous) =>
    (await healthWith({ "a.json": report(m(all5, 0.8, 0.6), m(0.7, 0.8, 0.6), m(0.65, 0.7, 0.55), undefined, { baseline_recall_at_5: baseline, previous_recall_at_5: previous }) })).checks;
  assert.notEqual(0.7 - 0.3, 0.4); // float error: 0.39999999999999997
  assert.notEqual(0.72 - 0.75, -0.03);
  assert.equal((await run(0.7, 0.3005, 0.7)).vs_baseline, false);
  assert.equal((await run(0.7, 0.3, 0.7)).vs_baseline, true);
  assert.equal((await run(0.72, 0.3, 0.7505)).no_regression, false);
  assert.equal((await run(0.72, 0.3, 0.75)).no_regression, true);
});

test("eval is null with no result file or a broken one", async () => {
  assert.equal(await healthWith({}), null);
  assert.equal(await healthWith({ "x.json": "{not json" }), null);
});

test("a report carrying its own lines is judged by them, not the 0.7 ones; invalid lines fall back to the defaults", async () => {
  const lines = { recall5: 0.3, mrr10: 0.4, paraphrase5: 0.1, keyword5: 0.6, gain: 0.3 };
  const clipping = { page_types: ["clipping"], lines, baseline_recall_at_5: 0, previous_recall_at_5: 0.3 };
  const e = await healthWith({ "a.json": report(m(0.317, 0.517, 0.408), m(1, 1, 1), m(0.146, 0.396, 0.26), undefined, clipping) });
  assert.deepEqual(e.page_types, ["clipping"]);
  assert.equal(e.lines.recall5, 0.3);
  assert.equal(e.passed, true);
  const low = await healthWith({ "a.json": report(m(0.25, 0.5, 0.408), m(1, 1, 1), m(0.146, 0.396, 0.26), undefined, clipping) });
  assert.equal(low.checks.overall_recall5, false);
  assert.equal(low.passed, false);
  const plain = await healthWith({ "a.json": report(m(0.317, 0.517, 0.408), m(1, 1, 1), m(0.146, 0.396, 0.26), undefined, { baseline_recall_at_5: 0, previous_recall_at_5: 0.3 }) });
  assert.equal(plain.page_types, null);
  assert.equal(plain.lines.recall5, 0.7);
  assert.equal(plain.passed, false);
  const broken = await healthWith({ "a.json": report(m(0.317, 0.517, 0.408), m(1, 1, 1), m(0.146, 0.396, 0.26), undefined, { ...clipping, lines: { recall5: "x" } }) });
  assert.equal(broken.lines.recall5, 0.7);
});
