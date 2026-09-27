import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

// A Decision that closes on its own — because its Work was cancelled, or
// because the Task it was blocking was superseded by a Manager replan —
// is announced as a decision.cancelled event exactly once, so a chat
// connector can tell the Owner the question no longer needs an answer.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}:${createUlid()}`,
    expected_version: expectedVersion,
    payload,
  };
}

async function openCore(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-decision-cancelled-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("this test drives the Work directly and never expects a Manager call"); },
    runWorker: async () => { throw new Error("this test drives the Work directly and never expects a Worker call"); },
    runReviewer: async () => { throw new Error("this test drives the Work directly and never expects a Reviewer call"); },
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, max_parallel: 4, dispatcher: { tick_interval_ms: 25 } });
  await core.start();
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  return { db, core };
}

/** Insert an open Decision directly, bypassing the workflow that would normally open one. */
function insertDecision(db, { workId, scope, blockedTaskIds }) {
  const decisionId = createUlid();
  db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried,
          current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, ?, 'open', ?, 'Test setup.', 'Test question.', 'Test tried.', 'Test state.', '[]', NULL, 1, 'core', 0, ?)`,
      decisionId, workId, scope, JSON.stringify(blockedTaskIds), new Date().toISOString(),
    );
    return null;
  });
  return decisionId;
}

function cancelledEvents(db, decisionId) {
  return db.all(
    "SELECT payload_json FROM events WHERE type = 'decision.cancelled' AND json_extract(payload_json, '$.decision_id') = ?",
    decisionId,
  ).map((row) => JSON.parse(row.payload_json));
}

test("cancelling a Work closes its open Decision and announces decision.cancelled exactly once", async (t) => {
  const { db, core } = await openCore(t);

  const created = await core.createWork(commandEnvelope({ title: "Cancel test", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const decisionId = insertDecision(db, { workId, scope: "work", blockedTaskIds: [] });

  await core.cancelWork(workId, commandEnvelope({ reason: "Owner cancelled the Work." }, "cancel", created.version));

  const decision = db.get("SELECT status FROM decisions WHERE id = ?", decisionId);
  assert.equal(decision.status, "cancelled");

  const events = cancelledEvents(db, decisionId);
  assert.equal(events.length, 1, "decision.cancelled is announced exactly once");
  assert.equal(events[0].work_id, workId);
  assert.equal(events[0].reason, "work_cancelled");

  // A retried announce (a startup backfill sweep, or a second call after a
  // crash before this session recorded the first one) must not duplicate it.
  await core.announceDecisionCancellations([decisionId]);
  await core.announceDecisionCancellations();
  assert.equal(cancelledEvents(db, decisionId).length, 1, "re-announcing an already-announced cancellation does not duplicate the event");
});

test("a Manager replan that supersedes a Task closes the Decision that only blocked it and announces decision.cancelled with a task_superseded reason", async (t) => {
  const { db, core } = await openCore(t);

  const created = await core.createWork(commandEnvelope({ title: "Supersede test", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const [t1] = await core.workflowEngine().registerPlan(workId, [
    { id: "T1", title: "T1 title", type: "research", acceptance: "Done.", depends_on: [], replaces: [], context: "", notes: "", review: false },
  ], "work.planned");

  const decisionId = insertDecision(db, { workId, scope: "task", blockedTaskIds: [t1.id] });

  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", t1.id);
    tx.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
    return null;
  });

  const work = db.get("SELECT plan_revision FROM works WHERE id = ?", workId);
  const plan = {
    newItems: [{ id: "N1", title: "Replacement", type: "research", acceptance: "Done.", manager_task_id: "N1", depends_on: [] }],
    revisions: new Map(),
    reopenIds: [],
    supersessions: new Map([[t1.id, ["N1"]]]),
  };
  const guard = {
    base_plan_revision: work.plan_revision,
    root_statuses: new Map([[t1.id, "failed"]]),
  };
  const applied = await core.workflowEngine().applyReplan(workId, plan, guard, "test supersede");

  assert.deepEqual(applied.cancelled_decision_ids, [decisionId], "the reducer surfaces the Decision it closed as a side effect");
  const decision = db.get("SELECT status FROM decisions WHERE id = ?", decisionId);
  assert.equal(decision.status, "cancelled");

  await core.announceDecisionCancellations(applied.cancelled_decision_ids);
  const events = cancelledEvents(db, decisionId);
  assert.equal(events.length, 1);
  assert.equal(events[0].work_id, workId);
  assert.equal(events[0].reason, "task_superseded");

  await core.announceDecisionCancellations([decisionId]);
  assert.equal(cancelledEvents(db, decisionId).length, 1, "re-announcing does not duplicate the event");
});
