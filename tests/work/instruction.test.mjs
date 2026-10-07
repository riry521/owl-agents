import assert from "node:assert/strict";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";

async function setup(t) {
  const { db, core } = await createTestCore(t, { version: "work-instruction-test", dispatcher: { tick_interval_ms: 60_000 } }, { prefix: "owl-work-instruction-" });
  return { db, core };
}

async function createWorkInState(core, db, state, suffix) {
  const created = await core.createWork(command({ title: `Work ${suffix}`, summary: "", size: "small", project_id: null }, `create:${suffix}`));
  const id = created.data.work_id;
  const now = "2020-01-01T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = ?, state_version = 1, updated_at = ? WHERE id = ?", state, now, id);
  });
  return id;
}

function marker(db, workId) {
  const row = db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`);
  return row ? JSON.parse(row.response_json) : null;
}

test("an instruction on a running Work records the message and queues an owner replan", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "running");
  assert.equal(core.getWork(workId).data.conversation_id, null);

  const response = await core.postWorkInstruction(workId, command({ body: "Add tests" }, "running", 1));
  assert.equal(response.data.status, "queued");
  assert.equal(response.data.work_id, workId);
  assert.equal(core.getWork(workId).data.conversation_id, response.data.conversation_id);
  const message = db.get("SELECT conversation_id, body FROM messages WHERE id = ?", response.data.message_id);
  assert.deepEqual({ ...message }, { conversation_id: response.data.conversation_id, body: "Add tests" });
  const queued = marker(db, workId);
  assert.equal(queued.kind, "instruction");
  assert.equal(queued.status, "queued");
  assert.equal(queued.answer, "Add tests");

  const replay = await core.postWorkInstruction(workId, command({ body: "Add tests" }, "running", 1));
  assert.equal(replay.data.message_id, response.data.message_id);

  const second = await core.postWorkInstruction(workId, command({ body: "And docs" }, "second", 1));
  assert.equal(second.data.conversation_id, response.data.conversation_id);
  assert.equal(marker(db, workId).answer, "Add tests\n\nAnd docs");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", response.data.conversation_id).n, 2);
});

test("an instruction keeps a pending decision answer", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "paused", "pending");
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, ?, 202, ?, ?)`,
      `owner-replan:${workId}`, "0".repeat(64),
      JSON.stringify({ work_id: workId, status: "queued", kind: "decision", answer: "Retry it" }),
      "2020-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z",
    );
  });
  await core.postWorkInstruction(workId, command({ body: "Also this" }, "pending", 1));
  const queued = marker(db, workId);
  assert.equal(queued.kind, "instruction");
  assert.equal(queued.answer, "Retry it\n\nAlso this");
});

test("a blank instruction is rejected", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "blank");
  await assert.rejects(
    core.postWorkInstruction(workId, command({ body: "   " }, "blank", 1)),
    (error) => error.code === "validation_error",
  );
  assert.equal(marker(db, workId), null);
});

test("an instruction to a Work that has not started is rejected", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "ready", "ready");
  await assert.rejects(
    core.postWorkInstruction(workId, command({ body: "Go" }, "ready", 1)),
    (error) => error.code === "invalid_state_transition",
  );
  assert.equal(db.get("SELECT COUNT(*) AS n FROM conversations WHERE work_id = ?", workId).n, 0);
});

test("a completed Work needs reopen to take an instruction", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "completed", "completed");
  await assert.rejects(
    core.postWorkInstruction(workId, command({ body: "More" }, "no-reopen", 1)),
    (error) => error.code === "work_reopen_required",
  );
  assert.equal(core.getWork(workId).data.state, "completed");
  assert.equal(marker(db, workId), null);

  const response = await core.postWorkInstruction(workId, command({ body: "More", reopen: true }, "reopen", 1));
  assert.equal(response.data.status, "queued");
  assert.equal(core.getWork(workId).data.state, "running");
  const queued = marker(db, workId);
  assert.equal(queued.kind, "instruction");
  assert.equal(queued.answer, "More");
});

test("a cancelled Work does not take instructions", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "cancelled", "cancelled");
  await assert.rejects(
    core.postWorkInstruction(workId, command({ body: "More", reopen: true }, "cancelled", 1)),
    (error) => error.code === "work_cancelled",
  );
  assert.equal(core.getWork(workId).data.state, "cancelled");
  assert.equal(marker(db, workId), null);
});

test("the database allows one active web conversation per Work", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "unique");
  const first = await core.postWorkInstruction(workId, command({ body: "One" }, "unique", 1));
  const owner = db.get("SELECT owner_id FROM works WHERE id = ?", workId).owner_id;
  const now = new Date().toISOString();
  await assert.rejects(db.createWriteLane().transact((transaction) => {
    transaction.run(
      "INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, ?, ?, 'web', 1, ?, ?)",
      createUlid(), owner, workId, now, now,
    );
  }));
  assert.equal(core.getWork(workId).data.conversation_id, first.data.conversation_id);
});

test("a completed Work reopens with its current state version", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "completed", "versioned");
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state_version = 5 WHERE id = ?", workId);
  });
  await assert.rejects(
    core.postWorkInstruction(workId, command({ body: "More", reopen: true }, "stale", 0)),
    (error) => error.code === "version_conflict",
  );
  await core.postWorkInstruction(workId, command({ body: "More", reopen: true }, "current", 5));
  assert.equal(core.getWork(workId).data.state, "running");
  assert.equal(core.getWork(workId).data.state_version, 6);
});

test("a Work conversation does not become the active Advisor conversation", async (t) => {
  const { db, core } = await setup(t);
  const advisor = await core.getActiveConversation();
  const workId = await createWorkInState(core, db, "running", "advisor");
  const posted = await core.postWorkInstruction(workId, command({ body: "Hello" }, "advisor", 1));
  assert.notEqual(posted.data.conversation_id, advisor.conversation_id);
  assert.equal((await core.getActiveConversation()).conversation_id, advisor.conversation_id);
});

test("an instruction to a judgement_waiting Work resolves its open Decision, resumes the blocked Task and returns the Work to running", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "judgement_waiting", "waiting");
  const taskId = createUlid();
  const decisionId = createUlid();
  const now = "2020-01-01T00:00:00.000Z";
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'blocked', 'research', 'judgement_waiting', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'task', 'open', ?, 'stuck', 'Core', 'judgement_waiting', '[]', NULL, 0, 'core', 0, ?)`,
      decisionId, workId, JSON.stringify([taskId]), now,
    );
    return null;
  });

  await core.postWorkInstruction(workId, command({ body: "Go another way" }, "waiting", 1));
  assert.equal(db.get("SELECT status FROM decisions WHERE id = ?", decisionId).status, "resolved");
  assert.equal(JSON.parse(db.get("SELECT answer_json FROM decision_answers WHERE decision_id = ?", decisionId).answer_json).answer, "Go another way");
  assert.equal(db.all("SELECT payload_json FROM events WHERE type = 'decision.resolved'").some((row) => JSON.parse(row.payload_json).decision_id === decisionId), true);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.notEqual(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "judgement_waiting");
  assert.equal(marker(db, workId).kind, "instruction");

  // A running Work with no open Decision is unchanged.
  const runningId = await createWorkInState(core, db, "running", "plain");
  await core.postWorkInstruction(runningId, command({ body: "Add tests" }, "plain", 1));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", runningId).state, "running");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", runningId).n, 0);
});
