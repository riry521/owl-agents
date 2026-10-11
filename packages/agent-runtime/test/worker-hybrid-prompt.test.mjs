import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRunner } from "../dist/index.js";
import { WORKER_REPORT_SCHEMA, buildWorkerPrompt, normalizeWorkerResponse } from "../dist/worker.js";

const request = {
  task: {
    id: "task-1",
    work_id: "work-1",
    title: "Implement feature",
    status: "running",
    type: "code",
    state_version: 1,
    updated_at: "2026-01-01T00:00:00.000Z",
    parent_task_id: null,
    acceptance: "Complete the feature",
    review_round: 0,
    failure_count: 0,
    worker_generation: 1,
    depends_on: [],
  },
};

test("hybrid Worker prompt dispatches, waits, integrates, and records delegation", () => {
  const prompt = buildWorkerPrompt(request, undefined, null, true).toLowerCase();
  assert.match(prompt, /dispatch/);
  assert.match(prompt, /wait/);
  assert.match(prompt, /provider/);
  assert.match(prompt, /model/);
  assert.match(prompt, /record each dispatch-returned child_id/);
  assert.match(prompt, /brief summary of the work assigned/);
  assert.doesNotMatch(prompt, /exact instruction/u);
  assert.match(prompt, /delegation/);
  assert.match(prompt, /review|inspect|check/);
  assert.ok(WORKER_REPORT_SCHEMA.required.includes("delegation"));
});

async function workerProviderRequest(hybridMode) {
  const calls = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        return {
          adapter: request.adapter,
          stdout: JSON.stringify({
            kind: "report",
            schema_version: "1.1.0",
            invocation_id: "worker-run",
            result: "success",
            work_done: "done",
            delegation: { decomposition: "Kept together", delegated: [], retained: [{ part: "All", reason: "Small" }] },
            changes: [],
            verification: { status: "passed", method: "checked", acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "e" }], checks: [], integration_check: null },
            remaining_issues: [],
            next_action: "none",
            needs_replanning: false,
            question_for_manager: null,
          }),
          stderr: "",
          exit_code: 0,
          signal: null,
          format: "plain-text",
        };
      },
    },
  });
  await runner.runWorker({
    invocation_id: "worker-run",
    work_id: "work-1",
    task_id: "task-1",
    attempt: 1,
    context: { task: request.task, hybrid_mode: hybridMode },
  });
  return calls[0];
}

test("hybrid Worker requests enable Owl dispatch MCP", async () => {
  const request = await workerProviderRequest(true);
  assert.equal(request.env.OWL_DISPATCH_MCP, "1");
});

test("regular Worker requests keep Owl dispatch MCP disabled", async () => {
  const request = await workerProviderRequest(false);
  assert.equal(request.env.OWL_DISPATCH_MCP, undefined);
});

test("Worker output rejects a report without the required delegation record", () => {
  const report = {
    kind: "report",
    schema_version: "1.1.0",
    invocation_id: "run-1",
    result: "success",
    work_done: "Done",
    changes: [],
    verification: { status: "passed", method: "Checked", acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "e" }], checks: [], integration_check: null },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
  assert.throws(() => normalizeWorkerResponse({
    adapter: "codex",
    format: "plain-text",
    stdout: JSON.stringify(report),
    exit_code: 0,
    signal: null,
  }, "run-1"), (error) => error?.code === "report_invalid");
});

test("Worker output rejects a delegated report entry without a child_id", () => {
  const report = {
    kind: "report",
    schema_version: "1.1.0",
    invocation_id: "run-1",
    result: "success",
    work_done: "Delegated a focused part.",
    delegation: {
      decomposition: "Split off a focused part.",
      delegated: [{ instruction: "Write the notes", provider: "codex", model: "gpt-5" }],
      retained: [],
    },
    changes: [],
    verification: { status: "passed", method: "Checked", acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "e" }], checks: [], integration_check: null },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
    pending_process: null, external_blocker: null,
  };
  assert.throws(() => normalizeWorkerResponse({
    adapter: "codex",
    format: "plain-text",
    stdout: JSON.stringify(report),
    exit_code: 0,
    signal: null,
  }, "run-1"), (error) => error?.code === "report_invalid" && error?.reason === "report_delegation_invalid");
});

test("Manager prompt tells the Manager to bundle small unrelated items into one Task", async () => {
  const { buildManagerPrompt } = await import("../dist/manager.js");
  for (const mode of ["plan", "replan"]) {
    const prompt = buildManagerPrompt({ mode, work: { id: "w", title: "t", summary: "s" }, tasks: [] });
    assert.match(prompt, /heavy, needs a spec decision, or is risky/);
    assert.match(prompt, /Bundle small, mutually unrelated, low-risk items/);
    assert.match(prompt, /disjoint write scope/);
    assert.match(prompt, /bundle granularity, not one per item/);
    assert.match(prompt, /max_acceptance_items/);
  }
});

test("Manager finalize prompt and schema let a lesson take a new theme title and leave theme empty only when unclassifiable", async () => {
  const { buildManagerPrompt, MANAGER_FINALIZE_PAGES_OUTPUT_SCHEMA } = await import("../dist/manager.js");
  const prompt = buildManagerPrompt({ mode: "finalize", memory_mode: "pages", work: { id: "w", title: "t", summary: "s" }, tasks: [] });
  assert.match(prompt, /use the existing title when one fits; when none fits, give a new short theme title; leave it empty only for a lesson that cannot be classified/);
  const description = JSON.stringify(MANAGER_FINALIZE_PAGES_OUTPUT_SCHEMA);
  assert.match(description, /if none fits, give a new short theme title; empty only if it cannot be classified/);
});
