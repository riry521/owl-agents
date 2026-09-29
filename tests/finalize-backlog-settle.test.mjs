import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

// The Final Manager sees the Work's in_progress backlog items and names the
// unaddressed ones; on completion those return to the backlog, the rest are done.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function envelope(payload, suffix) {
  return { request_id: createUlid(), idempotency_key: `test:${suffix}:${createUlid()}`, expected_version: 0, payload };
}

/** A Work whose only Task is completed, with `count` in_progress items issued to it. */
async function setup(t, verdictFor, count) {
  const root = await mkdtemp(join(tmpdir(), "owl-finalize-backlog-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const requests = [];
  const core = new Core({
    db,
    agentRunner: {
      runManagerPlan: async (request) => {
        if (request.mode !== "finalize") return { outcome: "failed", message: "unexpected" };
        requests.push(request);
        return { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: verdictFor(request) } };
      },
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
    },
    version: "test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  const create = async (title) => (await core.createWork(envelope({ title, summary: "x", size: "normal", project_id: null }, "create"))).data.work_id;
  const workId = await create("W");
  const sourceId = await create("source");
  const taskId = createUlid();
  const sourceTaskId = createUlid();
  const reviewId = createUlid();
  const now = new Date().toISOString();
  const ids = Array.from({ length: count }, (_, i) => `item-${String(i).padStart(4, "0")}`);
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count,
         review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'done', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    const runId = createUlid();
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'anthropic', 'm', 'completed', ?, ?)`,
      runId, workId, taskId, now, now,
    );
    tx.run(
      `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
       VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
      createUlid(), runId, JSON.stringify({ kind: "report", result: "success", work_done: "did it" }), "0".repeat(64), now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'T', 'code', 'completed', 'normal', '', '', ?, ?)`,
      sourceTaskId, sourceId, now, now,
    );
    tx.run("INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at) VALUES (?, ?, 0, 'pass', '[]', '{}', ?)", reviewId, sourceTaskId, now);
    ids.forEach((id, i) => tx.run(
      `INSERT INTO backlog_items (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion,
         status, issued_work_id, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 0, 'f.ts', ?, ?, '', 'fix it', 'in_progress', ?, ?, ?, ?)`,
      id, sourceId, sourceTaskId, reviewId, i + 1, `problem ${i}`, workId, `key-${i}`, now, now,
    ));
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  return { db, core, workId, sourceId, sourceTaskId, reviewId, ids, requests };
}

async function finalize({ core, workId }) {
  await core.start();
  await core.tick(workId);
}

const statuses = (db) => Object.fromEntries(db.all("SELECT id, status, issued_work_id FROM backlog_items").map((r) => [r.id, [r.status, r.issued_work_id]]));
const verdict = (extra = {}) => ({ verdict: "complete", summary: "done", missing: [], lessons: [], ...extra });

test("finalize input carries every in_progress item of the Work, beyond 500", async (t) => {
  const ctx = await setup(t, () => verdict(), 501);
  await finalize(ctx);
  const items = ctx.requests[0].context.backlog_items;
  assert.equal(items.length, 501);
  assert.deepEqual(Object.keys(items[0]), ["id", "file", "line", "problem", "suggestion"]);
  assert.deepEqual(items.map((item) => item.id), ctx.ids);
});

test("complete: unaddressed items return to open, others are done, unknown ids are ignored", async (t) => {
  const ctx = await setup(t, () => verdict({ unaddressed_backlog_items: [
    { item_id: "item-0001", reason: "not touched" }, { item_id: "unknown", reason: "?" }, { item_id: 7 },
  ] }), 3);
  await finalize(ctx);
  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", ctx.workId).state, "completed");
  const rows = statuses(ctx.db);
  assert.deepEqual(rows["item-0001"], ["open", null]);
  assert.deepEqual(rows["item-0000"], ["done", ctx.workId]);
  assert.deepEqual(rows["item-0002"], ["done", ctx.workId]);
});

test("complete: an unaddressed item whose finding is already open is dismissed", async (t) => {
  const ctx = await setup(t, () => verdict({ unaddressed_backlog_items: [{ item_id: "item-0000", reason: "not touched" }] }), 1);
  const now = new Date().toISOString();
  const otherTaskId = createUlid();
  await ctx.db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'T2', 'code', 'completed', 'normal', '', '', ?, ?)`,
      otherTaskId, ctx.sourceId, now, now,
    );
    tx.run(
      `INSERT INTO backlog_items (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion,
         status, issued_work_id, dedupe_key, created_at, updated_at)
       VALUES ('dup-open', ?, ?, NULL, ?, 0, 'f.ts', 1, 'problem 0', '', '', 'open', NULL, 'key-0', ?, ?)`,
      ctx.sourceId, otherTaskId, ctx.reviewId, now, now,
    );
    return null;
  });
  await finalize(ctx);
  const rows = statuses(ctx.db);
  assert.deepEqual(rows["item-0000"], ["dismissed", null]);
  assert.deepEqual(rows["dup-open"], ["open", null]);
});

test("incomplete verdict leaves the items in_progress", async (t) => {
  const ctx = await setup(t, () => verdict({
    verdict: "incomplete",
    missing: [{ item: "x", reason: "y", fix: "z" }],
    unaddressed_backlog_items: [{ item_id: "item-0000", reason: "r" }],
  }), 2);
  await finalize(ctx);
  assert.notEqual(ctx.db.get("SELECT state FROM works WHERE id = ?", ctx.workId).state, "completed");
  assert.deepEqual(statuses(ctx.db), { "item-0000": ["in_progress", ctx.workId], "item-0001": ["in_progress", ctx.workId] });
});

test("a verdict without unaddressed_backlog_items still completes and marks the items done", async (t) => {
  const ctx = await setup(t, () => verdict(), 2);
  await finalize(ctx);
  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", ctx.workId).state, "completed");
  assert.deepEqual(statuses(ctx.db), { "item-0000": ["done", ctx.workId], "item-0001": ["done", ctx.workId] });
});
