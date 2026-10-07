import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AdvisorSessionManager, AdvisorSessionRuntime, Core, createTaskPlanInTransaction, createWorkInTransaction } from "../../dist/index.js";
import { IndexInjector } from "../../dist/memory/index-injector.js";
import { MemoryService } from "../../dist/memory/memory-service.js";
import { ResearchRecall, renderRecall } from "../../dist/memory/research-recall.js";
import { DEFAULT_MEMORY_RECALL_LIMIT, DEFAULT_MEMORY_RECALL_MIN_SIMILARITY, readMemoryRecallLimit, readMemoryRecallMinSimilarity } from "../../../shared/dist/index.js";
import { createUlid, openDatabase } from "../../../db/dist/index.js";

const FIXTURES = new URL("./fixtures/recall/", import.meta.url).pathname;
const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

const COMPACT_ID = "01HZZZZZZZZZZZZZZZZZZZZZR2";
const LOG_ID = "01HZZZZZZZZZZZZZZZZZZZZZR4";

/** Stand-in embedder: one dimension per keyword (substring match) plus a constant, so similarity is fully predictable. */
const GROUPS = ["日付", "圧縮", "認証", "ログ", "障害"];
const vec = (text) => {
  const v = [...GROUPS.map((g) => (text.includes(g) ? 1 : 0)), 0.1];
  const norm = Math.hypot(...v);
  return Float32Array.from(v, (x) => x / norm);
};
const fakeEmbedder = {
  model: "fake-keywords", isReady: () => true, warmup() {}, stop: async () => {},
  health: () => ({ model: "fake-keywords", state: "ready", warning: null }),
  embed: async (_kind, texts) => texts.map(vec),
};

async function setup(t, { mutate } = {}) {
  const root = mkdtempSync(join(tmpdir(), "owl-clipping-recall-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "research", "2026-10"), { recursive: true });
  mkdirSync(join(root, "data"));
  cpSync(join(FIXTURES, "clippings"), join(vault, "research", "2026-10"), { recursive: true });
  mutate?.(vault);
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir: join(root, "data"), storage, embedder: fakeEmbedder, mode: () => "pages", indexOptions: { watch: false } });
  await service.start();
  await service.reindex({ mode: "diff", embed: true });
  // Background embedding (started by scans and searches) must settle before the index closes.
  t.after(async () => { await new Promise((r) => setTimeout(r, 100)); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const settings = { limit: DEFAULT_MEMORY_RECALL_LIMIT, min_similarity: DEFAULT_MEMORY_RECALL_MIN_SIMILARITY };
  const recall = new ResearchRecall({ search: service.searcher, index: service.index, settings: () => settings });
  const injector = new IndexInjector({ index: service.index, isAvailable: () => true, recall });
  return { service, settings, recall, injector, vault };
}

const lines = (text) => (text ?? "").split("\n").filter((l) => l.startsWith("前に調べた資料:"));
const ids = (items) => items.map((i) => i.id).sort();

test("Advisor: a related statement gets one line per strong clipping, without the body; an unrelated one gets nothing", async (t) => {
  const { injector } = await setup(t);
  const text = await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s1", recall_query: "日付ライブラリのタイムゾーンってどうだっけ" });
  assert.deepEqual(lines(text), ["前に調べた資料: [[日付ライブラリ 3 種の比較]] — 3 つの日付ライブラリのタイムゾーン対応とサイズを比べた記事。（2026-10-01）"]);
  assert.doesNotMatch(text, /BODY-|要点|使いどころ|タイムゾーン対応は 3 種/u);
  assert.equal(await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s2", recall_query: "おはよう" }), null);
  assert.equal(await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s3" }), null, "no recall_query, no recall");
});

test("Advisor: a clipping already shown in the session is not repeated until the session is reset", async (t) => {
  const { injector } = await setup(t);
  const ask = () => injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s1", recall_query: "日付の話" });
  assert.equal(lines(await ask()).length, 1);
  assert.equal(await ask(), null);
  injector.resetSession("s1");
  assert.equal(lines(await ask()).length, 1);
});

test("Manager and Designer get the same one-line form from the request; Worker, Reviewer and curator get none", async (t) => {
  const { injector } = await setup(t);
  const request = "圧縮の要約を取り出す機能\nフックで受け取れるか調べて実装する";
  const expected = ["前に調べた資料: [[コンテキスト圧縮の仕組み]] — CLI が会話を要約に置き換える圧縮の入力と出力を調べた資料。（2026-10-02）"];
  for (const role of ["manager", "designer"]) {
    const text = await injector.compose({ role, query: [], project_id: null, recall_query: request });
    assert.deepEqual(lines(text), expected, role);
    assert.doesNotMatch(text, /BODY-/u);
    assert.equal(await injector.compose({ role, query: [], project_id: null, recall_query: "ボタンの色を変える" }), null, `${role} unrelated`);
  }
  for (const role of ["worker", "reviewer", "curator"]) assert.equal(await injector.compose({ role, query: [], project_id: null, recall_query: request }), null, role);
});

test("the usage section is searched: a statement that matches only it finds the clipping", async (t) => {
  const { recall } = await setup(t);
  const found = await recall.recall("本番で障害が起きたときの追い方");
  assert.deepEqual(ids(found), [LOG_ID]);
  assert.ok(!readFileSync(join(FIXTURES, "clippings", "log-format.md"), "utf8").replace(/## 使いどころ[\s\S]*?\n\n/u, "").includes("障害"), "the word is only in 使いどころ");
});

test("without the usage line the same statement finds nothing (control)", async (t) => {
  const { recall } = await setup(t, { mutate: (vault) => {
    const file = join(vault, "research", "2026-10", "log-format.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("障害の調査で時系列を追うとき", "時系列を追うとき"));
  } });
  assert.deepEqual(await recall.recall("本番で障害が起きたときの追い方"), []);
});

test("the count and the strength cut come from the settings", async (t) => {
  const { recall, settings } = await setup(t);
  const both = "日付と圧縮の話";
  assert.equal((await recall.recall(both)).length, 2);
  settings.limit = 1;
  assert.equal((await recall.recall(both)).length, 1);
  settings.limit = 3;
  settings.min_similarity = 0.95;
  assert.equal((await recall.recall(both)).length, 0, "similarity of two-keyword statements is about 0.71");
  assert.equal((await recall.recall("日付")).length, 1, "a single-keyword statement is almost identical");
  settings.min_similarity = 0.7;
  assert.equal((await recall.recall(both)).length, 2);
});

test("settings readers accept 1 to 3 and 0 to 1 and fall back to the defaults otherwise", () => {
  assert.equal(readMemoryRecallLimit(3), 3);
  for (const bad of [0, 4, 1.5, "2", NaN]) assert.equal(readMemoryRecallLimit(bad), DEFAULT_MEMORY_RECALL_LIMIT);
  assert.equal(readMemoryRecallMinSimilarity(0.8), 0.8);
  for (const bad of [-0.1, 1.1, "0.5", NaN]) assert.equal(readMemoryRecallMinSimilarity(bad), DEFAULT_MEMORY_RECALL_MIN_SIMILARITY);
  assert.equal(readMemoryRecallMinSimilarity(undefined), DEFAULT_MEMORY_RECALL_MIN_SIMILARITY);
});

test("evaluation set: the default settings show a related clipping for every positive and nothing for every negative", async (t) => {
  const { recall, settings } = await setup(t);
  const rows = readFileSync(join(FIXTURES, "recall-set.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.gold_ids.length > 0) && rows.some((r) => r.gold_ids.length === 0));
  const grid = [];
  for (const min_similarity of [0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const limit of [1, 2, 3]) {
      Object.assign(settings, { min_similarity, limit });
      let hit = 0; let positives = 0; let falseShown = 0; let negatives = 0; let shown = 0; let correct = 0;
      for (const row of rows) {
        const got = ids(await recall.recall(row.question));
        shown += got.length;
        correct += got.filter((id) => row.gold_ids.includes(id)).length;
        if (row.gold_ids.length > 0) { positives += 1; if (got.some((id) => row.gold_ids.includes(id))) hit += 1; } else { negatives += 1; if (got.length > 0) falseShown += 1; }
      }
      grid.push({ min_similarity, limit, hit_rate: hit / positives, false_show_rate: falseShown / negatives, shown_precision: shown ? correct / shown : 1 });
    }
  }
  const atDefault = grid.find((g) => g.min_similarity === DEFAULT_MEMORY_RECALL_MIN_SIMILARITY && g.limit === DEFAULT_MEMORY_RECALL_LIMIT);
  assert.ok(atDefault, "the defaults are on the evaluated grid");
  assert.equal(atDefault.hit_rate, 1);
  assert.equal(atDefault.false_show_rate, 0);
  assert.equal(atDefault.shown_precision, 1);
  // The criterion (design §9.4) picks the highest hit rate with false_show <= 0.1 and precision >= 0.8, then the larger threshold.
  const ok = grid.filter((g) => g.false_show_rate <= 0.1 && g.shown_precision >= 0.8);
  const best = Math.max(...ok.map((g) => g.hit_rate));
  assert.ok(ok.some((g) => g.hit_rate === best && g.min_similarity === DEFAULT_MEMORY_RECALL_MIN_SIMILARITY));
  assert.ok(grid.some((g) => g.min_similarity === 0.8 && g.hit_rate < 1), "a threshold above the matches drops them, so the grid does separate settings");
});

test("an embedder that is not usable gives no recall (FTS ranks alone do not decide strength)", async (t) => {
  const { recall, service } = await setup(t);
  service.searcher.index.hasVectors = () => false;
  assert.deepEqual(await recall.recall("日付ライブラリ"), []);
  assert.equal(renderRecall([]), null);
});

test("pages mode: the search tool still finds clippings", async (t) => {
  const { service } = await setup(t);
  const out = await service.searchPages({ query: "日付ライブラリ" }, { caller: "worker", agent_run_id: "run-1", work_id: null, task_id: null, project_id: null });
  assert.ok(out.items.some((i) => i.path.endsWith("date-libraries.md")));
});

// --- Wiring: what Core and the Advisor runtime hand to the injector -----------------------------------------------

test("Manager, Designer and Advisor pass recall_query; Worker does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-recall-wiring-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const stop = () => { throw new Error("stop after capture"); };
  const agentRunner = { runManagerPlan: stop, runDesigner: stop, runWorker: stop, runReviewer: stop, runCurator: stop, runAdvisor: async () => ({ reply: "" }) };
  const core = new Core({ db, agentRunner, version: "t", owlRoot: root, dataDir: join(root, "data") });
  t.after(async () => { await core.stop({ force: true }); db.close(); await rm(root, { recursive: true, force: true }); });
  await core.start();
  const compose = core.memoryInjector.compose;
  const calls = [];
  core.memoryInjector.compose = (input) => { calls.push(input); return compose(input); };
  const now = new Date().toISOString();
  const { workId, designId, taskId } = await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    const created = createWorkInTransaction(tx, { title: "圧縮の要約", summary: "フックで取る", size: "normal", project_id: null });
    createTaskPlanInTransaction(tx, created.id, [
      { id: "D1", title: "Design", type: "design", acceptance: "ok", depends_on: [] },
      { id: "W1", title: "Implement", type: "code", acceptance: "ok", depends_on: [] },
    ]);
    const rows = tx.all("SELECT id, type FROM tasks WHERE work_id = ?", created.id);
    return { workId: created.id, designId: rows.find((r) => r.type === "design").id, taskId: rows.find((r) => r.type !== "design").id };
  });
  const startRun = async (task, role) => {
    const id = createUlid();
    await db.createWriteLane().transact((tx) => {
      tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'anthropic', 'm', 'running', ?, ?, ?)", id, workId, task, role, now, now, now);
      tx.run("UPDATE tasks SET status = 'running' WHERE id = ?", task);
    });
    return id;
  };
  await core.invokeManagerPlan({ work_id: workId }, "plan").catch(() => {});
  await core.workflow.runWorkerInternal(workId, designId, await startRun(designId, "designer"), 1).catch(() => {});
  await core.workflow.runWorkerInternal(workId, taskId, await startRun(taskId, "worker"), 1).catch(() => {});
  const by = (role) => calls.find((c) => c.role === role);
  assert.equal(by("manager")?.recall_query, "圧縮の要約\nフックで取る");
  assert.equal(by("designer")?.recall_query, "圧縮の要約\nフックで取る");
  assert.equal(by("worker")?.recall_query, undefined);
});

test("Advisor runtime passes the Owner's statement as recall_query every turn", async (t) => {
  const NOW = "2030-01-02T03:04:05.000Z";
  const root = await mkdtemp(join(tmpdir(), "owl-recall-advisor-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(resolve(migrations));
  const ownerId = createUlid(); const accountId = createUlid(); const conversationId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", ownerId, NOW, NOW);
    tx.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", accountId, ownerId, `web:${ownerId}`, NOW);
    tx.run("INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)", conversationId, ownerId, NOW, NOW);
  });
  const inputs = [];
  const memoryInjector = { compose: async (input) => { inputs.push(input); return null; }, resetSession() {}, noteShown() {} };
  const createSession = async () => {
    const queued = []; const waiters = [];
    const push = (e) => { const w = waiters.shift(); if (w) w({ value: e, done: false }); else queued.push(e); };
    return {
      pid: 1, provider_session_id: "p", exited: false,
      async send(turn) { setImmediate(() => push({ type: "turn.completed", turn_id: turn.turn_id, reply: "reply", usage: null })); },
      events() { return { [Symbol.asyncIterator]() { return { next() { const e = queued.shift(); return e ? Promise.resolve({ value: e, done: false }) : new Promise((r) => waiters.push(r)); } }; } }; },
      async stop() {},
    };
  };
  const runtime = new AdvisorSessionRuntime({
    db, sessionManager: new AdvisorSessionManager(db), memoryInjector,
    memorySaver: { saveCompactionSummary: async () => ({ path: null, captured: false }) },
    providerClient: { createSession }, owlRoot: root,
    git: { prepareAdvisorWorkspace: async () => ({ ok: true, worktree_path: root }) },
    getAdvisorSettings: () => ({ providerId: "anthropic", harnessId: "claude", model: "claude-test", systemPrompt: "Advisor" }),
    resolveAttachmentPaths: () => ({ paths: [], notes: [] }),
    isProviderPaused: () => false, onReply: async () => null, onError: async () => {},
  });
  t.after(async () => { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  const session = await runtime.ensureSession(ownerId, conversationId);
  for (const text of ["日付の話", "圧縮の話"]) {
    const messageId = createUlid();
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`, messageId, conversationId, accountId, `web-user:${messageId}`, text, NOW, NOW));
    const turnId = await runtime.enqueueTurn(session.id, conversationId, messageId, { turn_id: "", text, origin: { channel: "web" } });
    for (let i = 0; i < 500 && !["completed", "failed"].includes(db.get("SELECT status FROM advisor_turns WHERE id = ?", turnId).status); i++) await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(inputs.filter((i) => i.role === "advisor").map((i) => i.recall_query), ["日付の話", "圧縮の話"]);
});
