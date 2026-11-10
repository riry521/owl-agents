import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid, openDatabase } from "../../packages/db/dist/index.js";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const now = "2026-01-01T00:00:00.000Z";
const SUFFIX = "_move_manager_triggers_out_of_idempotency_keys.sql";

test("the Manager trigger migration moves only valid manager-trigger rows into manager_replan_triggers", async (t) => {
  const root = await tempDir(t, "owl-manager-trigger-migration-");
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: the test applies only the early migrations first
  t.after(() => db.close());
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  const target = files.find((name) => name.endsWith(SUFFIX));
  assert.ok(target, "the migration is found by its name suffix");
  const early = join(root, "early");
  await mkdir(early);
  for (const name of files.filter((name) => name < target)) await copyFile(join(migrations, name), join(early, name));
  db.migrate(early);

  const ownerId = createUlid();
  const workId = createUlid();
  const task = { queued: createUlid(), attempted: createUlid(), noStatus: createUlid(), otherStatus: createUlid(), notObject: createUlid() };
  const orphanTaskId = createUlid();
  const put = (tx, key, body) => tx.run(
    `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, '9999-12-31T23:59:59.999Z')`,
    key, "0".repeat(64), JSON.stringify(body), now,
  );
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'o', ?, ?)", ownerId, now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, ?, NULL, 'Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      workId, ownerId, now, now,
    );
    for (const id of Object.values(task)) {
      tx.run(
        `INSERT INTO tasks
           (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count,
            review_round, worker_generation, created_at, updated_at, retry_no)
         VALUES (?, ?, 'T', 'code', 'failed', 'normal', '', 'x', 0, 0, 0, 0, 0, ?, ?, 0)`,
        id, workId, now, now,
      );
    }
    put(tx, `manager-trigger:${task.queued}`, { task_id: task.queued, event: "task.failed", status: "queued", question: "why?", question_only: true });
    put(tx, `manager-trigger:${task.attempted}`, { status: "attempted", question: null, budget_recovery: true, partial_recovery: true });
    put(tx, `manager-trigger:${task.noStatus}`, { event: "task.failed" });
    put(tx, `manager-trigger:${task.otherStatus}`, { status: "done" });
    put(tx, `manager-trigger:${task.notObject}`, "queued");
    put(tx, `manager-trigger:${orphanTaskId}`, { status: "queued" });
    put(tx, `owner-replan:${workId}`, { status: "queued", kind: "decision", answer: "a" });
    put(tx, `design-completed:${task.queued}`, { task_id: task.queued });
    put(tx, `paused-reviewer-wait:${task.queued}`, { task_id: task.queued, provider: "codex" });
    put(tx, `work.resume_or_retry:${workId}`, { ok: true });
    put(tx, `http-idempotency:POST:/works`, { ok: true });
    return null;
  });

  await copyFile(join(migrations, target), join(early, target));
  db.migrate(early);

  assert.deepEqual(db.all("SELECT * FROM manager_replan_triggers ORDER BY task_id").map(({ task_id, ...rest }) => ({ ...rest, which: Object.keys(task).find((k) => task[k] === task_id) })).sort((a, b) => a.which.localeCompare(b.which)), [
    { status: "attempted", question: null, question_only: 0, budget_recovery: 1, partial_recovery: 1, created_at: now, updated_at: now, which: "attempted" },
    { status: "queued", question: "why?", question_only: 1, budget_recovery: 0, partial_recovery: 0, created_at: now, updated_at: now, which: "queued" },
  ], "queued and attempted triggers move with their question and flags; malformed and ownerless rows do not");

  assert.equal(db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key LIKE 'manager-trigger:%'").n, 0, "every manager-trigger row leaves idempotency_keys");
  assert.deepEqual(
    db.all("SELECT key FROM idempotency_keys ORDER BY key").map((row) => row.key.split(":")[0]),
    ["design-completed", "http-idempotency", "owner-replan", "paused-reviewer-wait", "work.resume_or_retry"],
    "other markers and command records stay",
  );

  await db.createWriteLane().transact((tx) => {
    tx.run("DELETE FROM tasks WHERE work_id = ?", workId);
    tx.run("DELETE FROM works WHERE id = ?", workId);
    return null;
  });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM manager_replan_triggers").n, 0, "deleting the Work removes its triggers");
});
