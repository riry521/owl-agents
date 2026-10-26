import assert from "node:assert/strict";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { command, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { openTestRunCore, plannedTask, workerReport as testRunWorkerReport } from "../helpers/test-run-core.mjs";

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

// An instruction stops the running Agents, confirms they ended, then replans.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envelope = (payload, suffix, expectedVersion = 0) => command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
const workVersion = (db, workId) => db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
const planTask = { id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false };
const workerReport = (invocationId) => ({
  kind: "report", schema_version: "1.0.0", invocation_id: invocationId, result: "success", work_done: "Done.", changes: [],
  verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
});

// `stops: false` makes cancelAgent a no-op, so a stopped Worker never ends until `release()`.
function stopRunner({ stops = true, replanReport, replanGate } = {}) {
  const state = { log: [], replans: 0, workerCalls: 0, cancels: [], hung: [], managerSignals: [], replanContexts: [] };
  const release = () => { for (const end of state.hung.splice(0)) end(); };
  return {
    state,
    release,
    cancelAgent: async (agentRunId, force) => {
      state.cancels.push({ agentRunId, force, at: Date.now() });
      state.log.push("cancel");
      if (stops) release();
    },
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask] } };
      if (mode === "replan") {
        state.replans += 1;
        state.log.push("replan");
        state.managerSignals.push(request.signal ?? null);
        state.replanContexts.push(request.context);
        await replanGate?.(state);
        return { outcome: "success", report_valid: true, report: replanReport?.(state) ?? { event: "task.replanned", tasks: [] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      state.log.push("worker-start");
      if (state.workerCalls === 1) {
        await new Promise((end) => state.hung.push(end));
        state.log.push("worker-end");
      }
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function openRunning(t, runner, coreOptions = {}) {
  const { db, core } = await createTestCore(t, { agentRunner: runner, dispatcher: { tick_interval_ms: 25 }, ...coreOptions }, { prefix: "owl-instruction-stop-", start: true });
  await disablePlanQuality(db);
  await core.setAutoRecoverySettings({ limit: 0 });
  const created = await core.createWork(envelope({ title: "W", summary: "Stop on instruction.", size: "normal", project_id: null }, "create"));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, "start", created.version));
  await waitFor(() => runner.state.workerCalls === 1, { message: "the Worker to start" });
  return { db, core, workId: created.data.work_id, taskId: db.get("SELECT id FROM tasks WHERE work_id = ?", created.data.work_id).id };
}

const instruct = (core, db, workId, body, suffix) => core.postWorkInstruction(workId, envelope({ body }, suffix, workVersion(db, workId)));

test("an instruction stops the Worker, then the Manager replans, then the Task starts again", async (t) => {
  const r = stopRunner();
  const { db, core, workId, taskId } = await openRunning(t, r);
  const workerRun = db.get("SELECT id FROM agent_runs WHERE task_id = ? AND role = 'worker'", taskId).id;

  await instruct(core, db, workId, "Change course", "order");
  await waitFor(() => r.state.workerCalls === 2, { message: "the Task to start again" });

  assert.deepEqual(r.state.log, ["worker-start", "cancel", "worker-end", "replan", "worker-start"]);
  assert.equal(r.state.cancels[0].agentRunId, workerRun, "only the Worker run is signalled");
  assert.equal(r.state.cancels.length, 1, "the Manager run gets no cancel");
  assert.deepEqual(r.state.managerSignals, [null], "the Manager call carries no signal");
  assert.equal(db.get("SELECT failure_count FROM tasks WHERE id = ?", taskId).failure_count, 0);
});

test("when the Manager leaves the Task the same id restarts in the same worktree", async (t) => {
  const r = stopRunner();
  const { db, core, workId, taskId } = await openRunning(t, r);
  const before = db.get("SELECT worktree_path FROM tasks WHERE id = ?", taskId).worktree_path;
  await instruct(core, db, workId, "Keep going", "keep");
  await waitFor(() => r.state.workerCalls === 2);
  const task = db.get("SELECT id, worktree_path, failure_count, same_error_count FROM tasks WHERE work_id = ?", workId);
  assert.deepEqual({ ...task }, { id: taskId, worktree_path: before, failure_count: 0, same_error_count: 0 });
});

test("the replan request lists the stopped Task, and the Manager can revise it in place", async (t) => {
  const revised = { ...planTask, title: "A, narrowed", acceptance: "Done differently; verified by the test." };
  const r = stopRunner({ replanReport: () => ({ event: "task.replanned", tasks: [revised] }) });
  const { db, core, workId, taskId } = await openRunning(t, r);
  const columns = "worktree_path, failure_count, same_error_count, retry_no, lineage_generation";
  const before = { ...db.get(`SELECT ${columns} FROM tasks WHERE id = ?`, taskId) };
  await instruct(core, db, workId, "Narrow it", "revise");
  await waitFor(() => r.state.workerCalls === 2, { message: "the revised Task to start" });
  assert.deepEqual(r.state.replanContexts[0].stopped_task_ids, [taskId]);
  const task = db.get(`SELECT id, title, acceptance, ${columns} FROM tasks WHERE work_id = ?`, workId);
  assert.deepEqual({ id: task.id, title: task.title, acceptance: task.acceptance }, { id: taskId, title: revised.title, acceptance: revised.acceptance });
  assert.deepEqual({ ...db.get(`SELECT ${columns} FROM tasks WHERE id = ?`, taskId) }, before);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.revised'", taskId).n, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.replanned'", taskId).n, 0, "a revision is not a retry");
});

test("a replan that is not an Owner instruction carries no stopped_task_ids", async (t) => {
  const r = stopRunner();
  const { db, core, workId, taskId } = await openRunning(t, r);
  await core.triggerManagerReplan(workId, [taskId], { kind: "queued_failed_tasks" });
  const replan = r.state.replanContexts.find((context) => context.owner_replan_kind === null);
  assert.ok(replan, "a replan was requested");
  assert.equal("stopped_task_ids" in replan, false);
});

test("when the Manager replaces the Task the original is cancelled and the new one starts", async (t) => {
  let originalId = "";
  const r = stopRunner({ replanReport: () => ({ event: "task.replanned", tasks: [{ ...planTask, id: "N1", replaces: [originalId] }] }) });
  const { db, core, workId, taskId } = await openRunning(t, r);
  originalId = taskId;
  await instruct(core, db, workId, "Do it another way", "replace");
  await waitFor(() => r.state.workerCalls === 2, { message: "the replacement to start" });
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "cancelled");
  assert.equal(db.get("SELECT failure_count FROM tasks WHERE id = ?", taskId).failure_count, 0);
  const next = db.get("SELECT id, status, failure_count FROM tasks WHERE work_id = ? AND id != ?", workId, taskId);
  assert.notEqual(next.status, "cancelled");
  assert.equal(next.failure_count, 0);
});

test("the replan waits until a stopped Worker has ended", async (t) => {
  const r = stopRunner({ stops: false });
  const { db, core, workId } = await openRunning(t, r);
  await instruct(core, db, workId, "Wait for the stop", "wait");
  await sleep(300);
  assert.equal(r.state.replans, 0, "no replan while the stopped run is alive");
  r.release();
  await waitFor(() => r.state.replans === 1, { message: "the replan after the run ended" });
});

test("the triggerManagerReplan entrance defers while a stopped run is alive", async (t) => {
  const r = stopRunner({ stops: false });
  const { db, core, workId, taskId } = await openRunning(t, r);
  await instruct(core, db, workId, "Entrance", "entrance");
  await core.triggerManagerReplan(workId, [taskId], { kind: "task_failed" });
  await sleep(200);
  assert.equal(r.state.replans, 0, "the entrance did not start a replan");
  r.release();
  await waitFor(() => r.state.replans === 1);
});

test("an instruction during the Manager call discards that plan and replans again", async (t) => {
  let second = false;
  const r = stopRunner({
    replanReport: (state) => (state.replans === 1 ? { event: "task.replanned", tasks: [{ ...planTask, id: "N1" }] } : { event: "task.replanned", tasks: [] }),
    replanGate: async (state) => { if (state.replans === 1) await waitFor(() => second); },
  });
  const { db, core, workId } = await openRunning(t, r);
  await instruct(core, db, workId, "First", "first");
  await waitFor(() => r.state.replans === 1);
  await instruct(core, db, workId, "Second", "second");
  second = true;
  await waitFor(() => r.state.replans === 2, { message: "the second replan" });
  await waitFor(() => marker(db, workId) === null, { message: "the marker to be consumed" });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE manager_task_id = 'N1'").n, 0, "the first plan was not applied");
});

test("a stopped run that never ends gets a forced stop, then an alert and a waiting Work", async (t) => {
  const r = stopRunner({ stops: false });
  const { db, core, workId, taskId } = await openRunning(t, r, { agentStopWaitMs: 40 });
  // A real runner records its process; this one's pid is the test process, which stays alive.
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE agent_runs SET status = 'running', pid = ? WHERE task_id = ? AND role = 'worker'", process.pid, taskId);
  });
  await instruct(core, db, workId, "Never stops", "stuck");
  await waitFor(() => r.state.cancels.some((c) => c.force === true), { message: "a forced stop" });
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting", { message: "judgement_waiting" });
  const alert = db.all("SELECT payload_json, created_at FROM events WHERE work_id = ? AND type = 'system.alert'", workId).find((row) => JSON.parse(row.payload_json).kind === "owner_stop_unconfirmed");
  assert.ok(alert, "owner_stop_unconfirmed was recorded");
  // The stop's own escalation sends the first forced stop; the bound resends it once before the alert.
  const forcedBeforeAlert = r.state.cancels.filter((c) => c.force === true && c.at <= Date.parse(alert.created_at));
  assert.equal(forcedBeforeAlert.length, 2, "the forced stop is resent once before the alert");
  await sleep(200);
  assert.equal(r.state.replans, 0);
  assert.equal(marker(db, workId).status, "queued");

  // While the process lives, the Decision keeps the replan back; once it has ended, the Decision is cleared and the replan runs.
  assert.equal(r.state.replans, 0, "no replan while the process is alive");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  r.release();
  await waitFor(() => db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND status = 'cancel_requested'", taskId).n === 0, { message: "the stopped run to end" });
  await waitFor(() => r.state.replans === 1, { message: "the replan after the run ended" });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 0, "the Decision was cleared");
});

test("clearing the unconfirmed-stop Decision leaves another open retry Decision for the Owner", async (t) => {
  const r = stopRunner({ stops: false });
  const { db, core, workId, taskId } = await openRunning(t, r, { agentStopWaitMs: 40 });
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE agent_runs SET status = 'running', pid = ? WHERE task_id = ? AND role = 'worker'", process.pid, taskId);
  });
  await instruct(core, db, workId, "Never stops", "stuck-other");
  // Opened before the stop Decision, so it comes first in id order.
  const otherId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state,
          options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'task', 'open', '[]', 'other', 'Retry the other Task?', '', 'judgement_waiting', ?, 'retry', 1, 'core', 0, ?)`,
      otherId, workId, JSON.stringify([{ key: "retry", label: "Retry" }]), new Date().toISOString(),
    );
  });
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting", { message: "judgement_waiting" });
  const stopId = db.get("SELECT id FROM decisions WHERE work_id = ? AND status = 'open' AND id <> ?", workId, otherId).id;

  r.release();
  await waitFor(() => db.get("SELECT status FROM decisions WHERE id = ?", stopId).status === "resolved", { message: "the stop Decision to be cleared" });
  await sleep(200);
  assert.equal(db.get("SELECT status FROM decisions WHERE id = ?", otherId).status, "open", "the other Decision was not answered");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decision_answers WHERE decision_id = ?", otherId).n, 0);
});

test("resuming from the unconfirmed-stop Decision waits the full bound again before the next Decision", async (t) => {
  const r = stopRunner({ stops: false });
  const { db, core, workId, taskId } = await openRunning(t, r, { agentStopWaitMs: 40 });
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE agent_runs SET status = 'running', pid = ? WHERE task_id = ? AND role = 'worker'", process.pid, taskId);
  });
  const stopAlerts = () => db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).filter((row) => JSON.parse(row.payload_json).kind === "owner_stop_unconfirmed").length;
  await instruct(core, db, workId, "Never stops", "stuck-again");
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting", { message: "judgement_waiting" });
  // Longer than twice the bound (2 × 3 × 40 ms), so time counted during the Decision would raise the next one at once.
  await sleep(300);

  const resumedAt = Date.now();
  await core.resumeWorkOrRetryDecision(workId, envelope({}, "resume-still-alive", workVersion(db, workId)));
  await sleep(120);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running", "no Decision right after the resume");
  assert.equal(stopAlerts(), 1);

  await waitFor(() => stopAlerts() === 2, { message: "the next Decision after the bound" });
  assert.ok(Date.now() - resumedAt >= 240, "the next Decision waits twice the bound from the resume");
  assert.equal(r.state.replans, 0);
  assert.equal(marker(db, workId).status, "queued");
  r.release();
});

test("pausing during a replan puts the marker back to queued", async (t) => {
  let hold = true;
  const r = stopRunner({ replanGate: async () => { await waitFor(() => !hold); } });
  const { db, core, workId } = await openRunning(t, r);
  await instruct(core, db, workId, "Pause me", "pause-replan");
  await waitFor(() => marker(db, workId)?.status === "attempted");
  await core.pauseWork(workId, envelope({ reason: "pause" }, "pause", workVersion(db, workId)));
  hold = false;
  await waitFor(() => marker(db, workId)?.status === "queued", { message: "the marker to return to queued" });
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");
});

test("a failed replan opens a Decision and lifts the launch hold", async (t) => {
  const r = stopRunner();
  const inner = r.runManagerPlan;
  r.runManagerPlan = async (request) => {
    if ((request.mode ?? request.context?.mode) === "replan") { r.state.replans += 1; return { outcome: "failed", message: "replan failed" }; }
    return inner(request);
  };
  const { db, core, workId } = await openRunning(t, r);
  await instruct(core, db, workId, "Will fail", "fail");
  await waitFor(() => db.get("SELECT 1 AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId), { message: "an open Decision" });
  assert.equal(core.ownerInstructionPending(workId), false, "the launch hold is lifted");
});

test("an instruction to a paused Work queues the replan and does not replan until resume", async (t) => {
  const r = stopRunner();
  const { db, core, workId } = await openRunning(t, r);
  await core.pauseWork(workId, envelope({ reason: "pause" }, "pause2", workVersion(db, workId)));
  await instruct(core, db, workId, "While paused", "paused");
  assert.equal(marker(db, workId).status, "queued");
  await sleep(200);
  assert.equal(r.state.replans, 0, "no replan while paused");
});

test("an instruction stops a verifying Task whose real command is still running, then replans", async (t) => {
  const r = stopRunner();
  r.runWorker = async (request) => { r.state.workerCalls += 1; return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) }; };
  const { root, db, core } = await createTestCore(t, { agentRunner: r, agentStopWaitMs: 100, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-instruction-verify-", start: true });
  await disablePlanQuality(db);
  const project = join(root, "project");
  await mkdir(project);
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const markerFile = join(root, "verify-stopped.marker");
  const readyFile = join(root, "verify-ready.marker");
  const plan = [{
    command_id: "trap-check",
    argv: ["sh", "-c", `trap 'touch ${markerFile}; exit 143' TERM; touch ${readyFile}; sleep 60 & wait`],
    cwd: ".", env_allowlist: [], timeout_seconds: 120, stdout_limit: 1_024, stderr_limit: 1_024, expected_exit_codes: [0], executor: "core",
  }];
  const registered = await core.createProject(envelope({ name: "P", canonical_path: project, base_branch: "main", allowed_roots: [root], verification_plan: plan }, "project"));
  const created = await core.createWork(envelope({ title: "W", summary: "Verify slowly.", size: "small", project_id: registered.data.id }, "vcreate"));
  await core.startWork(created.data.work_id, envelope({ mode: "small" }, "vstart", created.version));
  await waitFor(() => stat(readyFile).then(() => true, () => false), { message: "the command to install its trap" });
  const workId = created.data.work_id;
  assert.equal(db.get("SELECT status FROM tasks WHERE work_id = ?", workId).status, "verifying");

  let markerAtReplan = null;
  const inner = r.runManagerPlan;
  r.runManagerPlan = async (request) => {
    if ((request.mode ?? request.context?.mode) === "replan") markerAtReplan = await stat(markerFile).then(() => true, () => false);
    return inner(request);
  };
  await instruct(core, db, workId, "Stop verifying", "verify");
  await waitFor(() => markerAtReplan !== null, { message: "the replan" });
  assert.equal(markerAtReplan, true, "the command had ended and written its marker before the replan");
  assert.equal(core.workflow.verificationChildren.size, 0);
  assert.equal(db.get("SELECT failure_count FROM tasks WHERE work_id = ?", workId).failure_count, 0);
  assert.equal(await readFile(markerFile, "utf8"), "");
});

test("a Task stopped during Core's test run is not investigated, so no unconfirmed-stop Decision is raised", async (t) => {
  const gate = { release: null };
  const investigations = [];
  let replans = 0;
  const run = async () => {
    await new Promise((end) => { gate.release = end; });
    return { exit_code: 127, timed_out: false, stdout: "", stderr: "node: command not found\n", duration_ms: 1 };
  };
  const agentRunner = {
    cancelAgent: async () => {},
    runManagerPlan: async (request) => ((request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } }
      : (replans += 1, { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [] } })),
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "src/a.mjs"), "export const a = 2;\n");
      return { outcome: "success", report_valid: true, report: testRunWorkerReport(request.invocation_id, ["src/a.mjs"]) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
    // Never returns: it stands for the Agent outside agent_runs that kept the stopped pipeline pending.
    runTestSetupInvestigation: (request) => { if (request.trigger === "environment_failure") investigations.push(request); return new Promise(() => {}); },
  };
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-instruction-env-stop-" });
  const created = await ctx.core.createWork(ctx.envelope({ title: "W", summary: "x", size: "normal", project_id: ctx.projectId }, "work"));
  await ctx.core.startWork(created.data.work_id, { ...ctx.envelope({ mode: "normal" }, "start"), expected_version: created.version });
  const workId = created.data.work_id;
  await waitFor(() => gate.release !== null, { message: "Core test run to start" });

  await instruct(ctx.core, ctx.db, workId, "Stop testing", "env-stop");
  // The run ends as a broken environment only after the Task was stopped.
  gate.release();
  // The replan starts only once the stopped pipeline has ended.
  await waitFor(() => replans === 1, { message: "the replan" });
  assert.equal(investigations.length, 0, "a stopped Task is not investigated");
  const stopAlerts = ctx.db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).filter((row) => JSON.parse(row.payload_json).kind === "owner_stop_unconfirmed");
  assert.equal(stopAlerts.length, 0);
});

test("a Task stopped while its environment is being investigated has the investigation cancelled, then the Work replans", async (t) => {
  const investigations = [];
  const cancelled = [];
  let endInvestigation = null;
  let replans = 0;
  const run = async () => ({ exit_code: 127, timed_out: false, stdout: "", stderr: "node: command not found\n", duration_ms: 1 });
  const agentRunner = {
    cancelAgent: async (invocationId) => { cancelled.push(invocationId); endInvestigation?.(); },
    runManagerPlan: async (request) => ((request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } }
      : (replans += 1, { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [] } })),
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "src/a.mjs"), "export const a = 2;\n");
      return { outcome: "success", report_valid: true, report: testRunWorkerReport(request.invocation_id, ["src/a.mjs"]) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
    // Ends only when the runner is told to cancel it, as a real investigation Agent does.
    runTestSetupInvestigation: (request) => {
      if (request.trigger !== "environment_failure") return new Promise(() => {});
      investigations.push(request.invocation_id);
      return new Promise((end) => { endInvestigation = () => end({ ok: false, error: "cancelled", invocation_id: request.invocation_id }); });
    },
  };
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-instruction-env-cancel-" });
  const created = await ctx.core.createWork(ctx.envelope({ title: "W", summary: "x", size: "normal", project_id: ctx.projectId }, "work"));
  await ctx.core.startWork(created.data.work_id, { ...ctx.envelope({ mode: "normal" }, "start"), expected_version: created.version });
  const workId = created.data.work_id;
  await waitFor(() => investigations.length === 1, { message: "the investigation to start" });

  await instruct(ctx.core, ctx.db, workId, "Stop investigating", "env-cancel");
  await waitFor(() => replans === 1, { message: "the replan" });
  assert.deepEqual(cancelled, investigations, "the running investigation was cancelled");
  assert.equal(investigations.length, 1, "no new investigation after the stop");
  assert.equal(ctx.db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).filter((row) => JSON.parse(row.payload_json).kind === "owner_stop_unconfirmed").length, 0);
});

// T1 asks for a replan (so it fails) while T2 runs; `stops: false` leaves T2 alive after the stop signal.
function raceRunner({ stops, replanGate, replanTitles }) {
  const state = { replans: 0, requests: [], hung: [], t1Fail: null };
  // A replan has to retry or replace the failed T1; retrying keeps its id.
  const retryT1 = (title) => ({ event: "task.replanned", tasks: [{ ...planTask, id: "T1", title }] });
  const release = () => { for (const end of state.hung.splice(0)) end(); };
  return {
    state,
    release,
    cancelAgent: async () => { if (stops) release(); },
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask, { ...planTask, id: "T2", title: "B" }] } };
      const call = state.replans += 1;
      state.requests.push(JSON.stringify(request));
      await replanGate?.(call);
      return { outcome: "success", report_valid: true, report: call > (replanTitles?.length ?? 1) ? { event: "task.replanned", tasks: [] } : retryT1(replanTitles?.[call - 1] ?? "Retried") };
    },
    runWorker: async (request) => {
      const manager = state.db.get("SELECT manager_task_id FROM tasks WHERE id = ?", request.task_id)?.manager_task_id;
      if (manager === "T1") {
        await new Promise((end) => { state.t1Fail = end; });
        return { outcome: "success", report_valid: true, report: { ...workerReport(request.invocation_id), needs_replanning: true, question_for_manager: "T1 needs a new plan" } };
      }
      await new Promise((end) => state.hung.push(end));
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function openRace(t, runner) {
  const { db, core } = await createTestCore(t, { agentRunner: runner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-instruction-race-", start: true });
  runner.state.db = db;
  await disablePlanQuality(db);
  await core.setAutoRecoverySettings({ limit: 0 });
  const created = await core.createWork(envelope({ title: "W", summary: "Race.", size: "normal", project_id: null }, "create"));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, "start", created.version));
  await waitFor(() => runner.state.t1Fail !== null && runner.state.hung.length === 1, { message: "both Workers to start" });
  return { db, core, workId: created.data.work_id };
}

test("an instruction between a Task's failure and its replan request holds the replan until the stopped run ends", async (t) => {
  const r = raceRunner({ stops: false });
  const { db, core, workId } = await openRace(t, r);
  // Hold the request that follows T1's failure record so the instruction lands in the gap.
  let reached = () => {};
  const entered = new Promise((resolve) => { reached = resolve; });
  let proceed = () => {};
  const hold = new Promise((resolve) => { proceed = resolve; });
  const original = core.triggerManagerReplan.bind(core);
  core.triggerManagerReplan = async (...args) => { reached(); await hold; return original(...args); };

  r.state.t1Fail();
  await entered;
  await instruct(core, db, workId, "Gap instruction", "gap");
  proceed();
  await sleep(300);
  assert.equal(r.state.replans, 0, "no replan while T2's stopped run is alive");
  r.release();
  await waitFor(() => r.state.replans >= 1, { message: "the replan after T2 ended" });
  assertFailureAndInstruction(r.state.requests[0], "Gap instruction");
});

// The failure and the instruction reach the Manager in one request, so no plan is applied without the instruction.
function assertFailureAndInstruction(request, instruction) {
  const context = JSON.parse(request).context;
  assert.match(JSON.stringify(context), /T1 needs a new plan/, "the failure is in the request");
  assert.ok(context.owner_requests.some((entry) => entry.text.includes(instruction)), "the instruction is in owner_requests of the same request");
}

test("an instruction during the Manager call for a failure discards that plan and sends both to the next replan", async (t) => {
  let second = false;
  const r = raceRunner({
    stops: true,
    replanTitles: ["Discarded plan", "Applied plan"],
    replanGate: async (call) => { if (call === 1) await waitFor(() => second); },
  });
  const { db, core, workId } = await openRace(t, r);
  r.state.t1Fail();
  await waitFor(() => r.state.replans === 1, { message: "the failure replan to start" });
  await instruct(core, db, workId, "Mid-call instruction", "mid");
  second = true;
  await waitFor(() => r.state.replans >= 2, { message: "the second replan" });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Discarded plan'").n, 0, "the first plan was not applied");
  await waitFor(() => db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Applied plan'").n === 1, { message: "the second plan to be applied" });
  assertFailureAndInstruction(r.state.requests[1], "Mid-call instruction");
});
