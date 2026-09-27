import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

// Each started Task runs its own Worker/verification/merge pipeline: a slow
// Task never holds up the launch of other ready Tasks of the same Work, and
// a finished Task frees its slot for the next Task right away.

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

async function openCore(t, agentRunner, { maxParallel = 4, tickIntervalMs = 25 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-scheduler-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, max_parallel: maxParallel, dispatcher: { tick_interval_ms: tickIntervalMs } });
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
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function workerReport(invocationId) {
  return {
    outcome: "success",
    report_valid: true,
    report: {
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
    },
  };
}

function finalComplete(request) {
  return {
    outcome: "success",
    report_valid: true,
    report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } },
  };
}

/**
 * A runner whose Worker for each Task waits until the test releases it.
 * `release(title)` lets that Task's Worker finish.
 */
function gatedRunner(titleOf) {
  const gates = new Map();
  const started = [];
  let active = 0;
  let maxActive = 0;
  const gateFor = (title) => {
    if (!gates.has(title)) gates.set(title, deferred());
    return gates.get(title);
  };
  return {
    started,
    active: () => active,
    maxActive: () => maxActive,
    release: (title) => gateFor(title).resolve(),
    runner: {
      runManagerPlan: async (request) => (request.mode === "finalize" ? finalComplete(request) : { outcome: "failed", message: "unexpected" }),
      runWorker: async (request) => {
        const title = titleOf(request.task_id);
        started.push(title);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await gateFor(title).promise;
        } finally {
          active -= 1;
        }
        return workerReport(request.invocation_id);
      },
      runReviewer: async () => ({ outcome: "failed", message: "unused" }),
      runAdvisor: async () => ({ reply: "" }),
    },
  };
}

function insertTask(tx, workId, { id, status, title }) {
  const now = new Date().toISOString();
  tx.run(
    `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
     VALUES (?, ?, ?, 'research', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
    id, workId, title, status, now, now, title,
  );
}

/** A running Work with the given Tasks; `dependsOn` names Tasks by title. */
async function runningWork(db, core, suffix, tasks) {
  const created = await core.createWork(commandEnvelope({ title: suffix, summary: "x", size: "normal", project_id: null }, `${suffix}-create`));
  const workId = created.data.work_id;
  const ids = new Map(tasks.map((task) => [task.title, createUlid()]));
  await db.createWriteLane().transact((tx) => {
    for (const task of tasks) insertTask(tx, workId, { id: ids.get(task.title), status: task.status ?? "ready", title: task.title });
    for (const task of tasks) {
      for (const dependency of task.dependsOn ?? []) {
        tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", ids.get(task.title), ids.get(dependency));
      }
    }
    tx.run("UPDATE works SET state = 'running', state_version = state_version + 1, plan_revision = 1 WHERE id = ?", workId);
  });
  const titles = new Map([...ids].map(([title, id]) => [id, title]));
  return { workId, ids, titleOf: (id) => titles.get(id) };
}

function workVersion(db, workId) {
  return db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
}

function statusOf(db, id) {
  return db.get("SELECT status FROM tasks WHERE id = ?", id).status;
}

/** Title lookup that resolves once runningWork has created the Tasks. */
function lateTitles() {
  let lookup = () => undefined;
  return { titleOf: (id) => lookup(id), set: (fn) => { lookup = fn; } };
}

test("a Task that depends only on a finished Task starts while a slow Task is still running", async (t) => {
  const titles = lateTitles();
  const gated = gatedRunner(titles.titleOf);
  const { db, core } = await openCore(t, gated.runner);
  const { workId, ids, titleOf } = await runningWork(db, core, "throughput", [
    { title: "SLOW" },
    { title: "FAST" },
    { title: "NEXT", status: "waiting", dependsOn: ["FAST"] },
  ]);
  titles.set(titleOf);
  await core.start();

  await waitFor(() => gated.started.includes("SLOW") && gated.started.includes("FAST"));
  gated.release("FAST");
  assert.ok(await waitFor(() => gated.started.includes("NEXT"), 2_000), "NEXT starts before SLOW finishes");
  assert.equal(statusOf(db, ids.get("SLOW")), "running");

  gated.release("NEXT");
  gated.release("SLOW");
  assert.equal(await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed"), true);
});

test("no more Workers than max_parallel run at once, and every ready Task still runs", async (t) => {
  const titles = lateTitles();
  const gated = gatedRunner(titles.titleOf);
  const { db, core } = await openCore(t, gated.runner, { maxParallel: 1 });
  const { workId, titleOf } = await runningWork(db, core, "limit", [{ title: "A" }, { title: "B" }, { title: "C" }]);
  titles.set(titleOf);
  await core.start();

  for (let index = 0; index < 3; index += 1) {
    await waitFor(() => gated.started.length === index + 1);
    // Give the driver time to (wrongly) start another Worker.
    await sleep(100);
    assert.equal(gated.started.length, index + 1);
    assert.equal(gated.active(), 1);
    gated.release(gated.started[index]);
  }
  assert.equal(await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed"), true);
  assert.equal(gated.maxActive(), 1);
  assert.deepEqual([...gated.started].sort(), ["A", "B", "C"]);
});

test("a finished Task's slot goes to the next ready Task without waiting for the next periodic tick", async (t) => {
  const titles = lateTitles();
  const gated = gatedRunner(titles.titleOf);
  const { db, core } = await openCore(t, gated.runner, { maxParallel: 2, tickIntervalMs: 10_000 });
  const { workId, titleOf } = await runningWork(db, core, "wake", [{ title: "A" }, { title: "B" }, { title: "C" }]);
  titles.set(titleOf);
  await core.start();
  await core.tick(workId);

  await waitFor(() => gated.started.length === 2);
  assert.equal(gated.started.length, 2);
  gated.release(gated.started[0]);
  assert.ok(await waitFor(() => gated.started.length === 3, 2_000), "the third Task starts right after the first one finishes");
  for (const title of gated.started) gated.release(title);
  await core.workflow.drainPipelines();
});

test("cancelling a Work while its Worker runs closes the run and raises no alert", async (t) => {
  const titles = lateTitles();
  const gated = gatedRunner(titles.titleOf);
  const { db, core } = await openCore(t, gated.runner);
  const { workId, ids, titleOf } = await runningWork(db, core, "cancel", [{ title: "A" }]);
  titles.set(titleOf);
  await core.start();
  await waitFor(() => gated.started.includes("A"));

  await core.cancelWork(workId, commandEnvelope({ reason: "cancel" }, "cancel-running", workVersion(db, workId)));
  gated.release("A");
  await core.workflow.drainPipelines();

  assert.equal(statusOf(db, ids.get("A")), "cancelled");
  const runs = db.all("SELECT status FROM agent_runs WHERE work_id = ? AND role = 'worker'", workId).map((row) => row.status);
  assert.deepEqual(runs, ["cancelled"]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert'", workId).n, 0);
});

test("a Worker that finishes after pause and resume records its result and the Work completes", async (t) => {
  const titles = lateTitles();
  const gated = gatedRunner(titles.titleOf);
  const { db, core } = await openCore(t, gated.runner);
  const { workId, ids, titleOf } = await runningWork(db, core, "pause", [{ title: "A" }]);
  titles.set(titleOf);
  await core.start();
  await waitFor(() => gated.started.includes("A"));

  await core.pauseWork(workId, commandEnvelope({ reason: "pause" }, "pause-running", workVersion(db, workId)));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");
  assert.equal(statusOf(db, ids.get("A")), "running");
  await core.resumeWork(workId, commandEnvelope({}, "pause-resume", workVersion(db, workId)));
  gated.release("A");

  assert.equal(await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed"), true);
  assert.equal(statusOf(db, ids.get("A")), "completed");
  assert.deepEqual(gated.started, ["A"]);
});
