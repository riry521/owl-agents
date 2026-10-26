import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewerPrompt } from "../dist/reviewer.js";
import { buildDesignerRolePrompt, buildWorkerPrompt } from "../dist/worker.js";

const request = {
  task: {
    id: "task-1", work_id: "work-1", title: "Implement feature", status: "running", type: "code",
    state_version: 1, updated_at: "2026-01-01T00:00:00.000Z", parent_task_id: null,
    acceptance: "Complete the feature", review_round: 0, failure_count: 0, worker_generation: 1, depends_on: [],
  },
};

const designTask = { ...request.task, type: "design" };
const mockDir = "/tmp/owl-data/designs/work-1/task-1.mocks";

test("a screen design Designer prompt gets the mock instruction and, when configured, the skill sentence", () => {
  const configured = buildDesignerRolePrompt({ task: designTask, context: { design_tier: "lead", design_mock_dir: mockDir, design_skill: "example-ui-skill" } });
  assert.match(configured, /save_design_mock tool of the owl-design MCP server/);
  assert.match(configured, /Use the example-ui-skill skill when this Task designs screens/);
  assert.match(configured, /Do not write HTML mocks into the Markdown design document/);
  const standard = buildDesignerRolePrompt({ task: designTask, context: { design_tier: "standard", design_mock_dir: mockDir } });
  assert.match(standard, /save_design_mock tool of the owl-design MCP server/);
  const unconfigured = buildDesignerRolePrompt({ task: designTask, context: { design_tier: "lead", design_mock_dir: mockDir } });
  assert.match(unconfigured, /save_design_mock tool of the owl-design MCP server/);
  assert.doesNotMatch(unconfigured, /when this Task designs screens: load/);
});

test("a regular Designer prompt gets neither the mock instruction nor the skill sentence", () => {
  for (const context of [{}, { design_tier: "lead" }, { design_skill: "example-ui-skill" }]) {
    const prompt = buildDesignerRolePrompt({ task: designTask, context });
    assert.doesNotMatch(prompt, /save_design_mock/);
    assert.doesNotMatch(prompt, /when this Task designs screens: load/);
  }
});

test("the dependency sentence and the design Reviewer sentence mention HTML mocks", () => {
  assert.match(buildWorkerPrompt(request), /When an entry has a design_mock_dir, that directory holds the design's HTML screen mocks\./);
  const review = buildReviewerPrompt({ task: designTask, report: {}, review_round: 0 });
  assert.match(review, /design_document\.mocks lists its HTML mocks/);
  assert.doesNotMatch(buildReviewerPrompt({ task: request.task, report: {}, review_round: 0 }), /design_document\.mocks/);
});

test("the Worker prompt no longer treats created files or untestable work as a pass", () => {
  for (const prompt of [buildWorkerPrompt(request), buildDesignerRolePrompt(request)]) {
    assert.doesNotMatch(prompt, /files were created\/modified as requested/);
    assert.doesNotMatch(prompt, /Completing the assigned work is success/);
    assert.doesNotMatch(prompt, /MUST be "success"/);
    assert.doesNotMatch(prompt, /Do NOT set to false just because you could not run/);
    assert.doesNotMatch(prompt, /If the files exist with the expected content, passed is true/);
  }
});

test("the Worker prompt carries the Finalization steps, the retry limit and the evidence rule", () => {
  const prompt = buildWorkerPrompt(request);
  assert.match(prompt, /Finalization/);
  assert.match(prompt, /Take each criterion in task\.acceptance_criteria as one criterion, identified by its id/);
  assert.match(prompt, /final workspace itself/);
  assert.match(prompt, /re-verify the whole Task/);
  assert.match(prompt, /essential check cannot be run[^.]*blocked/);
  assert.match(prompt, /verify it yourself; a child's report is evidence, not proof/);
  assert.match(prompt, /secrets, credentials, environment dumps, and large raw logs/);
  assert.match(prompt, /two substantively different fixes, stop trying/);
  assert.match(prompt, /every required acceptance criterion[^.]*was verified as met in the final workspace/);
});

test("the Worker prompt tells required from goal criteria and reports a goal shortfall as goal_unmet, not partial", () => {
  const prompt = buildWorkerPrompt(request);
  assert.match(prompt, /goal criterion \(requirement goal\) that is not met does not prevent success: report it as goal_unmet with shortfall_reason/);
  assert.match(prompt, /Never report "partial" only because a goal criterion is not met/);
  assert.match(prompt, /verification\.status covers the required criteria and the checks only/);
  assert.match(prompt, /set status goal_unmet and write in shortfall_reason why[^.]*a goal_unmet without a reason is rejected/);
  assert.match(prompt, /Never use failed, blocked or unverifiable for a goal/);
  assert.match(prompt, /For a goal criterion, report goal_unmet with the reason instead/);
});

test("the Hybrid prompt says a child's success is evidence, not proof, and waits for every child", () => {
  const prompt = buildWorkerPrompt(request, undefined, null, true);
  assert.match(prompt, /evidence, not proof of the Task's correctness/);
  assert.match(prompt, /never return success while a child is still running/);
  assert.match(prompt, /every part you planned has a dispatched child/);
  assert.match(prompt, /files each child reported with the files actually changed in the final workspace/);
  assert.match(prompt, /interfaces between the children's work/);
  assert.match(prompt, /Task-level checks that cover each acceptance criterion/);
  assert.match(prompt, /integration check that exercises the combined result/);
  assert.match(prompt, /treat a failed, partial, or missing child result as unfinished work/);
});

test("the Worker prompt carries failed test names and a capped summary, never the test output", () => {
  const tail = "TAIL-OF-RAW-OUTPUT";
  const prompt = buildWorkerPrompt({
    ...request,
    context: {
      verification_failure: {
        source: "core_test_run", error: "1 test failed", error_key: "test_failed",
        commands: [{ command_id: "policy:test", stdout: `ok 1 - passing-one\nok 2 - passing-two\n${tail}`, stderr: tail }],
        test_failures: { failures: [{ file: "tests/a.test.mjs", name: "suite > broken case", line: 7, message: `boom ${"x".repeat(400)}` }], omitted_count: 2 },
      },
    },
  });
  assert.match(prompt, /tests\/a\.test\.mjs/);
  assert.match(prompt, /suite > broken case/);
  assert.match(prompt, /boom x+…/);
  assert.doesNotMatch(prompt, /x{301}/);
  assert.doesNotMatch(prompt, new RegExp(`${tail}|passing-one|passing-two`));
});

test("a test-run failure without test_failures still drops raw output, and a long error is capped", () => {
  const tail = "RAW-TAIL-MARKER";
  const prompt = buildWorkerPrompt({
    ...request,
    context: { verification_failure: { source: "core_test_run", error: `failed ${"y".repeat(1000)}${tail}`, commands: [{ stdout: tail, stderr: tail }] } },
  });
  assert.doesNotMatch(prompt, new RegExp(tail));
  assert.doesNotMatch(prompt, /y{301}/);
});
