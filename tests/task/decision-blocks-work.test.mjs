import assert from "node:assert/strict";
import { test } from "node:test";

import { createCore } from "../../packages/core/dist/index.js";
import { openDecisionInTransaction, reduceTaskInTransaction } from "../../packages/core/dist/state-reducer.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { openTestDatabase } from "../helpers/db.mjs";

// A Task-scope Decision that leaves no Task able to move puts the Work in
// judgement_waiting; answering it (or resume_work) returns the Work to running.

async function setup(t, others) {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-task-decision-work-" });
  const fail = async () => ({ outcome: "failed" });
  const core = createCore({
    db, version: "t", owlRoot: root, dataDir: root,
    agentRunner: { runManagerPlan: fail, runWorker: fail, runReviewer: fail, runAdvisor: fail },
  });
  t.after(async () => {
    await core.stop({ force: true }).catch(() => {});
  });
  const lane = db.createWriteLane();
  const now = new Date().toISOString();
  await lane.transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W', 'owner:default', NULL, 'W', 'x', 'normal', 'running', '[]', '[]', ?, ?)`,
      now, now,
    );
    const task = (id, status) => tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count,
         review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, 'W', ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
      id, id, status, now, now, id,
    );
    task("T1", "running");
    for (const [id, status] of others) task(id, status);
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('T2', 'T1')");
  });
  const failT1 = () => lane.transact((tx) => reduceTaskInTransaction(tx, "T1", {
    event: "task.failure.classified",
    payload: { failure_class: "deterministic", error_key: "provider_failed:exit:1", retry_allowed: false },
  }));
  const state = (table, id) => db.get(`SELECT ${table === "works" ? "state" : "status"} AS s FROM ${table} WHERE id = ?`, id).s;
  return { db, core, failT1, state };
}

const envelope = (expectedVersion, payload) => ({
  request_id: createUlid(), idempotency_key: `t:${createUlid()}`, expected_version: expectedVersion, payload,
});

test("no Task can move: Work waits for judgement, retry answer resumes both", async (t) => {
  const { db, core, failT1, state } = await setup(t, [["T2", "waiting"]]);
  await failT1();
  const decision = db.get("SELECT id, scope, state_version, options_json FROM decisions WHERE work_id = 'W' AND status = 'open'");
  assert.equal(decision.scope, "task");
  assert.equal(state("tasks", "T1"), "judgement_waiting");
  assert.equal(state("works", "W"), "judgement_waiting");

  const label = JSON.parse(decision.options_json).find((o) => o.key === "retry").label;
  await core.answerDecision(decision.id, envelope(decision.state_version, { answer: label, option_key: "retry", source: "web", source_message_id: null }));
  assert.equal(state("tasks", "T1"), "ready");
  assert.equal(state("works", "W"), "running");
});

test("another Task can still move: Work stays running", async (t) => {
  const { failT1, state } = await setup(t, [["T2", "waiting"], ["T3", "ready"]]);
  await failT1();
  assert.equal(state("tasks", "T1"), "judgement_waiting");
  assert.equal(state("works", "W"), "running");
});

test("resume_work answers the Task-scope retry Decision of a judgement_waiting Work", async (t) => {
  const { db, core, failT1, state } = await setup(t, [["T2", "waiting"]]);
  await failT1();
  const work = db.get("SELECT state_version FROM works WHERE id = 'W'");
  await core.resumeWorkOrRetryDecision("W", envelope(work.state_version, { source: "advisor" }));
  assert.equal(state("works", "W"), "running");
  assert.equal(state("tasks", "T1"), "ready");
});

const managerDecision = (lane) => lane.transact((tx) => openDecisionInTransaction(tx, {
  work_id: "W", scope: "task", blocked_task_ids: ["T1"], reason: "r", question: "q", tried: "t", current_state: "c",
  options: [{ key: "retry", label: "もう一度実行する", description: "d" }], recommended: "retry", allow_free_text: false, issuer_role: "manager",
}));

test("Manager-opened Task Decision also puts the Work in judgement_waiting", async (t) => {
  const { db, state } = await setup(t, [["T2", "waiting"]]);
  await managerDecision(db.createWriteLane());
  assert.equal(state("tasks", "T1"), "judgement_waiting");
  assert.equal(state("works", "W"), "judgement_waiting");
});

test("answer that leaves only dependency-waiting Tasks keeps the Work in judgement_waiting", async (t) => {
  const { db, core, state } = await setup(t, [["T2", "waiting"]]);
  const lane = db.createWriteLane();
  await lane.transact((tx) => tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('T1', 'T2')"));
  const d = await managerDecision(lane);
  assert.equal(state("works", "W"), "judgement_waiting");
  await core.answerDecision(d.id, envelope(0, { answer: "もう一度実行する", option_key: "retry", source: "web", source_message_id: null }));
  assert.equal(state("tasks", "T1"), "waiting");
  assert.equal(state("works", "W"), "judgement_waiting");
});

test("a Decision opened while T3 still ran blocks the Work once T3 completes; events record both changes", async (t) => {
  const { db, core, failT1, state } = await setup(t, [["T2", "waiting"], ["T3", "verifying"]]);
  await failT1();
  assert.equal(state("works", "W"), "running");
  const events = (type) => db.all("SELECT payload_json FROM events WHERE work_id = 'W' AND type = ?", type).map((e) => JSON.parse(e.payload_json));

  await db.createWriteLane().transact((tx) => reduceTaskInTransaction(tx, "T3", { event: "verification.completed", payload: { outcome: "pass", review_required: false } }));
  assert.equal(state("tasks", "T3"), "completed");
  assert.equal(state("works", "W"), "judgement_waiting");
  const decision = db.get("SELECT id, state_version, options_json FROM decisions WHERE work_id = 'W' AND status = 'open'");
  const blocked = events("work.judgement_waiting_by_task_decision");
  assert.equal(blocked.length, 1);
  assert.deepEqual([blocked[0].from, blocked[0].to], ["running", "judgement_waiting"]);
  assert.ok(blocked[0].reason.includes(decision.id));

  const label = JSON.parse(decision.options_json).find((o) => o.key === "retry").label;
  await core.answerDecision(decision.id, envelope(decision.state_version, { answer: label, option_key: "retry", source: "web", source_message_id: null }));
  assert.equal(state("tasks", "T1"), "ready");
  assert.equal(state("works", "W"), "running");
  const resumed = events("work.running_by_task_decision");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].decision_id, decision.id);
});
