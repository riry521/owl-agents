import assert from "node:assert/strict";
import { test } from "node:test";

import { TRANSIENT_RETRY_LIMIT, createCore, reduceTask } from "../../packages/core/dist/index.js";
import { reduceTaskInTransaction } from "../../packages/core/dist/state-reducer.js";
import {
  DEFAULT_ATTEMPT_POLICY_CONFIG, REVIEWER_FAILURE_LIMIT, attemptAction, evaluate, normalizeErrorKey,
} from "../../packages/core/dist/attempt-policy.js";
import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../packages/shared/dist/progress-guard-settings.js";
import { DEFAULT_REVIEW_LIMIT_SETTINGS } from "../../packages/shared/dist/review-limit-settings.js";
import { openTestDatabase } from "../helpers/db.mjs";

// reduceTask attaches an Attempt Policy decision (action / reason) to every
// transition that is a decision, and reduceTaskInTransaction records it as one
// task.attempt_decided event. The transition itself is unchanged.

function taskRow(overrides = {}) {
  const now = "2026-09-24T00:00:00.000Z";
  return {
    id: "task-1", work_id: "work-1", parent_task_id: null, title: "A", type: "code", status: "running",
    review_override: "true", priority: "normal", context: "", acceptance: "Done.", state_version: 3,
    failure_count: 0, same_error_count: 0, last_error_key: null, last_error_generation: null,
    review_round: 0, reviewer_failure_count: 0, total_review_attempts: 0, worker_generation: 1,
    manager_task_id: "T1", retry_no: 0, next_attempt_at: null, worktree_path: null, worktree_state: null,
    last_failure_class: null, paused_from: null, created_at: now, updated_at: now, ...overrides,
  };
}

const det = (extra = {}) => ({ failure_class: "deterministic", error_key: "e", retry_allowed: true, ...extra });
const reviewer = { role: "reviewer", report_present: false, error_key: "reviewer_failed:x" };

// [name, row, event, payload, status, manager_trigger, action, reason]
const cases = [
  ["transient", { retry_no: 0 }, "task.failure.classified", { failure_class: "transient", retry_no: 1 }, "ready", false, "retry", "transient_failure"],
  ["rate limit", {}, "task.rate_limited", { provider: "p" }, "ready", false, "retry", "rate_limited"],
  ["deterministic retry", {}, "task.failure.classified", det(), "ready", false, "retry", "deterministic_failure"],
  ["escalated transient", {}, "task.failure.classified", det({ escalated_from: "transient" }), "ready", false, "retry", "transient_budget_exhausted"],
  ["deterministic threshold", { failure_count: 2 }, "task.failure.classified", det(), "failed", true, "replan", "deterministic_threshold"],
  ["retry not allowed", {}, "task.failure.classified", det({ retry_allowed: false }), "judgement_waiting", false, "owner_decision", "retry_not_allowed"],
  ["crash", {}, "agent.crashed", { report_present: false, error_key: "c" }, "ready", false, "retry", "crash"],
  ["crash threshold", { failure_count: 2 }, "agent.crashed", { report_present: false, error_key: "c" }, "failed", true, "replan", "crash_threshold"],
  ["worker replan", {}, "task.replan_requested", {}, "failed", true, "replan", "worker_replan_requested"],
  ["worker question", {}, "task.replan_requested", { question: "q" }, "failed", true, "replan", "worker_question"],
  ["acceptance defect", {}, "task.acceptance_defect_reported", { source: "worker" }, "failed", true, "replan", "acceptance_defect"],
  ["external blocker", {}, "task.external_blocker_reported", {}, "failed", true, "replan", "external_blocker"],
  ["reviewer crash", { status: "verifying" }, "agent.crashed", reviewer, "review_fix_waiting", false, "fix", "reviewer_crash"],
  ["reviewer crash threshold", { status: "verifying", reviewer_failure_count: 99 }, "agent.crashed", reviewer, "failed", true, "replan", "reviewer_crash_threshold"],
  ["verification failed", { status: "verifying" }, "verification.completed", { outcome: "fail" }, "review_fix_waiting", false, "fix", "verification_failed"],
  ["verification exhausted", { status: "verifying", review_round: 99 }, "verification.completed", { outcome: "fail" }, "failed", true, "replan", "verification_exhausted"],
  ["verified without review", { status: "verifying" }, "verification.completed", { outcome: "pass", review_required: false }, "completed", false, "complete", "verified_without_review"],
  ["review passed", { status: "verifying" }, "review.passed", { merge_exit_code: 0 }, "completed", false, "complete", "review_passed"],
  ["integration conflict", { status: "verifying" }, "review.passed", { merge_exit_code: 1, task_branch: "t", work_branch: "w" }, "failed", true, "replan", "integration_conflict"],
  ["integration commit failure", { status: "verifying" }, "review.passed", { merge_exit_code: 1, task_branch: "t", work_branch: "w", failure_kind: "commit_failure" }, "failed", true, "replan", "integration_commit_failed"],
  ["work sync conflict", { status: "ready" }, "task.conflict", { task_branch: "t", work_branch: "w" }, "failed", true, "replan", "work_sync_conflict"],
  ["review fix", { status: "verifying" }, "review.failed", { verdict: "fix_required" }, "review_fix_waiting", false, "fix", "review_fix_required"],
  ["review replan", { status: "verifying" }, "review.failed", { verdict: "replan_required" }, "failed", true, "replan", "review_replan_required"],
  ["review budget exceeded", { status: "verifying", total_review_attempts: 999 }, "review.failed", { verdict: "fix_required" }, "judgement_waiting", false, "owner_decision", "review_budget_exceeded"],
  ["dependency failed", { status: "waiting" }, "task.dependency_failed", { failed_dependency_task_id: "d" }, "failed", false, "fail", "dependency_failed"],
  ["dependency restored", { status: "failed" }, "task.dependency_restored", { restored_dependency_task_id: "d" }, "waiting", false, "wait", "dependency_restored"],
  ["replanned ready", { status: "failed" }, "task.replanned", { base_plan_version: 1, current_plan_version: 1, dependencies_completed: true }, "ready", false, "retry", "replanned"],
  ["replanned waiting", { status: "failed" }, "task.replanned", { base_plan_version: 1, current_plan_version: 1, dependencies_completed: false }, "waiting", false, "wait", "dependency_incomplete"],
  ["manager cannot continue", { status: "failed" }, "decision.opened", { issuer: "manager" }, "judgement_waiting", false, "owner_decision", "manager_cannot_continue"],
  ["no progress", { status: "ready" }, "decision.opened", { issuer: "core" }, "judgement_waiting", false, "owner_decision", "no_progress_limit"],
  ["blocked by decision", {}, "decision.opened", { blocks_task: true }, "judgement_waiting", false, "owner_decision", "blocked_by_decision"],
];

const COUNTERS = ["failure_count", "same_error_count", "reviewer_failure_count", "total_review_attempts", "review_round", "retry_no"];
const failure = { failure_count: 1, same_error_count: 1 };
const rescheduled = ["deterministic_retry_scheduled"];
const manager = ["manager_trigger_required"];
const reviewed = { total_review_attempts: 1 };
// name -> [side_effects, counters that change (all other counters stay as they were)]
const unchanged = {
  "transient": [["transient_retry_scheduled"], { retry_no: 1 }],
  "rate limit": [["provider_pause_scheduled"], {}],
  "deterministic retry": [rescheduled, failure],
  "escalated transient": [rescheduled, failure],
  "deterministic threshold": [manager, { failure_count: 3, same_error_count: 1 }],
  "retry not allowed": [["core_decision_required"], failure],
  "crash": [rescheduled, failure],
  "crash threshold": [manager, { failure_count: 3, same_error_count: 1 }],
  "worker replan": [manager, {}],
  "worker question": [manager, {}],
  "acceptance defect": [manager, {}],
  "external blocker": [manager, {}],
  "reviewer crash": [["replacement_worker_reserved"], { reviewer_failure_count: 1 }],
  "reviewer crash threshold": [manager, { reviewer_failure_count: 100 }],
  "verification failed": [["replacement_worker_reserved"], { review_round: 1 }],
  "verification exhausted": [manager, {}],
  "verified without review": [["dependencies_unlock"], {}],
  "review passed": [["git_merge_recorded", "worktree_removal_recorded"], reviewed],
  "integration conflict": [["git_merge_aborted", ...manager], { ...failure, ...reviewed }],
  "integration commit failure": [["git_commit_failed", ...manager], { ...failure, ...reviewed }],
  "work sync conflict": [["git_merge_aborted", ...manager], failure],
  "review fix": [["replacement_worker_reserved"], { ...reviewed, review_round: 1 }],
  "review replan": [manager, reviewed],
  "review budget exceeded": [["core_decision_required"], { total_review_attempts: 1000 }],
  "dependency failed": [["dependency_failure_cascaded"], {}],
  "dependency restored": [[], {}],
  "replanned ready": [["plan_revision_incremented"], {}],
  "replanned waiting": [["plan_revision_incremented"], {}],
  "manager cannot continue": [["decision_opened"], {}],
  "no progress": [["decision_opened"], {}],
  "blocked by decision": [["decision_opened"], {}],
};

for (const [name, row, event, payload, status, managerTrigger, action, reason] of cases) {
  test(`decision: ${name}`, () => {
    const before = taskRow(row);
    const result = reduceTask(before, { event, payload });
    assert.equal(result.next.status, status);
    assert.equal(result.manager_trigger, managerTrigger);
    const [effects, changed] = unchanged[name];
    assert.deepEqual(result.side_effects, effects);
    for (const key of COUNTERS) assert.equal(result.next[key], key in changed ? changed[key] : before[key], key);
    assert.deepEqual(result.decision, { action, reason, from: before.status, to: result.next.status });
  });
}

const { plan_review_rounds: planRounds, total_review_attempts: reviewLimit } = DEFAULT_REVIEW_LIMIT_SETTINGS;
const lineage = (extra = {}) => ({ otherReviewAttempts: 0, otherBaseSyncReviewAttempts: 0, limit: reviewLimit * 10, baseSyncLimit: reviewLimit * 10, generations: 1, ...extra });
const waitSpec = { source: "worker", reason: "r", conditions: [{ kind: "process", pid: 1, log_path: "l.log", description: "d" }], base_head: null, deadline_at: "2026-10-01T00:00:00.000Z", replan_question: null };
const stop = JSON.stringify({ trigger: "designer", rejections: null, limit: null, at: "2026-09-24T00:00:00.000Z" });
const failedReview = { verdict: "fix_required" };

// [name, row, event, payload, options, status, side_effects, manager_trigger, next fields, action, reason]
// Counters not listed in "next fields" must stay as they were.
const detailed = [
  ["process wait", {}, "task.process_wait_started", { prerequisite: waitSpec }, {}, "waiting", ["report_saved"], false, {}, "wait", "process_wait"],
  ["design blocked", { type: "design", design_stop_json: stop }, "task.rate_limited", { provider: "p" }, {}, "judgement_waiting", ["core_decision_required"], false, {}, "owner_decision", "design_blocked"],
  ["reviewer output invalid", { status: "verifying" }, "agent.crashed", { role: "reviewer", error_key: "output_format_invalid" }, {}, "judgement_waiting", ["core_decision_required"], false, {}, "owner_decision", "reviewer_output_invalid"],
  ["lineage budget", { status: "verifying" }, "review.failed", failedReview, { lineage: lineage({ limit: 3, otherReviewAttempts: 2 }) }, "judgement_waiting", ["core_decision_required"], false, { total_review_attempts: 1 }, "owner_decision", "lineage_budget_exhausted"],
  ["base sync lineage budget", { status: "verifying", base_sync_only: 1 }, "review.failed", failedReview, { lineage: lineage({ baseSyncLimit: 1 }) }, "judgement_waiting", ["core_decision_required"], false, { total_review_attempts: 1, base_sync_review_attempts: 1 }, "owner_decision", "base_sync_lineage_budget_exhausted"],
  ["lead rejections", { status: "verifying", type: "design", lead_designer_start_round: planRounds, design_escalated: 1 }, "review.failed", failedReview, { lineage: lineage({ leadRejectionLimit: 1 }) }, "review_fix_waiting", ["replacement_worker_reserved"], false, { total_review_attempts: 1, lead_review_rejections: 1 }, "fix", "lead_rejections_exhausted"],
  ["review budget reached", { status: "verifying", total_review_attempts: reviewLimit - 1 }, "review.failed", failedReview, {}, "failed", ["manager_trigger_required"], true, { total_review_attempts: reviewLimit }, "replan", "review_budget_reached"],
  ["design escalated to lead", { status: "verifying", type: "design", review_round: planRounds - 1 }, "review.failed", failedReview, {}, "review_fix_waiting", ["replacement_worker_reserved"], false, { total_review_attempts: 1, review_round: planRounds, lead_designer_start_round: planRounds, design_escalated: 1 }, "fix", "design_escalated_to_lead"],
  ["review fix retried", { status: "verifying" }, "review.failed", failedReview, {}, "review_fix_waiting", ["replacement_worker_reserved"], false, { total_review_attempts: 1, review_round: 1 }, "fix", "review_fix_required"],
  ["review fix out of rounds", { status: "verifying", review_round: planRounds }, "review.failed", failedReview, {}, "failed", ["manager_trigger_required"], true, { total_review_attempts: 1 }, "replan", "review_fix_required"],
  ["core cannot continue", { status: "failed" }, "decision.opened", { issuer: "core" }, {}, "judgement_waiting", ["decision_opened"], false, {}, "owner_decision", "core_cannot_continue"],
  ["prerequisite unreachable", { status: "waiting", prerequisite_json: "{}" }, "decision.opened", { issuer: "core" }, {}, "judgement_waiting", ["decision_opened"], false, {}, "owner_decision", "prerequisite_unreachable"],
];

for (const [name, row, event, payload, options, status, effects, managerTrigger, fields, action, reason] of detailed) {
  test(`decision: ${name} keeps next and side effects`, () => {
    const before = taskRow(row);
    const result = reduceTask(before, { event, payload }, options);
    assert.equal(result.next.status, status);
    assert.deepEqual(result.side_effects, effects);
    assert.equal(result.manager_trigger, managerTrigger);
    for (const key of ["failure_count", "same_error_count", "reviewer_failure_count", "total_review_attempts", "review_round", "lead_designer_start_round", "lead_review_rejections", "base_sync_review_attempts"]) {
      assert.equal(result.next[key] ?? 0, key in fields ? fields[key] : before[key] ?? 0, key);
    }
    assert.deepEqual(result.decision, { action, reason, from: before.status, to: status });
  });
}

test("decision: transient retries stop at the shared limit", () => {
  const classified = (retryNo) => ({ event: "task.failure.classified", payload: { failure_class: "transient", retry_no: retryNo } });
  assert.equal(reduceTask(taskRow(), classified(TRANSIENT_RETRY_LIMIT)).decision.reason, "transient_failure");
  assert.throws(() => reduceTask(taskRow(), classified(TRANSIENT_RETRY_LIMIT + 1)));
});

test("decision: Owner decision branches", () => {
  const waiting = taskRow({ status: "judgement_waiting" });
  const resolve = (payload) => reduceTask(waiting, { event: "decision.resolved", payload: { winner_commit: true, ...payload } });
  const toManager = resolve({ to_manager: true });
  assert.equal(toManager.next.status, "failed");
  assert.equal(toManager.manager_trigger, false);
  assert.deepEqual(toManager.side_effects, []);
  for (const key of ["failure_count", "same_error_count", "reviewer_failure_count", "total_review_attempts", "review_round"]) assert.equal(toManager.next[key], waiting[key], key);
  assert.deepEqual(toManager.decision, { action: "replan", reason: "owner_to_manager", from: "judgement_waiting", to: "failed" });
  const rerun = resolve({ rerun_review: true });
  assert.deepEqual(rerun.decision, { action: "review", reason: "owner_rerun_review", from: "judgement_waiting", to: "verifying" });
  assert.deepEqual([rerun.side_effects, rerun.manager_trigger], [[], false]);
  const answered = resolve({ dependencies_completed: true });
  assert.deepEqual(answered.decision, { action: "retry", reason: "owner_answer", from: "judgement_waiting", to: "ready" });
  assert.deepEqual([answered.side_effects, answered.manager_trigger], [["blocked_task_resumed"], false]);
  for (const result of [rerun, answered]) {
    for (const key of ["failure_count", "same_error_count", "reviewer_failure_count", "total_review_attempts", "review_round"]) assert.equal(result.next[key], waiting[key], key);
  }
});

test("decision: transitions that are not decisions carry none", () => {
  const started = reduceTask(taskRow({ status: "ready" }), { event: "task.started", payload: { capacity_acquired: true, launch_lease_acquired: true } });
  assert.equal(started.decision, undefined);
  const exited = reduceTask(taskRow(), { event: "agent.exited", payload: { outcome: "success", report_valid: true } });
  assert.equal(exited.next.status, "verifying");
  assert.equal(exited.decision, undefined);
  const reserved = reduceTask(taskRow({ status: "verifying" }), { event: "verification.completed", payload: { outcome: "pass", review_required: true } });
  assert.equal(reserved.decision, undefined);
});

test("task.attempt_decided is recorded once per decision, not for task.ready or a successful exit", async (t) => {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-attempt-decision-" });
  const core = createCore({ db, version: "t", owlRoot: root, dataDir: root, agentRunner: {} });
  t.after(async () => { await core.stop({ force: true }).catch(() => {}); });
  const lane = db.createWriteLane();
  const now = new Date().toISOString();
  await lane.transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W', 'owner:default', NULL, 'W', 'x', 'normal', 'running', '[]', '[]', ?, ?)`,
      now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count,
         review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES ('T1', 'W', 'T1', 'code', 'waiting', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      now, now,
    );
  });
  const count = () => db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'task.attempt_decided'").n;
  const reduce = (event, payload) => lane.transact((tx) => reduceTaskInTransaction(tx, "T1", { event, payload }));
  const start = (invocation) => reduce("task.started", { capacity_acquired: true, launch_lease_acquired: true, role: "worker", provider: "p", model: "m", invocation_id: invocation });
  await reduce("task.ready", { dependencies_completed: true });
  assert.equal(count(), 0);
  await start("i1");
  await reduce("task.rate_limited", { provider: "p" });
  assert.equal(count(), 1);
  const delivered = db.get("SELECT COUNT(*) AS n FROM outbox_deliveries WHERE event_id IN (SELECT id FROM events WHERE type = 'task.attempt_decided')").n;
  assert.equal(delivered, 0);
  const payload = JSON.parse(db.get("SELECT payload_json FROM events WHERE type = 'task.attempt_decided'").payload_json);
  assert.deepEqual([payload.action, payload.reason, payload.from, payload.to], ["retry", "rate_limited", "running", "ready"]);
  await start("i2");
  await reduce("agent.exited", { outcome: "success", report_valid: true });
  assert.equal(count(), 1);

  await lane.transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count,
         review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES ('T2', 'W', 'T2', 'code', 'judgement_waiting', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T2')`,
      now, now,
    );
  });
  await lane.transact((tx) => reduceTaskInTransaction(tx, "T2", { event: "decision.resolved", payload: { winner_commit: true, rerun_review: true } }));
  assert.equal(count(), 2);
  const rerun = JSON.parse(db.get("SELECT payload_json FROM events WHERE type = 'task.attempt_decided' ORDER BY rowid DESC").payload_json);
  assert.deepEqual([rerun.action, rerun.reason, rerun.to], ["review", "owner_rerun_review", "verifying"]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM outbox_deliveries WHERE event_id IN (SELECT id FROM events WHERE type = 'task.attempt_decided')").n, 0);
});

// AttemptPolicy.evaluate: the pure decision function. Observations carry the Task row as `task`.

const cfg = (over = {}) => ({ ...DEFAULT_ATTEMPT_POLICY_CONFIG, ...over });
const key64 = "e".repeat(64);
const decisionOf = (result) => {
  assert.equal(result.outcome, "decision");
  return result.decision;
};
const lineageLimits = (over = {}) => ({ reviewAttempts: 9, baseSyncReviewAttempts: 9, leadReviewRejections: 1, ...over });
const lineageSeen = (over = {}) => ({ otherReviewAttempts: 0, otherBaseSyncReviewAttempts: 0, generations: 1, ...over });
const reviewFailed = (task, over = {}) => ({
  kind: "review_failed", task: taskRow({ status: "verifying", ...task }), verdict: "fix_required", reviewAttemptsBase: undefined, lineage: null, ...over,
});

function deepFreeze(value) {
  for (const inner of Object.values(value)) if (inner && typeof inner === "object") deepFreeze(inner);
  return Object.freeze(value);
}

test("the default config holds today's thresholds", () => {
  const c = DEFAULT_ATTEMPT_POLICY_CONFIG;
  assert.equal(c.transientRetryLimit, TRANSIENT_RETRY_LIMIT);
  assert.equal(c.deterministicSameErrorLimit, 2);
  assert.equal(c.deterministicFailureLimit, 3);
  assert.equal(c.reviewerFailureLimit, REVIEWER_FAILURE_LIMIT);
  assert.equal(REVIEWER_FAILURE_LIMIT, 3);
  assert.equal(c.reviewLimits, DEFAULT_REVIEW_LIMIT_SETTINGS);
  assert.equal(c.lineageLimits, null);
  assert.equal(c.noProgressLimit, DEFAULT_PROGRESS_GUARD_SETTINGS.no_progress_limit);
  assert.equal(c.externalBlockerLimit, DEFAULT_PROGRESS_GUARD_SETTINGS.external_blocker_limit);
});

const blocked = (earlierReports, task = {}) => ({ kind: "external_blocker", task: taskRow(task), earlierReports });

test("external blocker: Manager up to the limit, Owner past it, the config moves the line", () => {
  const within = decisionOf(evaluate(blocked(0), cfg({ externalBlockerLimit: 2 })));
  assert.deepEqual([within.action, within.reason, within.to, within.managerTrigger], ["replan", "external_blocker", "failed", true]);
  assert.ok(!("failure_count" in within.patch) && !("same_error_count" in within.patch));
  assert.equal(decisionOf(evaluate(blocked(1), cfg({ externalBlockerLimit: 2 }))).action, "replan");
  const past = decisionOf(evaluate(blocked(2), cfg({ externalBlockerLimit: 2 })));
  assert.deepEqual([past.action, past.reason, past.to, past.managerTrigger, past.sideEffects], ["owner_decision", "external_blocker_limit", "judgement_waiting", false, ["core_decision_required"]]);
  assert.equal(decisionOf(evaluate(blocked(0), cfg({ externalBlockerLimit: 0 }))).action, "owner_decision");
  assert.equal(decisionOf(evaluate(blocked(15), cfg({ externalBlockerLimit: 20 }))).action, "replan");
});

test("external blocker is rejected unless the Task is running or with a bad count", () => {
  assert.equal(evaluate(blocked(0, { status: "verifying" }), cfg()).outcome, "reject");
  for (const bad of [-1, 1.5]) assert.equal(evaluate(blocked(bad), cfg()).outcome, "reject");
});

test("task.external_blocker_reported: the reducer counts the lineage and fails the Task for the Manager", async (t) => {
  const row = taskRow();
  const alone = reduceTask(row, { event: "task.external_blocker_reported", payload: {} });
  assert.equal(alone.next.status, "failed");
  assert.equal(alone.manager_trigger, true);

  const { root, db } = await openTestDatabase(t, { prefix: "owl-external-blocker-" });
  const lane = db.createWriteLane();
  const now = "2026-09-24T00:00:00.000Z";
  const insertTask = (id, status, extra = "", values = []) => lane.transact((tx) => tx.run(
    `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count,
       review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id, no_progress_count${extra ? ", " + extra.split("=")[0] : ""})
     VALUES (?, 'W', ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 1, ?, ?, 0, ?, 0${extra ? ", ?" : ""})`,
    id, id, status, now, now, id, ...values,
  ));
  await lane.transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(`INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
            VALUES ('W', 'owner:default', NULL, 'W', 'x', 'normal', 'running', '[]', '[]', ?, ?)`, now, now);
  });
  await insertTask("T0", "failed");
  await insertTask("T1", "running", "replaces_task_ids_json=", ['["T0"]']);
  await lane.transact((tx) => tx.run("UPDATE tasks SET lineage_root_task_id = 'T0' WHERE id IN ('T0', 'T1')"));
  let sequence = 0;
  const report = (at) => lane.transact((tx) => tx.run(
    `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at)
     VALUES (?, ?, ?, 'task.external_blocker_reported', 'W', 'T0', '{}', 'handled', ?)`,
    `E${++sequence}`, sequence, `k${sequence}`, at,
  ));
  await report(now);
  await report(now);
  await lane.transact((tx) => tx.run("UPDATE tasks SET status = 'running' WHERE id = 'T1'"));
  const reduce = () => lane.transact((tx) => reduceTaskInTransaction(tx, "T1", { event: "task.external_blocker_reported", payload: { agent_run_id: null } }));
  const limit = (n) => lane.transact((tx) => tx.run("INSERT OR REPLACE INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('progress_guard', 'owner:default', '1.0.0', ?, ?)", JSON.stringify({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, external_blocker_limit: n }), now));
  await limit(2);
  const past = await reduce();
  assert.equal(past.next.status, "judgement_waiting");

  await lane.transact((tx) => tx.run("UPDATE tasks SET status = 'running', lineage_reset_json = ? WHERE id = 'T0'", JSON.stringify({ at: "2026-09-25T00:00:00.000Z", review_attempts: 0 })));
  await lane.transact((tx) => tx.run("UPDATE tasks SET status = 'running' WHERE id = 'T1'"));
  const reset = await reduce();
  assert.equal(reset.next.status, "failed");
  assert.equal(db.get("SELECT no_progress_count AS n FROM tasks WHERE id = 'T1'").n, 0);
});

test("evaluate is pure: same result twice, and frozen inputs are accepted", () => {
  const observation = deepFreeze(reviewFailed({ review_round: 1 }));
  const config = deepFreeze(cfg({ lineageLimits: lineageLimits() }));
  const first = evaluate({ ...observation, lineage: lineageSeen() }, config);
  assert.deepStrictEqual(evaluate({ ...observation, lineage: lineageSeen() }, config), first);
  const integration = deepFreeze({
    kind: "integration", task: taskRow({ status: "verifying" }), merge: { outcome: "merged", worktreeRetained: false },
    successReason: "review_passed", successSideEffects: [], countReview: true,
  });
  assert.equal(evaluate(integration, config).outcome, "decision");
});

test("transient failure: bounds and the configured limit", () => {
  const observe = (retryNo) => ({ kind: "transient_failure", task: taskRow(), retryNo, nextAttemptAt: "2026-09-24T00:00:30.000Z" });
  assert.deepEqual(evaluate(observe(0), cfg()), { outcome: "reject", message: "The transient retry number must be a positive integer." });
  const atLimit = decisionOf(evaluate(observe(TRANSIENT_RETRY_LIMIT), cfg()));
  assert.deepEqual([atLimit.to, atLimit.action, atLimit.reason], ["ready", "retry", "transient_failure"]);
  assert.deepEqual(atLimit.patch, { retry_no: TRANSIENT_RETRY_LIMIT, next_attempt_at: "2026-09-24T00:00:30.000Z" });
  assert.deepEqual(evaluate(observe(TRANSIENT_RETRY_LIMIT + 1), cfg()), { outcome: "reject", message: "The transient retry budget is exhausted." });
  assert.equal(evaluate(observe(2), cfg({ transientRetryLimit: 1 })).outcome, "reject");
});

test("deterministic failure: retry_not_allowed wins, thresholds decide retry or fail, config moves the line", () => {
  const observe = (task, over = {}) => ({
    kind: "deterministic_failure", task: taskRow(task), errorKey: key64, retryAllowed: true, escalatedFromTransient: false, ...over,
  });
  const blocked = decisionOf(evaluate(observe({ failure_count: 5 }, { retryAllowed: false }), cfg()));
  assert.deepEqual([blocked.to, blocked.reason, blocked.managerTrigger, blocked.patch.paused_from], ["judgement_waiting", "retry_not_allowed", false, null]);
  const retry = decisionOf(evaluate(observe({ failure_count: 1 }), cfg()));
  assert.deepEqual([retry.to, retry.reason], ["ready", "deterministic_failure"]);
  assert.equal(decisionOf(evaluate(observe({ failure_count: 1 }, { escalatedFromTransient: true }), cfg())).reason, "transient_budget_exhausted");
  const total = decisionOf(evaluate(observe({ failure_count: 2 }), cfg()));
  assert.deepEqual([total.to, total.action, total.reason, total.managerTrigger], ["failed", "replan", "deterministic_threshold", true]);
  const repeated = { failure_count: 0, same_error_count: 1, last_error_key: key64, last_error_generation: 1 };
  assert.equal(decisionOf(evaluate(observe(repeated), cfg())).reason, "deterministic_threshold");
  assert.equal(decisionOf(evaluate(observe({ ...repeated, last_error_generation: 0 }), cfg())).reason, "deterministic_failure");
  assert.equal(decisionOf(evaluate(observe({ failure_count: 2 }), cfg({ deterministicFailureLimit: 4 }))).reason, "deterministic_failure");
  assert.equal(decisionOf(evaluate(observe(repeated), cfg({ deterministicSameErrorLimit: 3 }))).reason, "deterministic_failure");
});

test("worker crash: retry below the threshold, crash_threshold at it, counters land in the patch", () => {
  const observe = (task) => ({ kind: "worker_crash", task: taskRow(task), errorKey: "c" });
  const retry = decisionOf(evaluate(observe({ failure_count: 1 }), cfg()));
  assert.deepEqual([retry.to, retry.action, retry.reason], ["ready", "retry", "crash"]);
  assert.equal(retry.patch.failure_count, 2);
  assert.equal(retry.patch.same_error_count, 1);
  assert.equal(retry.patch.last_error_key, normalizeErrorKey("c"));
  const stop = decisionOf(evaluate(observe({ failure_count: 2 }), cfg()));
  assert.deepEqual([stop.to, stop.reason, stop.managerTrigger], ["failed", "crash_threshold", true]);
});

test("reviewer crash: fix below the limit, threshold at it, the config moves the line", () => {
  const observe = (count) => ({ kind: "reviewer_crash", task: taskRow({ status: "verifying", reviewer_failure_count: count }) });
  const below = decisionOf(evaluate(observe(REVIEWER_FAILURE_LIMIT - 2), cfg()));
  assert.deepEqual([below.to, below.action, below.reason], ["review_fix_waiting", "fix", "reviewer_crash"]);
  assert.equal(below.patch.reviewer_failure_count, REVIEWER_FAILURE_LIMIT - 1);
  const at = decisionOf(evaluate(observe(REVIEWER_FAILURE_LIMIT - 1), cfg()));
  assert.deepEqual([at.to, at.reason, at.managerTrigger], ["failed", "reviewer_crash_threshold", true]);
  assert.equal(decisionOf(evaluate(observe(REVIEWER_FAILURE_LIMIT - 1), cfg({ reviewerFailureLimit: 4 }))).reason, "reviewer_crash");
});

test("verification failure: fix while review_round < plan_review_rounds, then exhausted", () => {
  const observe = (review_round) => ({ kind: "verification_failed", task: taskRow({ status: "verifying", review_round }) });
  const planRounds = DEFAULT_REVIEW_LIMIT_SETTINGS.plan_review_rounds;
  const fix = decisionOf(evaluate(observe(planRounds - 1), cfg()));
  assert.deepEqual([fix.to, fix.reason, fix.patch.review_round], ["review_fix_waiting", "verification_failed", planRounds]);
  const done = decisionOf(evaluate(observe(planRounds), cfg()));
  assert.deepEqual([done.to, done.reason, done.managerTrigger], ["failed", "verification_exhausted", true]);
});

test("review failure: lineage limit comes before the total review budget", () => {
  const config = cfg({ lineageLimits: lineageLimits({ reviewAttempts: 3 }) });
  const total = DEFAULT_REVIEW_LIMIT_SETTINGS.total_review_attempts;
  const result = decisionOf(evaluate(reviewFailed({ total_review_attempts: total + 4 }, { lineage: lineageSeen({ generations: 2 }) }), config));
  assert.equal(result.reason, "lineage_budget_exhausted");
  assert.equal(result.lineageBudget.reason, "lineage_review_attempts");
  assert.equal(result.lineageBudget.limit, 3);
  assert.equal(result.lineageBudget.generations, 2);
});

test("review failure: a base-sync generation stops at the base-sync lineage limit below the main limit", () => {
  const config = cfg({ lineageLimits: lineageLimits({ reviewAttempts: 50, baseSyncReviewAttempts: 2 }) });
  const result = decisionOf(evaluate(reviewFailed({ base_sync_only: 1 }, { lineage: lineageSeen({ otherBaseSyncReviewAttempts: 1 }) }), config));
  assert.equal(result.reason, "base_sync_lineage_budget_exhausted");
  assert.deepEqual([result.lineageBudget.reason, result.lineageBudget.attempts, result.lineageBudget.limit], ["base_sync_lineage_review_attempts", 2, 2]);
});

test("review failure: a partial lineage limit (undefined base-sync limit) never stops a base-sync generation", () => {
  const config = cfg({ lineageLimits: { reviewAttempts: 50 } });
  const result = decisionOf(evaluate(reviewFailed({ base_sync_only: 1 }, { lineage: lineageSeen({ otherBaseSyncReviewAttempts: 99 }) }), config));
  assert.equal(result.reason, "review_fix_required");
  assert.equal(result.lineageBudget, undefined);
});

test("review failure: lead rejection limit comes before the total budget and records a design stop; undefined skips it", () => {
  const task = { type: "design", lead_designer_start_round: 2, design_escalated: 1, review_round: 2, lead_review_rejections: 1, total_review_attempts: 99 };
  const config = cfg({ lineageLimits: lineageLimits({ reviewAttempts: 500, leadReviewRejections: 2 }) });
  const result = decisionOf(evaluate(reviewFailed(task, { lineage: lineageSeen({ otherLeadRejections: 0 }) }), config));
  assert.deepEqual([result.to, result.reason, result.designStop], ["review_fix_waiting", "lead_rejections_exhausted", { trigger: "lead_review_rejections", rejections: 2, limit: 2 }]);
  const skipped = decisionOf(evaluate(reviewFailed(task, { lineage: lineageSeen() }), cfg({ lineageLimits: lineageLimits({ reviewAttempts: 500, leadReviewRejections: undefined }) })));
  assert.equal(skipped.reason, "review_budget_exceeded");
});

test("review failure: without lineage the lineage and lead limits are not checked", () => {
  const task = { type: "design", lead_designer_start_round: 2, design_escalated: 1, review_round: 2, lead_review_rejections: 5 };
  assert.equal(decisionOf(evaluate(reviewFailed(task), cfg())).reason, "review_fix_required");
  assert.equal(decisionOf(evaluate(reviewFailed({ total_review_attempts: 50 }, { lineage: lineageSeen() }), cfg())).reason, "review_budget_exceeded");
});

test("review failure: over the budget asks the Owner, at the budget fails, and the base is subtracted", () => {
  const limit = DEFAULT_REVIEW_LIMIT_SETTINGS.total_review_attempts;
  const over = decisionOf(evaluate(reviewFailed({ total_review_attempts: limit }), cfg()));
  assert.deepEqual([over.to, over.reason, over.reviewBudget, over.patch.paused_from], ["judgement_waiting", "review_budget_exceeded", { attempts: limit + 1, limit }, null]);
  const at = decisionOf(evaluate(reviewFailed({ total_review_attempts: limit - 1 }), cfg()));
  assert.deepEqual([at.to, at.reason, at.managerTrigger, at.reviewBudget], ["failed", "review_budget_reached", true, { attempts: limit, limit }]);
  const rebased = decisionOf(evaluate(reviewFailed({ total_review_attempts: limit + 2 }, { reviewAttemptsBase: 3 }), cfg()));
  assert.equal(rebased.reviewBudget.attempts, limit);
  assert.equal(rebased.reason, "review_budget_reached");
});

test("review failure: replan_required fails before Lead escalation and before another fix round", () => {
  const planRounds = DEFAULT_REVIEW_LIMIT_SETTINGS.plan_review_rounds;
  const result = decisionOf(evaluate(reviewFailed({ type: "design", review_round: planRounds - 1 }, { verdict: "replan_required" }), cfg()));
  assert.deepEqual([result.to, result.reason, result.managerTrigger], ["failed", "review_replan_required", true]);
});

test("review failure: a design Task escalates to the Lead Designer on the last plan round", () => {
  const planRounds = DEFAULT_REVIEW_LIMIT_SETTINGS.plan_review_rounds;
  const result = decisionOf(evaluate(reviewFailed({ type: "design", review_round: planRounds - 1, lead_designer_start_round: null }), cfg()));
  assert.deepEqual([result.to, result.reason, result.patch.review_round, result.patch.lead_designer_start_round], ["review_fix_waiting", "design_escalated_to_lead", planRounds, planRounds]);
  assert.equal(result.patch.design_escalated, 1);
});

test("review failure: a design Task that began at Lead (design_mode=lead) is not stopped by the Lead rejection limit", () => {
  const started = decisionOf(evaluate(reviewFailed({ type: "design", lead_designer_start_round: 0, design_escalated: 0, review_round: 0 }, { lineage: lineageSeen() }), cfg({ lineageLimits: lineageLimits() })));
  assert.deepEqual([started.to, started.reason], ["review_fix_waiting", "review_fix_required"]);
  assert.equal(started.patch.lead_review_rejections, 0);
});

test("review failure: an escalated design Task is stopped by the Lead rejection limit", () => {
  const escalated = decisionOf(evaluate(reviewFailed({ type: "design", lead_designer_start_round: 0, design_escalated: 1, review_round: 0 }, { lineage: lineageSeen() }), cfg({ lineageLimits: lineageLimits() })));
  assert.equal(escalated.reason, "lead_rejections_exhausted");
});

test("review failure: fix rounds end at the last retry round (the Lead start round once the Lead began)", () => {
  const planRounds = DEFAULT_REVIEW_LIMIT_SETTINGS.plan_review_rounds;
  const fix = decisionOf(evaluate(reviewFailed({ review_round: planRounds - 1 }), cfg()));
  assert.deepEqual([fix.to, fix.reason, fix.patch.review_round], ["review_fix_waiting", "review_fix_required", planRounds]);
  const exhausted = decisionOf(evaluate(reviewFailed({ review_round: planRounds }), cfg()));
  assert.deepEqual([exhausted.to, exhausted.reason, exhausted.managerTrigger], ["failed", "review_fix_required", true]);
  const leadTask = { type: "design", lead_designer_start_round: 4 };
  assert.equal(decisionOf(evaluate(reviewFailed({ ...leadTask, review_round: 4 }), cfg())).to, "review_fix_waiting");
  assert.equal(decisionOf(evaluate(reviewFailed({ ...leadTask, review_round: 5 }), cfg())).to, "failed");
  assert.equal(decisionOf(evaluate(reviewFailed({ review_round: planRounds - 1 }), cfg({ reviewLimits: { ...DEFAULT_REVIEW_LIMIT_SETTINGS, plan_review_rounds: planRounds + 1 } }))).patch.review_round, planRounds);
});

test("review failure: every outcome records the review counts", () => {
  const outcomes = [
    reviewFailed({ total_review_attempts: 50 }),
    reviewFailed({ total_review_attempts: DEFAULT_REVIEW_LIMIT_SETTINGS.total_review_attempts - 1 }),
    reviewFailed({}, { verdict: "replan_required" }),
    reviewFailed({ review_round: 0, total_review_attempts: 1, base_sync_only: 1 }),
    reviewFailed({ review_round: 9 }),
  ];
  for (const observation of outcomes) {
    const { patch } = decisionOf(evaluate(observation, cfg()));
    assert.equal(patch.total_review_attempts, observation.task.total_review_attempts + 1);
    assert.equal(typeof patch.base_sync_review_attempts, "number");
    assert.equal(typeof patch.lead_review_rejections, "number");
  }
  assert.equal(decisionOf(evaluate(outcomes[3], cfg())).patch.base_sync_review_attempts, 1);
});

test("integration: a merge completes the Task and resets the failure counters", () => {
  const observe = (merge, over = {}) => ({
    kind: "integration", task: taskRow({ status: "verifying", failure_count: 2, reviewer_failure_count: 2 }), merge,
    successReason: "verified_without_review", successSideEffects: ["dependencies_unlock"], countReview: false, ...over,
  });
  const merged = decisionOf(evaluate(observe({ outcome: "merged", worktreeRetained: false }), cfg()));
  assert.deepEqual([merged.to, merged.reason, merged.patch.failure_count, merged.patch.reviewer_failure_count, merged.patch.worktree_state], ["completed", "verified_without_review", 0, 0, "merged"]);
  assert.deepEqual(merged.sideEffects.slice(-2), ["git_merge_recorded", "worktree_removal_recorded"]);
  assert.equal(merged.sideEffects[0], "dependencies_unlock");
  const retained = decisionOf(evaluate(observe({ outcome: "merged", worktreeRetained: true }), cfg()));
  assert.deepEqual([retained.patch.worktree_state, retained.sideEffects.at(-1)], ["retained", "worktree_retained"]);
  const commit = decisionOf(evaluate(observe({ outcome: "commit_failure", taskBranch: "t", workBranch: "w" }), cfg()));
  assert.deepEqual([commit.to, commit.reason, commit.patch.worktree_state, commit.managerTrigger], ["failed", "integration_commit_failed", "active", true]);
  const conflict = decisionOf(evaluate(observe({ outcome: "conflict", taskBranch: "t", workBranch: "w" }), cfg()));
  assert.deepEqual([conflict.reason, conflict.patch.worktree_state, conflict.patch.failure_count], ["integration_conflict", "conflict_retained", 3]);
});

test("integration: countReview adds a review attempt whatever the merge result, base-sync too", () => {
  const observe = (merge, task = {}) => ({
    kind: "integration", task: taskRow({ status: "verifying", total_review_attempts: 2, base_sync_review_attempts: 1, ...task }), merge,
    successReason: "review_passed", successSideEffects: [], countReview: true,
  });
  const merged = decisionOf(evaluate(observe({ outcome: "merged", worktreeRetained: false }), cfg()));
  assert.deepEqual([merged.patch.total_review_attempts, merged.patch.base_sync_review_attempts], [3, 1]);
  const failed = decisionOf(evaluate(observe({ outcome: "conflict", taskBranch: "t", workBranch: "w" }, { base_sync_only: 1 }), cfg()));
  assert.deepEqual([failed.patch.total_review_attempts, failed.patch.base_sync_review_attempts], [3, 2]);
});

test("work sync conflict: fails for the Manager without touching worktree_state", () => {
  const result = decisionOf(evaluate({ kind: "work_sync_conflict", task: taskRow({ status: "ready" }), taskBranch: "t", workBranch: "w" }, cfg()));
  assert.deepEqual([result.to, result.reason, result.managerTrigger, result.patch.next_attempt_at], ["failed", "work_sync_conflict", true, null]);
  assert.equal("worktree_state" in result.patch, false);
});

test("acceptance defect: worker while running and reviewer while verifying fail; other pairs are rejected", () => {
  const observe = (source, status) => ({ kind: "acceptance_defect", task: taskRow({ status }), source });
  for (const [source, status] of [["worker", "running"], ["reviewer", "verifying"]]) {
    const result = decisionOf(evaluate(observe(source, status), cfg()));
    assert.deepEqual([result.to, result.action, result.reason], ["failed", "replan", "acceptance_defect"]);
  }
  const rejected = evaluate(observe("worker", "verifying"), cfg());
  assert.equal(rejected.outcome, "reject");
  assert.match(rejected.message, /from worker is not valid while the Task is verifying/);
});

test("design stop: stores the designer default only when no stop was saved, otherwise reports the saved one", () => {
  const observe = (task, stop) => ({ kind: "design_stop", task: taskRow({ type: "design", ...task }), stop, source: "core", report: null });
  const fresh = decisionOf(evaluate(observe({ design_stop_json: null }, null), cfg()));
  assert.deepEqual(fresh.designStop, { trigger: "designer", rejections: null, limit: null });
  assert.deepEqual([fresh.to, fresh.reason, fresh.designBlock.trigger, fresh.designBlock.source], ["judgement_waiting", "design_blocked", "designer", "core"]);
  const saved = { trigger: "lead_review_rejections", rejections: 2, limit: 2 };
  const kept = decisionOf(evaluate(observe({ design_stop_json: JSON.stringify(saved) }, saved), cfg()));
  assert.equal(kept.designStop, undefined);
  assert.deepEqual([kept.designBlock.trigger, kept.designBlock.rejections, kept.designBlock.limit], ["lead_review_rejections", 2, 2]);
});

test("no-progress gate: continues below the limit and stops at it", () => {
  const limit = DEFAULT_PROGRESS_GUARD_SETTINGS.no_progress_limit;
  assert.deepEqual(evaluate({ kind: "no_progress_gate", noProgressCount: limit - 1 }, cfg()), { outcome: "continue" });
  assert.deepEqual(evaluate({ kind: "no_progress_gate", noProgressCount: limit }, cfg()), { outcome: "stop", reason: "no_progress_limit" });
  assert.equal(evaluate({ kind: "no_progress_gate", noProgressCount: limit }, cfg({ noProgressLimit: limit + 1 })).outcome, "continue");
});

test("evaluate's action is attemptAction(to, managerTrigger, reason) and from is the Task status", () => {
  const observations = [
    { kind: "worker_crash", task: taskRow({ failure_count: 2 }), errorKey: "c" },
    { kind: "reviewer_crash", task: taskRow({ status: "verifying" }) },
    reviewFailed({ review_round: 0 }),
    { kind: "work_sync_conflict", task: taskRow({ status: "ready" }), taskBranch: "t", workBranch: "w" },
  ];
  for (const observation of observations) {
    const decision = decisionOf(evaluate(observation, cfg()));
    assert.equal(decision.action, attemptAction(decision.to, decision.managerTrigger, decision.reason));
    assert.equal(decision.from, observation.task.status);
  }
});

test("evaluate throws on an unknown observation kind instead of returning a default decision", () => {
  assert.throws(() => evaluate({ kind: "no_such_kind", task: taskRow() }, cfg()), /Unknown attempt observation kind: no_such_kind/);
});

// reduceTask applies evaluate()'s decision as it is: the same Observation given to
// AttemptPolicy.evaluate() yields the same ReductionResult.decision and next status.
function assertReducerFollowsEvaluate(row, command, observation) {
  const expected = decisionOf(evaluate(observation, cfg()));
  const result = reduceTask(row, command);
  assert.deepEqual(result.decision, { action: expected.action, reason: expected.reason, from: expected.from, to: expected.to });
  assert.equal(result.next.status, expected.to);
  return result;
}

test("reducer applies evaluate: transient retries just below and at the limit", () => {
  const classified = (retryNo) => ({ event: "task.failure.classified", payload: { failure_class: "transient", retry_no: retryNo } });
  for (const retryNo of [TRANSIENT_RETRY_LIMIT - 1, TRANSIENT_RETRY_LIMIT]) {
    assertReducerFollowsEvaluate(taskRow(), classified(retryNo), { kind: "transient_failure", task: taskRow(), retryNo, nextAttemptAt: null });
  }
  assert.throws(() => reduceTask(taskRow(), classified(TRANSIENT_RETRY_LIMIT + 1)), /transient retry budget is exhausted/);
  assert.equal(evaluate({ kind: "transient_failure", task: taskRow(), retryNo: TRANSIENT_RETRY_LIMIT + 1, nextAttemptAt: null }, cfg()).outcome, "reject");
});

test("reducer applies evaluate: the same deterministic error retries once, then stops", () => {
  const command = { event: "task.failure.classified", payload: det({ error_key: key64 }) };
  const observe = (task) => ({ kind: "deterministic_failure", task, errorKey: key64, retryAllowed: true, escalatedFromTransient: false });
  const first = taskRow();
  assert.equal(assertReducerFollowsEvaluate(first, command, observe(first)).next.status, "ready");
  const repeated = taskRow({ same_error_count: 1, last_error_key: key64, last_error_generation: 1 });
  assert.equal(assertReducerFollowsEvaluate(repeated, command, observe(repeated)).next.status, "failed");
});

test("reducer applies evaluate: a Worker crash retries below the failure threshold and fails at it", () => {
  const command = { event: "agent.crashed", payload: { report_present: false, error_key: "c" } };
  for (const [failure_count, status] of [[1, "ready"], [2, "failed"]]) {
    const row = taskRow({ failure_count });
    assert.equal(assertReducerFollowsEvaluate(row, command, { kind: "worker_crash", task: row, errorKey: "c" }).next.status, status);
  }
});

test("reducer applies evaluate: a Reviewer failure fixes below the limit and fails at it", () => {
  const command = { event: "agent.crashed", payload: reviewer };
  for (const [reviewer_failure_count, status] of [[REVIEWER_FAILURE_LIMIT - 2, "review_fix_waiting"], [REVIEWER_FAILURE_LIMIT - 1, "failed"]]) {
    const row = taskRow({ status: "verifying", reviewer_failure_count });
    assert.equal(assertReducerFollowsEvaluate(row, command, { kind: "reviewer_crash", task: row }).next.status, status);
  }
});

test("reducer applies evaluate: a review failure fixes below the review limit and stops at it", () => {
  const limit = DEFAULT_REVIEW_LIMIT_SETTINGS.total_review_attempts;
  const command = { event: "review.failed", payload: { verdict: "fix_required" } };
  for (const total_review_attempts of [limit - 2, limit - 1]) {
    const row = taskRow({ status: "verifying", total_review_attempts });
    const observation = { kind: "review_failed", task: row, verdict: "fix_required", reviewAttemptsBase: undefined, lineage: null };
    assertReducerFollowsEvaluate(row, command, observation);
  }
});

test("reducer applies evaluate: a merged review pass completes and a conflict fails for replanning", () => {
  const row = taskRow({ status: "verifying" });
  const base = { kind: "integration", task: row, successReason: "review_passed", successSideEffects: [], countReview: true };
  const merged = assertReducerFollowsEvaluate(row, { event: "review.passed", payload: { merge_exit_code: 0 } }, { ...base, merge: { outcome: "merged", worktreeRetained: false } });
  assert.equal(merged.next.status, "completed");
  const conflict = assertReducerFollowsEvaluate(row, { event: "review.passed", payload: { merge_exit_code: 1, task_branch: "t", work_branch: "w" } }, { ...base, merge: { outcome: "conflict", taskBranch: "t", workBranch: "w" } });
  assert.equal(conflict.next.status, "failed");
});
