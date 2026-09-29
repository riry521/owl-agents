import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("the Advisor system prompt does not change when review backlog items are added", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-prompt-stability-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();

  const before = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.match(before, /GET \/api\/v1\/backlog \(status=open\)/);
  assert.match(before, /backlog_item_ids/);

  const workId = (await core.createWork({
    request_id: createUlid(),
    idempotency_key: "advisor-prompt-stability:work",
    expected_version: 0,
    payload: { title: "Source Work", summary: "", size: "small", project_id: null },
  })).data.work_id;
  const now = "2026-09-27T00:00:00.000Z";
  const taskId = createUlid();
  const reviewId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, created_at, updated_at)
       VALUES (?, ?, 'Task', 'code', 'completed', 'normal', '', '', '/repo', ?, ?)`,
      taskId, workId, now, now,
    );
    tx.run(
      `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
       VALUES (?, ?, 0, 'pass', '[]', '{}', ?)`,
      reviewId, taskId, now,
    );
    tx.run(
      `INSERT INTO backlog_items (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion, status, issued_work_id, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 0, 'f.ts', 0, 'p', '', '', 'open', NULL, 'stability-key', ?, ?)`,
      createUlid(), workId, taskId, reviewId, now, now,
    );
  });
  assert.equal(db.get("SELECT COUNT(*) AS count FROM backlog_items WHERE status = 'open'").count, 1);

  assert.equal(core.getAdvisorSettingsSnapshot().systemPrompt, before);
});
