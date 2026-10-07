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
    { id: "T1", title: "Add archived_at migration", type: "code", acceptance_criteria: [criterion], necessity: { serves: "archiving", if_omitted: "no archive" }, depends_on: [], required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [], context: "", notes: "", review: null },
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
