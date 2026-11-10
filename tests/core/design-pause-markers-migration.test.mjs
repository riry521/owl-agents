import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid, openDatabase } from "../../packages/db/dist/index.js";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const now = "2026-01-01T00:00:00.000Z";
const SUFFIX = "_move_design_and_pause_markers_out_of_idempotency_keys.sql";

test("the design and pause migration moves only valid design-completed and paused-reviewer-wait rows", async (t) => {
  const root = await tempDir(t, "owl-design-pause-migration-");
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
  const task = { design: createUlid(), waiting: createUlid(), emptyProvider: createUlid(), mismatch: createUlid() };
  const orphanId = createUlid();
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
         VALUES (?, ?, 'T', 'code', 'verifying', 'normal', '', 'x', 0, 0, 0, 0, 0, ?, ?, 0)`,
        id, workId, now, now,
      );
    }
    put(tx, `design-completed:${task.design}`, { task_id: task.design });
    put(tx, `design-completed:${orphanId}`, { task_id: orphanId });
    put(tx, `paused-reviewer-wait:${task.waiting}`, { task_id: task.waiting, provider: "anthropic" });
    put(tx, `paused-reviewer-wait:${task.emptyProvider}`, { task_id: task.emptyProvider, provider: "" });
    put(tx, `paused-reviewer-wait:${task.mismatch}`, { task_id: createUlid(), provider: "openai" });
    put(tx, `paused-reviewer-wait:${orphanId}`, { task_id: orphanId, provider: "openai" });
    put(tx, `manager-trigger:${task.design}`, { status: "queued" });
    put(tx, `owner-replan:${workId}`, { status: "queued", kind: "decision", answer: "a" });
    put(tx, `work.resume_or_retry:${workId}`, { ok: true });
    put(tx, "http-idempotency:POST:/works", { ok: true });
    return null;
  });

  await copyFile(join(migrations, target), join(early, target));
  db.migrate(early);

  assert.deepEqual(db.all("SELECT task_id, handed_at FROM design_handoffs"), [{ task_id: task.design, handed_at: now }], "the design marker moves with handed_at = created_at");
  assert.deepEqual(db.all("SELECT * FROM paused_reviewer_waits"), [{ task_id: task.waiting, provider: "anthropic", recorded_at: now }], "only a wait with a provider and a matching task_id moves");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key LIKE 'design-completed:%' OR key LIKE 'paused-reviewer-wait:%'").n, 0, "every moved or rejected row leaves idempotency_keys");
  assert.deepEqual(
    db.all("SELECT key FROM idempotency_keys ORDER BY key").map((row) => row.key.split(":")[0]),
    ["http-idempotency", "manager-trigger", "owner-replan", "work.resume_or_retry"],
    "other markers and command records stay",
  );

  await db.createWriteLane().transact((tx) => {
    tx.run("DELETE FROM tasks WHERE work_id = ?", workId);
    tx.run("DELETE FROM works WHERE id = ?", workId);
    return null;
  });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM design_handoffs").n + db.get("SELECT COUNT(*) AS n FROM paused_reviewer_waits").n, 0, "deleting the Work removes its rows");
});
