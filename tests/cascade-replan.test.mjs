import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core, reduceTask } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";

// A Task that failed only because its dependency
// failed carries tasks.failed_by_dependency_task_id. Core hands the Manager
// and Decisions only root failures; the cascaded Task returns to waiting on
// its own once the dependency is retried or replaced, a retried Task whose
// dependency is not completed waits instead of starting, a Decision answer
// never fails on a Task with an incomplete dependency, and a second Task
// halted for the same reason joins the open Decision.

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

/** A gate a fake Worker can wait on; released before Core stops so no call hangs. */
function workerGate() {
  let release;
  const promise = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release: () => release() };
}

async function openCore(t, agentRunnerFor, { migrationsDir = migrations, onStop = () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-cascade-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrationsDir);
  const agentRunner = agentRunnerFor({ db, root });
  const core = new Core({
    db,
    agentRunner,
    version: "test",
    owlRoot: root,
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  });
  t.after(async () => {
    onStop();
    await core.stop({ force: true });
    db.close();
  });
  return { db, core, root };
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

/** A real agent runner whose provider answers each prompt with `handler(prompt)`. */
function providerRunner(handler, prompts) {
  return createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        prompts.push(prompt);
        const out = handler(prompt, request);
        return {
          adapter: request.adapter,
          stdout: typeof out === "string" ? out : JSON.stringify(out),
          stderr: "",
          exit_code: 0,
          signal: null,
          format: "plain-text",
        };
      },
    },
  });
}

function managerInput(prompt) {
  const body = prompt.split("### Manager input\n")[1];
  assert.ok(body, "prompt has a Manager input section");
  return JSON.parse(body.trim());
}

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

function workerTaskId(request) {
  return request.task_id ?? request.context?.task_id ?? request.task?.id;
}

const managerTask = (id, dependsOn = [], replaces = []) => ({
  id,
  title: `${id} title`,
  type: "research",
  acceptance: "Done.",
  depends_on: dependsOn,
  replaces,
  context: "",
  notes: "",
  review: false,
});

function taskState(db, taskId) {
  return db.get("SELECT status, failed_by_dependency_task_id AS marker FROM tasks WHERE id = ?", taskId);
}

function dependencyIds(db, taskId) {
  return db.all("SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ? ORDER BY id", taskId).map((row) => row.id);
}

/** Copies the migrations older than `below` (e.g. "011") into a fresh directory. */
async function migrationsBelow(below) {
  const dir = await mkdtemp(join(tmpdir(), "owl-cascade-migrations-"));
  for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql") && file < below)) {
    await copyFile(join(migrations, name), join(dir, name));
  }
  return dir;
}

async function insertLegacyWork(db, title) {
  const workId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'owner:default', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works
         (id, owner_id, project_id, title, summary, size, state, state_version, plan_revision,
          rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', NULL, ?, 'x', 'normal', 'memo', 0, 0, ?, '[]', ?, ?)`,
      workId, title, JSON.stringify({ schema_version: "1.0.0", rules: [] }), now, now,
    );
    return null;
  });
  return workId;
}

/** Returns pre-011 cascade rows and the marker each one should carry after 012. */
async function insertBackfillRows(db) {
  const workId = await insertLegacyWork(db, "Backfill");
  const ids = {
    root: createUlid(), // root failure: latest failure event is its own classification
    marked011: createUlid(), // failed, latest event is the cascade: 011 already marks it
    paused: createUlid(), // cascaded and paused from failed: 011 skipped it (status)
    laterEvent: createUlid(), // cascaded, then an unrelated Task event: 011 skipped it (latest event)
    refailed: createUlid(), // cascaded, restored, then failed on its own: a root failure
    pausedReady: createUlid(), // paused from ready: not a failed Task
  };
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    let sequence = tx.get("SELECT COALESCE(MAX(sequence), 0) AS n FROM events").n + 1000;
    const insertTask = (id, status, pausedFrom, managerTaskId) => tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id, paused_from)
       VALUES (?, ?, ?, 'research', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?, ?)`,
      id, workId, `${managerTaskId} title`, status, now, now, managerTaskId, pausedFrom,
    );
    const insertEvent = (taskId, type, payload) => {
      sequence += 1;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'handled', 0, ?)`,
        createUlid(), sequence, `historical:${createUlid()}`, type, workId, taskId, JSON.stringify(payload), now,
      );
    };
    const cascade = (taskId) => insertEvent(taskId, "task.dependency_failed", { task_id: taskId, failed_dependency_task_id: ids.root, reason: "dependency_failed" });
    insertTask(ids.root, "failed", null, "B1");
    insertEvent(ids.root, "task.failure.classified", { failure_class: "deterministic", error_key: "broken", retry_allowed: false });
    insertTask(ids.marked011, "failed", null, "B2");
    cascade(ids.marked011);
    insertTask(ids.paused, "paused", "failed", "B3");
    cascade(ids.paused);
    insertTask(ids.laterEvent, "failed", null, "B4");
    cascade(ids.laterEvent);
    insertEvent(ids.laterEvent, "artifact.created", { path: "notes.md" });
    insertTask(ids.refailed, "failed", null, "B5");
    cascade(ids.refailed);
    insertEvent(ids.refailed, "task.dependency_restored", { task_id: ids.refailed });
    insertEvent(ids.refailed, "task.failure.classified", { failure_class: "deterministic", error_key: "own", retry_allowed: false });
    insertTask(ids.pausedReady, "paused", "ready", "B6");
    cascade(ids.pausedReady);
    for (const id of Object.values(ids).filter((id) => id !== ids.root)) {
      tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", id, ids.root);
    }
    tx.run("UPDATE works SET state = 'paused' WHERE id = ?", workId);
    return null;
  });
  const expected = {
    [ids.root]: null,
    [ids.marked011]: ids.root,
    [ids.paused]: ids.root,
    [ids.laterEvent]: ids.root,
    [ids.refailed]: null,
    [ids.pausedReady]: null,
  };
  return { ids, expected };
}

function markers(db, taskIds) {
  return Object.fromEntries(taskIds.map((id) => [id, taskState(db, id).marker]));
}

/**
 * T1 <- T2 plan in a running Work, with T1 failed as a root failure and T2
 * cascade-failed (Task row 27) through the real cascade path. The Work is not
 * registered with the driver: nothing moves until the test acts.
 */
async function seedCascade(core, db) {
  const created = await core.createWork(commandEnvelope({ title: "Cascade", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const [t1, t2] = await core.workflowEngine().registerPlan(workId, [managerTask("T1"), managerTask("T2", ["T1"])], "work.planned");
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", t1.id);
    tx.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
    return null;
  });
  await core.workflowEngine().cascadeFailure(workId, t1.id);
  assert.deepEqual(taskState(db, t2.id), { status: "failed", marker: t1.id }, "the cascade records the failed dependency");
  assert.deepEqual(taskState(db, t1.id), { status: "failed", marker: null }, "a root failure has no marker");
  return { workId, t1, t2 };
}

/** Start Core without driving the seeded Work (a paused Work is not registered at start). */
async function startWithoutDriving(core, db, workId) {
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'paused' WHERE id = ?", workId));
  await core.start();
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
}

/** A work-scope Decision the Owner answers, which queues an owner replan (as after "One or more tasks failed"). */
async function openWorkDecision(db, workId) {
  const decisionId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'judgement_waiting' WHERE id = ?", workId);
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'work', 'open', '[]', 'One or more tasks failed.', 'Core', 'judgement_waiting', '[]', NULL, 1, 'core', 0, ?)`,
      decisionId, workId, new Date().toISOString(),
    );
    return null;
  });
  return decisionId;
}

/** Retry failed Tasks through the one-transaction replan apply (no revisions, no new Tasks). */
async function retryTasks(core, db, workId, taskIds) {
  const plan = { newItems: [], revisions: new Map(), reopenIds: taskIds, supersessions: new Map() };
  const guard = {
    base_plan_revision: db.get("SELECT plan_revision FROM works WHERE id = ?", workId).plan_revision,
    root_statuses: new Map(taskIds.map((id) => [id, db.get("SELECT status FROM tasks WHERE id = ?", id).status])),
  };
  return core.workflowEngine().applyReplan(workId, plan, guard, "test retry");
}

test("a Manager replan failure blocks only the root Task; retry answer resumes it and returns the cascaded dependent to waiting", async (t) => {
  const { db, core } = await openCore(t, () => ({
    runManagerPlan: async () => ({ outcome: "failed", failure_class: "deterministic", retry_allowed: false, message: "manager unavailable" }),
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  const { workId, t1, t2 } = await seedCascade(core, db);
  await startWithoutDriving(core, db, workId);

  // Even when a caller passes every failed Task, only the root one reaches the Manager and the Decision.
  await core.triggerManagerReplan(workId, [t1.id, t2.id], "Owner answered.", "please retry");
  const decision = db.get("SELECT id, scope, blocked_task_ids_json AS blocked, state_version FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision, "the failed replan opened a Decision");
  assert.equal(decision.scope, "task");
  assert.deepEqual(JSON.parse(decision.blocked), [t1.id]);
  assert.equal(taskState(db, t1.id).status, "judgement_waiting");
  assert.deepEqual(taskState(db, t2.id), { status: "failed", marker: t1.id });

  const response = await core.answerDecision(
    decision.id,
    commandEnvelope({ answer: "もう一度実行する", option_key: "retry", source_message_id: null }, "answer", decision.state_version),
  );
  assert.equal(response.data.status, "resolved");
  assert.equal(db.get("SELECT status FROM decisions WHERE id = ?", decision.id).status, "resolved");
  assert.deepEqual(taskState(db, t1.id), { status: "ready", marker: null });
  assert.deepEqual(taskState(db, t2.id), { status: "waiting", marker: null });
});

test("an owner-answered replan hands the Manager only root failures", async (t) => {
  const prompts = [];
  const gate = workerGate();
  const { db, core } = await openCore(t, () => {
    const agent = providerRunner(
      // Only the root failure is retried; the cascaded T2 resumes on its own.
      (prompt) => (prompt.includes("REPLAN") ? { tasks: [managerTask("T1")] } : "not json"),
      prompts,
    );
    return { ...agent, runWorker: async () => { await gate.promise; return { outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" }; } };
  }, { onStop: gate.release });
  const { workId, t1, t2 } = await seedCascade(core, db);
  const decisionId = await openWorkDecision(db, workId);
  await core.start();
  await core.answerDecision(decisionId, commandEnvelope({ answer: "please fix T1 then continue", option_key: null, source_message_id: null }, "answer"));

  const replanPrompt = await waitFor(() => prompts.find((prompt) => prompt.includes("REPLAN")));
  assert.ok(replanPrompt, "the owner answer ran a Manager replan");
  const input = managerInput(replanPrompt);
  assert.deepEqual(input.context.failed_task_ids, [t1.id]);
  assert.deepEqual(input.tasks.map((task) => task.id), [t1.id]);
  const plan = new Map(input.context.current_plan.map((task) => [task.id, task]));
  assert.equal(plan.get(t1.id).failed_by_dependency, false);
  assert.equal(plan.get(t2.id).failed_by_dependency, true);
  assert.equal(plan.get(t2.id).status, "failed");

  // T1 retried; T2 restored to waiting behind it (it never starts early).
  await waitFor(() => taskState(db, t2.id).status === "waiting");
  assert.deepEqual(taskState(db, t2.id), { status: "waiting", marker: null });
  assert.ok(["ready", "running"].includes(taskState(db, t1.id).status));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ?", t2.id).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 0);
});

test("replacing only the root Task keeps the cascaded dependent and re-points it at the replacement", async (t) => {
  const prompts = [];
  const gate = workerGate();
  const { db, core } = await openCore(t, () => {
    const agent = providerRunner(
      (prompt) => (prompt.includes("REPLAN") ? { tasks: [managerTask("N1", [], ["T1"])] } : "not json"),
      prompts,
    );
    return { ...agent, runWorker: async () => { await gate.promise; return { outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" }; } };
  }, { onStop: gate.release });
  const { workId, t1, t2 } = await seedCascade(core, db);
  const decisionId = await openWorkDecision(db, workId);
  await core.start();
  await core.answerDecision(decisionId, commandEnvelope({ answer: "replace T1", option_key: null, source_message_id: null }, "answer"));

  const n1 = await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'N1'", workId));
  assert.ok(n1, "the replacement Task was registered");
  await waitFor(() => taskState(db, t1.id).status === "cancelled");
  // Only the root Task was superseded; its cascaded dependent now waits for N1.
  assert.equal(taskState(db, t1.id).status, "cancelled");
  assert.deepEqual(taskState(db, t2.id), { status: "waiting", marker: null });
  assert.deepEqual(dependencyIds(db, t2.id), [n1.id]);
  const superseded = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.superseded'", workId)
    .flatMap((row) => JSON.parse(row.payload_json).task_ids);
  assert.deepEqual(superseded, [t1.id]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 0);
});

test("a retried Task whose dependency is not completed goes to waiting, not ready", async (t) => {
  // Reducer rows 20/20b.
  const failedRow = {
    id: "task-a4", work_id: "work-a4", status: "failed", state_version: 3, failure_count: 2, same_error_count: 2,
    last_error_key: "a".repeat(64), last_error_generation: 1, review_round: 1, reviewer_failure_count: 1,
    worker_generation: 1, retry_no: 0, next_attempt_at: null, paused_from: null, failed_by_dependency_task_id: "task-root",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const replan = (dependenciesCompleted) => ({ event: "task.replanned", payload: { base_plan_version: 1, current_plan_version: 1, dependencies_completed: dependenciesCompleted } });
  assert.equal(reduceTask(failedRow, replan(false)).next.status, "waiting");
  assert.equal(reduceTask(failedRow, replan(false)).next.failed_by_dependency_task_id, null);
  assert.equal(reduceTask(failedRow, replan(true)).next.status, "ready");
  assert.throws(() => reduceTask(failedRow, { event: "task.replanned", payload: { base_plan_version: 1, current_plan_version: 1 } }), /dependencies_completed/);

  // End to end: T1 fails twice with the same error (row 7), T2 cascades, and
  // the Manager retries T1 (the root failure). T2 returns to waiting on its
  // own and waits until T1 completes.
  const order = [];
  let replanned = false;
  let t2StatusWhenT1Retried = null;
  const { db, core } = await openCore(t, ({ db }) => ({
    runManagerPlan: async (request) => {
      if (request.mode === "finalize") return finalComplete(request);
      if (request.mode === "replan") {
        replanned = true;
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [managerTask("T1")] } };
      }
      return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [managerTask("T1"), managerTask("T2", ["T1"])] } };
    },
    runWorker: async (request) => {
      const taskId = workerTaskId(request);
      const row = db.get("SELECT manager_task_id FROM tasks WHERE id = ?", taskId);
      const t1 = db.get("SELECT status FROM tasks WHERE manager_task_id = 'T1' AND work_id = (SELECT work_id FROM tasks WHERE id = ?)", taskId);
      order.push({ task: row.manager_task_id, t1Status: t1.status });
      if (row.manager_task_id === "T1" && !replanned) {
        return { outcome: "failed", failure_class: "deterministic", error_key: "same_err", retry_allowed: true, message: "broken" };
      }
      if (row.manager_task_id === "T1") {
        t2StatusWhenT1Retried = db.get("SELECT status FROM tasks WHERE manager_task_id = 'T2' AND work_id = (SELECT work_id FROM tasks WHERE id = ?)", taskId).status;
      }
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Retry both", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "start", created.version));

  const state = await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed" && "completed", 10_000);
  assert.equal(state, "completed", `Work state: ${db.get("SELECT state FROM works WHERE id = ?", workId).state}`);
  assert.equal(replanned, true);
  assert.equal(t2StatusWhenT1Retried, "waiting");
  const t2Runs = order.filter((entry) => entry.task === "T2");
  assert.equal(t2Runs.length, 1, JSON.stringify(order));
  assert.equal(t2Runs[0].t1Status, "completed", "T2 started only after T1 completed");
});

test("applyReplan sends a retried Task with an incomplete dependency to waiting", async (t) => {
  const { db, core } = await openCore(t, () => ({
    runManagerPlan: async () => ({ outcome: "failed", failure_class: "deterministic", retry_allowed: false, message: "unused" }),
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  const { workId, t1, t2 } = await seedCascade(core, db);
  // Both Tasks in one retry list, in either order: T2's dependency is not completed.
  await retryTasks(core, db, workId, [t2.id, t1.id]);
  assert.deepEqual(taskState(db, t1.id), { status: "ready", marker: null });
  assert.deepEqual(taskState(db, t2.id), { status: "waiting", marker: null });
});

test("a second Task halted for the same reason joins the open Decision", async (t) => {
  const attempts = new Map();
  const { db, core } = await openCore(t, ({ db }) => ({
    runManagerPlan: async (request) => {
      if (request.mode === "finalize") return finalComplete(request);
      if (request.mode === "replan") return { outcome: "failed", failure_class: "deterministic", retry_allowed: false, message: "no replan expected" };
      const same = (id) => ({ ...managerTask(id), title: "Same title" });
      return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [same("T1"), same("T2")] } };
    },
    runWorker: async (request) => {
      const taskId = workerTaskId(request);
      const attempt = (attempts.get(taskId) ?? 0) + 1;
      attempts.set(taskId, attempt);
      if (attempt === 1) {
        return { outcome: "failed", failure_class: "deterministic", error_key: "auth_revoked", retry_allowed: false, message: "The provider revoked the credentials." };
      }
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Same reason", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "start", created.version));

  const blocked = await waitFor(() => {
    const rows = db.all("SELECT id FROM tasks WHERE work_id = ? AND status = 'judgement_waiting'", workId);
    return rows.length === 2 ? rows.map((row) => row.id).sort() : null;
  });
  assert.ok(blocked, `Tasks: ${JSON.stringify(db.all("SELECT manager_task_id, status FROM tasks WHERE work_id = ?", workId))}`);
  const decisions = db.all("SELECT id, scope, blocked_task_ids_json AS blocked, state_version FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.equal(decisions.length, 1, JSON.stringify(decisions));
  assert.equal(decisions[0].scope, "task");
  assert.deepEqual(JSON.parse(decisions[0].blocked).sort(), blocked);

  const response = await core.answerDecision(
    decisions[0].id,
    commandEnvelope({ answer: "もう一度実行する", option_key: "retry", source_message_id: null }, "answer", decisions[0].state_version),
  );
  assert.deepEqual([...response.data.resumed_task_ids].sort(), blocked);
  const state = await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed" && "completed", 10_000);
  assert.equal(state, "completed", `Tasks: ${JSON.stringify(db.all("SELECT manager_task_id, status FROM tasks WHERE work_id = ?", workId))}`);
});

test("an already-open Decision containing a cascaded Task can be answered after the migration", async (t) => {
  // Migrate a database to 010 only, write pre-011 rows, then run every migration.
  const oldDir = await migrationsBelow("011");
  const { db, core } = await openCore(t, () => ({
    runManagerPlan: async () => ({ outcome: "failed", failure_class: "deterministic", retry_allowed: false, message: "unused" }),
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }), { migrationsDir: oldDir });
  assert.equal(db.all("PRAGMA table_info(tasks)").some((column) => column.name === "failed_by_dependency_task_id"), false);

  const workId = await insertLegacyWork(db, "Historical");
  const [t1, t2, t3, t4] = [createUlid(), createUlid(), createUlid(), createUlid()];
  const now = new Date().toISOString();
  const eventSequence = { value: 1000 };
  await db.createWriteLane().transact((tx) => {
    const insertTask = (id, status, managerTaskId) => tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, ?, 'research', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
      id, workId, `${managerTaskId} title`, status, now, now, managerTaskId,
    );
    const insertEvent = (taskId, type, payload) => {
      eventSequence.value += 1;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'handled', 0, ?)`,
        createUlid(), eventSequence.value, `historical:${createUlid()}`, type, workId, taskId, JSON.stringify(payload), now,
      );
    };
    // Decision 1 blocks T1 (root) and T2 (cascaded, still failed: its last event is the cascade).
    insertTask(t1, "judgement_waiting", "T1");
    insertTask(t2, "failed", "T2");
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", t2, t1);
    insertEvent(t1, "task.failed", { reason: "broken" });
    insertEvent(t2, "task.dependency_failed", { task_id: t2, failed_dependency_task_id: t1, reason: "dependency_failed" });
    // T3 depends on T4 (root, judgement_waiting); T3 was cascaded and then blocked as well.
    insertTask(t4, "judgement_waiting", "T4");
    insertTask(t3, "judgement_waiting", "T3");
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", t3, t4);
    insertEvent(t3, "task.dependency_failed", { task_id: t3, failed_dependency_task_id: t4, reason: "dependency_failed" });
    insertEvent(t3, "decision.opened", { reason: "manager replan failed" });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    const options = JSON.stringify([
      { key: "retry", label: "Retry", description: "Retry the Tasks." },
      { key: "cancel", label: "Cancel", description: "Cancel the Work." },
    ]);
    for (const [id, blocked] of [["decision-1", [t1, t2]], ["decision-2", [t4, t3]]]) {
      tx.run(
        `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
         VALUES (?, ?, 'task', 'open', ?, ?, 'Manager replan', 'judgement_waiting', ?, NULL, 1, 'manager', 0, ?)`,
        `${id}-${workId}`, workId, JSON.stringify(blocked), `The Manager could not make a plan (${id}).`, options, now,
      );
    }
    return null;
  });

  const backfill = await insertBackfillRows(db);

  const result = db.migrate(migrations);
  assert.deepEqual(result.applied, ["011", "012", "013", "014", "015", "016", "017", "018", "019", "020", "021", "022", "023", "024", "025"]);
  assert.equal(taskState(db, t2).marker, t1, "the backfill marks the cascaded failed Task");
  assert.equal(taskState(db, t1).marker, null);
  assert.equal(taskState(db, t3).marker, null, "only failed Tasks are backfilled");
  assert.deepEqual(markers(db, Object.keys(backfill.expected)), backfill.expected, "012 marks paused and later-event cascades only");

  for (const [id, root, cascaded] of [[`decision-1-${workId}`, t1, t2], [`decision-2-${workId}`, t4, t3]]) {
    const decision = db.get("SELECT state_version FROM decisions WHERE id = ?", id);
    const response = await core.answerDecision(id, commandEnvelope({ answer: "Retry", option_key: "retry", source_message_id: null }, `answer:${id}`, decision.state_version));
    assert.equal(response.data.status, "resolved");
    assert.equal(db.get("SELECT status FROM decisions WHERE id = ?", id).status, "resolved");
    assert.deepEqual(taskState(db, root), { status: "ready", marker: null });
    assert.deepEqual(taskState(db, cascaded), { status: "waiting", marker: null });
  }
});

test("012 corrects DBs that already ran 011", async (t) => {
  // Write pre-011 rows at 010, migrate to 011 (its backfill misses the paused
  // and later-event cascades), then apply 012.
  const dir010 = await migrationsBelow("011");
  const dir011 = await migrationsBelow("012");
  const { db, core } = await openCore(t, () => ({
    runManagerPlan: async () => ({ outcome: "failed", failure_class: "deterministic", retry_allowed: false, message: "unused" }),
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }), { migrationsDir: dir010 });
  const { ids, expected } = await insertBackfillRows(db);
  const taskIds = Object.keys(expected);

  assert.deepEqual(db.migrate(dir011).applied, ["011"]);
  assert.deepEqual(markers(db, taskIds), { ...expected, [ids.paused]: null, [ids.laterEvent]: null }, "011 alone misses the paused and later-event cascades");

  assert.deepEqual(db.migrate(migrations).applied, ["012", "013", "014", "015", "016", "017", "018", "019", "020", "021", "022", "023", "024", "025"]);
  assert.deepEqual(markers(db, taskIds), expected, "012 gives the same markers as a DB that ran 011 and 012 together");

  assert.deepEqual(db.migrate(migrations).applied, [], "all migrations are recorded once and their checksums match");
  assert.deepEqual(markers(db, taskIds), expected);
});

test("a pause round trip keeps the cascade marker", async (t) => {
  const { db, core } = await openCore(t, () => ({
    runManagerPlan: async () => ({ outcome: "failed", failure_class: "deterministic", retry_allowed: false, message: "unused" }),
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  const { workId, t1, t2 } = await seedCascade(core, db);
  const pauseVersion = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.pauseWork(workId, commandEnvelope({ reason: "break" }, "pause", pauseVersion));
  assert.deepEqual(taskState(db, t2.id), { status: "paused", marker: t1.id });
  // Any later Task-scoped event used to hide the cascade from the event-based detection.
  await db.createWriteLane().transact((tx) => {
    const sequence = tx.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events").n;
    tx.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
       VALUES (?, ?, ?, 'work.paused', ?, ?, NULL, '{}', 'handled', 0, ?)`,
      createUlid(), sequence, `audit:${createUlid()}`, workId, t2.id, new Date().toISOString(),
    );
    return null;
  });
  const resumeVersion = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.resumeWork(workId, commandEnvelope({}, "resume", resumeVersion));
  assert.deepEqual(taskState(db, t2.id), { status: "failed", marker: t1.id });
  assert.deepEqual(taskState(db, t1.id), { status: "failed", marker: null });

  // Retrying the root Task still restores the cascaded one.
  await retryTasks(core, db, workId, [t1.id]);
  assert.deepEqual(taskState(db, t1.id), { status: "ready", marker: null });
  assert.deepEqual(taskState(db, t2.id), { status: "waiting", marker: null });
});
