import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { WorkflowEngine } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a Task whose worktree conflicts with the Work branch fails alone while the Work keeps launching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-worktree-sync-conflict-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const workId = createUlid();
  const conflictedId = createUlid();
  const otherId = createUlid();
  const createdAt = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", "owner:sync-conflict", createdAt, createdAt);
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json,
        related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:sync-conflict', 'Work', '', 'normal', 'running', ?, '[]', ?, ?)`,
      workId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), createdAt, createdAt,
    );
    for (const [id, status] of [[conflictedId, "review_fix_waiting"], [otherId, "ready"]]) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
         VALUES (?, ?, 'Task', 'code', ?, 'normal', '', '', ?, ?)`,
        id, workId, status, createdAt, createdAt,
      );
    }
  });

  const replans = [];
  const workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "provider_failed:network", retry_allowed: true, message: "ECONNRESET" }),
    },
    git: {
      prepareWorktree: async ({ task_id }) => task_id === conflictedId
        ? {
          ok: false,
          exit_code: 1,
          recorded: false,
          failure_kind: "work_sync_conflict",
          message: "Task worktree conflicts with the Work branch: Auto-merging src/types.ts\nCONFLICT (content): Merge conflict in src/types.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
        }
        : { ok: true, exit_code: 0, recorded: false, message: "prepared" },
    },
    onManagerReplanNeeded: async (input) => { replans.push(input); },
  });
  t.after(async () => {
    await workflow.stop();
    db.close();
  });
  workflow.start();

  assert.deepEqual(await workflow.launchReady(workId), [otherId]);
  await workflow.drainPipelines();

  const conflicted = db.get("SELECT status, last_failure_class, last_error_key, failure_count FROM tasks WHERE id = ?", conflictedId);
  assert.equal(conflicted.status, "failed");
  assert.equal(conflicted.last_failure_class, "deterministic");
  assert.notEqual(conflicted.last_error_key, null);
  assert.equal(conflicted.failure_count, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");

  const event = db.get("SELECT payload_json FROM events WHERE task_id = ? AND type = 'task.conflict'", conflictedId);
  assert.deepEqual(JSON.parse(event.payload_json).merge_conflict_files, ["src/types.ts"]);
  assert.equal(replans.length, 1);
  assert.deepEqual(replans[0].failed_task_ids, [conflictedId]);
  assert.match(replans[0].reason, /could not be brought up to date with the Work branch .*src\/types\.ts/u);
});
