import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import {
  DEFAULT_PROGRESS_GUARD_SETTINGS,
  PROGRESS_GUARD_RANGES,
  readProgressGuardSettings,
  validateProgressGuardSettings,
} from "../../packages/shared/dist/progress-guard-settings.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A Task whose Worker keeps asking the Manager a question (a prerequisite is
// missing) must not loop forever: after progress_guard.no_progress_limit
// consecutive results without progress Core starts neither the Worker nor the
// Manager again and the Work waits for the Owner.

const QUESTION = "The file page-format.ts does not exist yet; wait for it to land on main?";

const envelope = (payload, suffix, expectedVersion = 0) => command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workerReport = (invocationId, question) => ({
  kind: "report",
  schema_version: "1.0.0",
  invocation_id: invocationId,
  result: question ? "partial" : "success",
  work_done: "Done.",
  changes: [],
  verification: { passed: true, method: "Checked." },
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: question ?? null,
});

const planTask = () => ({ id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false });

/** Every Worker run asks QUESTION until `succeedAfter` runs have happened; the Manager retries T1. */
function questionRunner({ succeedAfter = Infinity } = {}) {
  const state = { workerCalls: 0, replans: 0 };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        state.replans += 1;
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask()] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      const question = state.workerCalls > succeedAfter ? null : QUESTION;
      if (question === null) {
        await mkdir(join(request.context.worktree, "src"), { recursive: true });
        await writeFile(join(request.context.worktree, "src/feature.mjs"), "export const f = 1;\n");
      }
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, question) };
    },
    runReviewer: async () => {
      const review = { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function openCore(t, runner, limit) {
  const { db, core } = await createTestCore(t, { agentRunner: withNecessity(runner), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-no-progress-" });
  await core.start();
  if (limit !== undefined) await core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: limit });
  return { db, core };
}

async function startWork(core, suffix) {
  const created = await core.createWork(envelope({ title: suffix, summary: "Exercise the no-progress limit.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

const workState = (db, workId) => db.get("SELECT state FROM works WHERE id = ?", workId)?.state;
const task = (db, workId) => db.get("SELECT id, status, no_progress_count FROM tasks WHERE work_id = ?", workId);

test("default settings are validated and read per key", () => {
  assert.equal(DEFAULT_PROGRESS_GUARD_SETTINGS.no_progress_limit, 3);
  const { min, max } = PROGRESS_GUARD_RANGES.no_progress_limit;
  for (const bad of [min - 1, max + 1, 1.5, "3", null]) {
    assert.throws(() => validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: bad }), /no_progress_limit/);
  }
  assert.throws(() => validateProgressGuardSettings({}), /exactly/);
  assert.throws(() => validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, extra: 1 }), /exactly/);
  assert.deepEqual(validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: max }), { ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: max });
  const warnings = [];
  assert.deepEqual(readProgressGuardSettings({ no_progress_limit: 0 }, (m) => warnings.push(m)), DEFAULT_PROGRESS_GUARD_SETTINGS);
  assert.equal(warnings.length, 1);
});

test("repeated questions stop at the default limit: Worker and Manager stop, the Work waits with the reason", async (t) => {
  const runner = questionRunner();
  const { db, core } = await openCore(t, runner);
  const workId = await startWork(core, "default-limit");
  const limit = DEFAULT_PROGRESS_GUARD_SETTINGS.no_progress_limit;

  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `the Work waits (state=${workState(db, workId)})`);
  await sleep(300); // a regression would keep launching
  assert.ok(runner.state.workerCalls <= limit, `Worker launches ${runner.state.workerCalls} <= ${limit}`);
  assert.ok(runner.state.replans <= limit - 1, `Manager replans ${runner.state.replans} <= ${limit - 1}`);
  assert.equal(runner.state.workerCalls, limit);
  assert.equal(task(db, workId).status, "judgement_waiting");

  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision, "an Owner Decision is open");
  const text = JSON.stringify(decision);
  assert.ok(text.includes(task(db, workId).id), "the Decision names the Task id");
  assert.ok(text.includes(`${limit}`), "the Decision states the count");
  assert.ok(text.includes("page-format.ts"), "the Decision carries the last question");

  const event = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.no_progress_limited'", workId);
  assert.ok(event, "task.no_progress_limited was recorded");
  const payload = JSON.parse(event.payload_json);
  assert.equal(payload.count, limit);
  assert.equal(payload.limit, limit);
  assert.equal(payload.last_question, QUESTION);
  assert.ok(payload.reason.includes(task(db, workId).id));
});

test("changing the setting changes how many results are allowed", async (t) => {
  for (const limit of [2, 5]) {
    const runner = questionRunner();
    const { db, core } = await openCore(t, runner, limit);
    const workId = await startWork(core, `limit-${limit}`);
    assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `limit ${limit}: the Work waits`);
    await sleep(200);
    assert.equal(runner.state.workerCalls, limit, `limit ${limit}: Worker launches`);
    assert.equal(runner.state.replans, limit - 1, `limit ${limit}: Manager replans`);
  }
});

test("a successful result resets the count", async (t) => {
  // Two questions (count 2 of 3), then the Worker succeeds and the Task completes with count 0.
  const runner = questionRunner({ succeedAfter: 2 });
  const { db, core } = await openCore(t, runner, 3);
  const workId = await startWork(core, "success-resets");
  assert.ok(await waitFor(() => task(db, workId)?.status === "completed"), `the Task completes (status=${task(db, workId)?.status})`);
  assert.equal(task(db, workId).no_progress_count, 0);
  assert.equal(runner.state.workerCalls, 3);
});

test("the Owner's answer resets the count and allows a fresh run of attempts", async (t) => {
  const runner = questionRunner();
  const { db, core } = await openCore(t, runner, 2);
  const workId = await startWork(core, "owner-resets");
  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"));
  assert.equal(runner.state.workerCalls, 2);
  assert.equal(task(db, workId).no_progress_count, 2);

  const decision = db.get("SELECT id, state_version FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  await core.answerDecision(decision.id, envelope({ answer: "もう一度実行する", option_key: "retry", source_message_id: null }, "answer", decision.state_version));
  assert.ok(await waitFor(() => runner.state.workerCalls > 2), "the Worker runs again after the answer");
  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting" && runner.state.workerCalls >= 4));
  await sleep(300);
  assert.equal(runner.state.workerCalls, 4, "the answer bought exactly one more run of `limit` attempts");
  assert.equal(task(db, workId).no_progress_count, 2);
});

test("lowering the limit while a retry is pending stops the launch (Worker gate)", async (t) => {
  // The first replan waits; the limit drops to 1 meanwhile. T1 is then
  // retried with count 1 >= 1, so Core must not launch the Worker again.
  let release;
  const held = new Promise((resolveHeld) => { release = resolveHeld; });
  const runner = questionRunner();
  const replan = runner.runManagerPlan;
  runner.runManagerPlan = async (request) => {
    if ((request.mode ?? request.context?.mode) === "replan" && runner.state.replans === 0) await held;
    return replan(request);
  };
  const { db, core } = await openCore(t, runner, 3);
  const workId = await startWork(core, "worker-gate");
  assert.ok(await waitFor(() => task(db, workId)?.no_progress_count === 1 && runner.state.workerCalls === 1));
  await core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: 1 });
  release();

  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `the Work waits (state=${workState(db, workId)})`);
  await sleep(300);
  assert.equal(runner.state.workerCalls, 1, "the Worker was not launched again");
  const event = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.no_progress_limited'", workId);
  assert.equal(JSON.parse(event.payload_json).gate, "worker");
  assert.equal(task(db, workId).status, "judgement_waiting");
});

test("a failing no-progress gate skips the replan, tells the Owner once, and the next tick after recovery replans", async (t) => {
  const runner = questionRunner();
  const { db, core } = await openCore(t, runner);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  const transact = core.writeLane.transact.bind(core.writeLane);
  let broken = true;
  core.writeLane.transact = (fn, ...rest) => {
    if (broken && fn.toString().includes("stopTaskForNoProgressInTransaction")) return Promise.reject(new Error("gate transaction failed"));
    return transact(fn, ...rest);
  };
  t.after(() => { console.warn = warn; core.writeLane.transact = transact; });
  const workId = await startWork(core, "gate-failure");
  const events = () => db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.loop_gate_failed'", workId);

  assert.ok(await waitFor(() => events().length === 1), "the Owner-visible event is recorded");
  await sleep(300); // several ticks keep failing the same way
  assert.equal(events().length, 1, "the same failure is not recorded again");
  assert.equal(runner.state.replans, 0, "no replan without the gate");
  assert.ok(JSON.parse(events()[0].payload_json).message.includes("gate transaction failed"));
  assert.ok(warnings.some((line) => line.includes("gate transaction failed")), "the error is logged");

  broken = false;
  assert.ok(await waitFor(() => runner.state.replans >= 1), "the trigger was kept and replays once the gate works");
});
