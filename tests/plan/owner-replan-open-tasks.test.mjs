import assert from "node:assert/strict";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_REMAKE_LIMIT_SETTINGS } from "../../packages/shared/dist/remake-limit-settings.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";

// An Owner instruction reaches the Manager at the next tick even while Tasks
// are still running or blocked, and a retry answer to a remake-limit Decision
// goes to the Manager instead of starting the same Worker again.

const envelope = (payload, suffix, expectedVersion = 0) => command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const workerReport = (invocationId) => ({
  kind: "report", schema_version: "1.0.0", invocation_id: invocationId, result: "success", work_done: "Done.", changes: [],
  verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
});
const planTask = { id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false };
const marker = (db, workId) => JSON.parse(db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`)?.response_json ?? "null");
const workVersion = (db, workId) => db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;

async function openCore(t, agentRunner, settings) {
  const { db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-owner-replan-", start: true });
  await disablePlanQuality(db);
  if (settings) await core.setRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, ...settings });
  return { db, core };
}

async function startWork(core) {
  const created = await core.createWork(envelope({ title: "W", summary: "Owner replan.", size: "normal", project_id: null }, "create"));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, "start", created.version));
  return created.data.work_id;
}

function runner({ workerHangs, onReplan, replanGate, replanReport }) {
  const state = { replans: 0, workerCalls: 0 };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask] } };
      if (mode === "replan") {
        state.replans += 1;
        onReplan?.(state);
        await replanGate;
        return { outcome: "success", report_valid: true, report: replanReport?.() ?? { event: "task.replanned", tasks: [] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      if (workerHangs) await new Promise(() => {});
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
}

const LIMIT = { lineage_worker_runs: 1, lineage_review_attempts: 1000, non_functional_remakes: 100 };

test("an instruction on a Work with a running Task reaches the Manager at the next tick", async (t) => {
  let release;
  const r = runner({ workerHangs: true, replanGate: new Promise((resolve) => { release = resolve; }) });
  const { db, core } = await openCore(t, r);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => r.state.workerCalls === 1), "the Worker is running");

  await core.postWorkInstruction(workId, envelope({ body: "Also add docs" }, "instruction", workVersion(db, workId)));

  assert.ok(await waitFor(() => r.state.replans === 1), "the Manager replanned");
  assert.equal(marker(db, workId).status, "attempted", "the marker moved from queued to attempted");
  release();
  assert.ok(await waitFor(() => marker(db, workId) === null), "the Manager's answer consumed the marker");
  assert.equal(db.get("SELECT status FROM tasks WHERE work_id = ?", workId).status, "running", "the running Task was not stopped");
});

test("an instruction on a Work stopped at a limit closes the Decision and starts the Manager, not the Worker", async (t) => {
  let callsAtReplan = null;
  const r = runner({ onReplan: (state) => { callsAtReplan ??= state.workerCalls; } });
  const { db, core } = await openCore(t, r, LIMIT);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting"), "the Work waits for the Owner");
  await sleep(200);
  const callsBefore = r.state.workerCalls;
  assert.equal(r.state.replans, 0);

  await core.postWorkInstruction(workId, envelope({ body: "Change approach" }, "instruction", workVersion(db, workId)));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running", "the instruction resumed the Work");
  assert.equal(db.get("SELECT status FROM decisions WHERE work_id = ?", workId).status, "resolved", "the instruction closed the Decision");

  assert.ok(await waitFor(() => r.state.replans >= 1), "the Manager replanned");
  assert.equal(callsAtReplan, callsBefore, "no Worker started before the Manager");
  assert.ok(await waitFor(() => marker(db, workId)?.status === "attempted"));
});

test("retry on a Work stopped at a limit, with no instruction, also goes to the Manager", async (t) => {
  const r = runner({});
  const { db, core } = await openCore(t, r, LIMIT);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting"));
  await sleep(200);
  const callsBefore = r.state.workerCalls;

  await core.resumeWorkOrRetryDecision(workId, envelope({}, "retry", workVersion(db, workId)));
  assert.ok(await waitFor(() => r.state.replans >= 1), "the Manager replanned");
  assert.equal(r.state.workerCalls, callsBefore, "the same Task's Worker was not started again");
});

test("an instruction on a limit-stopped Work reaches the Manager without any resume", async (t) => {
  let workIdOf = "";
  // The instruction fails the Task the Decision held; the Manager retries it with a replacement.
  const r = runner({ replanReport: () => {
    const failed = db.get("SELECT id FROM tasks WHERE work_id = ? AND status = 'failed'", workIdOf);
    return { event: "task.replanned", tasks: failed ? [{ ...planTask, id: "N1", replaces: [failed.id] }] : [] };
  } });
  const { db, core } = await openCore(t, r, LIMIT);
  const workId = await startWork(core);
  workIdOf = workId;
  assert.ok(await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting"));
  await sleep(200);
  assert.equal(r.state.replans, 0);

  await core.postWorkInstruction(workId, envelope({ body: "Change approach" }, "instruction", workVersion(db, workId)));

  assert.ok(await waitFor(() => r.state.replans >= 1), "the Manager replanned without any resume");
  assert.ok(await waitFor(() => marker(db, workId) === null), "the marker was consumed");
  assert.ok(await waitFor(() => db.get("SELECT status FROM tasks WHERE work_id = ? AND status = 'failed'", workId) === undefined && db.get("SELECT 1 AS n FROM tasks WHERE work_id = ? AND id != ?", workId, db.get("SELECT id FROM tasks WHERE work_id = ? ORDER BY created_at, id LIMIT 1", workId).id)), "the replacement Task was applied");
  await sleep(300);
  assert.equal(r.state.replans, 1, "the Manager replanned once, not repeatedly");
});

test("the Manager can cancel a running Task after an Owner instruction", async (t) => {
  let taskIdOf = () => "";
  const r = runner({ workerHangs: true, replanReport: () => ({ event: "task.replanned", tasks: [], task_actions: [{ task_id: taskIdOf(), action: "cancel", reason: "Owner no longer needs it" }] }) });
  const { db, core } = await openCore(t, r);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => r.state.workerCalls === 1));
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ?", workId).id;
  taskIdOf = () => taskId;

  await core.postWorkInstruction(workId, envelope({ body: "Drop that Task" }, "instruction", workVersion(db, workId)));

  assert.ok(await waitFor(() => db.get("SELECT status FROM tasks WHERE id = ?", taskId).status === "cancelled"), "the open Task was cancelled");
});

test("two queued Owner instructions reach the marker as separate requests, each text whole", async (t) => {
  let release;
  const r = runner({ workerHangs: true, replanGate: new Promise((resolve) => { release = resolve; }) });
  const { db, core } = await openCore(t, r);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => r.state.workerCalls === 1));
  const first = "Add docs:\n- usage\n- install\n\n  indented line";
  await core.postWorkInstruction(workId, envelope({ body: first }, "instruction-1", workVersion(db, workId)));
  assert.ok(await waitFor(() => r.state.replans === 1), "the first instruction is being handled");
  // Two more arrive while it is handled: they queue together, the first stays beside them.
  const second = "Also rename the flag.";
  const third = "- keep\n- the\n- lists";
  await core.postWorkInstruction(workId, envelope({ body: second }, "instruction-2", workVersion(db, workId)));
  await core.postWorkInstruction(workId, envelope({ body: third }, "instruction-3", workVersion(db, workId)));

  const queued = marker(db, workId);
  assert.deepEqual(queued.requests.map((request) => [request.kind, request.text]), [["instruction", second], ["instruction", third]]);
  assert.deepEqual(queued.processing_requests.map((request) => request.text), [first]);
  release();
});
