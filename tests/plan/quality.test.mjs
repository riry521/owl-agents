import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluatePlanQuality, formatPlanQualityReason } from "../../packages/core/dist/plan-quality.js";
import { reviewerTaskView, roleTaskView } from "../../packages/core/dist/task-context.js";
import { createUlid } from "../../packages/db/dist/index.js";
import {
  DEFAULT_PLAN_QUALITY_SETTINGS,
  readPlanQualitySettings,
  validatePlanQualitySettings,
} from "../../packages/shared/dist/plan-quality-settings.js";
import { renderAcceptanceCriteria } from "../../packages/shared/dist/acceptance-criteria.js";
import { createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const S = DEFAULT_PLAN_QUALITY_SETTINGS;

const necessity = { serves: "test fixture", if_omitted: "test fixture" };
const criterion = (n, text = `item ${n} is satisfied`, extra = {}) => ({ id: `AC${n}`, text, check: "node --test the touched file", serves: "test fixture", if_omitted: "test fixture", check_weight: "light", weight_reason: "", ...extra });
const criteria = (count) => Array.from({ length: count }, (_, i) => criterion(i + 1));
const item = (list, extra = {}) => ({ id: "t1", title: "Change `foo` in packages/core/src/foo.ts", type: "code", acceptance: renderAcceptanceCriteria(list), acceptance_criteria: list, necessity, ...extra });
const codes = (items, settings = S) => evaluatePlanQuality(items, settings).map((warning) => warning.code);

test("evaluatePlanQuality: each code fires only above its threshold", () => {
  assert.deepEqual(codes([item(criteria(S.max_acceptance_items))]), []);
  assert.deepEqual(codes([item(criteria(S.max_acceptance_items + 1))]), ["acceptance_items_over"]);

  const padded = (n) => [criterion(1, "x".repeat(n - "node --test the touched file".length))];
  assert.deepEqual(codes([item(padded(S.max_acceptance_chars))]), []);
  assert.deepEqual(codes([item(padded(S.max_acceptance_chars + 1))]), ["acceptance_chars_over"]);

  assert.deepEqual(codes([item(criteria(S.max_acceptance_items + 1), { type: "design" })]), []);
});

test("evaluatePlanQuality: a missing or out-of-range field is a field warning, not a guess from the text", () => {
  const field = (extra) => evaluatePlanQuality([item([criterion(1, "x", extra)])], S);
  assert.deepEqual(field({ check: "" }).map((w) => [w.code, w.measured]), [["criterion_field_missing", ["acceptance_criteria[1].check"]]]);
  assert.deepEqual(field({ check_weight: "huge" }).map((w) => w.code), ["criterion_field_missing"]);
  assert.deepEqual(field({ check_weight: "heavy", weight_reason: "" }).map((w) => w.code), ["criterion_field_missing"]);
  for (const key of ["text", "check", "serves", "id"]) {
    const { [key]: _omitted, ...rest } = criterion(1);
    assert.deepEqual(codes([{ ...item(criteria(1)), acceptance_criteria: [rest] }]), ["criterion_field_missing"], `${key} omitted`);
  }
  assert.deepEqual(codes([item([criterion(2)])]), ["criterion_field_missing"]);
  assert.deepEqual(codes([item(criteria(1), { necessity: null })]), ["criterion_field_missing"]);
  assert.deepEqual(codes([{ ...item(criteria(1)), acceptance_criteria: undefined }]), ["criterion_field_missing"]);
});

test("evaluatePlanQuality: the same content written with other line breaks, numbering and wording gives no warning", () => {
  const plain = item([criterion(1, "Rename the field.", { check: "node --test tests/a.test.mjs" })]);
  const reworded = item([criterion(1, "(1)\n- the field is renamed\n", { check: "pnpm test  tests/a.test.mjs\n" })]);
  assert.deepEqual(codes([plain]), []);
  assert.deepEqual(codes([reworded]), []);
  assert.deepEqual(evaluatePlanQuality([plain], S), evaluatePlanQuality([reworded], S));
});

test("evaluatePlanQuality: patterns read only the content and check fields, and come from the settings", () => {
  const prod = (extra) => item([criterion(1, "本番のデータが前後で変わらない", extra)]);
  assert.deepEqual(codes([prod({})]), ["external_state_comparison"]);
  assert.deepEqual(codes([item([criterion(1, "ok", { serves: "本番のデータが前後で変わらない", if_omitted: "本番 unchanged" })])]), []);
  assert.deepEqual(codes([item([criterion(1, "Run it on 全件")])]), ["heavy_check_unjustified"]);
  assert.deepEqual(codes([item([criterion(1, "Run it on 全件", { weight_reason: "the request needs it" })])]), []);
  assert.deepEqual(codes([prod({})], { ...S, state_comparison_patterns: ["nothing-matches"] }), []);
  const reason = formatPlanQualityReason(evaluatePlanQuality([prod({})], S));
  assert.match(reason, /t1/);
  assert.match(reason, /external_state_comparison/);
});

test("plan quality settings: defaults on missing keys, strict on PUT", () => {
  assert.deepEqual(readPlanQualitySettings({}), S);
  assert.equal(readPlanQualitySettings({ max_acceptance_items: "x", max_components: 9 }).max_acceptance_items, S.max_acceptance_items);
  assert.equal(readPlanQualitySettings({ max_components: 9 }).max_components, 9);
  assert.deepEqual(validatePlanQualitySettings({ ...S }), S);
  assert.throws(() => validatePlanQualitySettings({ ...S, component_patterns: ["("] }));
  assert.throws(() => validatePlanQualitySettings({ ...S, extra: 1 }));
});

const managerTask = (id, list) => ({
  id, title: `${id} title`, type: "code", acceptance: renderAcceptanceCriteria(list), acceptance_criteria: list, necessity, depends_on: [], required_sections: [], required_tests: [], replaces: [], context: "", notes: "", review: false,
});

async function openCore(t, plans, seen, onCall = () => {}) {
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  t.after(() => release());
  const { db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async (request) => {
        seen.push(request.context?.previous_output_feedback ? JSON.stringify(request.context.previous_output_feedback) : null);
        onCall(request);
        const tasks = plans[Math.min(seen.length, plans.length) - 1];
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks } };
      },
      runWorker: async () => {
        await gate;
        return { outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" };
      },
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
    },
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-plan-quality-", start: true });
  return { db, core };
}

async function startWork(core) {
  const created = await core.createWork({
    request_id: createUlid(), idempotency_key: `test:create:${createUlid()}`, expected_version: 0,
    payload: { title: "W", summary: "x", size: "normal", project_id: null },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, {
    request_id: createUlid(), idempotency_key: `test:start:${createUlid()}`, expected_version: created.version,
    payload: { mode: "normal" },
  });
  return workId;
}

const warnedEvents = (db, workId) =>
  db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.plan_quality_warned' ORDER BY sequence", workId)
    .map((row) => JSON.parse(row.payload_json));
const taskCount = (db, workId) => db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n;

const tooBig = criteria(S.max_acceptance_items + 4);
const small = criteria(1);

test("initial plan: an over-threshold plan is sent back to the Manager with the warnings, then applied", async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[managerTask("A", tooBig)], [managerTask("A", small)]], seen);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => taskCount(db, workId) === 1));
  assert.equal(seen.length, 2);
  assert.equal(seen[0], null);
  assert.match(seen[1], /"kind":"quality_repair"/);
  assert.match(seen[1], /acceptance_items_over/);
  const events = warnedEvents(db, workId);
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "plan");
  assert.equal(events[0].outcome, "repair_requested");
  assert.equal(events[0].warnings[0].code, "acceptance_items_over");
  const keys = db.all("SELECT idempotency_key FROM events WHERE work_id = ? AND type = 'work.plan_quality_warned'", workId).map((row) => row.idempotency_key);
  assert.deepEqual(keys, [`plan-quality:${workId}:${events[0].manager_agent_run_id}`]);
  assert.ok(db.get("SELECT id FROM agent_runs WHERE id = ? AND role = 'manager'", events[0].manager_agent_run_id), "the event points at the Manager run that produced the plan");
});

test("initial plan: still over the limit on the last call plan_rejection_attempts_max allows is accepted unchanged with a warning record", async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[managerTask("A", tooBig)]], seen);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => taskCount(db, workId) === 1));
  assert.equal(seen.length, 3, "repair requests up to the default limit of three calls");
  assert.deepEqual(warnedEvents(db, workId).map((event) => event.outcome), ["repair_requested", "repair_requested", "accepted_with_warnings"]);
  const runIds = warnedEvents(db, workId).map((event) => event.manager_agent_run_id);
  assert.equal(new Set(runIds).size, 3, "each Manager call gets its own warning record");
  assert.equal(taskCount(db, workId), 1, "the Task is not split mechanically");
});

test("initial plan: a plan within the thresholds gets no warning and no repair request", async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[managerTask("A", small)]], seen);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => taskCount(db, workId) === 1));
  assert.equal(seen.length, 1);
  assert.deepEqual(warnedEvents(db, workId), []);
});

test("initial plan: the settings stored through Core change the threshold", async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[managerTask("A", tooBig)]], seen);
  await core.setPlanQualitySettings({ ...S, max_acceptance_items: 50, max_acceptance_chars: 5000 });
  const workId = await startWork(core);
  assert.ok(await waitFor(() => taskCount(db, workId) === 1));
  assert.equal(seen.length, 1);
  assert.deepEqual(warnedEvents(db, workId), []);
});

test("a Task stored with a free-text acceptance reads as one legacy criterion for the Worker, the Reviewer and the Manager view", () => {
  const legacy = { id: "x", work_id: "w", title: "T", type: "code", status: "ready", state_version: 0, updated_at: "", parent_task_id: null, acceptance: "1. a\n2. b", acceptance_criteria_json: null, context: "", review_round: 0, failure_count: 0, worker_generation: 0, review_override: null };
  const expected = [{ id: "AC1", text: "1. a\n2. b", check: "", serves: "", if_omitted: "", check_weight: null, weight_reason: "", legacy: true }];
  assert.deepEqual(roleTaskView(legacy, []).acceptance_criteria, expected);
  assert.deepEqual(reviewerTaskView({ ...legacy, acceptance_criteria_json: "{broken" }, []).acceptance_criteria, expected);
  const structured = [criterion(1)];
  const view = roleTaskView({ ...legacy, acceptance: renderAcceptanceCriteria(structured), acceptance_criteria_json: JSON.stringify(structured) }, []);
  assert.deepEqual(view.acceptance_criteria, structured);
  assert.equal("acceptance" in view, false);
  assert.equal("acceptance" in reviewerTaskView(legacy, []), false);
});

test("a Task's plan context reaches the Worker and the Reviewer as separate fields; one without plan_context_json keeps tasks.context whole", () => {
  const row = { id: "x", work_id: "w", title: "T", type: "code", status: "ready", state_version: 0, updated_at: "", parent_task_id: null, acceptance: "a", acceptance_criteria_json: null, plan_context_json: null, context: "ctx\n\nManager notes:\nn", review_round: 0, failure_count: 0, worker_generation: 0, review_override: null };
  const legacyFields = { context: row.context, manager_notes: null, necessity: null, plan_context_legacy: true };
  for (const view of [roleTaskView(row, []), reviewerTaskView(row, [])]) assert.deepEqual({ context: view.context, manager_notes: view.manager_notes, necessity: view.necessity, plan_context_legacy: view.plan_context_legacy }, legacyFields);
  const necessity = { serves: "s", if_omitted: "o" };
  const stored = { ...row, plan_context_json: JSON.stringify({ context: "ctx", notes: "n", necessity }) };
  for (const view of [roleTaskView(stored, []), reviewerTaskView(stored, [])]) {
    assert.deepEqual({ context: view.context, manager_notes: view.manager_notes, necessity: view.necessity }, { context: "ctx", manager_notes: "n", necessity });
    assert.equal("plan_context_legacy" in view, false);
  }
});

test("initial plan: the same content with other line breaks, numbering and wording is registered at once, with no repair request", async (t) => {
  const seen = [];
  const reworded = [criterion(1, "(1)\n- the field is renamed\n", { check: "pnpm test  tests/a.test.mjs\n" })];
  const { db, core } = await openCore(t, [[managerTask("A", reworded)]], seen);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => taskCount(db, workId) === 1));
  assert.equal(seen.length, 1);
  assert.deepEqual(warnedEvents(db, workId), []);
});

const startedRecords = (db, workId) =>
  db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'recovery.started' ORDER BY sequence", workId)
    .map((row) => JSON.parse(row.payload_json));
const decisionCount = (db, workId) => db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n;

test("initial plan: a quality rejection opens no Decision at first and retries on the next tick with the same feedback; the Decision comes after the limit", async (t) => {
  const seen = [];
  const atCall = [];
  const ref = { db: null, workId: null };
  const { db, core } = await openCore(t, [[managerTask("A", [criterion(1, "本番のデータが前後で変わらない")])]], seen, () => {
    if (ref.workId === null) return;
    atCall.push({ decisions: decisionCount(ref.db, ref.workId), started: startedRecords(ref.db, ref.workId).length, state: ref.db.get("SELECT state FROM works WHERE id = ?", ref.workId).state });
  });
  ref.db = db;
  const workId = await startWork(core);
  ref.workId = workId;
  assert.ok(await waitFor(() => decisionCount(db, workId) === 1), "after the limit a Decision opens");

  // Calls 1 to 3 are one tick (repair requests, then the rejection on the last allowed call); call 4 is the next tick after the first recovery.
  assert.equal(seen[0], null);
  assert.match(seen[1], /"kind":"quality_repair"/);
  assert.match(seen[2], /"kind":"quality_repair"/);
  assert.match(seen[3], /"kind":"quality_rejected"/);
  assert.equal(seen.length, 9, "three ticks of plan_rejection_attempts_max calls each, none after the Decision");
  assert.equal(atCall[3].decisions, 0);
  assert.equal(atCall[3].started, 1);
  assert.notEqual(atCall[3].state, "judgement_waiting");

  const records = startedRecords(db, workId);
  assert.deepEqual(records.map((record) => [record.kind, record.attempt_no, record.counted]), [["plan_quality_rejected", 1, true], ["plan_quality_rejected", 2, true]]);
  assert.equal(JSON.parse(records[0].previous_failure.detail).kind, "quality_rejected");
  assert.deepEqual(JSON.parse(seen[3]), JSON.parse(records[0].previous_failure.detail), "the next tick retries with the feedback of the last rejection");
  const decision = db.get("SELECT tried FROM decisions WHERE work_id = ?", workId);
  assert.match(decision.tried, /自動で試したこと|Tried automatically/);
});

test("initial plan: a validator rejection (plan_rejected) opens no Decision at first and keeps the feedback for the next tick; the Decision comes after the limit", async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[managerTask("A", [criterion(1)]), managerTask("A", [criterion(1)])]], seen);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => decisionCount(db, workId) === 1), "after the limit a Decision opens");

  assert.equal(seen[0], null);
  assert.match(seen[1], /"kind":"plan_rejected"/);
  assert.equal(seen[2], seen[1], "the next call keeps the last feedback");
  const records = startedRecords(db, workId);
  assert.deepEqual(records.map((record) => [record.kind, record.attempt_no, record.counted]), [["plan_quality_rejected", 1, true], ["plan_quality_rejected", 2, true]]);
  assert.equal(JSON.parse(records[0].previous_failure.detail).kind, "plan_rejected");
  assert.match(db.get("SELECT tried FROM decisions WHERE work_id = ?", workId).tried, /自動で試したこと|Tried automatically/);
});

test("initial plan: a plan the parser rejects (criteria_relaxations not a list) goes back to the Manager with the Task and field named, then the fixed plan is registered", async (t) => {
  const seen = [];
  const bad = { ...managerTask("A", small), auto_recovery: { criteria_relaxations: "AC1" } };
  const { db, core } = await openCore(t, [[bad], [bad], [managerTask("A", small)]], seen);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => taskCount(db, workId) === 1));
  assert.equal(seen.length, 3);
  assert.equal(seen[0], null);
  for (const feedback of seen.slice(1)) {
    assert.match(feedback, /"kind":"fields_missing"/);
    assert.match(feedback, /Task A: .*criteria_relaxations must be a list of criterion_id, reason and keeps/);
  }
  assert.equal(decisionCount(db, workId), 0);
  assert.equal(startedRecords(db, workId).length, 0, "no recovery was started before the limit");
});

test("evaluatePlanQuality: an owner criterion needs a quote found in the Owner's words, and is then exempt from the weight checks", () => {
  const ownerTexts = ["Please check the 本番のデータ\n and run it on 全件 before release."];
  const owner = (quote, text = "ok", extra = {}) => item([criterion(1, text, { origin: { kind: "owner", source: "summary", quote }, ...extra })]);
  const run = (list) => evaluatePlanQuality(list, S, ownerTexts).map((warning) => warning.code);
  assert.deepEqual(run([owner("")]), ["criterion_origin_unquoted"]);
  assert.deepEqual(run([owner("never said this")]), ["criterion_origin_unquoted"]);
  assert.deepEqual(run([owner("check the 本番のデータ and run it")]), []);
  assert.deepEqual(run([owner("全件 before release", "Run it on 全件")]), []);
  assert.deepEqual(run([owner("本番のデータ", "本番のデータが前後で変わらない")]), []);
  assert.deepEqual(run([item([criterion(1, "Run it on 全件", { origin: { kind: "manager", source: null, quote: "" } })])]), ["heavy_check_unjustified"]);
});

test("evaluatePlanQuality: an owner criterion keeps the requirement of the Work summary section it quotes; other sources are not checked", () => {
  const summary = "依頼: x\n\n受け入れ条件:\n- The build passes\n\n目標:\n- Add at least 10 tests";
  const owner = (quote, requirement, source = "summary") => item([criterion(1, "ok", { origin: { kind: "owner", source, quote }, ...(requirement === undefined ? {} : { requirement }) })]);
  const run = (list) => evaluatePlanQuality(list, S, [summary, "Make it required"], summary).map((warning) => warning.code);
  assert.deepEqual(run([owner("Add at least 10 tests", "required")]), ["criterion_requirement_mismatch"]);
  assert.deepEqual(run([owner("Add at least 10 tests", "goal")]), []);
  assert.deepEqual(run([owner("The build passes", "goal")]), ["criterion_requirement_mismatch"]);
  assert.deepEqual(run([owner("The build passes", "required")]), []);
  assert.deepEqual(run([owner("The build passes", undefined)]), [], "no requirement reads as required");
  assert.deepEqual(run([owner("Make it required", "goal", "instruction")]), [], "an instruction quote is not checked");
  assert.deepEqual(run([owner("Make it required", "required", "decision_answer")]), []);
});

test("the default plan quality settings make criterion_requirement_mismatch blocking", () => {
  assert.ok(S.blocking_codes.includes("criterion_requirement_mismatch"));
});
