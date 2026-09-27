import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { WorkflowEngine } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

test("overloaded transient failures retry after 30 seconds, 2 minutes, and 5 minutes before deterministic escalation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-transient-retry-delays-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const workId = createUlid();
  const taskId = createUlid();
  const createdAt = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", "owner:transient-retry", createdAt, createdAt);
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
          error_key: "provider_failed:harness_error:529",
          retry_allowed: true,
          message: "API Error: Overloaded (HTTP 529)",
        };
      },
    },
    git: { prepareWorktree: async () => ({ ok: true, message: "prepared" }) },
  });
  t.after(async () => {
    await workflow.stop();
    db.close();
  });

  const startTime = Date.parse("2026-01-02T03:04:05.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: startTime });
  workflow.start();

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.deepEqual(await workflow.launchReady(workId), [taskId]);
    await workflow.drainPipelines();

    const task = db.get("SELECT status, retry_no, next_attempt_at, failure_count, same_error_count, last_failure_class FROM tasks WHERE id = ?", taskId);
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

  const failures = db.all(
    "SELECT payload_json FROM events WHERE work_id = ? AND task_id = ? AND type = 'task.failure.classified' ORDER BY sequence",
    workId,
    taskId,
  ).map((event) => JSON.parse(event.payload_json));
  assert.deepEqual(failures.map((failure) => failure.failure_class), ["transient", "transient", "transient", "deterministic"]);
  assert.deepEqual(failures.slice(0, 3).map((failure) => failure.retry_no), [1, 2, 3]);
  assert.ok(failures.every((failure) => failure.error_key === "provider_failed:harness_error:529"));
});
