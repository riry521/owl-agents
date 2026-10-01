import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { agentRunDisplay } from "../apps/web/lib/agent-run-display.mjs";

// agent_runs.status 'failed' means the run produced no valid result. A run
// that produced one is 'completed' and records agent_runs.outcome.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

const envelope = (payload, suffix, expectedVersion = 0) => ({
  request_id: createUlid(), idempotency_key: `test:${suffix}:${createUlid()}`, expected_version: expectedVersion, payload,
});

async function waitFor(read, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function openCore(t, agentRunner) {
  const root = await mkdtemp(join(tmpdir(), "owl-outcome-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();
  return { db, core };
}

async function startWork(core, suffix) {
  const created = await core.createWork(envelope({ title: suffix, summary: "Record outcomes.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

const planTask = { id: "T1", title: "A", type: "code", acceptance: "Done.", depends_on: [], replaces: [], review: true };
const managerMode = (request) => request.mode ?? request.context?.mode;
const managerPlansThenStops = async (request) => managerMode(request) === "plan"
  ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask] } }
  : { outcome: "failed", message: "The Manager stops here in this test." };

const workerReport = (invocationId, extra = {}) => ({
  kind: "report",
  schema_version: "1.0.0",
  invocation_id: invocationId,
  result: "success",
  work_done: "Done.",
  changes: [],
  verification: { passed: true, method: "Checked." },
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: null,
  ...extra,
});

const review = (verdict) => ({
  verdict,
  summary: "Review.",
  findings: verdict === "pass" ? [] : [{ severity: "major", description: "Broken." }],
  tests: { ran: false, command: "none", passed: 0, failed: 0 },
});

test("a Reviewer fix_required verdict completes the run as redo, then pass completes it as success", async (t) => {
  let reviews = 0;
  const { db, core } = await openCore(t, {
    runManagerPlan: managerPlansThenStops,
    runWorker: async (request) => ({ outcome: "success", report_valid: true, report: workerReport(request.invocation_id) }),
    runReviewer: async () => {
      reviews += 1;
      const body = review(reviews === 1 ? "fix_required" : "pass");
      return { outcome: reviews === 1 ? "failed" : "success", report_valid: true, report: body, review: body };
    },
    runAdvisor: async () => ({ reply: "" }),
  });
  const workId = await startWork(core, "reviewer-outcome");
  const rows = await waitFor(() => {
    const found = db.all("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'reviewer' ORDER BY created_at, rowid", workId);
    return found.length >= 2 ? found : null;
  });
  assert.deepEqual(rows.slice(0, 2), [
    { status: "completed", outcome: "redo" },
    { status: "completed", outcome: "success" },
  ]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ? AND role = 'reviewer' AND status = 'failed'", workId).n, 0);
});

test("a Worker report with result failed completes the run as not_achieved and still counts a failure", async (t) => {
  let calls = 0;
  const { db, core } = await openCore(t, {
    runManagerPlan: managerPlansThenStops,
    runWorker: async (request) => {
      calls += 1;
      const report = workerReport(request.invocation_id, { result: "failed" });
      return { outcome: "failed", failure_class: "deterministic", error_key: "report_result:failed", retry_allowed: true, report_valid: true, report, message: "The Worker reported failed." };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  });
  const workId = await startWork(core, "worker-not-achieved");
  const run = await waitFor(() => db.get("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'worker' AND status = 'completed'", workId));
  assert.deepEqual(run, { status: "completed", outcome: "not_achieved" });
  const task = await waitFor(() => db.get("SELECT failure_count, same_error_count, last_error_key FROM tasks WHERE work_id = ? AND manager_task_id = 'T1' AND failure_count >= 1", workId));
  assert.ok(task.last_error_key);
  assert.ok(task.same_error_count >= 1);
  assert.ok(calls >= 1);
});

test("a Worker that cannot produce a valid result fails with no outcome", async (t) => {
  const { db, core } = await openCore(t, {
    runManagerPlan: managerPlansThenStops,
    runWorker: async () => ({ outcome: "failed", failure_class: "deterministic", error_key: "runtime:report_invalid:worker_schema", retry_allowed: false, message: "broke" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  });
  const workId = await startWork(core, "worker-error");
  const run = await waitFor(() => db.get("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'worker' AND status = 'failed'", workId));
  assert.deepEqual(run, { status: "failed", outcome: null });
});

test("a Worker needs_replanning report completes the run as replan", async (t) => {
  const { db, core } = await openCore(t, {
    runManagerPlan: managerPlansThenStops,
    runWorker: async (request) => ({ outcome: "success", report_valid: true, report: workerReport(request.invocation_id, { needs_replanning: true }) }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  });
  const workId = await startWork(core, "worker-replan");
  const run = await waitFor(() => db.get("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'worker' AND status = 'completed'", workId));
  assert.deepEqual(run, { status: "completed", outcome: "replan" });
});

test("the outcome column only takes the known values", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-outcome-check-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  try {
    assert.ok(db.all("PRAGMA table_info(agent_runs)").some((column) => column.name === "outcome" && column.notnull === 0));
    await assert.rejects(
      db.createWriteLane().transact((tx) => tx.run("INSERT INTO agent_runs (id, work_id, role, provider, model, status, outcome, created_at, updated_at) VALUES ('x','w','worker','p','m','completed','bogus','n','n')")),
      /CHECK constraint failed|FOREIGN KEY/,
    );
  } finally {
    db.close();
  }
});

test("migration 030 backfills outcomes from reviews, reports and retry events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owl-outcome-migrations-"));
  for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql") && file < "030")) {
    await copyFile(join(migrations, name), join(dir, name));
  }
  const root = await mkdtemp(join(tmpdir(), "owl-outcome-db-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(dir);
  const now = new Date().toISOString();
  const workId = createUlid();
  const taskId = createUlid();
  const ids = Object.fromEntries(
    ["revPass", "revFix", "revReplan", "revCrash", "wSuccess", "wPartial", "wFailed", "wReplan", "wQuestion", "wBoth", "wRetry", "wCrash", "manager", "cancelled"].map((k) => [k, createUlid()]),
  );
  let sequence = 0;
  try {
    await db.createWriteLane().transact((tx) => {
      tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default','owner:default',?,?)", now, now);
      tx.run(
        `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, state_version, plan_revision, rules_json, related_work_ids_json, created_at, updated_at)
         VALUES (?, 'owner:default', NULL, 'W', 'x', 'normal', 'running', 0, 0, ?, '[]', ?, ?)`,
        workId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), now, now,
      );
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
         VALUES (?, ?, 'T', 'code', 'failed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
        taskId, workId, now, now,
      );
      const run = (id, role, status) => tx.run(
        "INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'p', 'm', ?, ?, ?)",
        id, workId, taskId, role, status, now, now,
      );
      let round = 0;
      const reviewRow = (id, verdict) => tx.run(
        "INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at) VALUES (?, ?, ?, ?, '[]', '{}', ?)",
        id, taskId, round++, verdict, now,
      );
      run(ids.revPass, "reviewer", "completed"); reviewRow(ids.revPass, "pass");
      run(ids.revFix, "reviewer", "failed"); reviewRow(ids.revFix, "fix_required");
      run(ids.revReplan, "reviewer", "failed"); reviewRow(ids.revReplan, "replan_required");
      run(ids.revCrash, "reviewer", "failed");
      const reportRow = (id, result, payload) => tx.run(
        "INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1.0.0', ?, ?, ?, 2, ?)",
        createUlid(), id, result, JSON.stringify({ result, ...payload }), "0".repeat(64), now,
      );
      run(ids.wSuccess, "worker", "completed"); reportRow(ids.wSuccess, "success", {});
      run(ids.wPartial, "worker", "failed"); reportRow(ids.wPartial, "partial", { needs_replanning: false, question_for_manager: null });
      run(ids.wFailed, "worker", "failed"); reportRow(ids.wFailed, "failed", {});
      run(ids.wReplan, "worker", "completed"); reportRow(ids.wReplan, "failed", { needs_replanning: true });
      run(ids.wQuestion, "worker", "completed"); reportRow(ids.wQuestion, "success", { question_for_manager: "Which one?" });
      run(ids.wBoth, "worker", "completed"); reportRow(ids.wBoth, "success", { needs_replanning: true, question_for_manager: "Which one?" });
      run(ids.wRetry, "worker", "failed");
      sequence += 1;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, 'task.failure.classified', ?, ?, ?, ?, 'handled', 0, ?)`,
        createUlid(), sequence, `k:${sequence}`, workId, taskId, ids.wRetry, JSON.stringify({ error_key: "hybrid_worker_retry_requested" }), now,
      );
      run(ids.wCrash, "worker", "failed");
      run(ids.manager, "manager", "completed");
      run(ids.cancelled, "worker", "cancelled");
      return null;
    });
    db.migrate(migrations);
    const state = (id) => db.get("SELECT status, outcome FROM agent_runs WHERE id = ?", id);
    assert.deepEqual(state(ids.revPass), { status: "completed", outcome: "success" });
    assert.deepEqual(state(ids.revFix), { status: "completed", outcome: "redo" });
    assert.deepEqual(state(ids.revReplan), { status: "completed", outcome: "replan" });
    assert.deepEqual(state(ids.revCrash), { status: "failed", outcome: null });
    assert.deepEqual(state(ids.wSuccess), { status: "completed", outcome: "success" });
    assert.deepEqual(state(ids.wPartial), { status: "completed", outcome: "partial" });
    assert.deepEqual(state(ids.wFailed), { status: "completed", outcome: "not_achieved" });
    assert.deepEqual(state(ids.wReplan), { status: "completed", outcome: "replan" });
    assert.deepEqual(state(ids.wQuestion), { status: "completed", outcome: "question" });
    assert.deepEqual(state(ids.wBoth), { status: "completed", outcome: "question" });
    assert.deepEqual(state(ids.wRetry), { status: "completed", outcome: "redo" });
    assert.deepEqual(state(ids.wCrash), { status: "failed", outcome: null });
    assert.deepEqual(state(ids.manager), { status: "completed", outcome: "success" });
    assert.deepEqual(state(ids.cancelled), { status: "cancelled", outcome: null });
  } finally {
    db.close();
  }
});

test("the web display shows the outcome of a completed run and the status otherwise", () => {
  assert.deepEqual(agentRunDisplay("completed", "success"), { kind: "outcome", key: "success", tone: "green" });
  for (const outcome of ["redo", "replan", "question", "partial", "not_achieved"]) {
    assert.deepEqual(agentRunDisplay("completed", outcome), { kind: "outcome", key: outcome, tone: "amber" });
  }
  assert.deepEqual(agentRunDisplay("completed", null), { kind: "status", key: "completed", tone: "green" });
  assert.deepEqual(agentRunDisplay("failed", null), { kind: "status", key: "failed", tone: "red" });
  assert.deepEqual(agentRunDisplay("failed", "redo"), { kind: "status", key: "failed", tone: "red" });
  assert.deepEqual(agentRunDisplay("completed", "unknown"), { kind: "status", key: "completed", tone: "green" });
});
