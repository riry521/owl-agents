import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { WorkflowEngine } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a Task can become ready again after replanning adds a dependency", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-ready-again-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  t.after(() => db.close());
  const workId = createUlid();
  const taskId = createUlid();
  const dependencyId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", "owner:ready-again", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json,
        related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:ready-again', 'Work', '', 'normal', 'running', ?, '[]', ?, ?)`,
      workId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), now, now,
    );
    for (const [id, status] of [[taskId, "waiting"], [dependencyId, "waiting"]]) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
         VALUES (?, ?, 'Task', 'doc', ?, 'normal', '', '', ?, ?)`,
        id, workId, status, now, now,
      );
    }
  });
  const workflow = new WorkflowEngine({ db, agentRunner: {} });

  assert.deepEqual(await workflow.resolveDependencies(workId), [taskId, dependencyId]);
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'waiting', state_version = state_version + 1 WHERE id = ?", taskId);
    tx.run("UPDATE tasks SET status = 'running', state_version = state_version + 1 WHERE id = ?", dependencyId);
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", taskId, dependencyId);
  });
  assert.deepEqual(await workflow.resolveDependencies(workId), []);
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'completed', state_version = state_version + 1 WHERE id = ?", dependencyId);
  });

  assert.deepEqual(await workflow.resolveDependencies(workId), [taskId]);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type = 'task.ready'", taskId).count, 2);
});
