import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { validateReplan } from "../../packages/core/dist/replan-plan.js";
import { evaluateWorkerCompletion } from "../../packages/core/dist/task-completion-gate.js";
import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../packages/shared/dist/progress-guard-settings.js";
import { DEFAULT_REMAKE_LIMIT_SETTINGS } from "../../packages/shared/dist/remake-limit-settings.js";
import { ACCEPTANCE_DEFECT_EVENT, workerAcceptanceDefects } from "../../packages/shared/dist/acceptance-defect.js";
import { DESIGNER_REPORT_SCHEMA, WORKER_REPORT_SCHEMA, buildWorkerPrompt, normalizeWorkerResponseWithFeedback } from "../../packages/agent-runtime/dist/worker.js";
import { buildManagerPrompt } from "../../packages/agent-runtime/dist/manager.js";
import { lineageUsage } from "../../packages/core/dist/task-lineage.js";
import { DEFAULT_ATTEMPT_POLICY_CONFIG } from "../../packages/core/dist/attempt-policy.js";
import { validateReportEnvelope, validateReportSemantics } from "../../packages/agent-runtime/dist/protocol.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { findInternalTerms } from "../../packages/shared/dist/decision-explanation.js";

// A Worker that reports a criterion as "unverifiable" must not be restarted and
// its Task must not be replaced: Core asks the Manager to rewrite the criterion
// on the same Task, and the Task then runs again with the rewritten acceptance.

const BAD_CRITERION = "The live server data directory is unchanged before and after the run.";
const REASON = "The live server is outside the Task, so no command the Task runs can compare it.";
const GOOD_ACCEPTANCE = "A copy of the data directory made inside the Task is unchanged; verified by node --test tests/copy.test.mjs.";

const envelope = (payload, suffix, expectedVersion = 0) => command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);

const unverifiableReport = (invocationId) => ({
  kind: "report",
  schema_version: "1.1.0",
  invocation_id: invocationId,
  result: "partial",
  work_done: "Implemented; one criterion cannot be proven.",
  delegation: { decomposition: "kept together", delegated: [], retained: [] },
  changes: [],
  verification: {
    status: "blocked",
    method: "Ran the tests.",
    acceptance: [
      { criterion_id: "AC1", criterion: BAD_CRITERION, status: "unverifiable", evidence: "n/a", unverifiable_reason: REASON },
      { criterion_id: "AC2", criterion: "The feature file exists.", status: "passed", evidence: "ls shows it" },
    ],
    checks: [],
    integration_check: null,
  },
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: null,
});

const passedReport = (invocationId) => ({
  ...unverifiableReport(invocationId),
  result: "success",
  verification: {
    status: "passed",
    method: "Ran the tests.",
    acceptance: [{ criterion_id: "AC1", criterion: GOOD_ACCEPTANCE, status: "passed", evidence: "node --test passed" }],
    checks: [],
    integration_check: null,
  },
});

const MANAGER = { kind: "manager", source: null, quote: "" };
const OWNER = { kind: "owner", source: "summary", quote: "Exercise unverifiable reports" };

/** A Task whose only criterion is AC1 with the given origin; every answer carries the loosening record, which Core reads only when the text changed. */
const planTask = (text, origin = MANAGER) => ({
  id: "T1", title: "A", type: "code",
  necessity: { serves: "test fixture", if_omitted: "test fixture" },
  acceptance_criteria: [{ id: "AC1", text, check: "node --test tests/x.test.mjs", serves: "test fixture", if_omitted: "test fixture", check_weight: "light", weight_reason: "", kind: "work_check", ...(origin ? { origin } : {}) }],
  auto_recovery: { criteria_relaxations: [{ criterion_id: "AC1", reason: REASON, keeps: "A copy made inside the Task is unchanged." }] },
  depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false,
});

/** The first Worker run reports BAD_CRITERION unverifiable (every run with alwaysUnverifiable); the Manager answers each replan with `answers[i]`. */
function runnerWith(answers, { origin = MANAGER, alwaysUnverifiable = false } = {}) {
  const state = { workerCalls: 0, replanRequests: [] };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask(BAD_CRITERION, origin)] } };
      if (mode === "replan") {
        state.replanRequests.push(request);
        const tasks = answers[Math.min(state.replanRequests.length - 1, answers.length - 1)](request);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      if (alwaysUnverifiable || state.workerCalls === 1) return { outcome: "success", report_valid: true, report: unverifiableReport(request.invocation_id) };
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      await writeFile(join(request.context.worktree, "src/feature.mjs"), "export const f = 1;\n");
      return { outcome: "success", report_valid: true, report: passedReport(request.invocation_id) };
    },
    runReviewer: async () => {
      const review = { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function openCore(t, runner, configure) {
  const { db, core, root } = await createTestCore(t, { agentRunner: runner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-unverifiable-", start: true });
  // The plan quality gate would reject the unprovable starting criterion before the path under test runs.
  await disablePlanQuality(db);
  if (configure) await configure(core);
  return { db, core, root };
}

async function startWork(core, suffix) {
  const created = await core.createWork(envelope({ title: suffix, summary: "Exercise unverifiable reports.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

const tasksOf = (db, workId) => db.all("SELECT id, status, acceptance, no_progress_count FROM tasks WHERE work_id = ? ORDER BY created_at", workId);

test("report schema and prompt describe unverifiable", () => {
  const prompt = buildWorkerPrompt({ context: { rules: null, knowledge: null, skills: null }, task: { id: "t", title: "t", acceptance: "a", type: "code" }, invocation_id: "i" });
  assert.match(prompt, /unverifiable_reason/);
  assert.match(prompt, /status "unverifiable"/);
  assert.deepEqual(workerAcceptanceDefects(unverifiableReport("i")).map((d) => [d.criterion_id, d.reason]), [["AC1", REASON]]);
  assert.deepEqual(workerAcceptanceDefects(passedReport("i")), []);
  // The report contract accepts the new status and reason, and still rejects a success claim that carries one.
  assert.equal(validateReportEnvelope(unverifiableReport("i")).verification.acceptance[0].status, "unverifiable");
  assert.throws(() => validateReportSemantics(validateReportEnvelope({ ...unverifiableReport("i"), result: "success", verification: { ...unverifiableReport("i").verification, status: "passed" } })), /Owl report contract/);
  const gate = evaluateWorkerCompletion({ ...unverifiableReport("i"), result: "success" }, { hybrid: false, delegated_work_detected: false });
  assert.equal(gate.passed, false);
  assert.equal(gate.error_key, "worker_acceptance_unverifiable");
});

test("report schema and prompt describe external_blocker", () => {
  const schema = WORKER_REPORT_SCHEMA.properties.external_blocker;
  assert.deepEqual(schema.properties.kind.enum, ["pre_existing", "environment"]);
  assert.ok(WORKER_REPORT_SCHEMA.required.includes("external_blocker"));
  assert.equal(DESIGNER_REPORT_SCHEMA.properties.external_blocker, undefined);
  const prompt = buildWorkerPrompt({ context: { rules: null, knowledge: null, skills: null }, task: { id: "t", title: "t", acceptance: "a", type: "code" }, invocation_id: "i" });
  assert.match(prompt, /external_blocker/);
  assert.match(prompt, /code_unchecked/);
  const report = { ...unverifiableReport("i"), external_blocker: { kind: "environment", summary: "s", evidence: "e", suggested_fix: "f" } };
  assert.deepEqual(validateReportEnvelope(report).external_blocker, report.external_blocker);
});

test("validateReplan requires the same Task id, a changed acceptance and no wait", () => {
  const snapshot = { tasks: [{ id: "id-1", manager_task_id: "T1", title: "A", status: "failed", failed_by_dependency: false }], edges: [] };
  const required = new Map([["id-1", "old acceptance"]]);
  const item = (patch) => ({ id: "T1", title: "A", type: "code", acceptance: "new acceptance", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false, ...patch });
  const errorsOf = (items) => validateReplan(items, snapshot, ["id-1"], { acceptanceRevisionRequired: required }).errors ?? [];
  assert.deepEqual(errorsOf([item({})]), []);
  assert.match(errorsOf([item({ acceptance: " old acceptance " })]).join("\n"), /acceptance is unchanged/);
  assert.match(errorsOf([item({ id: "T2", replaces: ["T1"] })]).join("\n"), /retry it with its existing id instead of replacing/);
  assert.match(errorsOf([item({ wait_for: { reason: "r", conditions: [{ kind: "owner", target: "", paths: [], description: "d" }] } })]).join("\n"), /must not wait/);
});

test("an unverifiable report goes to the Manager on the same Task, which then runs with the rewritten acceptance", async (t) => {
  const runner = runnerWith([() => [planTask(GOOD_ACCEPTANCE)]]);
  const { db, core } = await openCore(t, runner);
  const workId = await startWork(core, "rewrite");

  assert.ok(await waitFor(() => tasksOf(db, workId)[0]?.status === "completed"), `the Task completes (${JSON.stringify(tasksOf(db, workId))})`);
  const tasks = tasksOf(db, workId);
  assert.equal(tasks.length, 1, "no replacement Task was created");
  assert.match(tasks[0].acceptance, new RegExp(GOOD_ACCEPTANCE.slice(0, 30)), "the Manager's rewritten acceptance is stored");
  assert.equal(runner.state.workerCalls, 2, "one Worker run per acceptance version");
  assert.equal(runner.state.replanRequests.length, 1);

  const request = runner.state.replanRequests[0];
  const brief = request.context.failed_tasks[0];
  assert.equal(request.trigger.kind, "task_failed");
  assert.equal(request.trigger.tasks[0].task_id, tasks[0].id);
  assert.equal(brief.failure.kind, "acceptance_defect");
  assert.equal(brief.acceptance_defects[0].criterion, BAD_CRITERION, "the defect names the criterion");
  assert.equal(brief.acceptance_defects[0].reason, REASON, "the defect carries the Worker's reason");

  const event = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = ?", workId, ACCEPTANCE_DEFECT_EVENT);
  assert.ok(event, "task.acceptance_defect_reported was recorded");
  assert.equal(JSON.parse(event.payload_json).source, "worker");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND scope = 'task'", workId).n, 0, "no Task Decision (remake or no-progress limit) was opened");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.no_progress_limited'", workId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.superseded'", workId).n, 0);
  // A partial report with an unverifiable criterion is the same kind 7 recovery as a Reviewer's defect.
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'recovery.started' AND json_extract(payload_json, '$.kind') = 'criteria_too_strict'", workId).n, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'criteria.relaxed'", workId).n, 1);
});

test("an unverifiable report on an Owner criterion opens the criteria Decision at once, without asking the Manager", async (t) => {
  const runner = runnerWith([() => [planTask(GOOD_ACCEPTANCE, OWNER)]], { origin: OWNER });
  const { db, core } = await openCore(t, runner);
  const workId = await startWork(core, "owner-criterion");

  assert.ok(await waitFor(() => db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open' AND blocked_task_ids_json != '[]'", workId).n === 1));
  assert.equal(runner.state.replanRequests.length, 0);
  assert.equal(runner.state.workerCalls, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'recovery.started'", workId).n, 0);
});

test("an unverifiable report after the recovery limit is used up opens the criteria Decision with what was tried", async (t) => {
  const runner = runnerWith([() => [planTask(GOOD_ACCEPTANCE)]], { alwaysUnverifiable: true });
  const { db, core } = await openCore(t, runner, (c) => c.setAutoRecoverySettings({ limit: 1 }));
  const workId = await startWork(core, "exhausted");

  assert.ok(await waitFor(() => db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open' AND blocked_task_ids_json != '[]'", workId).n === 1));
  assert.equal(runner.state.replanRequests.length, 1);
  assert.match(db.get("SELECT tried FROM decisions WHERE work_id = ? AND blocked_task_ids_json != '[]'", workId).tried, /自動で試したこと/);
});

test("a Manager answer that keeps the acceptance unchanged is sent back until it rewrites it", async (t) => {
  const runner = runnerWith([(request) => [planTask(request.context.failed_tasks[0].acceptance_criteria[0].text)], () => [planTask(GOOD_ACCEPTANCE)]]);
  const { db, core } = await openCore(t, runner);
  const workId = await startWork(core, "unchanged");

  assert.ok(await waitFor(() => tasksOf(db, workId)[0]?.status === "completed"), `the Task completes (${JSON.stringify(tasksOf(db, workId))})`);
  assert.match(tasksOf(db, workId)[0].acceptance, new RegExp(GOOD_ACCEPTANCE.slice(0, 30)));
  assert.equal(runner.state.workerCalls, 2, "the unchanged answer never started a Worker");
  assert.ok(runner.state.replanRequests.length >= 2);
  assert.match(JSON.stringify(runner.state.replanRequests[1]), /acceptance is unchanged/);
});

test("the tightest no_progress and lineage_worker_runs limits do not stop the Manager from rewriting the criteria", async (t) => {
  const runner = runnerWith([() => [planTask(GOOD_ACCEPTANCE)]]);
  const { db, core } = await openCore(t, runner, async (c) => {
    await c.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: 1 });
    await c.setRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_worker_runs: 1 });
  });
  const workId = await startWork(core, "tight");

  assert.ok(await waitFor(() => tasksOf(db, workId)[0]?.status === "completed"), `the Task completes (${JSON.stringify(tasksOf(db, workId))})`);
  assert.equal(tasksOf(db, workId).length, 1);
  assert.equal(runner.state.replanRequests.length, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND blocked_task_ids_json != '[]'", workId).n, 0, "no Decision blocking the Task (remake or no-progress limit) was opened");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.no_progress_limited'", workId).n, 0);
});

// A partial report that names a problem outside the Task goes to the Manager, which adds a fix Task in the same Work.

const BLOCKER = { kind: "pre_existing", summary: "The base branch test suite is red.", evidence: "node --test tests/base.test.mjs fails on the untouched base.", suggested_fix: "Repair tests/base.test.mjs." };

// The shape runner.ts gives a partial report after the Worker used a side-effect tool (reportAsCoreResult, then afterSideEffect).
function partialAfterSideEffect(report) {
  return { outcome: "partial", failure_class: "deterministic", error_key: "side_effect_failure:report_result:partial", retry_allowed: false, report_valid: true, report: { ...report, result: "partial", pending_process: null } };
}

// The shape of an ordinary partial report (reportAsCoreResult only).
function plainPartial(report) {
  return { outcome: "partial", failure_class: "deterministic", error_key: "report_result:partial", retry_allowed: true, report_valid: true, report: { ...report, result: "partial", external_blocker: null, pending_process: null } };
}

/** Worker runs of T1 follow `script` (each entry maps the request to a result, or undefined to succeed); every FIX Task succeeds. Each replan adds a new FIX Task and retries T1 behind it. */
function blockerRunner(script) {
  const state = { t1Calls: 0, replanRequests: [], db: null };
  const t1 = () => planTask(GOOD_ACCEPTANCE);
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [t1()] } };
      if (mode === "replan") {
        state.replanRequests.push(request);
        const fix = { ...planTask("The base test passes; verified by node --test tests/base.test.mjs."), id: `FIX${state.replanRequests.length}`, title: "FIX" };
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [fix, { ...t1(), depends_on: [fix.id] }] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      const succeed = async (unique) => {
        await mkdir(join(request.context.worktree, "src"), { recursive: true });
        await writeFile(join(request.context.worktree, `src/${unique}.mjs`), "export const f = 1;\n");
        return { outcome: "success", report_valid: true, report: { ...passedReport(request.invocation_id), external_blocker: null, pending_process: null } };
      };
      const managerId = state.db.get("SELECT manager_task_id FROM tasks WHERE id = ?", request.task_id ?? request.context?.task_id ?? request.task?.id)?.manager_task_id;
      if (managerId !== "T1") return succeed(`fix-${createUlid()}`);
      const step = script[state.t1Calls];
      state.t1Calls += 1;
      return (step && (await step(request))) || succeed(`t1-${state.t1Calls}`);
    },
    runReviewer: async () => {
      const review = { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

const blocked = (extra = {}) => (request) => partialAfterSideEffect({ ...unverifiableReport(request.invocation_id), external_blocker: BLOCKER, ...extra });
const plain = () => (request) => plainPartial({ ...passedReport(request.invocation_id), work_done: "Half done; the run failed for an ordinary reason." });
const openDecisions = (db, workId) => db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open' AND blocked_task_ids_json != '[]'", workId).n;
const eventCount = (db, workId, type) => db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = ?", workId, type).n;
const t1Of = (db, workId) => db.get("SELECT id, status FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId);
const decidedReasons = (db, workId) => db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.attempt_decided'", workId).map((row) => JSON.parse(row.payload_json).reason);

test("the Manager replan prompt describes external_blocker", () => {
  const prompt = buildManagerPrompt({ work: { id: "w", title: "T" }, mode: "replan", context: {} }, "en");
  assert.match(prompt, /failure\.kind "external_blocker"/);
  assert.match(prompt, /pre_existing/);
  assert.match(prompt, /depends_on including the new Task's id/);
});

test("a partial report with external_blocker after a side effect goes to the Manager, which adds a fix Task in the same Work", async (t) => {
  const runner = blockerRunner([blocked()]);
  const { db, core } = await openCore(t, runner);
  runner.state.db = db;
  const workId = await startWork(core, "blocker");

  assert.ok(await waitFor(() => t1Of(db, workId)?.status === "completed"), `T1 completes (${JSON.stringify(tasksOf(db, workId))})`);
  assert.equal(runner.state.replanRequests.length, 1);
  const request = runner.state.replanRequests[0];
  assert.equal(request.trigger.kind, "task_failed");
  assert.deepEqual(request.trigger.tasks, [{ kind: "external_blocker", task_id: t1Of(db, workId).id, cause: "pre_existing" }]);
  const failure = request.context.failed_tasks[0].failure;
  assert.equal(failure.kind, "external_blocker");
  assert.deepEqual([failure.summary, failure.evidence, failure.suggested_fix], [BLOCKER.summary, BLOCKER.evidence, BLOCKER.suggested_fix]);
  assert.equal(openDecisions(db, workId), 0, "no Owner Decision was opened");
  assert.equal(tasksOf(db, workId).length, 2, "the fix Task was added to the same Work");
  assert.equal(runner.state.t1Calls, 2);
  assert.equal(eventCount(db, workId, "task.external_blocker_reported"), 1);
});

test("an external blocker past progress_guard.external_blocker_limit asks the Owner", async (t) => {
  const runner = blockerRunner([blocked(), blocked()]);
  const { db, core } = await openCore(t, runner, (c) => c.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, external_blocker_limit: 1 }));
  runner.state.db = db;
  const workId = await startWork(core, "blocker-limit");

  assert.ok(await waitFor(() => t1Of(db, workId)?.status === "judgement_waiting"), `T1 waits for the Owner (${JSON.stringify(tasksOf(db, workId))})`);
  assert.ok(await waitFor(() => openDecisions(db, workId) === 1));
  assert.ok(decidedReasons(db, workId).includes("external_blocker_limit"));
  assert.equal(runner.state.replanRequests.length, 1, "the second report did not reach the Manager");
});

test("a partial without a usable external_blocker still waits for the Owner", async (t) => {
  const failedReport = (request) => ({ outcome: "failed", failure_class: "deterministic", error_key: "side_effect_failure:report_result:failed", retry_allowed: false, report_valid: true, report: { ...unverifiableReport(request.invocation_id), result: "failed", external_blocker: BLOCKER, pending_process: null } });
  const withProcess = (request) => ({ ...partialAfterSideEffect({ ...unverifiableReport(request.invocation_id), external_blocker: BLOCKER }), report: { ...unverifiableReport(request.invocation_id), result: "partial", external_blocker: BLOCKER, pending_process: { description: "d", command: "c", log_path: "l", done_path: null, pid: null, expected_minutes: 1 } } });
  // A partial with an unverifiable criterion and no usable blocker (none, or an invalid record) is a criteria defect now (see the tests above), so it is not a case here.
  const cases = { "result failed": failedReport, "with pending_process": withProcess };
  for (const [name, step] of Object.entries(cases)) {
    const runner = blockerRunner([step]);
    const { db, core } = await openCore(t, runner);
    runner.state.db = db;
    const workId = await startWork(core, `unusable-${name.replaceAll(" ", "-")}`);
    assert.ok(await waitFor(() => t1Of(db, workId)?.status === "judgement_waiting"), `${name}: T1 waits for the Owner (${JSON.stringify(tasksOf(db, workId))})`);
    assert.ok(decidedReasons(db, workId).includes("retry_not_allowed"), `${name}: ${JSON.stringify(decidedReasons(db, workId))}`);
    assert.equal(runner.state.replanRequests.length, 0, name);
    assert.equal(eventCount(db, workId, "task.external_blocker_reported"), 0, name);
  }
});

test("external blockers reach the Manager although the lineage already used lineage_worker_runs, and do not count as Worker runs", async (t) => {
  const runner = blockerRunner([plain(), blocked(), blocked(), blocked()]);
  const { db, core } = await openCore(t, runner, async (c) => {
    await c.setRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_worker_runs: 1 });
    await c.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, external_blocker_limit: 3 });
  });
  runner.state.db = db;
  const workId = await startWork(core, "blocker-remake");

  assert.ok(await waitFor(() => t1Of(db, workId)?.status === "completed"), `T1 completes (${JSON.stringify(tasksOf(db, workId))})`);
  assert.equal(openDecisions(db, workId), 0, "the remake gate did not open a Decision");
  assert.equal(eventCount(db, workId, "task.no_progress_limited"), 0);
  assert.equal(runner.state.replanRequests.length, 3, "only the three blockers went to the Manager; the ordinary failure was retried");
  assert.equal(lineageUsage(db, t1Of(db, workId).id, DEFAULT_REMAKE_LIMIT_SETTINGS).worker_runs, 2, "only the ordinary failure and the success count");
});

test("an external blocker reaches the Manager and relaunches although no_progress_count is already at the limit", async (t) => {
  const question = (request) => ({ outcome: "success", report_valid: true, report: { ...passedReport(request.invocation_id), result: "partial", external_blocker: null, pending_process: null, question_for_manager: "Which API should I use?" } });
  const holder = {};
  // The limit drops to 1 while the Worker runs, so no_progress_count (1 after the question) is at it when the blocker is reported.
  const lowered = async (request) => {
    await holder.core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: 1, external_blocker_limit: 2 });
    return blocked()(request);
  };
  const runner = blockerRunner([question, lowered]);
  const { db, core } = await openCore(t, runner, (c) => c.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: 3, external_blocker_limit: 2 }));
  holder.core = core;
  runner.state.db = db;
  const workId = await startWork(core, "blocker-noprogress");

  assert.ok(await waitFor(() => t1Of(db, workId)?.status === "completed"), `T1 completes (${JSON.stringify(tasksOf(db, workId))})`);
  assert.equal(eventCount(db, workId, "task.no_progress_limited"), 0);
  assert.equal(openDecisions(db, workId), 0);
  assert.equal(runner.state.replanRequests.length, 2);
});

// A partial after a side effect with nothing for the Manager or the Owner (no pending_process, external_blocker,
// unverifiable criterion or needs_replanning) only needs another run: Core retries it within the deterministic limits.
const resumable = (seen) => (request) => {
  seen?.push(request.context?.previous_report ?? null);
  return partialAfterSideEffect({ ...passedReport(request.invocation_id), work_done: "Half done; continue from here.", external_blocker: null });
};

test("a partial after a side effect with nothing to escalate is retried with its report, without an Owner Decision", async (t) => {
  const seen = [];
  const record = (request) => { seen.push(request.context?.previous_report ?? null); };
  const runner = blockerRunner([resumable(seen), record]);
  const { db, core } = await openCore(t, runner);
  runner.state.db = db;
  const workId = await startWork(core, "resumable-partial");

  assert.ok(await waitFor(() => t1Of(db, workId)?.status === "completed"), `T1 completes (${JSON.stringify(tasksOf(db, workId))})`);
  assert.equal(runner.state.t1Calls, 2);
  assert.equal(seen[0], null);
  assert.equal(seen[1]?.work_done, "Half done; continue from here.", "the retried Worker gets the previous report");
  assert.ok(decidedReasons(db, workId).includes("resumable_partial"), JSON.stringify(decidedReasons(db, workId)));
  assert.ok(!decidedReasons(db, workId).includes("retry_not_allowed"));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND blocked_task_ids_json != '[]'", workId).n, 0, "no Owner Decision blocked the Task");
  assert.equal(runner.state.replanRequests.length, 0);
});

test("resumable partials up to partial_limit are retried as completed/partial runs, then the Owner decides without a failure count", async (t) => {
  const limit = DEFAULT_ATTEMPT_POLICY_CONFIG.partialLimit;
  const runner = blockerRunner(Array.from({ length: limit + 1 }, () => resumable()));
  const { db, core } = await openCore(t, runner);
  runner.state.db = db;
  const workId = await startWork(core, "resumable-partial-limit");

  assert.ok(await waitFor(() => t1Of(db, workId)?.status === "judgement_waiting"), `T1 waits for the Owner (${JSON.stringify(tasksOf(db, workId))})`);
  assert.ok(await waitFor(() => openDecisions(db, workId) === 1));
  assert.equal(runner.state.t1Calls, limit + 1);
  const reasons = decidedReasons(db, workId);
  assert.deepEqual([reasons.filter((r) => r === "resumable_partial").length, reasons.at(-1)], [limit, "partial_limit"]);
  const t1 = db.get("SELECT id, failure_count, same_error_count, last_error_key FROM tasks WHERE id = ?", t1Of(db, workId).id);
  assert.deepEqual([t1.failure_count, t1.same_error_count, t1.last_error_key], [0, 0, null]);
  const runs = db.all("SELECT status, outcome FROM agent_runs WHERE task_id = ? AND role = 'worker'", t1.id);
  assert.equal(runs.length, limit + 1);
  assert.ok(runs.every((run) => run.status === "completed" && run.outcome === "partial"), JSON.stringify(runs));
});

// A report whose result contradicts its own fields is repaired by lowering the result, never by raising it.
const asProvider = (payload) => ({ adapter: "claude", stdout: JSON.stringify(payload), stderr: "", exit_code: 0, signal: null, format: "plain-text" });
// The model never writes the criterion text; the runtime fills it from the Task.
const modelAcceptance = [{ criterion_id: "AC1", status: "passed", evidence: "node --test passed" }];
const claimedSuccess = (extra = {}) => ({ ...passedReport("i"), external_blocker: null, pending_process: null, ...extra, verification: { ...passedReport("i").verification, acceptance: modelAcceptance, ...extra.verification } });
const blockedItem = { criterion_id: "AC2", status: "blocked", evidence: "n/a" };
const withVerification = (extra) => ({ verification: extra });

test("success contradicted by its own fields is lowered to partial and keeps the question and needs_replanning", () => {
  const cases = {
    success_with_question_for_manager: claimedSuccess({ question_for_manager: "Which branch?" }),
    success_with_needs_replanning: claimedSuccess({ needs_replanning: true }),
    success_with_unpassed_item: claimedSuccess(withVerification({ acceptance: [...modelAcceptance, blockedItem] })),
    success_with_unpassed_verification: claimedSuccess(withVerification({ status: "blocked" })),
  };
  for (const [rule, payload] of Object.entries(cases)) {
    const { report, corrections } = normalizeWorkerResponseWithFeedback(asProvider(payload), "i");
    assert.equal(report.result, "partial", rule);
    assert.ok(corrections.some((c) => c.rule === rule && c.from_result === "success" && c.to_result === "partial"), JSON.stringify(corrections));
    assert.equal(report.question_for_manager, payload.question_for_manager ?? null);
    assert.equal(report.needs_replanning, payload.needs_replanning ?? false);
  }
  const checks = claimedSuccess(withVerification({ checks: [{ name: "tsc", status: "failed", evidence: "errors" }] }));
  assert.equal(normalizeWorkerResponseWithFeedback(asProvider(checks), "i").report.result, "partial");
});

test("corrections never raise a result and leave broken or ambiguous reports rejected", () => {
  for (const result of ["failed", "partial"]) {
    const payload = claimedSuccess({ result, question_for_manager: "Q?", needs_replanning: true });
    const { report, corrections } = normalizeWorkerResponseWithFeedback(asProvider(payload), "i");
    assert.deepEqual([report.result, corrections.length, report.question_for_manager, report.needs_replanning], [result, 0, "Q?", true]);
  }
  assert.equal(normalizeWorkerResponseWithFeedback(asProvider(claimedSuccess()), "i").corrections.length, 0);
  assert.throws(() => normalizeWorkerResponseWithFeedback(asProvider({ ...claimedSuccess(), result: "done" }), "i"), /Owl report contract|worker_output/);
  assert.throws(() => normalizeWorkerResponseWithFeedback(asProvider({ ...claimedSuccess(), verification: null }), "i"), /Owl report contract|worker_output/);
  assert.throws(() => validateReportSemantics(validateReportEnvelope(claimedSuccess()), { verdict: "retry", retry_subtasks: [] }), /Owl report contract/);
});

test("the Worker and Designer paths share the one correction list", () => {
  const payload = claimedSuccess({ question_for_manager: "Which branch?" });
  const { external_blocker: _blocker, ...designerPayload } = payload;
  for (const [schema, body] of [[WORKER_REPORT_SCHEMA, payload], [DESIGNER_REPORT_SCHEMA, designerPayload]]) {
    const { report, corrections } = normalizeWorkerResponseWithFeedback(asProvider(body), "i", false, undefined, schema);
    assert.deepEqual([report.result, corrections.map((c) => c.rule)], ["partial", ["success_with_question_for_manager"]]);
  }
  const delegated = { ...claimedSuccess(), delegation: { decomposition: "d", delegated: [{ child_id: "c", instruction: "i", provider: "p", model: "m" }], retained: [] } };
  assert.equal(normalizeWorkerResponseWithFeedback(asProvider(delegated), "i", true).report.result, "partial", "a Hybrid success without a passed integration check is lowered too");
});

test("a lowered report with a question reaches the Manager and the correction is recorded in events", async (t) => {
  const lowered = (request) => ({
    outcome: "partial", failure_class: "deterministic", error_key: "report_result:partial", retry_allowed: true, report_valid: true,
    report_corrections: [{ rule: "success_with_question_for_manager", from_result: "success", to_result: "partial" }],
    report: { ...passedReport(request.invocation_id), result: "partial", external_blocker: null, pending_process: null, question_for_manager: "Which branch?" },
  });
  const runner = blockerRunner([lowered]);
  const { db, core } = await openCore(t, runner);
  runner.state.db = db;
  const workId = await startWork(core, "corrected");

  assert.ok(await waitFor(() => eventCount(db, workId, "worker.report_corrected") === 1), "the correction event is recorded");
  const payload = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'worker.report_corrected'", workId).payload_json);
  assert.deepEqual(payload.corrections, [{ rule: "success_with_question_for_manager", from_result: "success", to_result: "partial" }]);
  assert.ok(await waitFor(() => runner.state.replanRequests.length === 1), "the question went to the Manager");
});

// A plain partial that repeats up to progress_guard.partial_limit opens a Decision, and Core adds a plain explanation to it.

const CRITERIA_AFTER = "The per-trial time without startup is shorter than before; verified by node --test tests/trial.test.mjs.";
const CRITERIA_CHECK = "Run node --test tests/trial.test.mjs after startup and compare the mean with the earlier one.";

// The work is done; the criterion cannot be met because of how it is measured.
const criteriaPartial = (request) => partialAfterSideEffect({
  ...passedReport(request.invocation_id),
  work_done: "The work is finished; only the measurement of the criterion fails.",
  verification: {
    status: "failed",
    method: "Ran the tests.",
    acceptance: [{ criterion_id: "AC1", criterion: GOOD_ACCEPTANCE, status: "failed", evidence: "The criterion averages three trials, so the startup time of the first trial makes the mean longer than before." }],
    checks: [],
    integration_check: null,
  },
  external_blocker: null,
});

const goodExplanation = (patch = {}) => ({
  summary: "The work is finished, but the criterion averages three trials, so the startup time makes it fail.",
  cause_kind: "criteria",
  options: [
    { label: "Reword the criterion", description: "Measure the time without startup and retry the Task.", instruction: "Reword the criterion and retry the Task.", criteria_rewrites: [{ criterion_id: "AC1", after: CRITERIA_AFTER, check: CRITERIA_CHECK }] },
    { label: "Speed up startup", description: "Keep the criterion and add work that shortens startup.", instruction: "Add work that shortens startup and retry the Task.", criteria_rewrites: [] },
  ],
  recommended_option: 0,
  ...patch,
});

/** A blockerRunner whose Worker keeps returning criteriaPartial; `explain` answers runDecisionExplanation (undefined: the runner has none). */
function explainingRunner(explain) {
  const runner = blockerRunner([criteriaPartial, criteriaPartial, criteriaPartial]);
  runner.state.explanationRequests = [];
  if (explain) {
    runner.runDecisionExplanation = async (request) => {
      runner.state.explanationRequests.push(request);
      return explain(request);
    };
  }
  return runner;
}

// The same partial twice is repaired automatically (kind 8) while a try is left; these tests are about partial_limit, so no try is left.
const limitOne = async (c) => {
  await c.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, partial_limit: 1 });
  await c.setAutoRecoverySettings({ limit: 0 });
};
const explanationOf = (db, workId) => {
  const row = db.get("SELECT id, explanation_json, options_json, recommended FROM decisions WHERE work_id = ? AND blocked_task_ids_json != '[]'", workId);
  return row && { id: row.id, explanation: JSON.parse(row.explanation_json), options: JSON.parse(row.options_json), recommended: row.recommended };
};
const openedEvents = (db, workId) => db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'decision.opened'", workId).map((row) => JSON.parse(row.payload_json));

test("two partial reports open one Decision, and the explanation, fix options and recommendation are added to it", async (t) => {
  const runner = explainingRunner(() => ({ ok: true, explanation: goodExplanation() }));
  const { db, core } = await openCore(t, runner, limitOne);
  runner.state.db = db;
  const workId = await startWork(core, "explained");

  assert.ok(await waitFor(() => explanationOf(db, workId)?.explanation.status === "ready"), `the explanation is ready (${JSON.stringify(explanationOf(db, workId))})`);
  const row = explanationOf(db, workId);
  assert.equal(openDecisions(db, workId), 1);
  assert.ok(row.explanation.summary.length > 0);
  assert.ok(["work", "criteria", "external"].includes(row.explanation.cause_kind));
  assert.deepEqual(row.options.map((option) => option.key), ["fix_1", "fix_2", "retry", "cancel"]);
  assert.equal(row.recommended, "fix_1");
  assert.deepEqual(findInternalTerms(row.explanation.summary, [t1Of(db, workId).id, workId, "T1", "AC1"]), []);
  assert.equal(db.get("SELECT state_version FROM decisions WHERE id = ?", row.id).state_version, 0, "adding the explanation does not bump state_version");

  assert.ok(await waitFor(() => openedEvents(db, workId).length === 1));
  const opened = openedEvents(db, workId)[0];
  assert.deepEqual(opened.explanation, { summary: row.explanation.summary, cause_kind: row.explanation.cause_kind });
  assert.equal(opened.recommended, "fix_1");

  assert.equal(runner.state.explanationRequests.length, 1, "one explanation job per Decision");
  const request = runner.state.explanationRequests[0];
  assert.equal(request.task.acceptance_criteria[0].text, GOOD_ACCEPTANCE);
  assert.equal(request.reports.length, 2);
  assert.match(request.reports[0].work_done, /finished/);
  assert.ok(request.verification, "the verification record is passed");
  assert.ok(request.forbidden_terms.includes("AC1"));
});

test("a criteria cause carries the reworded criterion with the original text copied from the Task", async (t) => {
  const runner = explainingRunner(() => ({ ok: true, explanation: goodExplanation() }));
  const { db, core } = await openCore(t, runner, limitOne);
  runner.state.db = db;
  const workId = await startWork(core, "criteria-cause");

  assert.ok(await waitFor(() => explanationOf(db, workId)?.explanation.status === "ready"));
  const row = explanationOf(db, workId);
  assert.equal(row.explanation.cause_kind, "criteria");
  const [rewrite] = row.options[0].criteria_rewrites;
  assert.equal(rewrite.before, GOOD_ACCEPTANCE);
  assert.equal(rewrite.after, CRITERIA_AFTER);
  assert.equal(rewrite.check, CRITERIA_CHECK);
});

test("a Decision opens with the plain text when the explanation cannot be made", async (t) => {
  const cases = {
    "no runDecisionExplanation": [undefined, "runner_unavailable"],
    "recommended_option out of range": [() => ({ ok: true, explanation: goodExplanation({ recommended_option: 5 }) }), "recommended_option out of range"],
    "summary with an internal term": [() => ({ ok: true, explanation: goodExplanation({ summary: "A partial report came back twice." }) }), "internal_terms"],
  };
  for (const [name, [explain, error]] of Object.entries(cases)) {
    const runner = explainingRunner(explain);
    const { db, core } = await openCore(t, runner, limitOne);
    runner.state.db = db;
    const workId = await startWork(core, `failed-${name.replaceAll(" ", "-")}`);

    assert.ok(await waitFor(() => explanationOf(db, workId)?.explanation.status === "failed"), `${name}: failed (${JSON.stringify(explanationOf(db, workId))})`);
    const row = explanationOf(db, workId);
    assert.equal(row.explanation.error, error, name);
    assert.deepEqual(row.options.map((option) => option.key), ["retry", "cancel"], name);
    assert.equal(row.recommended, null, name);
    assert.ok(await waitFor(() => openedEvents(db, workId).length === 1), `${name}: decision.opened is emitted`);
    assert.equal(openedEvents(db, workId)[0].explanation, undefined, name);
  }
});

test("choosing the recommended fix option sends its instruction to the Manager, reruns the Task and records the rewrite", async (t) => {
  const runner = explainingRunner(() => ({ ok: true, explanation: goodExplanation() }));
  const replans = [];
  runner.runManagerPlan = async (request) => {
    const mode = request.mode ?? request.context?.mode;
    if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask(GOOD_ACCEPTANCE)] } };
    replans.push(request);
    return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask(CRITERIA_AFTER)] } };
  };
  const { db, core, root } = await openCore(t, runner, limitOne);
  runner.state.db = db;
  const workId = await startWork(core, "choose-fix");
  assert.ok(await waitFor(() => explanationOf(db, workId)?.explanation.status === "ready"));
  const row = explanationOf(db, workId);
  const callsBefore = runner.state.t1Calls;

  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const api = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir });
  if (api === null) return t.skip("localhost listen is not permitted in this environment");
  const response = await api.request("POST", `/api/v1/decisions/${row.id}/answer`, envelope({ answer: row.options[0].label, option_key: "fix_1", source: "web", source_message_id: null }, "answer-fix"));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));

  assert.ok(await waitFor(() => replans.length === 1), "the Manager was asked to replan");
  const ownerRequests = JSON.stringify(replans[0].context.owner_requests);
  assert.match(ownerRequests, /Instruction: Reword the criterion and retry the Task\./);
  assert.ok(ownerRequests.includes(`\\"${GOOD_ACCEPTANCE}\\" -> \\"${CRITERIA_AFTER}\\"`), ownerRequests);
  assert.ok(await waitFor(() => db.get("SELECT acceptance FROM tasks WHERE id = ?", t1Of(db, workId).id).acceptance.includes(CRITERIA_AFTER)), "the Task's criterion was rewritten");
  assert.ok(await waitFor(() => runner.state.t1Calls > callsBefore), "the Worker ran the Task again");
  const resolved = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'decision.resolved'", workId).map((event) => JSON.parse(event.payload_json));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].chosen_option.criteria_rewrites[0].after, CRITERIA_AFTER);
});
