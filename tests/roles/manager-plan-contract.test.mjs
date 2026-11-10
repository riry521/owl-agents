import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The Manager prompt asks only for {"tasks":[...]}. A provider that follows
// the prompt exactly must still yield a plan Core accepts.
const criterion = { id: "AC1", text: "Migration applies cleanly.", check: "node --test tests/db/migration.test.mjs", serves: "archiving", if_omitted: "no archive", check_weight: "light", weight_reason: "", kind: "work_check" };
const promptCompliantPlan = {
  tasks: [
    { id: "T1", title: "Add archived_at migration", type: "code", acceptance_criteria: [criterion], necessity: { serves: "archiving", if_omitted: "no archive" }, depends_on: [], required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, assigned_designer: null, replaces: [], context: "", notes: "", review: null },
  ],
};

function runnerReturning(body) {
  return createAgentRunner({
    adapter: "claude-cli/v1",
    provider: {
      execute: async (request) => ({
        adapter: request.adapter,
        stdout: JSON.stringify(body),
        stderr: "",
        exit_code: 0,
        signal: null,
        format: "plain-text",
      }),
    },
  });
}

test("Core-shaped Manager plan without an explicit event is reported as work.planned", async () => {
  const runner = runnerReturning(promptCompliantPlan);
  const result = await runner.runManagerPlan({
    invocation_id: "manager-plan-no-event",
    work_id: "work-plan-no-event",
    task_id: null,
    attempt: 1,
    context: { mode: "plan", work: { id: "work-plan-no-event", title: "Archive Works", summary: "Hide finished Works." } },
  });
  assert.equal(result.outcome, "success");
  assert.equal(result.report.event, "work.planned");
  assert.equal(result.report.tasks.length, 1);
  assert.deepEqual(result.report.tasks[0].acceptance_criteria, [criterion]);
  assert.match(result.report.tasks[0].acceptance, /Migration applies cleanly\./u);
});

test("Manager plan with only a free-text acceptance, or an unnumbered criterion, is a format violation", async () => {
  const { acceptance_criteria: _drop, ...rest } = promptCompliantPlan.tasks[0];
  for (const task of [{ ...rest, acceptance: "Migration applies cleanly." }, { ...promptCompliantPlan.tasks[0], acceptance_criteria: [{ ...criterion, id: "2" }] }]) {
    const result = await runnerReturning({ tasks: [task] }).runManagerPlan({ work: { id: "work-legacy-plan", title: "Archive Works" }, mode: "plan" }).catch((error) => error);
    assert.match(String(result.code ?? result.error_key ?? result.message), /manager_plan_invalid|manager_output_schema/u);
  }
});

test("role-shaped Manager plan without an explicit event is reported as work.planned", async () => {
  const runner = runnerReturning(promptCompliantPlan);
  const result = await runner.runManagerPlan({ work: { id: "work-role-plan", title: "Archive Works" }, mode: "plan" });
  assert.equal(result.event, "work.planned");
});

test("Manager plan still rejects an event that contradicts the requested mode", async () => {
  const runner = runnerReturning({ ...promptCompliantPlan, event: "work.completed" });
  const result = await runner.runManagerPlan({
    invocation_id: "manager-plan-bad-event",
    work_id: "work-plan-bad-event",
    task_id: null,
    attempt: 1,
    context: { mode: "plan", work: { id: "work-plan-bad-event", title: "Archive Works" } },
  });
  assert.notEqual(result.outcome, "success");
});

test("A Core-issued Decision carries the actual tick failure instead of the generic reconcile text", async (t) => {
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "manager-failure-marker" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-core-decision-reason-", start: true });
  const created = await core.createWork(command({
    title: "Decision reason test",
    summary: "The Manager plan fails.",
    size: "normal",
    project_id: null,
  }, "test:decision-reason-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, command({ mode: "normal" }, "test:decision-reason-start", created.version));
  const decision = await waitFor(
    () => db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId),
    { timeoutMs: 5_000, message: "a Decision opened for the owner" },
  );
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  assert.match(decision.reason, /manager-failure-marker/u);
  assert.doesNotMatch(decision.reason, /Core could not safely reconcile/u);
});

test("acceptance criteria require a valid kind, stored criteria without kind still read, and requestsSpecTest needs a spec_test", async () => {
  const { validateAcceptanceCriteria, readStoredAcceptanceCriteria, requestsSpecTest } = await import("../../packages/shared/dist/acceptance-criteria.js");
  const { kind, ...noKind } = criterion;
  assert.equal(validateAcceptanceCriteria([criterion]), null);
  assert.match(validateAcceptanceCriteria([noKind]), /acceptance_criteria\[1\]\.kind/u);
  assert.match(validateAcceptanceCriteria([{ ...criterion, kind: "other" }]), /acceptance_criteria\[1\]\.kind/u);
  assert.equal(readStoredAcceptanceCriteria(JSON.stringify([noKind]), "text")[0].legacy, undefined);
  assert.equal(readStoredAcceptanceCriteria(JSON.stringify([criterion]), "text")[0].kind, "work_check");
  assert.equal(requestsSpecTest([{ ...criterion, kind: "spec_test" }, noKind]), true);
  assert.equal(requestsSpecTest([criterion, noKind]), false);
  assert.equal(requestsSpecTest([]), false);
});

test("the Manager output schema requires kind", async () => {
  const { kind, ...noKind } = criterion;
  const runner = runnerReturning({ tasks: [{ ...promptCompliantPlan.tasks[0], acceptance_criteria: [noKind] }] });
  const result = await runner.runManagerPlan({ invocation_id: "manager-plan-no-kind", work_id: "w", task_id: null, attempt: 1, context: { mode: "plan", work: { id: "w", title: "T", summary: "" } } });
  assert.notEqual(result.outcome, "success");
});

test("a criterion without requirement reads as required, a goal is marked, and any other value is rejected", async () => {
  const { validateAcceptanceCriteria, readStoredAcceptanceCriteria, criterionRequirement, isGoalCriterion, renderAcceptanceCriteria } = await import("../../packages/shared/dist/acceptance-criteria.js");
  assert.equal(validateAcceptanceCriteria([criterion]), null);
  assert.equal(validateAcceptanceCriteria([{ ...criterion, requirement: "goal" }]), null);
  assert.equal(validateAcceptanceCriteria([{ ...criterion, requirement: "required" }]), null);
  assert.match(validateAcceptanceCriteria([{ ...criterion, requirement: "optional" }]), /acceptance_criteria\[1\]\.requirement/u);
  assert.equal(criterionRequirement(criterion), "required");
  assert.equal(criterionRequirement(readStoredAcceptanceCriteria(null, "free text")[0]), "required");
  assert.equal(criterionRequirement(readStoredAcceptanceCriteria(JSON.stringify([criterion]), "t")[0]), "required");
  assert.equal(isGoalCriterion({ requirement: "goal" }), true);
  assert.doesNotMatch(renderAcceptanceCriteria([criterion]), /\[goal\]/u);
  assert.match(renderAcceptanceCriteria([{ ...criterion, requirement: "goal" }]), /^\(1\) \[goal\] Migration/u);
});

test("the Manager output schemas take requirement, criterion_ref and goals_met as optional, and a plan keeps requirement", async () => {
  const { MANAGER_PLAN_OUTPUT_SCHEMA, finalizeOutputSchema } = await import("../../packages/shared/dist/manager-schema.js");
  const item = MANAGER_PLAN_OUTPUT_SCHEMA.properties.tasks.items.properties.acceptance_criteria.items;
  assert.ok(item.properties.requirement && !item.required.includes("requirement"));
  const verdict = finalizeOutputSchema(false).properties.verdict;
  const missing = verdict.properties.missing.items;
  assert.ok(missing.properties.criterion_ref && !missing.required.includes("criterion_ref"));
  assert.ok(verdict.properties.goals_met && !verdict.required.includes("goals_met"));
  const runner = runnerReturning({ tasks: [{ ...promptCompliantPlan.tasks[0], acceptance_criteria: [{ ...criterion, requirement: "goal" }] }] });
  const result = await runner.runManagerPlan({ invocation_id: "m-req", work_id: "w-req", task_id: null, attempt: 1, context: { mode: "plan", work: { id: "w-req", title: "t", summary: "s" } } });
  assert.equal(result.outcome, "success");
  assert.equal(result.report.tasks[0].acceptance_criteria[0].requirement, "goal");
});

// A criterion that asks for the whole test suite is Core's job at the end of the Work, not a Worker's inside its time limit.
const crit = (id, text, check = "node --test tests/x.test.mjs") => ({ ...criterion, id, text, check });

test("work_full_test_run is a boolean in the plan and replan schemas and reaches the parsed plan, defaulting to false", async () => {
  const { MANAGER_PLAN_OUTPUT_SCHEMA, MANAGER_REPLAN_OUTPUT_SCHEMA } = await import("../../packages/shared/dist/manager-schema.js");
  for (const schema of [MANAGER_PLAN_OUTPUT_SCHEMA, MANAGER_REPLAN_OUTPUT_SCHEMA]) assert.equal(schema.properties.work_full_test_run.type, "boolean");
  const parse = async (body, mode) => (await runnerReturning(body).runManagerPlan({
    invocation_id: `m-${mode}`, work_id: "w", task_id: null, attempt: 1, context: { mode, work: { id: "w", title: "t", summary: "s" } },
  })).report;
  assert.equal((await parse(promptCompliantPlan, "plan")).work_full_test_run, false);
  assert.equal((await parse({ ...promptCompliantPlan, work_full_test_run: true }, "plan")).work_full_test_run, true);
  assert.equal((await parse({ ...promptCompliantPlan, work_full_test_run: true }, "replan")).work_full_test_run, true);
});

test("stripFullTestCriteria removes only whole-suite criteria, renumbers the rest and keeps one when none remain", async () => {
  const { stripFullTestCriteria, isFullTestCriterion } = await import("../../packages/shared/dist/full-test-criteria.js");
  for (const text of ["既存のテストがすべて通る", "全件の実行結果を載せる", "the whole test suite passes", "All existing tests pass"]) {
    assert.equal(isFullTestCriterion(crit("AC1", text)), true, text);
  }
  const scoped = [
    "tests/work/core-test-run-integration.test.mjs が通る", "tests/a.test.mjs 内のすべてのテストが通る", "tests/plan/ のテストがすべて通る",
    "packages/core のテストが全件通る", "all tests in tests/a.test.mjs pass", "every test under tests/work/ passes", "npm run build が通る",
    "all tests in the core package pass", "core パッケージのテストがすべて通る",
  ];
  for (const text of scoped) {
    assert.equal(isFullTestCriterion(crit("AC1", text, "pnpm run build")), false, text);
    assert.equal(isFullTestCriterion(crit("AC1", text, text)), false, `${text} (in the check too)`);
    if (!text.includes("build")) assert.equal(isFullTestCriterion(crit("AC1", text, "全件の実行結果を確認する")), false, `${text} (with a whole-run check of that scope)`);
  }
  assert.equal(isFullTestCriterion(crit("AC1", "変更が入っている", "全件の実行結果を確認する")), true, "a check decides when the text names no scope");
  assert.equal(isFullTestCriterion(crit("AC1", "変更が入っている", "tests/a.test.mjs の全件の実行結果を確認する")), false, "a scoped check");
  assert.equal(stripFullTestCriteria(scoped.map((text, index) => crit(`AC${index + 1}`, text))).removed, 0);
  assert.equal(isFullTestCriterion(crit("AC1", "all tests in tests/a.test.mjs pass"), undefined, []), true, "the scope phrases can be replaced");
  const mixed = stripFullTestCriteria([crit("AC1", "既存のテストがすべて通る"), crit("AC2", "ビルドが通る"), crit("AC3", "x.test.mjs が通る")]);
  assert.equal(mixed.removed, 1);
  assert.deepEqual(mixed.criteria.map((c) => [c.id, c.text]), [["AC1", "ビルドが通る"], ["AC2", "x.test.mjs が通る"]]);
  const none = stripFullTestCriteria([crit("AC1", "the whole test suite passes")]);
  assert.equal(none.criteria.length, 1);
  assert.equal(none.criteria[0].id, "AC1");
  assert.equal(isFullTestCriterion(none.criteria[0]), false);
  assert.equal(stripFullTestCriteria([crit("AC1", "ビルドが通る")]).removed, 0);
  assert.equal(stripFullTestCriteria([crit("AC1", "ビルドが通る")], ["ビルド"]).removed, 1);
});
