import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A Manager replan started by an Owner request may rewrite the Work title/summary;
// the change and its history row commit with the plan.

const envelope = (payload, suffix, expectedVersion = 0) => ({
  request_id: createUlid(),
  idempotency_key: `instruction-status:${suffix}:${createUlid()}`,
  expected_version: expectedVersion,
  payload,
});

const task = (id, title) => ({ id, title, type: "code", acceptance: "Done.", depends_on: [], context: "", notes: "", review: null, required_sections: [], required_tests: [], replaces: [] });

/** A Core whose Manager answers every replan with `answer(core, workId)`; Workers never run. */
async function setup(t, answer) {
  const ref = { core: null, workId: null, finalPrompts: [] };  const agent = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        if (prompt.includes("final review of a Work")) ref.finalPrompts.push(prompt);
        const out = prompt.includes("This is a REPLAN") ? await answer(ref) : "not json";
        return { adapter: request.adapter, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const { root, db, core } = await createTestCore(t, {
    agentRunner: { ...agent, runWorker: () => new Promise(() => {}) },
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-instruction-status-" });
  ref.core = core;
  const created = await core.createWork(envelope({ title: "W", summary: "OLD summary", size: "normal", project_id: null }, "create"));
  ref.workId = created.data.work_id;
  return { db, core, ref, root };
}

/** A running Work whose only Task is completed, so the next tick consumes an Owner replan. */
async function seedCompletedTask(db, workId) {
  const now = new Date().toISOString();
  const run = createUlid();
  const taskId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count,
         same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'first', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'anthropic', 'm', 'completed', ?, ?)`,
      run, workId, taskId, now, now,
    );
    tx.run(
      `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
       VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
      createUlid(), run, JSON.stringify({ kind: "report", result: "success", work_done: "did T1" }), "0".repeat(64), now,
    );
    tx.run("UPDATE works SET state = 'paused', state_version = 1 WHERE id = ?", workId);
    return null;
  });
}


async function postWhilePaused(core, db, ref, body) {
  await seedCompletedTask(db, ref.workId);
  const posted = await core.postWorkInstruction(ref.workId, envelope({ body }, "post", 1));
  return posted.data.message_id;
}

async function resume(core, db, workId) {
  const version = db.get("SELECT state_version AS v FROM works WHERE id = ?", workId).v;
  await core.start();
  await core.resumeWork(workId, envelope({}, "resume", version));
}

const revisions = (db, workId) => db.all("SELECT * FROM work_summary_revisions WHERE work_id = ?", workId);
const workRow = (db, workId) => db.get("SELECT title, summary, state_version FROM works WHERE id = ?", workId);
const markerKey = (workId) => `owner-replan:${workId}`;
const markerGone = (db, workId) => !db.get("SELECT 1 FROM idempotency_keys WHERE key = ?", markerKey(workId));

async function runInstruction(t, answer, body = "Add acceptance criteria") {
  const ctx = await setup(t, answer);
  const messageId = await postWhilePaused(ctx.core, ctx.db, ctx.ref, body);
  await resume(ctx.core, ctx.db, ctx.ref.workId);
  await waitFor(() => markerGone(ctx.db, ctx.ref.workId));
  return { ...ctx, messageId };
}

test("an instruction that adds acceptance criteria updates the summary and records history", async (t) => {
  const { db, core, ref, messageId } = await runInstruction(t, () => ({ tasks: [], updated_summary: "NEW summary with criteria", skills_used: [] }));
  const row = workRow(db, ref.workId);
  assert.equal(row.summary, "NEW summary with criteria");
  assert.equal(row.title, "W");
  const [rev] = revisions(db, ref.workId);
  assert.equal(rev.actor, "manager");
  assert.equal(db.get("SELECT role FROM agent_runs WHERE id = ?", rev.agent_run_id).role, "manager");
  assert.equal(rev.trigger_kind, "instruction");
  assert.deepEqual(JSON.parse(rev.trigger_message_ids_json), [messageId]);
  assert.equal(rev.trigger_text, "Add acceptance criteria");
  assert.deepEqual([rev.summary_before, rev.summary_after], ["OLD summary", "NEW summary with criteria"]);
  assert.ok(markerGone(db, ref.workId), "no work_update replan was queued");

  const history = core.listWorkSummaryRevisions(ref.workId);
  assert.equal(history.truncated, false);
  assert.equal(history.revisions.length, 1);
  assert.deepEqual(history.revisions[0].changed_fields, ["summary"]);
  assert.deepEqual(history.revisions[0].before, { title: "W", summary: "OLD summary" });
  assert.deepEqual(history.revisions[0].after, { title: "W", summary: "NEW summary with criteria" });
  assert.equal(history.revisions[0].trigger.kind, "instruction");
  assert.equal(history.revisions[0].agent_run_id, rev.agent_run_id);
  assert.throws(() => core.listWorkSummaryRevisions(createUlid()), /not found/i);
});

test("an instruction unrelated to the summary (fields omitted or null) changes nothing", async (t) => {
  for (const answer of [{ tasks: [] }, { tasks: [], updated_title: null, updated_summary: null }]) {
    const { db, ref } = await runInstruction(t, () => answer);
    assert.equal(workRow(db, ref.workId).summary, "OLD summary");
    assert.equal(revisions(db, ref.workId).length, 0);
  }
});

test("a title-only update is recorded as a title change", async (t) => {
  const { db, ref } = await runInstruction(t, () => ({ tasks: [], updated_title: "W2" }));
  assert.deepEqual(JSON.parse(revisions(db, ref.workId)[0].changed_fields_json), ["title"]);
  assert.equal(workRow(db, ref.workId).title, "W2");
});

test("a reopen request updates the summary", async (t) => {
  const { db, core, ref } = await setup(t, () => ({ tasks: [], updated_summary: "REOPENED summary", skills_used: [] }));
  await seedCompletedTask(db, ref.workId);
  await db.createWriteLane().transact((tx) => { tx.run("UPDATE works SET state = 'completed' WHERE id = ?", ref.workId); return null; });
  await core.start();
  const version = db.get("SELECT state_version AS v FROM works WHERE id = ?", ref.workId).v;
  await core.reopenWork(ref.workId, envelope({ reason: "Also cover edge cases" }, "reopen", version));
  await waitFor(() => revisions(db, ref.workId).length > 0);
  const [rev] = revisions(db, ref.workId);
  assert.equal(rev.trigger_kind, "reopen");
  assert.match(rev.trigger_text, /Also cover edge cases/);
  assert.equal(workRow(db, ref.workId).summary, "REOPENED summary");
});

test("an answer to a Decision updates the summary", async (t) => {
  let answered = false;
  const { db, core, ref } = await setup(t, () => (answered ? { tasks: [], updated_summary: "DECIDED summary", skills_used: [] } : "not json"));
  await seedCompletedTask(db, ref.workId);
  await db.createWriteLane().transact((tx) => { tx.run("UPDATE works SET state = 'running' WHERE id = ?", ref.workId); return null; });
  await core.start();
  // An unparsable Manager answer opens a Decision through the public replan path.
  await core.triggerManagerReplan(ref.workId, [], { kind: "queued_failed_tasks" }, [{ task_id: "T1", question: "retry" }]);
  const decision = await waitFor(() => db.get("SELECT id, state_version FROM decisions WHERE work_id = ? AND status = 'open'", ref.workId));
  assert.ok(decision, "a Decision was opened");
  answered = true;
  await core.answerDecision(decision.id, envelope({ answer: "Use option B", option_key: null, source_message_id: null }, "answer", decision.state_version));
  await waitFor(() => revisions(db, ref.workId).length > 0);
  const [rev] = revisions(db, ref.workId);
  assert.equal(rev.trigger_kind, "decision");
  assert.equal(rev.trigger_text, "Use option B");
  assert.equal(db.get("SELECT role FROM agent_runs WHERE id = ?", rev.agent_run_id).role, "manager");
  assert.equal(rev.summary_before, "OLD summary");
  assert.equal(workRow(db, ref.workId).summary, "DECIDED summary");
});

test("a work_update replan does not let the Manager rewrite the summary", async (t) => {
  const { db, core, ref } = await setup(t, () => ({ tasks: [], updated_summary: "MGR summary", skills_used: [] }));
  await seedCompletedTask(db, ref.workId);
  await core.updateWork(ref.workId, envelope({ summary: "OWNER summary" }, "update", 1));
  await resume(core, db, ref.workId);
  await waitFor(() => markerGone(db, ref.workId));
  assert.equal(workRow(db, ref.workId).summary, "OWNER summary");
  assert.deepEqual(revisions(db, ref.workId).map((r) => r.actor), ["owner"]);
});

test("the final check receives the updated summary", async (t) => {
  const { db, ref } = await runInstruction(t, () => ({ tasks: [], updated_summary: "FRESH summary text", skills_used: [] }));
  const prompt = await waitFor(() => ref.finalPrompts.at(-1));
  assert.ok(prompt, "the final Manager ran");
  assert.match(prompt, /FRESH summary text/);
  assert.doesNotMatch(prompt, /OLD summary/);
  assert.equal(revisions(db, ref.workId).length, 1);
});
