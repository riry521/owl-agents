import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { buildTokenUsageReport, countRequestsOverThreshold, insertRequestUsageRows } from "../../packages/core/dist/token-usage-report.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const requireFromDb = createRequire(new URL("../../packages/db/dist/connection.js", import.meta.url));
const SqliteDatabase = requireFromDb("better-sqlite3");

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function setup(t, prefix) {
  const root = await tempDir(t, prefix);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const now = new Date(2030, 5, 15, 12, 34, 56, 0);
  const nowIso = now.toISOString();
  const { db, core: durableCore } = await createTestCore(t, {
    owlRoot: root, dataDir, version: "token-usage-report-test",
    now: () => nowIso,
    getProviderHarness: (provider) => provider === "anthropic" || provider === "claude" ? "claude" : provider === "openai" || provider === "codex" ? "codex" : undefined,
  });
  const createWork = async (title) => (await durableCore.createWork(command(
    { title, summary: "", size: "small", project_id: null },
    `token-usage:${title}`,
  ))).data.work_id;
  const insertRuns = async (rows) => db.createWriteLane().transact((tx) => {
    tx.run("PRAGMA ignore_check_constraints = ON");
    for (const row of rows) {
      tx.run(
        `INSERT INTO agent_runs (id, work_id, parent_agent_id, role, provider, model, status, origin,
                                ended_at, created_at, updated_at, usage_json)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`,
        row.id, row.workId, row.parentId ?? null, row.role, row.provider, row.model, row.origin ?? null,
        row.at, row.at, row.at, row.usage === "invalid" ? "{" : row.usage === null ? null : JSON.stringify(row.legacy ? row.usage : { ...row.usage, input_excludes_cache: 1 }),
      );
    }
    tx.run("PRAGMA ignore_check_constraints = OFF");
  });
  return { root, dataDir, db, durableCore, now, nowIso, createWork, insertRuns };
}

test("observed Codex Executor rows are summed as stored (usage is normalized by the adapter)", (t) => {
  const database = new SqliteDatabase(":memory:");
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE works (id TEXT, title TEXT, display_number INTEGER, project_id TEXT, state TEXT);
    CREATE TABLE tasks (id TEXT, work_id TEXT, title TEXT, status TEXT);
    CREATE TABLE reviews (id TEXT, task_id TEXT, round INTEGER, verdict TEXT, created_at TEXT);
    CREATE TABLE agent_runs (
      id TEXT, work_id TEXT, task_id TEXT, role TEXT, provider TEXT, model TEXT, status TEXT, origin TEXT,
      ended_at TEXT, updated_at TEXT, usage_json TEXT
    );
  `);
  database.prepare("INSERT INTO works VALUES (?, ?, ?, ?, ?)").run("work", "Observed Codex Work", 1, null, "open");
  const now = new Date("2030-06-15T12:34:56.000Z");
  const at = new Date(now.getTime() - 1).toISOString();
  database.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "run", "work", null, "executor", "codex", "gpt-5.6", "completed", "observed", at, at,
    JSON.stringify({ input_tokens: 70, cache_read_tokens: 30, output_tokens: 2, input_excludes_cache: 1 }),
  );
  database.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "legacy", "work", null, "executor", "codex", "gpt-5.6", "completed", "observed", at, at,
    JSON.stringify({ input_tokens: 100, cache_read_tokens: 30, output_tokens: 2 }),
  );
  const db = {
    all: (sql, ...parameters) => database.prepare(sql).all(...parameters),
    get: (sql, ...parameters) => database.prepare(sql).get(...parameters),
  };

  const report = buildTokenUsageReport(db, {
    period: "today", top: 10, now,
    harnessOf: (provider) => provider === "codex" ? "codex" : undefined,
  });
  // normalized row as stored (70) + legacy Codex row whose raw input (100) includes its cache read (30)
  assert.equal(report.totals.input_tokens, 140);
  assert.equal(report.totals.total_tokens, 204);
});

test("Core aggregates valid agent run usage once across periods, dimensions, and child Executor rows", async (t) => {
  const fixture = await setup(t, "owl-token-usage-core-");
  const { durableCore, now, nowIso, createWork, insertRuns } = fixture;
  const workA = await createWork("Work A");
  const workB = await createWork("Work B");
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const since7 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const since30 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  const iso = (date) => date.toISOString();
  await insertRuns([
    { id: "worker-codex", workId: workA, role: "worker", provider: "openai", model: "gpt-5.6", at: iso(since7), usage: { input_tokens: 70, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 4 } },
    { id: "executor-claude", workId: workA, parentId: "worker-codex", role: "executor", provider: "anthropic", model: "claude-opus", origin: "spawned", at: iso(todayStart), usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2, cache_write_tokens: 3 } },
    { id: "reviewer-claude", workId: workB, role: "reviewer", provider: "anthropic", model: "claude-sonnet", at: iso(new Date(todayStart.getTime() + 1000)), usage: { input_tokens: 5, output_tokens: 200, cache_read_tokens: 7, cache_write_tokens: 8 } },
    { id: "codex-cached-more-than-input", workId: workA, role: "worker", provider: "openai", model: "gpt-5.6", at: iso(new Date(todayStart.getTime() + 4000)), usage: { input_tokens: 0, cache_read_tokens: 5 } },
    { id: "codex-same-group", workId: workA, role: "worker", provider: "openai", model: "gpt-5.6", at: iso(new Date(todayStart.getTime() + 5000)), usage: { input_tokens: 10 } },
    { id: "yesterday-codex", workId: workB, role: "worker", provider: "codex", model: "gpt-5.6", at: iso(new Date(todayStart.getTime() - 1)), usage: { input_tokens: 9, output_tokens: 1 } },
    { id: "observed-executor", workId: workA, parentId: "worker-codex", role: "executor", provider: "anthropic", model: "claude-opus", origin: "observed", at: iso(new Date(todayStart.getTime() + 6000)), usage: { input_tokens: 10, output_tokens: 2 } },
    { id: "before-seven-days", workId: workA, role: "worker", provider: "openai", model: "gpt-5.6", at: iso(new Date(since7.getTime() - 1)), usage: { input_tokens: 1000 } },
    { id: "at-until", workId: workA, role: "worker", provider: "openai", model: "gpt-5.6", at: nowIso, usage: { input_tokens: 1000 } },
    { id: "at-thirty-days", workId: workA, role: "designer", provider: "anthropic", model: "claude-sonnet", at: iso(since30), usage: { input_tokens: 1, output_tokens: 1 } },
    { id: "before-thirty-days", workId: workA, role: "designer", provider: "anthropic", model: "claude-sonnet", at: iso(new Date(since30.getTime() - 1)), usage: { input_tokens: 1000 } },
    { id: "null-usage", workId: workB, role: "reviewer", provider: "anthropic", model: "claude-sonnet", at: iso(new Date(todayStart.getTime() + 2000)), usage: null },
    { id: "invalid-usage", workId: workB, role: "reviewer", provider: "anthropic", model: "claude-sonnet", at: iso(new Date(todayStart.getTime() + 3000)), usage: "invalid" },
  ]);

  const week = await durableCore.getTokenUsageReport({ period: "7d", top: 10 });
  assert.equal(week.since, iso(since7));
  assert.equal(week.until, nowIso);
  assert.equal(week.time_zone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.deepEqual(week.totals, { input_tokens: 114, output_tokens: 227, cache_read_tokens: 44, cache_write_tokens: 15, total_tokens: 400, runs: 7 });
  assert.equal(week.runs_without_usage, 2);
  assert.deepEqual(week.by_role.map(({ role, totals }) => [role, totals.total_tokens]), [["reviewer", 220], ["worker", 149], ["executor", 31]]);
  assert.deepEqual(week.by_harness.map(({ harness, totals }) => [harness, totals.total_tokens]), [["claude", 251], ["codex", 149]]);
  assert.deepEqual(week.by_model.map(({ provider, model, harness, totals }) => [provider, model, harness, totals.total_tokens]), [
    ["anthropic", "claude-sonnet", "claude", 220], ["openai", "gpt-5.6", "codex", 139],
    ["anthropic", "claude-opus", "claude", 31], ["codex", "gpt-5.6", "codex", 10],
  ]);
  assert.deepEqual(week.by_work.map(({ title, totals }) => [title, totals.total_tokens]), [["Work B", 230], ["Work A", 170]]);
  assert.deepEqual(week.top_works.map(({ title, display_number, totals }) => [title, display_number, totals.total_tokens]), [["Work B", 2, 230], ["Work A", 1, 170]]);
  assert.deepEqual((await durableCore.getTokenUsageReport({ period: "7d", top: 1 })).top_works.map(({ title }) => title), ["Work B"]);
  assert.equal(week.daily.length, 7);
  assert.deepEqual(week.daily.filter(({ totals }) => totals.runs > 0).map(({ date, totals }) => [date, totals.total_tokens]), [
    [localDate(since7), 124], [localDate(new Date(todayStart.getTime() - 1)), 10], [localDate(now), 266],
  ]);

  const today = await durableCore.getTokenUsageReport({ period: "today", top: 10 });
  assert.equal(today.since, iso(todayStart));
  assert.deepEqual(today.totals, { input_tokens: 35, output_tokens: 206, cache_read_tokens: 14, cache_write_tokens: 11, total_tokens: 266, runs: 5 });
  const month = await durableCore.getTokenUsageReport({ period: "30d", top: 10 });
  assert.equal(month.since, iso(since30));
  assert.equal(month.totals.total_tokens, 1402);
});

test("Task, Work and role metrics: uncached input, tokens after first review, first-review pass rate", async (t) => {
  const { db, now, createWork } = await setup(t, "owl-token-usage-metrics-");
  const work = await createWork("Metrics Work");
  const at = (offsetMs) => new Date(now.getTime() - 60_000 + offsetMs).toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("PRAGMA ignore_check_constraints = ON");
    for (const [id, status] of [["task-pass", "completed"], ["task-fix", "completed"], ["task-open", "running"]]) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
         VALUES (?, ?, ?, 'code', ?, 'normal', '', '', ?, ?)`, id, work, id, status, at(0), at(0));
    }
    for (const [id, taskId, round, verdict, created] of [["rev-pass", "task-pass", 0, "pass", 1000], ["rev-fix", "task-fix", 0, "fix_required", 1000], ["rev-fix-2", "task-fix", 1, "pass", 5000]]) {
      tx.run(
        `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
         VALUES (?, ?, ?, ?, '[]', '{}', ?)`, id, taskId, round, verdict, at(created));
    }
    const runs = [
      ["w-pass", "task-pass", "worker", "anthropic", 0, { input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 20 }],
      ["r-pass", "task-pass", "reviewer", "anthropic", 1000, { input_tokens: 1, output_tokens: 1 }],
      ["w-fix", "task-fix", "worker", "openai", 0, { input_tokens: 20, output_tokens: 5, cache_read_tokens: 30 }],
      ["w-fix-2", "task-fix", "worker", "anthropic", 3000, { input_tokens: 7, output_tokens: 3, cache_read_tokens: 1, cache_write_tokens: 2 }],
      ["r-fix", "task-fix", "reviewer", "anthropic", 1000, { input_tokens: 2, output_tokens: 2 }],
      ["w-open", "task-open", "worker", "anthropic", 0, { input_tokens: 3 }],
      ["manager-no-task", null, "manager", "anthropic", 0, { input_tokens: 4 }],
    ];
    for (const [id, taskId, role, provider, offset, usage] of runs) {
      tx.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, ended_at, created_at, updated_at, usage_json)
         VALUES (?, ?, ?, ?, ?, 'm', 'completed', ?, ?, ?, ?)`, id, work, taskId, role, provider, at(offset), at(offset), at(offset), JSON.stringify({ ...usage, input_excludes_cache: 1 }));
    }
    tx.run("PRAGMA ignore_check_constraints = OFF");
  });
  const report = buildTokenUsageReport(db, {
    period: "today", top: 10, now,
    harnessOf: (provider) => provider === "anthropic" ? "claude" : provider === "openai" ? "codex" : undefined,
  });
  const tasks = Object.fromEntries(report.by_task.map((row) => [row.task_id, row]));
  assert.equal(tasks["task-pass"].uncached_input_tokens, 10 + 20 + 1);
  assert.equal(tasks["task-pass"].tokens_after_first_review, 0);
  assert.equal(tasks["task-pass"].first_review_verdict, "pass");
  // Usage arrives already normalized by the provider adapter; only w-fix-2 ran after the first review.
  assert.equal(tasks["task-fix"].uncached_input_tokens, 20 + 7 + 2 + 2);
  assert.equal(tasks["task-fix"].tokens_after_first_review, 7 + 3 + 1 + 2);
  assert.equal(tasks["task-fix"].first_review_verdict, "fix_required");
  assert.equal(tasks["task-open"].first_review_verdict, null);
  assert.deepEqual([tasks["task-pass"], tasks["task-fix"], tasks["task-open"]].map((task) => task.first_review_pass_rate), [1, 0, null]);
  assert.deepEqual(report.by_work[0].metrics, {
    uncached_input_tokens: 31 + 31 + 3 + 4, tokens_after_first_review: 13, first_review_pass_rate: 0.5,
    completed_tasks: 2, uncached_input_tokens_per_completed_task: 69 / 2,
    runs_per_completed_task: report.by_work[0].totals.runs / 2,
  });
  const worker = report.by_role.find((row) => row.role === "worker").metrics;
  assert.equal(worker.uncached_input_tokens, 30 + 29 + 3);
  assert.equal(worker.tokens_after_first_review, 13);
  assert.equal(worker.first_review_pass_rate, 0.5);
  assert.equal(worker.uncached_input_tokens_per_completed_task, 62 / 2);
  const manager = report.by_role.find((row) => row.role === "manager").metrics;
  assert.deepEqual([manager.completed_tasks, manager.first_review_pass_rate, manager.uncached_input_tokens_per_completed_task, manager.runs_per_completed_task], [0, null, null, null]);
});

test("GET /api/v1/token-usage resolves through ExternalCoreAdapter and validates the period", async (t) => {
  const fixture = await setup(t, "owl-token-usage-http-");
  const { root, dataDir, db, durableCore, nowIso, createWork, insertRuns } = fixture;
  const workId = await createWork("HTTP Work");
  await insertRuns([{ id: "http-run", workId, role: "worker", provider: "openai", model: "gpt-5.6", at: new Date(Date.parse(nowIso) - 1).toISOString(), usage: { input_tokens: 5, cache_read_tokens: 3, output_tokens: 2 } }]);
  const adapter = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root, dataDir }, { token: randomBytes(24).toString("hex") });
  if (!api) return t.skip("localhost listen is unavailable");
  const request = (period) => api.request("GET", `/api/v1/token-usage${period === null ? "" : `?period=${period}`}`);
  const invalid = await request("last-week");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "validation_error");
  const response = await request("today");
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.period, "today");
  assert.equal(result.totals.input_tokens, 5);
  assert.equal(result.totals.total_tokens, 10);
  const defaultPeriod = await request(null);
  assert.equal(defaultPeriod.status, 200);
  assert.equal((await defaultPeriod.json()).data.period, "7d");

  const method = durableCore.getTokenUsageReport;
  durableCore.getTokenUsageReport = undefined;
  try {
    const missing = await request("7d");
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).error.code, "dependency_unavailable");
  } finally {
    durableCore.getTokenUsageReport = method;
  }
});

test("large requests are counted strictly over the threshold per model, with defaults from the child-run settings", async (t) => {
  const fixture = await setup(t, "owl-token-usage-requests-");
  const { db, durableCore, nowIso, createWork, insertRuns } = fixture;
  const workId = await createWork("Request Work");
  const otherWork = await createWork("Other Request Work");
  await insertRuns([
    { id: "haiku-child", workId, role: "executor", provider: "claude", model: "claude-haiku-5-5", at: nowIso, usage: null },
    { id: "opus-child", workId: otherWork, role: "executor", provider: "claude", model: "claude-opus-5-5", at: nowIso, usage: null },
  ]);
  const row = (agentRunId, work, model, messageId, promptTokens) => ({
    agent_run_id: agentRunId, work_id: work, child_run_id: null, provider: "claude", model, message_id: messageId, subagent: false,
    input_tokens: 10, cache_read_tokens: promptTokens - 10, cache_write_tokens: 0, output_tokens: 5, created_at: nowIso,
  });
  const inserted = await db.createWriteLane().transact((tx) => insertRequestUsageRows(tx, [
    row("haiku-child", workId, "claude-haiku-5-5", "msg_exact", 100_000),
    row("haiku-child", workId, "claude-haiku-5-5", "msg_over", 100_001),
    row("haiku-child", workId, "claude-haiku-5-5-20261001", "msg_snapshot", 150_000),
    row("haiku-child", workId, "claude-haiku-5-5", "msg_small", 2_000),
    row("opus-child", otherWork, "claude-opus-5-5", "msg_opus", 200_000),
    // The same request seen again (Claude repeats a message id per content block) is not a new row.
    row("haiku-child", workId, "claude-haiku-5-5", "msg_over", 100_001),
  ]));
  assert.equal(inserted, 5);
  assert.deepEqual(db.all("SELECT message_id, prompt_tokens FROM agent_run_requests WHERE message_id = 'msg_exact'"), [{ message_id: "msg_exact", prompt_tokens: 100_000 }]);

  const count = (input) => countRequestsOverThreshold(db, input);
  assert.deepEqual(count({ threshold_tokens: 100_000, models: ["claude-haiku-5-5"] }),
    { threshold_tokens: 100_000, models: ["claude-haiku-5-5"], total_requests: 4, over_threshold: 2 });
  assert.equal(count({ threshold_tokens: 120_000, models: ["claude-haiku-5-5"] }).over_threshold, 1);
  assert.equal(count({ threshold_tokens: 100_000, models: ["claude-opus-5-5"] }).over_threshold, 1);
  // A model matches itself and its dated snapshots ("<model>-..."), not any name that merely starts the same.
  assert.equal(count({ threshold_tokens: 100_000, models: ["claude-haiku-5"] }).total_requests, 4);
  assert.equal(count({ threshold_tokens: 100_000, models: ["claude-hai"] }).total_requests, 0);
  assert.equal(count({ threshold_tokens: 100_000, models: null }).over_threshold, 3);
  assert.equal(count({ threshold_tokens: 100_000, models: [] }).total_requests, 0);
  assert.equal(count({ threshold_tokens: 100_000, models: null, work_id: otherWork }).total_requests, 1);

  // Defaults: relay-watched models plus the Claude researcher model, at token_relay.report_threshold_tokens.
  assert.deepEqual(durableCore.countLargeModelRequests(),
    { threshold_tokens: 100_000, models: ["claude-haiku-5-5"], total_requests: 4, over_threshold: 2 });
  assert.equal(durableCore.countLargeModelRequests({ models: ["claude-opus-5-5"] }).over_threshold, 1);
  assert.throws(() => durableCore.countLargeModelRequests({ threshold_tokens: 0 }), (error) => error.details?.field === "threshold_tokens");
  const settings = durableCore.getChildRunSettings();
  await durableCore.setChildRunSettings({
    ...settings,
    token_relay: { ...settings.token_relay, models: [], report_threshold_tokens: 120_000 },
    research_subagent: { ...settings.research_subagent, claude: { ...settings.research_subagent.claude, model: "claude-opus-5-5" } },
  });
  assert.deepEqual(durableCore.countLargeModelRequests(),
    { threshold_tokens: 120_000, models: ["claude-opus-5-5"], total_requests: 1, over_threshold: 1 });
});
