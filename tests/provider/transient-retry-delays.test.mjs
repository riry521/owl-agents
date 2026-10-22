import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowEngine } from "../../packages/core/dist/index.js";
import { FALLBACK_BACKOFF_MINUTES } from "../../packages/core/dist/provider-pause-controller.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { openTestDatabase } from "../helpers/db.mjs";

const TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

// A Work with one ready Task whose Worker always fails with a 529; `autoRecoveryLimit` null keeps the default.
async function setUp(t, autoRecoveryLimit, errorKey = "provider_failed:harness_error:503") {
  const { db } = await openTestDatabase(t, { prefix: "owl-transient-retry-delays-" });
  const workId = createUlid();
  const taskId = createUlid();
  const createdAt = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", "owner:transient-retry", createdAt, createdAt);
    if (autoRecoveryLimit !== null) {
      tx.run(
        "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('auto_recovery', 'owner:transient-retry', '1.0.0', ?, ?)",
        JSON.stringify({ limit: autoRecoveryLimit }), createdAt,
      );
    }
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json,
        related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:transient-retry', 'Work', '', 'normal', 'running', ?, '[]', ?, ?)`,
      workId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), createdAt, createdAt,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Task', 'code', 'ready', 'normal', '', '', ?, ?)`,
      taskId, workId, createdAt, createdAt,
    );
  });

  const receivedAt = [];
  const workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async () => {
        receivedAt.push(Date.now());
        return {
          outcome: "failed",
          failure_class: "transient",
          error_key: errorKey,
          retry_allowed: true,
          message: "API Error: Service unavailable (HTTP 503)",
        };
      },
    },
    git: { prepareWorktree: async () => ({ ok: true, message: "prepared" }) },
  });
  t.after(async () => {
    await workflow.stop();
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-02T03:04:05.000Z") });
  workflow.start();
  return { db, workflow, workId, taskId, receivedAt };
}

const taskState = (db, taskId) => db.get("SELECT status, retry_no, next_attempt_at, failure_count, same_error_count, last_failure_class FROM tasks WHERE id = ?", taskId);

async function runAttempt(workflow, workId, taskId) {
  assert.deepEqual(await workflow.launchReady(workId), [taskId]);
  await workflow.drainPipelines();
}

const startedRecords = (db, workId) => db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'recovery.started' ORDER BY sequence", workId).map((event) => JSON.parse(event.payload_json));

const classified = (db, workId, taskId) => db.all(
  "SELECT payload_json FROM events WHERE work_id = ? AND task_id = ? AND type = 'task.failure.classified' ORDER BY sequence",
  workId,
  taskId,
).map((event) => JSON.parse(event.payload_json));

test("overloaded transient failures retry after 30 seconds, 2 minutes, and 5 minutes before deterministic escalation", async (t) => {
  const { db, workflow, workId, taskId, receivedAt } = await setUp(t, 0);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await runAttempt(workflow, workId, taskId);

    const task = taskState(db, taskId);
    if (attempt <= TRANSIENT_RETRY_DELAYS_MS.length) {
      const expectedNextAttemptAt = new Date(receivedAt.at(-1) + TRANSIENT_RETRY_DELAYS_MS[attempt - 1]).toISOString();
      assert.equal(task.status, "ready");
      assert.equal(task.retry_no, attempt);
      assert.equal(task.next_attempt_at, expectedNextAttemptAt);
      const failureEvent = db.get(
        "SELECT payload_json FROM events WHERE task_id = ? AND type = 'task.failure.classified' ORDER BY sequence DESC LIMIT 1",
        taskId,
      );
      assert.equal(JSON.parse(failureEvent.payload_json).failure_class, "transient");
      assert.equal(task.failure_count, 0);
      assert.equal(task.same_error_count, 0);
      t.mock.timers.setTime(Date.parse(expectedNextAttemptAt));
    } else {
      assert.equal(task.last_failure_class, "deterministic");
      assert.equal(task.retry_no, 3);
      assert.equal(task.next_attempt_at, null);
      assert.equal(task.failure_count, 1);
      assert.equal(task.same_error_count, 1);
    }
  }

  const failures = classified(db, workId, taskId);
  assert.deepEqual(failures.map((failure) => failure.failure_class), ["transient", "transient", "transient", "deterministic"]);
  assert.deepEqual(failures.slice(0, 3).map((failure) => failure.retry_no), [1, 2, 3]);
  assert.ok(failures.every((failure) => failure.error_key === "provider_failed:harness_error:503"));
  assert.deepEqual(startedRecords(db, workId), [], "with a limit of 0 no recovery is recorded");
});

test("with the default limit of 2, two long waits follow the short retries before the failure becomes deterministic", async (t) => {
  const { db, workflow, workId, taskId, receivedAt } = await setUp(t, null);

  for (let attempt = 1; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    await runAttempt(workflow, workId, taskId);
    t.mock.timers.setTime(Date.parse(taskState(db, taskId).next_attempt_at));
  }
  assert.deepEqual(startedRecords(db, workId), [], "the short retries are not recoveries");

  for (const attemptNo of [1, 2]) {
    await runAttempt(workflow, workId, taskId);
    const task = taskState(db, taskId);
    const expectedAt = new Date(receivedAt.at(-1) + FALLBACK_BACKOFF_MINUTES[attemptNo - 1] * 60_000).toISOString();
    assert.equal(task.status, "ready");
    assert.equal(task.next_attempt_at, expectedAt);
    const records = startedRecords(db, workId);
    assert.equal(records.length, attemptNo);
    assert.equal(records.at(-1).attempt_no, attemptNo);
    assert.equal(records.at(-1).counted, true);
    assert.equal(records.at(-1).kind, "provider_transient");
    assert.equal(records.at(-1).resume_at, expectedAt);
    assert.equal(task.retry_no, TRANSIENT_RETRY_DELAYS_MS.length + attemptNo);
    t.mock.timers.setTime(Date.parse(expectedAt));
  }

  await runAttempt(workflow, workId, taskId);
  const failures = classified(db, workId, taskId);
  assert.equal(failures.at(-1).failure_class, "deterministic");
  assert.equal(failures.at(-1).escalated_from, "transient");
  assert.equal(startedRecords(db, workId).length, 2, "no third recovery");
  assert.equal(taskState(db, taskId).last_failure_class, "deterministic");
});

for (const limit of [0, null]) {
  test(`a Worker timeout is not recovered with limit ${limit ?? "default 2"}: three short retries, then deterministic with no recovery.started`, async (t) => {
    const { db, workflow, workId, taskId } = await setUp(t, limit, "provider_failed:timeout:wall");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await runAttempt(workflow, workId, taskId);
      const next = taskState(db, taskId).next_attempt_at;
      if (next) t.mock.timers.setTime(Date.parse(next));
    }
    const failures = classified(db, workId, taskId);
    assert.deepEqual(failures.map((failure) => failure.failure_class), ["transient", "transient", "transient", "deterministic"]);
    assert.equal(failures.at(-1).escalated_from, "transient");
    assert.deepEqual(startedRecords(db, workId), []);
  });
}
