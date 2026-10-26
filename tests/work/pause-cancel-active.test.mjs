import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { NoopGitGateway, createTaskPlanInTransaction, createWorkInTransaction } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { git } from "../helpers/git.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A Work pauses while Tasks are running/verifying (they keep
// their state and record no paused_from), nothing drives a paused Work (no
// relaunch, no Manager replan until resume), and a cancel that lands while
// launchReady is launching Tasks strands no started Task, no AgentRun and
// raises no alert.

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
}

function openCore(t, agentRunner, coreOptions = {}) {
  return createTestCore(t, { agentRunner, max_parallel: 4, dispatcher: { tick_interval_ms: 25 }, ...coreOptions }, { prefix: "owl-pause-cancel-" });
}

const AGENT_STOP_SETTLE_MS = 400;
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

/**
 * A runner whose Worker and Manager calls block until the Owner's stop signal arrives, then return a normal
 * success, like a CLI that finished just as it was cancelled. Later calls for the same Task return at once.
 */
function stoppableRunner({ onWorker = async () => {}, managerPlan = null } = {}) {
  const cancelled = [];
  const gates = new Map();
  const gateFor = (id) => {
    if (!gates.has(id)) {
      let open;
      const promise = new Promise((resolve) => { open = resolve; });
      gates.set(id, { promise, open });
    }
    return gates.get(id);
  };
  const workerCalls = [];
  const managerCalls = [];
  return {
    cancelled,
    workerCalls,
    managerCalls,
    runManagerPlan: async (request) => {
      managerCalls.push(request);
      if (request.mode === "finalize") return finalComplete(request);
      if (managerPlan) return managerPlan(request, gateFor);
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async (request) => {
      workerCalls.push({ task_id: request.task_id, invocation_id: request.invocation_id, worktree: request.context?.worktree ?? null });
      await onWorker(request, gateFor, workerCalls.filter((call) => call.task_id === request.task_id).length);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
    cancelAgent: async (id) => {
      cancelled.push(id);
      gateFor(id).open();
    },
  };
}

function insertRun(tx, { id, workId, taskId = null, role, status = "running", origin = null, hookAgentId = null }) {
  const now = new Date().toISOString();
  tx.run(
    `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, origin, hook_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', 'test', ?, ?, ?, ?, ?)`,
    id, workId, taskId, role, status, origin, hookAgentId, now, now,
  );
}

const COUNTERS_SQL = "SELECT failure_count, same_error_count, reviewer_failure_count, no_progress_count FROM tasks WHERE id = ?";
const ZERO_COUNTERS = { failure_count: 0, same_error_count: 0, reviewer_failure_count: 0, no_progress_count: 0 };

test("pausing a Work stops its running Agents, pauses running and verifying Tasks, and leaves the Advisor and hook or observed runs alone", async (t) => {
  const runner = stoppableRunner();
  const { db, core } = await openCore(t, runner, { agentStopWaitMs: 100 });
  const running = createUlid();
  const verifying = createUlid();
  const ready = createUlid();
  const workId = await runningWork(db, core, "pause-active", [
    { id: running, status: "running", managerTaskId: "T1", title: "Running" },
    { id: verifying, status: "verifying", managerTaskId: "T2", title: "Verifying" },
    { id: ready, status: "ready", managerTaskId: "T3", title: "Ready" },
  ]);
  const ids = { worker: createUlid(), reviewer: createUlid(), manager: createUlid(), executor: createUlid(), advisor: createUlid(), hook: createUlid(), observed: createUlid() };
  await db.createWriteLane().transact((tx) => {
    insertRun(tx, { id: ids.worker, workId, taskId: running, role: "worker" });
    insertRun(tx, { id: ids.reviewer, workId, taskId: verifying, role: "reviewer" });
    insertRun(tx, { id: ids.manager, workId, role: "manager" });
    insertRun(tx, { id: ids.executor, workId, taskId: running, role: "executor", origin: "spawned" });
    insertRun(tx, { id: ids.advisor, workId, role: "advisor" });
    insertRun(tx, { id: ids.hook, workId, taskId: running, role: "worker", hookAgentId: "hook-1" });
    insertRun(tx, { id: ids.observed, workId, taskId: running, role: "worker", origin: "observed" });
  });

  const paused = await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "pause-active-pause", workVersion(db, workId)));
  assert.deepEqual({ work_id: paused.data.work_id, state: paused.data.state, signal: paused.data.signal }, { work_id: workId, state: "paused", signal: "pause_requested" });
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");

  const status = (id) => db.get("SELECT status, paused_from FROM tasks WHERE id = ?", id);
  for (const id of [running, verifying, ready]) assert.deepEqual({ ...status(id) }, { status: "paused", paused_from: "ready" });

  const runStatus = (id) => db.get("SELECT status FROM agent_runs WHERE id = ?", id).status;
  for (const id of [ids.worker, ids.reviewer, ids.manager, ids.executor]) assert.equal(runStatus(id), "cancel_requested");
  for (const id of [ids.advisor, ids.hook, ids.observed]) assert.equal(runStatus(id), "running");

  await waitFor(() => [ids.worker, ids.reviewer, ids.manager].every((id) => runner.cancelled.includes(id)));
  assert.deepEqual(runner.cancelled.filter((id) => [ids.advisor, ids.hook, ids.observed].includes(id)), []);
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type IN ('agent.crashed', 'task.failure.classified')", workId).n,
    0,
    "stopping an Agent is not a failure",
  );
  // Let the background stop finish (the fake Agents never exit) before the database closes.
  await sleep(AGENT_STOP_SETTLE_MS);
});

test("a stopped Worker's result is discarded and the Task is redone with the same id after resume", async (t) => {
  const runner = stoppableRunner({
    // The first Worker waits for the stop signal; the redo returns at once.
    onWorker: async (request, gateFor, attempt) => { if (attempt === 1) await gateFor(request.invocation_id).promise; },
  });
  const { db, core } = await openCore(t, runner, { agentStopWaitMs: 100 });
  const taskId = createUlid();
  const workId = await runningWork(db, core, "pause-redo", [{ id: taskId, status: "ready", managerTaskId: "T1", title: "Redo me" }]);
  await core.start();
  await waitFor(() => runner.workerCalls.length >= 1);
  const firstRun = runner.workerCalls[0].invocation_id;
  assert.ok(["launch_pending", "spawned", "running"].includes(db.get("SELECT status FROM agent_runs WHERE id = ?", firstRun).status));

  await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "pause-redo-pause", workVersion(db, workId)));
  await waitFor(() => db.get("SELECT status FROM agent_runs WHERE id = ?", firstRun).status === "cancelled");
  await sleep(100);

  assert.deepEqual({ ...db.get("SELECT status, paused_from FROM tasks WHERE id = ?", taskId) }, { status: "paused", paused_from: "ready" });
  assert.deepEqual({ ...db.get(COUNTERS_SQL, taskId) }, ZERO_COUNTERS);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'agent.crashed'", workId).n, 0);
  assert.equal(runner.workerCalls.length, 1, "nothing relaunches while the Work is paused");

  await core.resumeWork(workId, commandEnvelope({}, "pause-redo-resume", workVersion(db, workId)));
  await waitFor(() => runner.workerCalls.length >= 2);
  assert.equal(runner.workerCalls[1].task_id, taskId, "the same Task is redone");
  assert.notEqual(runner.workerCalls[1].invocation_id, firstRun, "with a new run");
  assert.deepEqual({ ...db.get(COUNTERS_SQL, taskId) }, ZERO_COUNTERS);
});

test("a Manager stopped during the first plan is discarded and the plan runs again after resume", async (t) => {
  const runner = stoppableRunner({
    managerPlan: async (request, gateFor) => {
      const planCalls = runner.managerCalls.filter((call) => call.mode !== "finalize").length;
      if (planCalls === 1) await gateFor(request.invocation_id).promise;
      return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Research", type: "research", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false }] } };
    },
  });
  const { db, core } = await openCore(t, runner, { agentStopWaitMs: 100 });
  await core.start();
  await disablePlanQuality(db);
  const created = await core.createWork(commandEnvelope({ title: "plan-stop", summary: "x", size: "normal", project_id: null }, "plan-stop-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "plan-stop-start", created.version));
  await waitFor(() => runner.managerCalls.length >= 1);
  const firstRun = runner.managerCalls[0].invocation_id;

  await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "plan-stop-pause", workVersion(db, workId)));
  await waitFor(() => db.get("SELECT status FROM agent_runs WHERE id = ?", firstRun).status === "cancelled");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n, 0, "the stopped plan creates no Task");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");

  await core.resumeWork(workId, commandEnvelope({}, "plan-stop-resume", workVersion(db, workId)));
  await waitFor(() => runner.managerCalls.filter((call) => call.mode !== "finalize").length >= 2);
  await waitFor(() => db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n >= 1);
});

/** A started Core with a real git Project, so Tasks get real worktrees. */
async function openGitProject(t, runner, verificationPlan = []) {
  const { root, db, core } = await createTestCore(
    t,
    { agentRunner: runner, agentStopWaitMs: 100, dispatcher: { tick_interval_ms: 25 } },
    { prefix: "owl-pause-git-", start: true },
  );
  const project = join(root, "project");
  await mkdir(project);
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const registered = await core.createProject(commandEnvelope({
    name: "Pause worktree project",
    canonical_path: project,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: verificationPlan,
  }, "pause-git-project"));
  return { root, db, core, projectId: registered.data.id };
}

test("the Worker's file stays in the same worktree across pause and resume", async (t) => {
  const FILE = "feature.mjs";
  const worktrees = [];
  const runner = stoppableRunner({
    onWorker: async (request, gateFor, attempt) => {
      worktrees.push(request.context.worktree);
      if (attempt === 1) {
        await writeFile(join(request.context.worktree, FILE), "export {};\n");
        await gateFor(request.invocation_id).promise;
      } else {
        assert.equal(existsSync(join(request.context.worktree, FILE)), true, "the redo sees the stopped Worker's file");
      }
    },
  });
  const { db, core, projectId } = await openGitProject(t, runner);
  const created = await core.createWork(commandEnvelope({ title: "pause-git", summary: "Write a file.", size: "small", project_id: projectId }, "pause-git-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "small" }, "pause-git-start", created.version));
  await waitFor(() => existsSync(worktrees[0] ? join(worktrees[0], FILE) : "/nonexistent"));
  const task = db.get("SELECT id, worktree_path FROM tasks WHERE work_id = ?", workId);

  await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "pause-git-pause", workVersion(db, workId)));
  await waitFor(() => db.get("SELECT status FROM agent_runs WHERE task_id = ? AND role = 'worker'", task.id)?.status === "cancelled");
  assert.equal(db.get("SELECT worktree_path FROM tasks WHERE id = ?", task.id).worktree_path, task.worktree_path);
  assert.equal(existsSync(join(task.worktree_path, FILE)), true, "pausing keeps the Worker's file");

  await core.resumeWork(workId, commandEnvelope({}, "pause-git-resume", workVersion(db, workId)));
  await waitFor(() => worktrees.length >= 2);
  assert.equal(worktrees[1], worktrees[0], "the redo runs in the same worktree");
  assert.equal(db.get("SELECT worktree_path FROM tasks WHERE id = ?", task.id).worktree_path, task.worktree_path);
  assert.equal(existsSync(join(task.worktree_path, FILE)), true);
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

function idleRunner(workerCalls) {
  return {
    runManagerPlan: async (request) => (request.mode === "finalize" ? finalComplete(request) : { outcome: "failed", message: "unexpected" }),
    runWorker: async (request) => {
      workerCalls.push(request.task_id);
      return { outcome: "failed", failure_class: "deterministic", error_key: "boom", retry_allowed: false, message: "boom" };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
}

test("a ready Task is not launched while a cancel_requested run of it remains, and launches once the run closes", async (t) => {
  const workerCalls = [];
  const { db, core } = await openCore(t, idleRunner(workerCalls));
  const taskId = createUlid();
  const workId = await runningWork(db, core, "stopped-run", [{ id: taskId, status: "waiting", managerTaskId: "T1", title: "Redo" }]);
  const runId = createUlid();
  const now = new Date().toISOString();
  // Startup recovery closes cancel_requested rows, so insert after start.
  await core.start();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'test', 'test', 'cancel_requested', ?, ?)`,
      runId, workId, taskId, now, now,
    );
    tx.run("UPDATE tasks SET status = 'ready' WHERE id = ?", taskId);
  });
  await sleep(300);
  assert.deepEqual(workerCalls, [], "no Worker starts while the stopped run is still open");

  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE agent_runs SET status = 'cancelled', ended_at = ? WHERE id = ?", now, runId);
  });
  await waitFor(() => workerCalls.length >= 1);
  assert.deepEqual(workerCalls, [taskId]);
});

test("a ready Task is not launched while its old pipeline is still running in this process", async (t) => {
  const workerCalls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const agentRunner = {
    ...idleRunner(workerCalls),
    runWorker: async (request) => {
      workerCalls.push(request.task_id);
      await gate;
      return { outcome: "failed", message: "stopped" };
    },
  };
  const { db, core } = await openCore(t, agentRunner);
  const taskId = createUlid();
  const workId = await runningWork(db, core, "old-pipeline", [{ id: taskId, status: "ready", managerTaskId: "T1", title: "Redo" }]);
  await core.start();
  await waitFor(() => workerCalls.length >= 1);
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'ready' WHERE id = ?", taskId);
  });
  await sleep(300);
  assert.equal(workerCalls.length, 1, `no second Worker starts for ${workId} while the first pipeline is active`);
  release();
  await waitFor(async () => {
    await db.createWriteLane().transact((tx) => {
      tx.run("UPDATE tasks SET status = 'ready' WHERE id = ?", taskId);
    });
    return workerCalls.length >= 2;
  });
  assert.equal(workerCalls[1], taskId, "the Task launches again once the old pipeline has finished");
});

// --- The Owner pauses in the gap between a run's check and its write (design table 5.2) ---

/** Commit the Owner's pause right before the first write that matches, as if it landed in that gap. */
function pauseBefore(core, db, workId, matches, lane = "write") {
  const writeLane = core.writeLane;
  const original = writeLane[lane].bind(writeLane);
  const state = { fired: false };
  writeLane[lane] = async (input) => {
    if (!state.fired && matches(input)) {
      state.fired = true;
      await core.pauseWork(workId, commandEnvelope({ reason: "race" }, `race-pause-${createUlid()}`, workVersion(db, workId)));
    }
    return original(input);
  };
  return state;
}

const eventTypeIs = (...types) => (input) => types.includes(input.event?.type);
const STOP_TRACE_TYPES = ["agent.crashed", "task.failure.classified", "recovery.started", "task.rate_limited", "review.failed", "review.passed"];
// retry_no past the short transient retries, so the next transient failure would take an auto-recovery slot.
const PAST_TRANSIENT_RETRIES = 100;
const RATE_LIMIT_RESET_AT = "2099-01-01T00:00:00.000Z";

function eventCount(db, workId, types) {
  return db.get(`SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type IN (${types.map(() => "?").join(",")})`, workId, ...types).n;
}

function assertStoppedWithoutTrace(db, workId, taskId) {
  assert.deepEqual({ ...db.get("SELECT status, paused_from FROM tasks WHERE id = ?", taskId) }, { status: "paused", paused_from: "ready" });
  assert.deepEqual({ ...db.get(COUNTERS_SQL, taskId) }, ZERO_COUNTERS);
  assert.equal(eventCount(db, workId, STOP_TRACE_TYPES), 0, "no failure, verdict or recovery slot remains");
}

async function workerRace(t, { worker, matches, retryNo = 0, wrap = null }) {
  const runner = stoppableRunner();
  runner.runWorker = async (request) => { runner.workerCalls.push({ task_id: request.task_id }); return worker(request); };
  const { db, core } = await openCore(t, runner, { agentStopWaitMs: 100 });
  const taskId = createUlid();
  const workId = await runningWork(db, core, "worker-race", [{ id: taskId, status: "ready", managerTaskId: "T1", title: "Race" }]);
  if (retryNo > 0) await db.createWriteLane().transact((tx) => { tx.run("UPDATE tasks SET retry_no = ? WHERE id = ?", retryNo, taskId); });
  const state = matches ? pauseBefore(core, db, workId, matches) : null;
  if (wrap) wrap(core, db, workId);
  await core.start();
  await waitFor(() => db.get("SELECT status FROM tasks WHERE id = ?", taskId).status === "paused", { message: "the Task to be paused" });
  await waitFor(() => db.get("SELECT status FROM agent_runs WHERE task_id = ? AND role = 'worker'", taskId)?.status === "cancelled", { message: "the Worker run to be cancelled" });
  await sleep(100);
  return { db, core, workId, taskId, runner, state };
}

test("a Worker result that arrives just after the pause is discarded without a trace", async (t) => {
  const { db, workId, taskId, state } = await workerRace(t, {
    worker: async (request) => ({ outcome: "success", report_valid: true, report: workerReport(request.invocation_id) }),
    matches: (input) => input.event?.idempotencyKey?.startsWith("agent-exited:") === true,
  });
  assert.equal(state.fired, true);
  assertStoppedWithoutTrace(db, workId, taskId);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'agent.exited' AND json_extract(payload_json, '$.result_ignored') IS NULL", workId).n, 0);
});

test("a Worker crash that arrives just after the pause records no crash", async (t) => {
  const { db, workId, taskId, state } = await workerRace(t, {
    worker: async () => { throw new Error("the CLI died"); },
    matches: eventTypeIs("agent.crashed"),
  });
  assert.equal(state.fired, true);
  assertStoppedWithoutTrace(db, workId, taskId);
});

test("a transient failure past the short retries that arrives just after the pause takes no auto-recovery slot", async (t) => {
  const { db, workId, taskId, state } = await workerRace(t, {
    worker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "provider_failed:network", retry_allowed: true, message: "network" }),
    matches: eventTypeIs("task.failure.classified"),
    retryNo: PAST_TRANSIENT_RETRIES,
  });
  assert.equal(state.fired, true);
  assertStoppedWithoutTrace(db, workId, taskId);
  assert.equal(db.get("SELECT retry_no FROM tasks WHERE id = ?", taskId).retry_no, PAST_TRANSIENT_RETRIES);
});

test("a Worker rate limit that arrives just after the pause takes no auto-recovery slot", async (t) => {
  const { db, workId, taskId, state } = await workerRace(t, {
    worker: async () => ({ outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited", rate_limit: { resets_at: RATE_LIMIT_RESET_AT, source: "event" }, message: "limit" }),
    // The pause lands after the Provider pause is recorded and before the recovery record is written.
    wrap: (core, db, workId) => {
      const controller = core.providerPauseController;
      const recordRateLimit = controller.recordRateLimit.bind(controller);
      controller.recordRateLimit = async (input) => {
        const recorded = await recordRateLimit(input);
        await core.pauseWork(workId, commandEnvelope({ reason: "race" }, `race-pause-${createUlid()}`, workVersion(db, workId)));
        return recorded;
      };
    },
  });
  assertStoppedWithoutTrace(db, workId, taskId);
});

// --- Reviewer paths ---

const REVIEW_NOW = "2030-01-02T03:04:05.000Z";

async function reviewerRace(t, { reviewer, matches, prepare = null }) {
  const root = await tempDir(t, "owl-pause-reviewer-race-");
  const db = createTestDatabase(root);
  const runner = stoppableRunner();
  runner.reviewerCalls = [];
  runner.runWorker = async (request) => {
    await writeFile(join(request.context.worktree, `${request.task_id}.mjs`), "export const x = 1;\n");
    return { outcome: "success", report_valid: true, report: { result: "success", verification: { passed: true } }, skill_feedback: null };
  };
  runner.runReviewer = async (request) => { runner.reviewerCalls.push(request.invocation_id); return reviewer(request); };
  const { core } = await createTestCore(t, {
    db,
    agentRunner: runner,
    owlRoot: root,
    git: Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) }),
    dispatcher: { tick_interval_ms: 60_000 },
    agentStopWaitMs: 100,
  });
  t.after(() => db.close());
  const { workId, taskId } = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Reviewer race", summary: "Pause during the review", size: "normal", project_id: null });
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] }]);
    tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "worker", provider: "openai", model: "gpt-5.6-terra" },
        { role: "reviewer", provider: "anthropic", model: "claude-sonnet-5" },
      ] }), REVIEW_NOW);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    return { workId: work.id, taskId: task.id };
  });
  const integrations = [];
  const integrateTask = core.workflow.integrateTask.bind(core.workflow);
  core.workflow.integrateTask = async (...args) => { integrations.push(args[1]); return integrateTask(...args); };
  const state = matches ? pauseBefore(core, db, workId, matches) : null;
  if (prepare) prepare(core, db, workId, state);
  await core.start();
  await core.tick(workId);
  await waitFor(() => db.get("SELECT status FROM tasks WHERE id = ?", taskId).status === "paused", { message: "the Task to be paused" });
  await core.workflow.drainPipelines();
  await waitFor(() => db.get("SELECT status FROM agent_runs WHERE task_id = ? AND role = 'worker'", taskId)?.status !== "running", { message: "the Worker run to end" });
  await sleep(100);
  return { db, core, workId, taskId, runner, state, integrations };
}

const reviewerRunStatus = (db, taskId) => db.get("SELECT status FROM agent_runs WHERE task_id = ? AND role = 'reviewer' ORDER BY created_at DESC LIMIT 1", taskId)?.status ?? null;

test("a Reviewer verdict that arrives just after the pause is discarded and the Task is not merged", async (t) => {
  const { db, workId, taskId, state } = await reviewerRace(t, {
    reviewer: async () => ({ outcome: "success", report_valid: true, report: { result: "success" }, review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null }),
    matches: eventTypeIs("review.passed"),
  });
  assert.equal(state.fired, true);
  assertStoppedWithoutTrace(db, workId, taskId);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM reviews WHERE task_id = ?", taskId).n, 0);
  assert.equal(reviewerRunStatus(db, taskId), "cancelled");
});

test("a Reviewer that finishes after the pause is never merged", async (t) => {
  let pauseWhileReviewing = null;
  const { db, workId, taskId, integrations } = await reviewerRace(t, {
    reviewer: async () => {
      await pauseWhileReviewing();
      return { outcome: "success", report_valid: true, report: { result: "success" }, review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null };
    },
    matches: null,
    prepare: (core, db, workId) => {
      pauseWhileReviewing = () => core.pauseWork(workId, commandEnvelope({ reason: "race" }, `race-pause-${createUlid()}`, workVersion(db, workId)));
    },
  });
  assert.deepEqual(integrations, [], "a Task the Owner stopped is not merged");
  assertStoppedWithoutTrace(db, workId, taskId);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM reviews WHERE task_id = ?", taskId).n, 0);
});

test("a Reviewer failure that arrives just after the pause records nothing", async (t) => {
  const { db, workId, taskId, state } = await reviewerRace(t, {
    reviewer: async () => { throw new Error("the Reviewer CLI died"); },
    matches: eventTypeIs("review.failed"),
  });
  assert.equal(state.fired, true);
  assertStoppedWithoutTrace(db, workId, taskId);
  assert.equal(reviewerRunStatus(db, taskId), "cancelled");
});

test("a Reviewer start refused by the pause leaves no failure, wait or run", async (t) => {
  const { db, workId, taskId, state } = await reviewerRace(t, {
    reviewer: async () => { throw new Error("must not run"); },
    matches: eventTypeIs("reviewer.started"),
  });
  assert.equal(state.fired, true);
  assertStoppedWithoutTrace(db, workId, taskId);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND role = 'reviewer'", taskId).n, 0);
});

test("a Reviewer deferred by a Provider pause that arrives just after the Owner's pause records no wait", async (t) => {
  const { db, workId, taskId, state } = await reviewerRace(t, {
    reviewer: async () => { throw new Error("must not run"); },
    matches: eventTypeIs("reviewer.deferred"),
    prepare: (core) => {
      const controller = core.providerPauseController;
      const isPaused = controller.isPaused.bind(controller);
      let reviewerStarted = false;
      const write = core.writeLane.write.bind(core.writeLane);
      core.writeLane.write = async (input) => {
        const result = await write(input);
        if (input.event?.type === "reviewer.started") reviewerStarted = true;
        return result;
      };
      controller.isPaused = (provider) => (reviewerStarted && provider === "anthropic" ? true : isPaused(provider));
    },
  });
  assert.equal(state.fired, true);
  assertStoppedWithoutTrace(db, workId, taskId);
  assert.equal(eventCount(db, workId, ["reviewer.deferred", "reviewer.rate_limited"]), 0);
});

test("a Reviewer rate limit that arrives just after the pause records no wait", async (t) => {
  const { db, workId, taskId, state } = await reviewerRace(t, {
    reviewer: async () => ({ outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited", rate_limit: { resets_at: RATE_LIMIT_RESET_AT, source: "event" }, message: "limit", skill_feedback: null }),
    matches: eventTypeIs("reviewer.rate_limited"),
  });
  assert.equal(state.fired, true);
  assertStoppedWithoutTrace(db, workId, taskId);
  assert.equal(eventCount(db, workId, ["reviewer.deferred", "reviewer.rate_limited"]), 0);
});

// --- Manager paths ---

async function managerRace(t, { managerPlan, matches }) {
  const runner = stoppableRunner({ managerPlan });
  const { db, core } = await openCore(t, runner, { agentStopWaitMs: 100 });
  await core.start();
  await disablePlanQuality(db);
  const created = await core.createWork(commandEnvelope({ title: "manager-race", summary: "x", size: "normal", project_id: null }, "manager-race-create"));
  const workId = created.data.work_id;
  const state = pauseBefore(core, db, workId, matches);
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "manager-race-start", created.version));
  await waitFor(() => state.fired, { message: "the pause to land" });
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "paused");
  await sleep(200);
  return { db, core, workId, runner };
}

const PLANNED = { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Research", type: "research", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false }] } };

test("a Manager start that the pause beats leaves no run and does not plan", async (t) => {
  // The first plan cannot be paused before its run exists, so the start races a replan of a Work with a running Task.
  const runner = stoppableRunner({ onWorker: async (request, gateFor) => { await gateFor(request.invocation_id).promise; } });
  const { db, core } = await openCore(t, runner, { agentStopWaitMs: 100 });
  const taskId = createUlid();
  const workId = await runningWork(db, core, "manager-start-race", [{ id: taskId, status: "ready", managerTaskId: "T1", title: "Busy" }]);
  await core.start();
  await waitFor(() => runner.workerCalls.length >= 1);
  const state = pauseBefore(core, db, workId, eventTypeIs("manager.started"));

  const raw = await core.invokeManagerPlan({ work_id: workId, mode: "replan" }, "test.manager");

  assert.equal(state.fired, true);
  assert.equal(raw, null);
  assert.equal(runner.managerCalls.length, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ? AND role = 'manager'", workId).n, 0);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");
});

test("a Manager plan that arrives just after the pause is discarded", async (t) => {
  const { db, workId } = await managerRace(t, {
    managerPlan: async () => PLANNED,
    matches: eventTypeIs("manager.completed"),
  });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n, 0, "the stopped plan creates no Task");
  assert.equal(db.get("SELECT status FROM agent_runs WHERE work_id = ? AND role = 'manager'", workId).status, "cancelled");
  assert.equal(eventCount(db, workId, ["manager.completed", "manager.failed"]), 0);
  assert.ok(db.get("SELECT 1 FROM events WHERE work_id = ? AND type = 'agent.exited' AND json_extract(payload_json, '$.reason') = 'manager_result_arrived_after_owner_pause'", workId));
});

test("a Manager failure that arrives just after the pause records no failure", async (t) => {
  const { db, workId } = await managerRace(t, {
    managerPlan: async () => ({ outcome: "failed", message: "could not plan" }),
    matches: eventTypeIs("manager.failed"),
  });
  assert.equal(eventCount(db, workId, ["manager.completed", "manager.failed"]), 0);
  assert.equal(db.get("SELECT status FROM agent_runs WHERE work_id = ? AND role = 'manager'", workId).status, "cancelled");
});

const SLEEP_SECONDS = 60;
const VERIFY_TIMEOUT_SECONDS = 120;

test("pausing during a verification command stops it, leaves the Task paused and never merges", async (t) => {
  const runner = stoppableRunner();
  const plan = [{
    command_id: "sleep-check",
    argv: ["sleep", String(SLEEP_SECONDS)],
    cwd: ".",
    env_allowlist: [],
    timeout_seconds: VERIFY_TIMEOUT_SECONDS,
    stdout_limit: 1_024,
    stderr_limit: 1_024,
    expected_exit_codes: [0],
    executor: "core",
  }];
  const { db, core, projectId } = await openGitProject(t, runner, plan);
  const integrations = [];
  const integrateTask = core.workflow.integrateTask.bind(core.workflow);
  core.workflow.integrateTask = async (...args) => { integrations.push(args[1]); return integrateTask(...args); };
  const created = await core.createWork(commandEnvelope({ title: "pause-verify", summary: "Verify slowly.", size: "small", project_id: projectId }, "pause-verify-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "small" }, "pause-verify-start", created.version));
  await waitFor(() => core.workflow.verificationChildren.size > 0, { message: "the verification command to start" });
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ?", workId).id;
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "verifying");

  await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "pause-verify-pause", workVersion(db, workId)));
  await waitFor(() => core.workflow.verificationChildren.size === 0, { message: "the verification command to stop" });
  await sleep(300);

  assert.deepEqual({ ...db.get("SELECT status, paused_from FROM tasks WHERE id = ?", taskId) }, { status: "paused", paused_from: "ready" });
  assert.deepEqual({ ...db.get(COUNTERS_SQL, taskId) }, ZERO_COUNTERS);
  assert.deepEqual(integrations, []);
  assert.equal(eventCount(db, workId, ["verification.completed", ...STOP_TRACE_TYPES]), 0, "a killed command is not a verification result");
});

test("a stale Worker that does not end after resume gets a forced stop, then an alert, and its Task is not started again", async (t) => {
  const cancels = [];
  const hung = [];
  let workerCalls = 0;
  const planned = { id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false };
  const agentRunner = {
    // The stop signal is ignored: the Worker keeps running until the test releases it.
    cancelAgent: async (agentRunId, force) => { cancels.push({ agentRunId, force }); },
    runManagerPlan: async (request) => ((request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planned] } }
      : { outcome: "failed", message: "unexpected" }),
    runWorker: async (request) => {
      workerCalls += 1;
      if (workerCalls === 1) await new Promise((end) => hung.push(end));
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner, { agentStopWaitMs: 40 });
  await core.start();
  await disablePlanQuality(db);
  const created = await core.createWork(commandEnvelope({ title: "stale", summary: "Stale Worker.", size: "normal", project_id: null }, "stale-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "stale-start", created.version));
  await waitFor(() => workerCalls === 1, { message: "the Worker to start" });
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ?", workId).id;
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE agent_runs SET status = 'running', pid = ? WHERE task_id = ? AND role = 'worker'", process.pid, taskId);
  });

  await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "stale-pause", workVersion(db, workId)));
  await core.resumeWork(workId, commandEnvelope({}, "stale-resume", workVersion(db, workId)));

  await waitFor(() => cancels.some((c) => c.force === true), { message: "a forced stop" });
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting", { message: "judgement_waiting" });
  const alert = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).map((row) => JSON.parse(row.payload_json)).find((p) => p.kind === "owner_stop_unconfirmed");
  assert.ok(alert, "owner_stop_unconfirmed was recorded");
  await sleep(200);
  assert.equal(workerCalls, 1, "the Task did not start while the stale Worker lives");
  // The stale Worker ending while the Decision is open does not start the Task; the Owner's answer does.
  for (const end of hung.splice(0)) end();
  await sleep(200);
  assert.equal(workerCalls, 1, "the Task waits for the Owner's answer");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  await core.resumeWorkOrRetryDecision(workId, commandEnvelope({}, "stale-answer", workVersion(db, workId)));
  await waitFor(() => workerCalls === 2, { message: "the Task to start after the answer" });
});
