import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { lineageUsage } from "../../packages/core/dist/task-lineage.js";
import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../packages/shared/dist/progress-guard-settings.js";
import { DEFAULT_REMAKE_LIMIT_SETTINGS } from "../../packages/shared/dist/remake-limit-settings.js";
import { ACCEPTANCE_DEFECT_EVENT } from "../../packages/shared/dist/acceptance-defect.js";
import { buildReviewerPrompt, parseReviewResultWithFeedback } from "../../packages/agent-runtime/dist/reviewer.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";
import os from "node:os";
// Some runners start tests with an empty environment; child processes need PATH and HOME.
process.env.PATH ||= [process.execPath.replace(/\/[^/]+$/u, ""), "/usr/bin", "/bin"].join(":");
process.env.HOME ||= os.homedir();

// A Reviewer that says a criterion cannot be proven inside the Task is not a
// review: Core sends the criterion to the Manager on the same Task and the
// verdict counts toward neither review_limits nor lineage_review_attempts.

const BAD_CRITERION = "The live server data directory is unchanged before and after the run.";
const REASON = "The live server is outside the Task, so no command the Task runs can compare it.";
const GOOD_ACCEPTANCE = "A copy of the data directory made inside the Task is unchanged; verified by node --test tests/copy.test.mjs.";
const TESTS = { ran: false, command: "none", passed: 0, failed: 0 };

const passedReport = (invocationId, acceptance) => ({
  kind: "report",
  schema_version: "1.1.0",
  invocation_id: invocationId,
  result: "success",
  work_done: "Implemented.",
  delegation: { decomposition: "kept together", delegated: [], retained: [] },
  changes: [],
  verification: {
    status: "passed",
    method: "Ran the tests.",
    acceptance: [{ criterion_id: "AC1", criterion: acceptance, status: "passed", evidence: "node --test passed" }],
    checks: [],
    integration_check: null,
  },
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: null,
});

const MANAGER = { kind: "manager", source: null, quote: "" };
const OWNER = { kind: "owner", source: "summary", quote: "unprovable criterion" };
const RELAX = { reason: "The live server is outside the Task.", keeps: "A copy made inside the Task is unchanged." };

/** A Task whose only criterion is AC1 with the given origin (undefined: no origin). A loosening names its entry in auto_recovery. */
const planTask = (text, origin, relax = false) => ({
  id: "T1", title: "A", type: "code",
  necessity: { serves: "test fixture", if_omitted: "test fixture" },
  acceptance_criteria: [{ id: "AC1", text, check: "node --test tests/x.test.mjs", serves: "test fixture", if_omitted: "test fixture", check_weight: "light", weight_reason: "", kind: "work_check", ...(origin ? { origin } : {}) }],
  auto_recovery: { criteria_relaxations: relax ? [{ criterion_id: "AC1", ...RELAX }] : [] },
  depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true,
});

/**
 * The first review reports BAD_CRITERION as unprovable; the Manager rewrites it; the next review passes.
 * With alwaysDefect every review reports it, so the recovery limit is what ends the loop.
 */
function runner({ origin = MANAGER, alwaysDefect = false } = {}) {
  const state = { workerCalls: 0, reviewCalls: 0, replanRequests: [] };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask(BAD_CRITERION, origin)] } };
      if (mode === "replan") {
        state.replanRequests.push(request);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask(GOOD_ACCEPTANCE, origin, true)] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      await writeFile(join(request.context.worktree, "src/feature.mjs"), `export const f = ${state.workerCalls};\n`);
      return { outcome: "success", report_valid: true, report: passedReport(request.invocation_id, state.workerCalls === 1 ? BAD_CRITERION : GOOD_ACCEPTANCE) };
    },
    runReviewer: async () => {
      state.reviewCalls += 1;
      if (alwaysDefect || state.reviewCalls === 1) {
        const review = {
          verdict: "acceptance_defect",
          summary: "One criterion cannot be proven.",
          findings: [],
          acceptance_defects: [{ criterion_id: "AC1", criterion: BAD_CRITERION, reason: REASON, suggestion: "Compare a copy made inside the Task." }],
          tests: TESTS,
        };
        return { outcome: "failed", report_valid: true, report: review, review, failure_class: "deterministic", error_key: "review:acceptance_defect", retry_allowed: false };
      }
      const review = { verdict: "pass", summary: "Looks right.", findings: [], acceptance_defects: [], tests: TESTS };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

const tasksOf = (db, workId) => db.all("SELECT id, status, acceptance, review_round, total_review_attempts FROM tasks WHERE work_id = ? ORDER BY created_at", workId);

async function run(t, configure, { until = (rows) => rows[0]?.status === "completed", ...options } = {}) {
  const fake = runner(options);
  const { db, core } = await createTestCore(t, { agentRunner: fake, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-reviewer-defect-", start: true });
  // The plan quality gate would reject the unprovable starting criterion before the path under test runs.
  await disablePlanQuality(db);
  if (configure) await configure(core);
  const created = await core.createWork(command({ title: "defect", summary: "Reviewer reports an unprovable criterion.", size: "normal", project_id: null }, "test:create"));
  await core.startWork(created.data.work_id, command({ mode: "normal" }, "test:start", created.version));
  const workId = created.data.work_id;
  assert.ok(await waitFor(() => until(tasksOf(db, workId), db, workId), { message: "the expected state" }), `the expected state is reached (${JSON.stringify(tasksOf(db, workId))})`);
  return { fake, db, workId };
}

test("an acceptance_defect review goes to the Manager on the same Task and is not counted as a review", async (t) => {
  const { fake, db, workId } = await run(t);
  const [task] = tasksOf(db, workId);
  assert.equal(tasksOf(db, workId).length, 1, "no replacement Task was created");
  assert.match(task.acceptance, new RegExp(GOOD_ACCEPTANCE.slice(0, 30)));
  assert.equal(fake.state.workerCalls, 2);
  assert.equal(fake.state.reviewCalls, 2);

  const event = db.get("SELECT agent_run_id, payload_json FROM events WHERE work_id = ? AND type = ?", workId, ACCEPTANCE_DEFECT_EVENT);
  assert.ok(event, "task.acceptance_defect_reported was recorded");
  const payload = JSON.parse(event.payload_json);
  assert.equal(payload.source, "reviewer");
  assert.equal(payload.defects[0].criterion, BAD_CRITERION);
  const reviewerRun = db.get("SELECT role, status, outcome FROM agent_runs WHERE id = ?", event.agent_run_id);
  assert.deepEqual({ ...reviewerRun }, { role: "reviewer", status: "completed", outcome: "replan" });

  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'review.failed'", workId).n, 0);
  assert.deepEqual(db.all("SELECT verdict FROM reviews WHERE task_id = ?", task.id).map((r) => r.verdict), ["pass"]);
  assert.equal(task.total_review_attempts, 1, "only the passing review is counted");
  assert.equal(lineageUsage(db, task.id, DEFAULT_REMAKE_LIMIT_SETTINGS).review_attempts, 1);

  const brief = fake.state.replanRequests[0].context.failed_tasks[0];
  assert.equal(brief.failure.kind, "acceptance_defect");
  assert.equal(brief.acceptance_defects[0].criterion, BAD_CRITERION);
  assert.equal(brief.acceptance_defects[0].reason, REASON);
  assert.equal(fake.state.replanRequests[0].trigger.kind, "task_failed");

  // Kind 7 recovery: no Decision, one recovery.started, and the loosening is on record in the replan's transaction.
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND blocked_task_ids_json != '[]'", workId).n, 0, "no Task Decision was opened");
  const started = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'recovery.started'", workId).map((row) => JSON.parse(row.payload_json));
  assert.deepEqual(started.map((entry) => entry.kind), ["criteria_too_strict"]);
  const relaxed = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'criteria.relaxed'", workId).map((row) => JSON.parse(row.payload_json));
  assert.equal(relaxed.length, 1);
  assert.equal(relaxed[0].criterion_id, "AC1");
  assert.equal(relaxed[0].original.text, BAD_CRITERION);
  assert.equal(relaxed[0].relaxed.text, GOOD_ACCEPTANCE);
  assert.equal(relaxed[0].reason, RELAX.reason);
  assert.equal(relaxed[0].keeps, RELAX.keeps);
  const stored = JSON.parse(db.get("SELECT acceptance_criteria_json AS json FROM tasks WHERE id = ?", task.id).json);
  assert.equal(stored[0].text, GOOD_ACCEPTANCE, "the Task's criteria were rewritten");
});

const openDecisions = (db, workId) => db.all("SELECT reason, tried, options_json FROM decisions WHERE work_id = ? AND status = 'open' AND blocked_task_ids_json != '[]'", workId);
const hasDecision = (_rows, db, workId) => openDecisions(db, workId).length > 0;

for (const [label, origin] of [["an Owner criterion", OWNER], ["a criterion with no origin", null]]) {
  test(`a defect on ${label} opens the criteria Decision at once and the Manager is not asked`, async (t) => {
    const { fake, db, workId } = await run(t, undefined, { origin, until: hasDecision });
    const [decision] = openDecisions(db, workId);
    assert.match(decision.reason, /AC1/);
    assert.ok(JSON.parse(decision.options_json).some((option) => option.key === "rewrite_criteria"), "the rewrite option is offered");
    assert.equal(fake.state.replanRequests.length, 0, "no automatic replan");
    assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type IN ('recovery.started', 'criteria.relaxed')", workId).n, 0);
  });
}

test("a defect after the recovery limit is used up opens the criteria Decision with what was tried automatically", async (t) => {
  const { fake, db, workId } = await run(t, async (core) => { await core.setAutoRecoverySettings({ limit: 1 }); }, { alwaysDefect: true, until: hasDecision });
  assert.equal(fake.state.replanRequests.length, 1, "the Manager loosened the criterion once");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'recovery.started'", workId).n, 1);
  const [decision] = openDecisions(db, workId);
  assert.match(decision.tried, /自動で試したこと/);
});

test("the tightest review, remake and no_progress limits do not stop the rewrite", async (t) => {
  const { db, workId } = await run(t, async (core) => {
    await core.setReviewLimitSettings({ plan_review_rounds: 1, total_review_attempts: 2 });
    await core.setRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_review_attempts: 1 });
    await core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: 1 });
  });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND blocked_task_ids_json != '[]'", workId).n, 0, "no Task Decision was opened");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type IN ('task.no_progress_limited', 'review.failed')", workId).n, 0);
});

const reviewStdout = (patch) => JSON.stringify({
  verdict: "pass", summary: "s", findings: [], tests: TESTS, skills_used: [], skill_proposals: [], ...patch,
});
const parse = (patch) => parseReviewResultWithFeedback({ adapter: "claude", format: "plain-text", stdout: reviewStdout(patch) }).review;
const mismatch = (error) => error.code === "review_invalid" && error.reason === "acceptance_defect_without_defects";
const DEFECT = { criterion_id: "AC1", reason: REASON, suggestion: "" };
const criterion = (id, text) => ({ id, text, check: "c", serves: "s", if_omitted: "i", check_weight: "light", weight_reason: "" });
const TASK = { acceptance: `(1) ${BAD_CRITERION}`, acceptance_criteria: [criterion("AC1", BAD_CRITERION), criterion("AC2", "second")] };
const parseFor = (task, patch) => parseReviewResultWithFeedback({ adapter: "claude", format: "plain-text", stdout: reviewStdout(patch) }, task).review;

test("the Reviewer points at criteria by id: the quote comes from the Task and an unknown id is review_invalid", () => {
  const [defect] = parseFor(TASK, { verdict: "acceptance_defect", acceptance_defects: [DEFECT] }).acceptance_defects;
  assert.deepEqual({ ...defect }, { criterion_id: "AC1", criterion: BAD_CRITERION, reason: REASON, suggestion: "" });
  assert.throws(() => parseFor(TASK, { verdict: "acceptance_defect", acceptance_defects: [{ ...DEFECT, criterion_id: "AC9" }] }), (error) => error.code === "review_invalid" && /unknown_criterion_id:AC9/.test(error.reason));
  assert.throws(() => parseFor(TASK, { verdict: "acceptance_defect", acceptance_defects: [{ ...DEFECT, criterion_id: "" }] }), (error) => error.code === "review_invalid");
  assert.throws(() => parseFor(TASK, { verdict: "acceptance_defect", acceptance_defects: [DEFECT, DEFECT] }), (error) => error.code === "review_invalid" && /duplicate_criterion_id:AC1/.test(error.reason));
  const quoted = { ...DEFECT, criterion: BAD_CRITERION };
  assert.throws(() => parseFor(TASK, { verdict: "acceptance_defect", acceptance_defects: [quoted] }), (error) => error.code === "review_invalid" && /review_output_schema/.test(error.reason));
});

test("a legacy free-text Task reads as AC1 and a defect that points at AC1 is accepted", () => {
  const legacy = { acceptance: "do the thing", acceptance_criteria: [{ ...criterion("AC1", "do the thing"), check_weight: null, legacy: true }] };
  assert.equal(parseFor(legacy, { verdict: "acceptance_defect", acceptance_defects: [DEFECT] }).acceptance_defects[0].criterion, "do the thing");
  assert.throws(() => parseFor(legacy, { verdict: "acceptance_defect", acceptance_defects: [{ ...DEFECT, criterion_id: "AC2" }] }), (error) => error.code === "review_invalid");
});

test("file and line of a finding are separate fields and are kept as given", () => {
  const finding = { severity: "major", target: "deliverable", scope: "in_scope", subject: "other", file: "src/a.mjs", line: 42, problem: "p", reason: "r", fix: "f" };
  const [saved] = parseFor(TASK, { verdict: "fix_required", findings: [finding] }).findings;
  assert.equal(saved.file, "src/a.mjs");
  assert.equal(saved.line, 42);
  assert.throws(() => parseFor(TASK, { verdict: "fix_required", findings: [{ ...finding, file: "src/a.mjs:42", line: "42" }] }), (error) => error.code === "review_invalid");
});

test("the Reviewer output accepts acceptance_defect only together with defects, and drops defects of other verdicts", () => {
  assert.equal(parse({ verdict: "acceptance_defect", acceptance_defects: [DEFECT] }).acceptance_defects.length, 1);
  assert.throws(() => parse({ verdict: "acceptance_defect", acceptance_defects: [] }), mismatch);
  assert.throws(() => parse({ verdict: "acceptance_defect" }), mismatch);
  assert.deepEqual(parse({ verdict: "fix_required", acceptance_defects: [DEFECT] }).acceptance_defects, [], "defects with another verdict are dropped");
  assert.deepEqual(parse({ verdict: "fix_required" }).acceptance_defects, [], "older output without the field still parses");
  assert.deepEqual(parse({}).acceptance_defects, []);
});

test("the Reviewer prompt says when to use acceptance_defect and how it differs from fix_required", () => {
  const prompt = buildReviewerPrompt({ task: { id: "t", title: "t", acceptance: "a", type: "code", review_round: 0 }, report: { changes: [] } });
  assert.match(prompt, /verdict "acceptance_defect"/);
  assert.match(prompt, /that is fix_required/);
  assert.match(prompt, /does not count as a review attempt/);
});
