import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}`,
    expected_version: expectedVersion,
    payload,
  };
}

async function openDb(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-stale-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const cores = [];
  db.__cores = cores;
  t.after(async () => {
    for (const core of cores) await core.stop({ force: true });
    db.close();
  });
  return { root, db };
}

function newCore(t, db, root, agentRunner, dispatcher = {}) {
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 5_000, ...dispatcher } });
  db.__cores.push(core);
  return core;
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

function insertTask(transaction, workId, { id, status, managerTaskId, title }) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO tasks
       (id, work_id, title, type, status, priority, context, acceptance,
        state_version, failure_count, same_error_count, review_round, worker_generation,
        created_at, updated_at, retry_no, manager_task_id)
     VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
    id, workId, title, status, now, now, managerTaskId,
  );
}

function insertAgentRun(transaction, workId, taskId, { id, pid }) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO agent_runs
       (id, work_id, task_id, role, provider, model, status, pid, process_start_time, process_cmdline_sha256, fencing_token, created_at, updated_at)
     VALUES (?, ?, ?, 'worker', 'test', 'test', 'running', ?, NULL, NULL, ?, ?, ?)`,
    id, workId, taskId, pid, id, now, now,
  );
}

async function createRunningWork(core, db, suffix) {
  const created = await core.createWork(commandEnvelope({ title: `Stale ${suffix}`, summary: "x", size: "normal", project_id: null }, `${suffix}-create`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
  });
  return workId;
}

/** A pid that is guaranteed to no longer identify a live process. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid;
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  return pid;
}

const noopAgentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unexpected manager call" }),
  runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "test_stop", retry_allowed: true, message: "stop here" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("a Worker agent_run with a dead pid is only reconciled as crashed on the second stale-agent scan", async (t) => {
  const { root, db } = await openDb(t);
  const core = newCore(t, db, root, noopAgentRunner, { stale_check_interval_ms: 150 });
  const workId = await createRunningWork(core, db, "two-pass");

  const crashedTaskId = createUlid();
  const crashedRunId = createUlid();
  const pid = await deadPid();

  const survivorTaskId = createUlid();
  const survivorRunId = createUlid();

  // Started right before the fixture rows are inserted: startup recovery
  // (which unconditionally reconciles any agent_run left `running` from a
  // prior process) must not be the thing that touches them, and the periodic
  // stale-agent scan's interval should start counting close to the insert.
  await core.start();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: crashedTaskId, status: "running", managerTaskId: "T1", title: "Dead pid" });
    insertAgentRun(transaction, workId, crashedTaskId, { id: crashedRunId, pid });

    insertTask(transaction, workId, { id: survivorTaskId, status: "running", managerTaskId: "T2", title: "Null pid" });
    insertAgentRun(transaction, workId, survivorTaskId, { id: survivorRunId, pid: null });
  });

  // Shortly after the first scan but before the second, neither row has been
  // reconciled yet: a dead pid alone is not enough on the first sighting.
  await sleep(200);
  assert.equal(
    db.get("SELECT 1 AS found FROM events WHERE type = 'agent.crashed' AND agent_run_id = ?", crashedRunId),
    undefined,
    "the first scan only records the dead pid, it does not reconcile the run",
  );
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", crashedTaskId).status, "running");
  assert.equal(db.get("SELECT status FROM agent_runs WHERE id = ?", crashedRunId).status, "running");

  // The second scan, still seeing the same dead pid, reconciles the run.
  const crashed = await waitFor(() =>
    db.get("SELECT 1 AS found FROM events WHERE type = 'agent.crashed' AND agent_run_id = ?", crashedRunId));
  assert.ok(crashed, "a pid still dead on the second scan is reconciled as a crash");
  assert.equal(db.get("SELECT status FROM agent_runs WHERE id = ?", crashedRunId).status, "failed");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", crashedTaskId).status, "ready");

  // A row whose pid is NULL is never treated as a dead process, on any scan.
  assert.equal(
    db.get("SELECT 1 AS found FROM events WHERE type = 'agent.crashed' AND agent_run_id = ?", survivorRunId),
    undefined,
    "a NULL pid is never reconciled as a crash",
  );
  assert.equal(db.get("SELECT status FROM agent_runs WHERE id = ?", survivorRunId).status, "running");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", survivorTaskId).status, "running");
});
