import assert from "node:assert/strict";
import { test } from "node:test";

import { recoverOrphanedState } from "../../packages/core/dist/startup-recovery.js";
import { reduceTaskInTransaction } from "../../packages/core/dist/state-reducer.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { openTestDatabase } from "../helpers/db.mjs";

async function openDb(t) {
  const { db } = await openTestDatabase(t, { prefix: "owl-child-recovery-" });
  return db;
}

async function seedTask(db, status) {
  const workId = createUlid();
  const taskId = createUlid();
  const parentId = createUlid();
  const queuedId = createUlid();
  const runningId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Test Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Child recovery test', 'x', 'normal', ?, '{}', '[]', ?, ?)`,
      workId, status === "running" ? "running" : "completed", now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Child recovery task', 'code', ?, 'normal', '', 'Done.', ?, ?)`,
      taskId, workId, status, now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'claude', 'claude-sonnet-5', ?, ?, ?)`,
      parentId, workId, taskId, status === "running" ? "running" : "completed", now, now,
    );
    const insertChild = (id, seq, childStatus) => tx.run(
      `INSERT INTO child_runs
         (id, work_id, task_id, parent_agent_run_id, seq, title, instruction, write_paths_json, workspace_dir,
          provider, model, timeout_ms, max_attempts, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Child', 'Work', '["src"]', '/tmp/workspace', 'claude', 'claude-sonnet-5',
               60000, 2, ?, ?, ?, ?)`,
      id, workId, taskId, parentId, seq, childStatus, childStatus === "running" ? now : null, now, now,
    );
    insertChild(queuedId, 1, "queued");
    insertChild(runningId, 2, "running");
  });
  return { taskId, queuedId, runningId };
}

test("startup recovery cancels queued and running child runs as core_restart", async (t) => {
  const db = await openDb(t);
  const { queuedId, runningId } = await seedTask(db, "completed");

  await recoverOrphanedState(db);

  for (const id of [queuedId, runningId]) {
    const child = db.get("SELECT status, blocked_reason, failure_kind, failure_reason, finished_at FROM child_runs WHERE id = ?", id);
    assert.equal(child.status, "cancelled");
    assert.equal(child.blocked_reason, null);
    assert.equal(child.failure_kind, "core_restart");
    assert.equal(child.failure_reason, "Core restarted before the child finished.");
    assert.ok(child.finished_at);
  }
});

test("Task cancellation cancels its queued and running child runs", async (t) => {
  const db = await openDb(t);
  const { taskId, queuedId, runningId } = await seedTask(db, "running");

  await db.createWriteLane().transact((tx) => {
    reduceTaskInTransaction(tx, taskId, { event: "work.cancelled", payload: { owner_cancel: true } });
  });

  for (const id of [queuedId, runningId]) {
    const child = db.get("SELECT status, blocked_reason, failure_kind, failure_reason, finished_at FROM child_runs WHERE id = ?", id);
    assert.equal(child.status, "cancelled");
    assert.equal(child.blocked_reason, null);
    assert.equal(child.failure_kind, "cancelled");
    assert.equal(child.failure_reason, "Task was cancelled.");
    assert.ok(child.finished_at);
  }
});
