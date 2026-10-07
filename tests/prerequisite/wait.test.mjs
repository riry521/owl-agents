import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../../packages/core/dist/index.js";
import { isPlanRejection, validatePlan, validateReplan } from "../../packages/core/dist/replan-plan.js";
import { reduceTaskInTransaction } from "../../packages/core/dist/state-reducer.js";
import { openDatabase } from "../../packages/db/dist/index.js";
import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../packages/shared/dist/progress-guard-settings.js";
import { createRetryingTestCore } from "../helpers/cleanup.mjs";
import { command } from "../helpers/core.mjs";
import { migrationsDir } from "../helpers/paths.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A retried Task with wait_for waits (status waiting, prerequisite_json set)
// and no path starts its Worker or the Manager while it waits.

const QUESTION = "The file page-format.ts does not exist yet; wait for it to land on main?";
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

const planTask = (extra = {}) => ({ id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false, ...extra });
const ownerWait = { reason: "Waiting for the Owner to merge #51", conditions: [{ kind: "owner", target: "", paths: [], description: "Owner confirms" }] };

/** The Worker asks QUESTION on its first run; each replan answer comes from `replanAnswers` (the last one repeats). */
function runnerWith(replanAnswers) {
  const state = { workerCalls: 0, replans: 0, reasons: [] };
  return {
    state,
    replanAnswers,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        state.reasons.push(request.context?.previous_output_feedback ?? null);
        const picked = replanAnswers[Math.min(state.replans, replanAnswers.length - 1)];
        const answer = typeof picked === "function" ? picked() : picked;
        state.replans += 1;
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask(answer)] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      if (state.hold) await new Promise(() => {});
      state.workerCalls += 1;
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      await writeFile(join(request.context.worktree, "src/feature.mjs"), "export const f = 1;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, state.workerCalls === 1 ? QUESTION : null) };
    },
    runReviewer: async () => {
      const review = { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function openCore(t, runner, hours) {
  const ctx = await createRetryingTestCore(t, { agentRunner: withNecessity(runner), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-prereq-wait-", start: true });
  if (hours !== undefined) await ctx.core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, prerequisite_max_wait_hours: hours });
  return ctx;
}

/** A wait_for on another (never finished) Work: a wait that opens no Decision. */
async function workWaitFor(db, core, suffix) {
  const other = await core.createWork(command({ title: "other-" + suffix, summary: "The Work being waited for.", size: "normal", project_id: null }, "other-" + suffix));
  const number = db.get("SELECT display_number FROM works WHERE id = ?", other.data.work_id).display_number;
  return { reason: "Waiting for the other Work", conditions: [{ kind: "work", target: "#" + number, paths: [], description: "other Work completes" }] };
}

async function startWork(core, suffix) {
  const created = await core.createWork(command({ title: suffix, summary: "Exercise prerequisite waits.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, command({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

const task = (db, workId) => db.get("SELECT id, status, no_progress_count, prerequisite_json, prerequisite_since FROM tasks WHERE work_id = ?", workId);
const counts = (db, workId) => ({
  runs: db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ?", workId).n,
  tasks: db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.started'", workId).n,
});
const workVersion = (db, workId) => db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;

const item = (extra = {}) => ({ id: "T1", title: "A", type: "code", acceptance: "x", depends_on: [], replaces: [], ...extra });
const snapshot = { tasks: [{ id: "T1", manager_task_id: "T1", status: "failed", failed_by_dependency: false }], edges: [] };

test("validateReplan accepts wait_for on a retried Task and collects it in waits", () => {
  const plan = validateReplan([item({ wait_for: ownerWait })], snapshot, ["T1"]);
  assert.ok(!isPlanRejection(plan), JSON.stringify(plan));
  assert.deepEqual(plan.waits.get("T1"), ownerWait);
  const none = validateReplan([item({ wait_for: null })], snapshot, ["T1"]);
  assert.equal(none.waits.size, 0);
});

test("validateReplan and validatePlan reject wait_for outside a retried Task", () => {
  const inPlan = validatePlan([item({ wait_for: ownerWait })]);
  assert.ok(isPlanRejection(inPlan));
  assert.match(inPlan.errors.join(" "), /plan waits for nothing/);

  const newItem = validateReplan([item(), item({ id: "N1", wait_for: ownerWait })], snapshot, ["T1"]);
  assert.ok(isPlanRejection(newItem));
  assert.match(newItem.errors.join(" "), /allowed only on a retried Task/);

  const replace = validateReplan([item({ id: "N1", replaces: ["T1"], wait_for: ownerWait })], snapshot, ["T1"]);
  assert.ok(isPlanRejection(replace));
  assert.match(replace.errors.join(" "), /allowed only on a retried Task/);

  const badKind = validateReplan([item({ wait_for: { reason: "r", conditions: [{ kind: "bogus", target: "", paths: [], description: "d" }] } })], snapshot, ["T1"]);
  assert.ok(isPlanRejection(badKind));
  assert.match(badKind.errors.join(" "), /invalid wait_for/);
});

const badTargets = {
  "a Task of the same Work": (ctx) => ({ kind: "task", target: ctx.taskId, paths: [], description: "d" }),
  "a Work that does not exist": () => ({ kind: "work", target: "#99999", paths: [], description: "d" }),
  "a Task that does not exist": () => ({ kind: "task", target: "no-such-task", paths: [], description: "d" }),
  "a cancelled Work": (ctx) => ({ kind: "work", target: ctx.cancelledWorkId, paths: [], description: "d" }),
  "a cancelled Task of another Work": (ctx) => ({ kind: "task", target: ctx.cancelledTaskId, paths: [], description: "d" }),
  "base_branch of a Work without a Project": () => ({ kind: "base_branch", target: "", paths: ["src/a.ts"], description: "d" }),
};

for (const [name, makeCondition] of Object.entries(badTargets)) {
  test(`wait_for on ${name} is sent back with the replan rejection`, async (t) => {
    const ctx = { taskId: null };
    // First answer is a bad wait_for; the repair answer is a plain retry.
    const runner = runnerWith([() => ({ wait_for: { reason: "r", conditions: [makeCondition(ctx)] } }), {}]);
    const { db, core } = await openCore(t, runner);
    // Another Work whose Worker is held forever, cancelled in the database directly.
    runner.state.hold = true;
    ctx.cancelledWorkId = await startWork(core, "cancelled-other");
    ctx.cancelledTaskId = await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ?", ctx.cancelledWorkId)?.id);
    await sleep(200);
    await db.createWriteLane().transact((tx) => {
      tx.run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", ctx.cancelledTaskId);
      tx.run("UPDATE works SET state = 'cancelled' WHERE id = ?", ctx.cancelledWorkId);
      return null;
    });
    runner.state.hold = false;
    const baseReplans = runner.state.replans;
    const workId = await startWork(core, "bad-target");
    ctx.taskId = await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ?", workId)?.id);
    assert.ok(await waitFor(() => runner.state.replans >= baseReplans + 2), "the Manager was asked again");
    assert.equal(runner.state.reasons[baseReplans + 1]?.kind, "plan_rejected");
    assert.ok(runner.state.reasons[baseReplans + 1].errors.length > 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.prerequisite_wait_started'", workId).n, 0, "nothing was recorded for the rejected wait_for");
  });
}

test("an accepted wait_for waits: prerequisite recorded, no_progress_count kept, nothing starts", async (t) => {
  const runner = runnerWith([{}]);
  const { db, core } = await openCore(t, runner, 5);
  const workWait = await workWaitFor(db, core, "wait");
  runner.replanAnswers[0] = { wait_for: workWait };
  const workId = await startWork(core, "owner-wait");
  assert.ok(await waitFor(() => task(db, workId)?.prerequisite_json), `the Task waits (status=${task(db, workId)?.status})`);
  const waiting = task(db, workId);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.no_progress_count, 1, "the wait does not reset the no-progress count");
  assert.ok(waiting.prerequisite_since);
  const spec = JSON.parse(waiting.prerequisite_json);
  assert.equal(spec.reason, workWait.reason);
  assert.equal(spec.source, "manager");
  assert.equal(spec.conditions[0].kind, "work");
  assert.equal(spec.base_head, null);
  assert.equal(Date.parse(spec.deadline_at) - Date.parse(waiting.prerequisite_since) >= 5 * 3_600_000 - 5_000, true, "deadline = since + prerequisite_max_wait_hours");
  assert.equal(Date.parse(spec.deadline_at) - Date.parse(waiting.prerequisite_since) <= 5 * 3_600_000 + 5_000, true);
  const started = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.prerequisite_wait_started'", workId);
  assert.ok(started, "task.prerequisite_wait_started was recorded");
  const payload = JSON.parse(started.payload_json);
  assert.equal(payload.reason, workWait.reason);
  assert.equal(payload.no_progress_count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0, "a non-owner wait opens no Decision");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");

  // Every path that could start something while the Task waits.
  const before = { ...counts(db, workId), replans: runner.state.replans, workers: runner.state.workerCalls };
  await core.triggerManagerReplan(workId, [waiting.id], { kind: "queued_failed_tasks" });
  await core.tick(workId);
  await core.tick(workId);
  await core.workflow.resolveDependencies(workId);
  await db.createWriteLane().transact((tx) => {
    assert.throws(() => reduceTaskInTransaction(tx, waiting.id, { event: "task.ready", payload: { dependencies_completed: true } }), /prerequisite/);
    return null;
  });
  await core.pauseWork(workId, command({ reason: "pause" }, "pause", workVersion(db, workId)));
  assert.equal(task(db, workId).status, "paused");
  await core.resumeWork(workId, command({}, "resume", workVersion(db, workId)));
  await core.tick(workId);
  await sleep(300);
  const after = task(db, workId);
  assert.equal(after.status, "waiting", "still waiting after pause/resume and ticks");
  assert.equal(after.prerequisite_json, waiting.prerequisite_json, "the mark survives pause/resume");
  assert.deepEqual({ ...counts(db, workId), replans: runner.state.replans, workers: runner.state.workerCalls }, before, "no agent run or Manager call was added");
  assert.equal(runner.state.workerCalls, 1);
  assert.equal(runner.state.replans, 1);
});

test("a work condition given as #number is stored as the work id", async (t) => {
  const runner = runnerWith([{}]);
  const ctx = await openCore(t, runner);
  const other = await ctx.core.createWork(command({ title: "other", summary: "The Work being waited for.", size: "normal", project_id: null }, "other"));
  const number = ctx.db.get("SELECT display_number FROM works WHERE id = ?", other.data.work_id).display_number;
  assert.ok(number !== null, "the other Work has a display number");
  runner.replanAnswers[0] = { wait_for: { reason: "needs the other Work", conditions: [{ kind: "work", target: `#${number}`, paths: [], description: "other Work completes" }] } };
  const workId = await startWork(ctx.core, "work-wait");
  assert.ok(await waitFor(() => task(ctx.db, workId)?.prerequisite_json));
  const spec = JSON.parse(task(ctx.db, workId).prerequisite_json);
  assert.deepEqual(spec.conditions, [{ kind: "work", work_id: other.data.work_id, description: "other Work completes" }]);
});

test("the wait survives a restart: mark, reason and deadline stay and no Worker starts", async (t) => {
  const runner = runnerWith([{}]);
  const ctx = await openCore(t, runner);
  runner.replanAnswers[0] = { wait_for: await workWaitFor(ctx.db, ctx.core, "restart") };
  const workId = await startWork(ctx.core, "restart");
  assert.ok(await waitFor(() => task(ctx.db, workId)?.prerequisite_json));
  const before = task(ctx.db, workId);
  const runsBefore = counts(ctx.db, workId);

  await ctx.core.stop({ force: true });
  ctx.db.close();
  const db = openDatabase(join(ctx.root, "owl.db")); // helpers-exempt: reopens the same DB file and builds a second Core on it to prove the wait survives a restart
  db.migrate(migrationsDir);
  const core = new Core({ db, agentRunner: withNecessity(runner), version: "test", owlRoot: ctx.root, dispatcher: { tick_interval_ms: 25 } }); // helpers-exempt: second Core on the same DB and root
  try {
    await core.start();
    await sleep(400);

    assert.deepEqual(task(db, workId), before, "status, mark, since, reason, deadline and count are unchanged");
    assert.deepEqual(counts(db, workId), runsBefore);
    assert.equal(runner.state.workerCalls, 1);
    assert.equal(runner.state.replans, 1);
    assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  } finally {
    await core.stop({ force: true });
    db.close();
  }
});

test("an owner wait opens one Owner Decision and the answer releases the Task", async (t) => {
  const runner = runnerWith([{ wait_for: ownerWait }]);
  const { db, core } = await openCore(t, runner, 5);
  const workId = await startWork(core, "owner-decision");
  const open = () => db.all("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(await waitFor(() => open().length === 1), "one open Decision");
  const decision = open()[0];
  assert.deepEqual(JSON.parse(decision.blocked_task_ids_json), [task(db, workId).id]);
  assert.match(decision.reason, /Owner confirms/);
  assert.match(decision.reason, /Waiting for the Owner to merge #51/);
  assert.match(decision.reason, new RegExp(task(db, workId).id));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  assert.equal(task(db, workId).status, "judgement_waiting");
  assert.ok(db.get("SELECT 1 AS x FROM events WHERE work_id = ? AND type = 'decision.opened'", workId), "the Decision notification event was recorded");
  await core.tick(workId);
  await sleep(200);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 1, "evaluating again adds no Decision");

  await core.answerDecision(decision.id, command({ answer: "Merged it, go ahead.", option_key: null }, "owner-answer", decision.state_version));
  const released = task(db, workId);
  assert.equal(released.prerequisite_json, null, "the owner condition is met: the mark is gone");
  assert.notEqual(released.status, "judgement_waiting");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decision_answers WHERE decision_id = ?", decision.id).n, 1, "the answer stays as guidance");
});

test("answering an owner wait keeps the unmet non-owner conditions waiting", async (t) => {
  const runner = runnerWith([{}]);
  const { db, core } = await openCore(t, runner, 5);
  const workWait = await workWaitFor(db, core, "mixed");
  runner.replanAnswers[0] = { wait_for: { reason: workWait.reason, conditions: [...ownerWait.conditions, ...workWait.conditions] } };
  const workId = await startWork(core, "owner-mixed");
  const open = () => db.all("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(await waitFor(() => open().length === 1), "one open Decision");
  const decision = open()[0];
  await core.answerDecision(decision.id, command({ answer: "Done.", option_key: null }, "mixed-answer", decision.state_version));
  const after = task(db, workId);
  assert.equal(after.status, "waiting", "the other Work is still unmet");
  assert.deepEqual(JSON.parse(after.prerequisite_json).conditions.map((c) => c.kind), ["work"]);
});
