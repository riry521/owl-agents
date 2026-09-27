import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

// A Work pauses while Tasks are running/verifying (they keep
// their state and record no paused_from), nothing drives a paused Work (no
// relaunch, no Manager replan until resume), and a cancel that lands while
// launchReady is launching Tasks strands no started Task, no AgentRun and
// raises no alert.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}:${createUlid()}`,
    expected_version: expectedVersion,
    payload,
  };
}

async function openCore(t, agentRunner) {
  const root = await mkdtemp(join(tmpdir(), "owl-pause-cancel-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, max_parallel: 4, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  return { db, core };
}

async function waitFor(read, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workerReport(invocationId) {
  return {
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
  };
}

function finalComplete(request) {
  return {
    outcome: "success",
    report_valid: true,
    report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } },
  };
}

function insertTask(tx, workId, { id, status, managerTaskId, title, failureCount = 0, type = "research" }) {
  const now = new Date().toISOString();
  tx.run(
    `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
     VALUES (?, ?, ?, ?, ?, 'normal', '', 'Done.', 0, ?, 0, 0, 0, ?, ?, 0, ?)`,
    id, workId, title, type, status, failureCount, now, now, managerTaskId,
  );
}

/** A Work already in `running` with the given Tasks, bypassing the initial Manager plan. */
async function runningWork(db, core, suffix, tasks) {
  const created = await core.createWork(commandEnvelope({ title: suffix, summary: "x", size: "normal", project_id: null }, `${suffix}-create`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((tx) => {
    for (const task of tasks) insertTask(tx, workId, task);
    tx.run("UPDATE works SET state = 'running', state_version = state_version + 1, plan_revision = 1 WHERE id = ?", workId);
  });
  return workId;
}

function workVersion(db, workId) {
  return db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
}

test("pausing a Work with running and verifying Tasks succeeds and leaves them active", async (t) => {
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
    runWorker: async () => ({ outcome: "failed", message: "unused" }),
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner);
  const running = createUlid();
  const verifying = createUlid();
  const ready = createUlid();
  const workId = await runningWork(db, core, "pause-active", [
    { id: running, status: "running", managerTaskId: "T1", title: "Running" },
    { id: verifying, status: "verifying", managerTaskId: "T2", title: "Verifying" },
    { id: ready, status: "ready", managerTaskId: "T3", title: "Ready" },
  ]);

  const paused = await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "pause-active-pause", workVersion(db, workId)));
  assert.equal(paused.data.state, "paused");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");

  const status = (id) => db.get("SELECT status, paused_from FROM tasks WHERE id = ?", id);
  assert.deepEqual({ ...status(running) }, { status: "running", paused_from: null });
  assert.deepEqual({ ...status(verifying) }, { status: "verifying", paused_from: null });
  assert.deepEqual({ ...status(ready) }, { status: "paused", paused_from: "ready" });

  await core.resumeWork(workId, commandEnvelope({}, "pause-active-resume", workVersion(db, workId)));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.deepEqual({ ...status(running) }, { status: "running", paused_from: null });
  assert.deepEqual({ ...status(verifying) }, { status: "verifying", paused_from: null });
  assert.deepEqual({ ...status(ready) }, { status: "ready", paused_from: null });
});

test("a Task that finishes during the pause is not relaunched and a Manager trigger raised during the pause fires after resume", async (t) => {
  const workerCalls = [];
  const managerCalls = [];
  let releaseWorkers;
  const workersReleased = new Promise((resolve) => { releaseWorkers = resolve; });
  const agentRunner = {
    runManagerPlan: async (request) => {
      managerCalls.push(request);
      if (request.mode === "finalize") return finalComplete(request);
      return { outcome: "failed", message: "replan not needed for this test" };
    },
    runWorker: async (request) => {
      workerCalls.push(request.task_id);
      const attempt = workerCalls.filter((id) => id === request.task_id).length;
      if (attempt === 1) await workersReleased;
      if (request.task_id === failing || attempt === 1) {
        // failing: third deterministic failure -> failed + manager trigger.
        // retried: first deterministic failure -> ready (retry scheduled).
        return { outcome: "failed", failure_class: "deterministic", error_key: `boom:${request.task_id}`, retry_allowed: true, message: "boom" };
      }
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner);
  const failing = createUlid();
  const retried = createUlid();
  const workId = await runningWork(db, core, "pause-finish", [
    { id: failing, status: "ready", managerTaskId: "T1", title: "Fails for good", failureCount: 2 },
    { id: retried, status: "ready", managerTaskId: "T2", title: "Fails once" },
  ]);
  await core.start();
  await waitFor(() => workerCalls.length >= 2);
  assert.equal(workerCalls.length, 2, "both Tasks start their first Worker");

  await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "pause-finish-pause", workVersion(db, workId)));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");
  releaseWorkers();

  const statusOf = (id) => db.get("SELECT status FROM tasks WHERE id = ?", id).status;
  await waitFor(() => statusOf(failing) === "failed" && statusOf(retried) === "ready");
  assert.equal(statusOf(failing), "failed");
  assert.equal(statusOf(retried), "ready");
  // Give the (unregistered) driver and any stray trigger time to misbehave.
  await sleep(300);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");
  assert.equal(workerCalls.length, 2, "no Task is relaunched while the Work is paused");
  assert.equal(managerCalls.length, 0, "no Manager replan runs while the Work is paused");
  const trigger = db.get("SELECT json_extract(response_json, '$.status') AS status FROM idempotency_keys WHERE key = ?", `manager-trigger:${failing}`);
  assert.equal(trigger?.status, "queued", "the Manager trigger stays queued during the pause");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert'", workId).n, 0);

  await core.resumeWork(workId, commandEnvelope({}, "pause-finish-resume", workVersion(db, workId)));
  const replan = await waitFor(() => managerCalls.find((request) => request.mode === "replan"));
  assert.ok(replan, "the queued Manager trigger fires after resume");
  assert.deepEqual(replan.context.failed_task_ids, [failing]);
  await waitFor(() => statusOf(retried) === "completed" || workerCalls.length >= 3);
  assert.ok(workerCalls.filter((id) => id === retried).length >= 2, "the retried Task relaunches after resume");
});

test("cancelling a Work while Tasks are being launched leaves no started Task without a Worker and no alert", async (t) => {
  const workerCalls = [];
  let finishWorker;
  const workerGate = new Promise((resolve) => { finishWorker = resolve; });
  const agentRunner = {
    runManagerPlan: async (request) => (request.mode === "finalize" ? finalComplete(request) : { outcome: "failed", message: "unexpected" }),
    runWorker: async (request) => {
      workerCalls.push(request.task_id);
      await workerGate;
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner);
  const git = core.gitGateway();
  const prepareWorktree = git.prepareWorktree.bind(git);
  let prepared = 0;
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  git.prepareWorktree = async (input) => {
    prepared += 1;
    if (prepared === 2) await gate;
    return prepareWorktree(input);
  };
  const first = createUlid();
  const second = createUlid();
  const workId = await runningWork(db, core, "cancel-launch", [
    { id: first, status: "ready", managerTaskId: "T1", title: "A" },
    { id: second, status: "ready", managerTaskId: "T2", title: "B" },
  ]);
  await core.start();
  await waitFor(() => prepared >= 2 && workerCalls.length >= 1);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", first).status, "running", "the first Task was started before the cancel");
  assert.deepEqual(workerCalls, [first], "the first Task's Worker runs while the next Task is being prepared");

  await core.cancelWork(workId, commandEnvelope({ reason: "cancel" }, "cancel-launch-cancel", workVersion(db, workId)));
  openGate();
  finishWorker();
  await waitFor(() => db.get(
    `SELECT COUNT(*) AS n FROM agent_runs
      WHERE work_id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')`,
    workId,
  ).n === 0);
  await sleep(200);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "cancelled");
  const runs = db.all("SELECT task_id, role, status FROM agent_runs WHERE work_id = ?", workId);
  assert.ok(runs.length >= 1, "the first Task had an AgentRun");
  for (const run of runs) {
    assert.ok(["cancelled", "failed", "completed"].includes(run.status), `AgentRun for ${run.task_id} is ${run.status}`);
  }
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ? AND status IN ('running','verifying')", workId).n, 0);
  assert.deepEqual(
    db.all("SELECT status FROM tasks WHERE work_id = ? ORDER BY manager_task_id", workId).map((row) => row.status),
    ["cancelled", "cancelled"],
  );
  assert.deepEqual(workerCalls, [first], "no Worker is started for the Task cancelled before it launched");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert'", workId).n, 0);
});
