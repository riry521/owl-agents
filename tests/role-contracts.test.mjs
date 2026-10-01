import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner, MINIMAL_CODE_RULES, WORKING_STYLE_HEADING, WORKING_STYLE_RULES } from "../packages/agent-runtime/dist/index.js";
import { objectSchema, renderOutputTemplate, renderRolePrompt, splitRolePrompt, validateRoleOutput } from "../packages/agent-runtime/dist/role-contract.js";
import { MANAGER_PLAN_OUTPUT_SCHEMA, MANAGER_REPLAN_OUTPUT_SCHEMA, MANAGER_FINALIZE_OUTPUT_SCHEMA } from "../packages/agent-runtime/dist/manager.js";
import { WORKER_REPORT_SCHEMA, HYBRID_REPORT_SCHEMA, HYBRID_PLAN_SCHEMA, buildDesignerRolePrompt, buildWorkerPrompt } from "../packages/agent-runtime/dist/worker.js";
import { buildReviewerPrompt, REVIEW_OUTPUT_SCHEMA } from "../packages/agent-runtime/dist/reviewer.js";

// Every role and mode renders one fixed prompt template whose "## Output
// template" section is generated from the same schema that the parser
// enforces and the provider receives. These tests hold that contract: the
// template as rendered must parse, and off-schema output must be rejected
// with a precise error_key.

const TEMPLATE_HEADING = "## Output template\n";

test("rendered role prompts split back into their named input values", () => {
  const slots = {
    role: "You are the Owl Worker.",
    instructions: ["Complete the Task."],
    processSkills: null,
    output: objectSchema({ answer: { type: "string" } }),
    outputRules: [],
    language: "en",
    inputs: [
      { name: "Task", value: { id: "T1", nested: [1, null, { ready: true }] } },
      { name: "Guidance", value: "Keep the change small." },
      { name: "Notes\n### Nested heading", value: ["one", "two"] },
      { name: "__proto__", value: { safe: true } },
      { name: "Optional", value: null },
    ],
  };
  const prompt = renderRolePrompt(slots);
  const split = splitRolePrompt(prompt);

  assert.ok(split);
  assert.deepEqual(split.inputs, Object.fromEntries(slots.inputs.map(({ name, value }) => [name, value])));
  assert.equal(split.header, prompt.slice(0, prompt.lastIndexOf("## Input\n\n")));
  assert.equal(split.shape, JSON.stringify([
    ["Task", "object"],
    ["Guidance", "string"],
    ["Notes\n### Nested heading", "array"],
    ["__proto__", "object"],
    ["Optional", "null"],
  ]));

  const emptySplit = splitRolePrompt(renderRolePrompt({ ...slots, inputs: [] }));
  assert.deepEqual(emptySplit?.inputs, {});
  assert.equal(emptySplit?.header, split.header);
  assert.equal(emptySplit?.shape, "[]");
  assert.equal(splitRolePrompt(renderRolePrompt({ ...slots, inputs: [
    { name: "Repeated", value: 1 },
    { name: "Repeated", value: 2 },
  ] })), null);
  assert.equal(splitRolePrompt(renderRolePrompt({ ...slots, inputs: [{ name: "Not JSON", value: undefined }] })), null);

  const separatorInputs = [{ name: "Line separator", value: "before\u2028### After: 1\u2029end" }];
  assert.deepEqual(splitRolePrompt(renderRolePrompt({ ...slots, inputs: separatorInputs }))?.inputs, {
    "Line separator": "before\u2028### After: 1\u2029end",
  });
});

function renderedTemplate(prompt) {
  const start = prompt.indexOf(TEMPLATE_HEADING);
  assert.notEqual(start, -1, "prompt has an Output template section");
  const body = prompt.slice(start + TEMPLATE_HEADING.length);
  const jsonStart = body.indexOf("\n{") + 1;
  const jsonEnd = body.indexOf("\n}\n") + 2;
  return JSON.parse(body.slice(jsonStart, jsonEnd));
}

/** Replace every unfilled `<...>` fill-in placeholder in a rendered template with a realistic value. */
function fillTemplate(value) {
  if (typeof value === "string") return /^<.+>$/.test(value) ? `filled ${value.slice(1, -1)}` : value;
  if (Array.isArray(value)) return value.map(fillTemplate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillTemplate(entry)]));
  }
  return value;
}

/** The JSON value of one "### <name>" input section (the last section of every prompt). */
function renderedInput(prompt, name) {
  const heading = `### ${name}\n`;
  const start = prompt.lastIndexOf(heading);
  assert.notEqual(start, -1, `prompt has a ${name} input section`);
  return JSON.parse(prompt.slice(start + heading.length));
}

/** Runner whose provider answers with `answer(template, request)`. */
function runnerAnswering(answer, calls = [], extra = {}) {
  return createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    ...extra,
    provider: {
      execute: async (request) => {
        calls.push(request);
        const reply = answer(renderedTemplate(request.prompt), request);
        return {
          adapter: request.adapter,
          stdout: typeof reply === "string" ? reply : JSON.stringify(reply),
          stderr: "",
          exit_code: 0,
          signal: null,
          format: "plain-text",
        };
      },
    },
  });
}

const task = {
  id: "task-1",
  work_id: "work-1",
  title: "Add archived_at column",
  status: "running",
  type: "code",
  state_version: 0,
  updated_at: "2026-09-24T00:00:00.000Z",
  parent_task_id: null,
  acceptance: "Migration applies cleanly.",
  review_round: 0,
  failure_count: 0,
  worker_generation: 0,
  depends_on: [],
};

const managerRequest = (mode, extraContext = {}) => ({
  invocation_id: `manager-${mode}`,
  work_id: "work-1",
  task_id: null,
  attempt: 1,
  context: { mode, work: { id: "work-1", title: "Archive Works" }, ...extraContext },
});

const workerRequest = (context = {}) => ({
  invocation_id: "worker-1",
  work_id: "work-1",
  task_id: "task-1",
  attempt: 1,
  context: { task, ...context },
});

const reviewerRequest = (extraContext = {}) => ({
  invocation_id: "reviewer-1",
  work_id: "work-1",
  task_id: "task-1",
  attempt: 1,
  review_round: 1,
  context: {
    task,
    report: {
      kind: "report",
      schema_version: "1.0.0",
      invocation_id: "worker-1",
      result: "success",
      work_done: "Added the migration.",
      changes: [{ file: "migrations/007.sql", action: "created" }],
      verification: { passed: true, method: "Checked the result." },
      remaining_issues: [],
      next_action: "none",
      needs_replanning: false,
      question_for_manager: null,
    },
    ...extraContext,
  },
});

const executorResults = [
  { subtask_id: "s1", success: true, output: "done", exit_code: 0, duration_ms: 10 },
];

test("Manager plan: the rendered template parses and the schema is sent to the provider", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  const result = await runner.runManagerPlan(managerRequest("plan"));
  assert.equal(result.outcome, "success", result.message);
  assert.equal(result.report.event, "work.planned");
  assert.equal(result.tasks.length, 1);
  const schema = calls[0].structured_output_schema;
  assert.deepEqual(schema.required, ["tasks", "skills_used"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(JSON.stringify(schema).includes("\"example\""), false);
});

test("Manager plan: an extra task key and a missing field are rejected with the schema path", async () => {
  const extra = await runnerAnswering((template) => ({
    tasks: [{ ...template.tasks[0], priority: "high" }],
  })).runManagerPlan(managerRequest("plan"));
  assert.equal(extra.outcome, "failed");
  assert.equal(extra.error_key, "runtime:manager_plan_invalid:manager_output_schema:tasks[0].priority:not_allowed");

  const missing = await runnerAnswering((template) => {
    const { notes: _notes, ...rest } = template.tasks[0];
    return { tasks: [rest] };
  }).runManagerPlan(managerRequest("plan"));
  assert.equal(missing.error_key, "runtime:manager_plan_invalid:manager_output_schema:tasks[0].notes:missing");

  const empty = await runnerAnswering(() => ({ tasks: [] })).runManagerPlan(managerRequest("plan"));
  assert.equal(empty.error_key, "runtime:manager_plan_invalid:manager_output_schema:tasks:fewer_than_1_items");
});

test("Manager replan: the rendered template parses as task.replanned with fixed input keys", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  const result = await runner.runManagerPlan(managerRequest("replan", {
    reason: "T1 failed twice",
    failed_task_ids: ["T1"],
    current_plan: [{ id: "T1", status: "failed" }],
    unexpected_key: "dropped",
  }));
  assert.equal(result.outcome, "success", result.message);
  assert.equal(result.report.event, "task.replanned");
  const prompt = calls[0].prompt;
  assert.match(prompt, /This is a REPLAN/);
  assert.equal(prompt.includes("unexpected_key"), false);
  assert.match(prompt, /"question": null/);
  // failed_tasks and final_verdict are fixed context keys like the others.
  const input = renderedInput(prompt, "Manager input");
  assert.deepEqual(Object.keys(input), ["mode", "work", "tasks", "reports", "notes", "reason", "context"]);
  assert.deepEqual(Object.keys(input.context), [
    "start_mode", "failed_task_ids", "current_plan", "question", "failed_tasks", "final_verdict", "backlog_items", "rules", "knowledge", "skills", "design_documents",
  ]);
  assert.deepEqual(input.context.failed_tasks, []);
  assert.equal(input.context.final_verdict, null);
  assert.match(prompt, /context\.failed_tasks gives, per root failed Task, why it failed/);
});

test("Manager plan guidance covers design requests and heavy implementation", async () => {
  const calls = [];
  const request = {
    ...managerRequest("plan"),
    context: { mode: "plan", work: { id: "work-1", title: "Build a multi-component feature" } },
  };
  const result = await runnerAnswering((template) => fillTemplate(template), calls).runManagerPlan(request);
  assert.equal(result.outcome, "success", result.message);
  const prompt = calls[0].prompt;
  assert.match(prompt, /type design/);
  assert.match(prompt, /heavy work/);
  assert.match(prompt, /three or more implementation Tasks/);
  assert.match(prompt, /Design documents never go in the repository/);
});

test("Manager replan: tasks and the failed_tasks brief and final_verdict reach the prompt as supplied", async () => {
  const calls = [];
  const brief = {
    task_id: "T1",
    manager_task_id: "T1",
    title: "Add archived_at column",
    acceptance: "Migration applies cleanly.",
    failure: { kind: "verification_failed", detail: "npm test exited with code 1" },
    last_report: { work_done: "Wrote the migration.", changes: [], remaining_issues: [] },
    reviewer_findings: [],
    verification_failure: { source: "project_verification_plan", commands: [], error: null },
  };
  const finalVerdict = { summary: "Docs are missing.", missing: [{ item: "docs page", reason: "none written", fix: "write docs" }] };
  const result = await runnerAnswering((template) => fillTemplate(template), calls).runManagerPlan(managerRequest("replan", {
    failed_task_ids: ["T1"],
    tasks: [{ ...task, id: "T1", status: "failed" }],
    failed_tasks: [brief],
    final_verdict: finalVerdict,
  }));
  assert.equal(result.outcome, "success", result.message);
  const input = renderedInput(calls[0].prompt, "Manager input");
  assert.equal(input.tasks[0].id, "T1", "tasks are the root failed Tasks");
  assert.deepEqual(input.context.failed_tasks, [brief]);
  assert.deepEqual(input.context.final_verdict, finalVerdict);
});

test("Manager replan: an empty task list is a valid answer and the provider schema has no minItems", async () => {
  const calls = [];
  const result = await runnerAnswering(() => ({ tasks: [] }), calls).runManagerPlan(managerRequest("replan", {
    reason: "The Owner reopened the Work.",
    failed_task_ids: [],
    current_plan: [{ id: "T1", status: "completed" }],
  }));
  assert.equal(result.outcome, "success", result.message);
  assert.equal(result.report.event, "task.replanned");
  assert.deepEqual(result.report.tasks, []);
  const schema = calls[0].structured_output_schema;
  assert.equal(JSON.stringify(schema).includes("minItems"), false, "an empty replan must be expressible");
  assert.deepEqual(schema.properties.tasks.items.required.includes("replaces"), true);
  assert.equal(schema.properties.tasks.items.additionalProperties, false);
  // The template shows the empty-replan option in the prompt.
  assert.match(calls[0].prompt, /return \{"tasks": \[\]\}/i);
});

test("Manager plan and replan: an answer without replaces is rejected; the template carries replaces", async () => {
  for (const mode of ["plan", "replan"]) {
    const calls = [];
    const ok = await runnerAnswering((template) => fillTemplate(template), calls).runManagerPlan(managerRequest(mode));
    assert.equal(ok.outcome, "success", `${mode}: ${ok.message}`);
    assert.deepEqual(renderedTemplate(calls[0].prompt).tasks[0].replaces, [], `${mode}: the template shows replaces`);
    assert.ok(calls[0].structured_output_schema.properties.tasks.items.required.includes("replaces"));

    const old = await runnerAnswering((template) => {
      const { replaces: _replaces, ...rest } = template.tasks[0];
      return { tasks: [rest] };
    }).runManagerPlan(managerRequest(mode));
    assert.equal(old.outcome, "failed", `${mode}: an old-format answer is rejected`);
    assert.equal(old.error_key, "runtime:manager_plan_invalid:manager_output_schema:tasks[0].replaces:missing");

    const wrongType = await runnerAnswering((template) => ({
      tasks: [{ ...fillTemplate(template.tasks[0]), replaces: "T1" }],
    })).runManagerPlan(managerRequest(mode));
    assert.equal(wrongType.error_key, "runtime:manager_plan_invalid:manager_output_schema:tasks[0].replaces:expected_array_got_string");
  }
  // The initial plan still needs at least one Task.
  const plan = await runnerAnswering(() => ({ tasks: [] })).runManagerPlan(managerRequest("plan"));
  assert.equal(plan.error_key, "runtime:manager_plan_invalid:manager_output_schema:tasks:fewer_than_1_items");
});

test("Manager prompt input carries failed_tasks and final_verdict with defaults", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runManagerPlan(managerRequest("replan", { failed_task_ids: [] }));
  assert.match(calls[0].prompt, /"failed_tasks": \[\]/);
  assert.match(calls[0].prompt, /"final_verdict": null/);
  assert.match(calls[0].prompt, /"knowledge": null/u);
  assert.match(instructionsSection(calls[0].prompt), /Rules are binding; context\.knowledge is reference information/u);

  const knowledge = "Past work summary";
  await runner.runManagerPlan(managerRequest("plan", { knowledge }));
  assert.equal(renderedInput(calls[1].prompt, "Manager input").context.knowledge, knowledge);
  assert.match(instructionsSection(calls[1].prompt), /Rules are binding; context\.knowledge is reference information/u);
});

test("Manager finalize: the rendered template parses into a verdict; an off-enum verdict is rejected", async () => {
  const finalizeInput = {
    work: { id: "work-1", title: "Archive Works" },
    mode: "finalize",
    tasks: [task],
    reports: [],
  };
  const ok = await runnerAnswering((template) => fillTemplate(template)).runManagerPlan(finalizeInput);
  assert.equal(ok.verdict.verdict, "complete");
  assert.deepEqual(ok.verdict.missing, []);

  await assert.rejects(
    runnerAnswering((template) => ({ verdict: { ...template.verdict, verdict: "done" } })).runManagerPlan(finalizeInput),
    (error) => error.code === "manager_plan_invalid" && error.reason === "manager_output_schema:verdict.verdict:not_one_of_complete|incomplete",
  );
});

test("Manager finalize: unaddressed_backlog_items requires item_id and reason; a verdict without it parses as []", async () => {
  const items = MANAGER_FINALIZE_OUTPUT_SCHEMA.properties.verdict.properties.unaddressed_backlog_items;
  assert.equal(items.type, "array");
  assert.deepEqual(items.items.required, ["item_id", "reason"]);
  const finalizeInput = { work: { id: "work-1", title: "Archive Works" }, mode: "finalize", tasks: [task], reports: [] };
  const legacy = await runnerAnswering(() => ({ verdict: { verdict: "complete", summary: "s", missing: [], lessons: [] } })).runManagerPlan(finalizeInput);
  assert.deepEqual(legacy.verdict.unaddressed_backlog_items, []);
  const mixed = await runnerAnswering(() => ({ verdict: { verdict: "complete", summary: "s", missing: [], lessons: [], unaddressed_backlog_items: [
    { item_id: 1, reason: "r" }, { item_id: "a" }, "x", { item_id: "b", reason: "ok" },
  ] } })).runManagerPlan(finalizeInput);
  assert.deepEqual(mixed.verdict.unaddressed_backlog_items, [{ item_id: "b", reason: "ok" }]);
});

test("Worker: the rendered template parses as a report; a wrong field type is rejected", async () => {
  const calls = [];
  const ok = await runnerAnswering((template) => fillTemplate(template), calls).runWorker(workerRequest());
  assert.equal(ok.outcome, "success", ok.message);
  assert.equal(ok.report.invocation_id, "worker-1");
  assert.equal(calls[0].structured_output_schema.additionalProperties, false);
  assert.ok(calls[0].structured_output_schema.required.includes("question_for_manager"));

  const bad = await runnerAnswering((template) => ({ ...fillTemplate(template), remaining_issues: "none" })).runWorker(workerRequest());
  assert.equal(bad.outcome, "failed");
  assert.equal(bad.error_key, "runtime:report_invalid:worker_output_schema:remaining_issues:expected_array_got_string");
});

test("Worker: an empty skill name in skills_used does not reject the report", async () => {
  const ok = await runnerAnswering((template) => ({
    ...fillTemplate(template),
    skills_used: [{ name: "", verdict: "helpful", note: "" }],
  })).runWorker(workerRequest());
  assert.equal(ok.outcome, "success", ok.message);
});

test("Worker: the prompt input has fixed context keys with null/[] defaults, including verification_failure", async () => {
  const calls = [];
  await runnerAnswering((template) => fillTemplate(template), calls).runWorker(workerRequest({ worktree: "/tmp/worker-cwd", hybrid_mode: false }));
  const input = renderedInput(calls[0].prompt, "Task");
  assert.deepEqual(Object.keys(input), ["task", "context"]);
  assert.deepEqual(input.context, {
    rules: null,
    knowledge: null,
    skills: null,
    dependency_reports: [],
    artifact_paths: [],
    verification_failure: null,
    previous_report: null,
    reviewer_findings: [],
    owner_guidance: [],
    retry_subtasks: [],
  });
  assert.match(calls[0].prompt, /If context\.verification_failure is non-null, the previous attempt failed Core verification/);
  assert.match(instructionsSection(calls[0].prompt), /Rules are binding; context\.knowledge is reference information/u);

  const knowledge = "Relevant notes";
  const supplied = [];
  const suppliedPrompt = buildWorkerPrompt({ task, context: { knowledge } }, "en");
  assert.equal(renderedInput(suppliedPrompt, "Task").context.knowledge, knowledge);
  const dependencyReport = {
    task_id: "T0", manager_task_id: "T0", title: "Schema", work_done: "Created the table.",
    changes: [{ file: "schema.sql", action: "created" }], remaining_issues: [], design_document_path: null,
  };
  const verificationFailure = { source: "project_verification_plan", commands: [{ command_id: "test", passed: false, exit_code: 1 }], error: null };
  await runnerAnswering((template) => fillTemplate(template), supplied).runWorker(workerRequest({
    task: { ...task, depends_on: ["T0"] },
    dependency_reports: [dependencyReport],
    artifact_paths: ["schema.sql"],
    verification_failure: verificationFailure,
    knowledge,
  }));
  const suppliedInput = renderedInput(supplied[0].prompt, "Task");
  assert.equal(suppliedInput.context.knowledge, knowledge);
  assert.deepEqual(suppliedInput.task.depends_on, ["T0"]);
  assert.deepEqual(suppliedInput.context.dependency_reports, [dependencyReport]);
  assert.deepEqual(suppliedInput.context.artifact_paths, ["schema.sql"]);
  assert.deepEqual(suppliedInput.context.verification_failure, verificationFailure);
});

test("Worker: a fenced answer is not accepted (the parser is strict)", async () => {
  const bad = await runnerAnswering((template) => `\`\`\`json\n${JSON.stringify(template)}\n\`\`\``).runWorker(workerRequest());
  assert.equal(bad.outcome, "failed");
  assert.match(bad.error_key, /^runtime:report_invalid:worker_stdout_not_single_json_object/);
});

test("Hybrid plan: the rendered template parses; an extra subtask key is rejected", async () => {
  const hybrid = { hybrid_mode: true, hybrid_phase: "plan" };
  const calls = [];
  const ok = await runnerAnswering((template) => fillTemplate(template), calls).runWorker(workerRequest(hybrid));
  assert.equal(ok.outcome, "success", ok.message);
  assert.equal(ok.report.subtasks[0].subtask_id, "s1");
  assert.deepEqual(ok.report.subtasks[0].write_paths, ["src/component.ts"]);
  assert.deepEqual(calls[0].structured_output_schema.required, ["subtasks"]);
  assert.equal(calls[0].prompt.includes("skills_used"), false);

  const badCalls = [];
  const bad = await runnerAnswering((template) => ({
    subtasks: [{ ...template.subtasks[0], priority: 1 }],
  }), badCalls).runWorker(workerRequest(hybrid));
  assert.equal(bad.outcome, "failed");
  // The bounded repair retry runs once before the failure is reported.
  assert.equal(badCalls.length, 2);
  assert.equal(bad.error_key, "runtime:report_invalid:hybrid_plan_schema:subtasks[0].priority:not_allowed");
});

test("Hybrid verdict: the rendered template parses; retry without retry_subtasks is rejected", async () => {
  const hybrid = { hybrid_mode: true, hybrid_phase: "verdict", executor_results: executorResults };
  const ok = await runnerAnswering((template) => fillTemplate(template)).runWorker(workerRequest(hybrid));
  assert.equal(ok.outcome, "success", ok.message);
  assert.equal(ok.report.verdict, "ok");

  const bad = await runnerAnswering((template) => ({ ...fillTemplate(template), verdict: "retry" })).runWorker(workerRequest(hybrid));
  assert.equal(bad.outcome, "failed");
  assert.equal(bad.error_key, "runtime:report_invalid:hybrid_retry_subtasks_empty");

  const offSchema = await runnerAnswering((template) => ({ ...fillTemplate(template), verdict: "maybe" })).runWorker(workerRequest(hybrid));
  assert.equal(offSchema.error_key, "runtime:report_invalid:hybrid_report_schema:verdict:not_one_of_ok|retry|needs_replanning");
});

test("Reviewer: the rendered template parses; a string line number or null file is rejected", async () => {
  const calls = [];
  const ok = await runnerAnswering((template) => fillTemplate(template), calls).runReviewer(reviewerRequest());
  assert.equal(ok.outcome, "success", ok.message);
  assert.equal(ok.review.findings[0].line, 0);
  const reviewKnowledgeCalls = [];
  await runnerAnswering((template) => fillTemplate(template), reviewKnowledgeCalls).runReviewer(reviewerRequest({ knowledge: "Relevant notes" }));
  assert.equal(renderedInput(reviewKnowledgeCalls[0].prompt, "Task and Worker report").context.knowledge, "Relevant notes");
  assert.equal(calls[0].structured_output_schema.properties.findings.items.properties.line.type, "integer");
  assert.ok(calls[0].structured_output_schema.properties.findings.items.required.includes("pre_existing"));

  const missingPreExisting = await runnerAnswering((template) => {
    const filled = fillTemplate(template);
    return { ...filled, findings: filled.findings.map(({ pre_existing, ...finding }) => finding) };
  }).runReviewer(reviewerRequest());
  assert.equal(missingPreExisting.error_key, "runtime:review_invalid:review_output_schema:findings[0].pre_existing:missing");

  const majorPreExisting = await runnerAnswering((template) => {
    const filled = fillTemplate(template);
    return { ...filled, findings: [{ ...filled.findings[0], severity: "major", pre_existing: true }] };
  }).runReviewer(reviewerRequest());
  assert.equal(majorPreExisting.error_key, "runtime:review_invalid:pre_existing_major");

  const stringLine = await runnerAnswering((template) => {
    const filled = fillTemplate(template);
    return { ...filled, findings: [{ ...filled.findings[0], line: "12" }] };
  }).runReviewer(reviewerRequest());
  assert.equal(stringLine.outcome, "failed");
  assert.equal(stringLine.error_key, "runtime:review_invalid:review_output_schema:findings[0].line:expected_integer_got_string");

  const nullFile = await runnerAnswering((template) => {
    const filled = fillTemplate(template);
    return { ...filled, findings: [{ ...filled.findings[0], file: null }] };
  }).runReviewer(reviewerRequest());
  assert.equal(nullFile.error_key, "runtime:review_invalid:review_output_schema:findings[0].file:expected_string_got_null");
});

test("Reviewer input carries knowledge with a null default and reference-only guidance", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runReviewer(reviewerRequest());
  assert.equal(renderedInput(calls[0].prompt, "Task and Worker report").context.knowledge, null);
  assert.match(instructionsSection(calls[0].prompt), /Rules are binding; context\.knowledge is reference information/u);

  const knowledge = "Relevant notes";
  const base = reviewerRequest();
  const suppliedPrompt = buildReviewerPrompt({
    task: base.context.task,
    report: base.context.report,
    knowledge,
  }, "en");
  assert.equal(renderedInput(suppliedPrompt, "Task and Worker report").context.knowledge, knowledge);
});

test("Reviewer can review a Designer's external document without changing Worker review prompts", async () => {
  const calls = [];
  const base = reviewerRequest();
  const designTask = { ...task, type: "design" };
  const request = {
    ...base,
    context: {
      ...base.context,
      task: designTask,
      design_document: { path: "/tmp/owl-data/designs/work-1/task-1.md", markdown: "# Design\nUse an adapter." },
    },
  };
  const result = await runnerAnswering((template) => fillTemplate(template), calls).runReviewer(request);
  assert.equal(result.outcome, "success", result.message);
  assert.match(calls[0].prompt, /Review the Designer report/u);
  assert.match(calls[0].prompt, /design document/u);
  const input = renderedInput(calls[0].prompt, "Task and Designer report");
  assert.deepEqual(input.design_document, request.context.design_document);
});

test("Claude --json-schema structured_output is accepted as the role answer", async () => {
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => ({
        adapter: request.adapter,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Here is the review.",
          structured_output: fillTemplate(renderedTemplate(request.prompt)),
        }),
        stderr: "",
        exit_code: 0,
        signal: null,
      }),
    },
  });
  const result = await runner.runReviewer(reviewerRequest());
  assert.equal(result.outcome, "success", result.message);
  assert.equal(result.review.verdict, "pass");
});

test("Core retry_subtasks reach the Hybrid plan and Worker prompts", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  const retry = ["Re-run the migration test for SQLite 3.46"];
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "plan", retry_subtasks: retry }));
  await runner.runWorker(workerRequest({ retry_subtasks: retry }));
  for (const call of calls) {
    assert.match(call.prompt, /"retry_subtasks": \[\n\s+"Re-run the migration test for SQLite 3\.46"\n\s+\]/);
  }
  assert.match(calls[0].prompt, /Plan subtasks only for the listed retry instructions/);
  assert.match(calls[1].prompt, /do not redo/i);
});

test("An answer that breaks the contract is kept, redacted, in the agent-output log", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-output-log-"));
  const secret = "sk-ant-abcdefghijklmnop1234567890";
  const runner = runnerAnswering(
    () => `Sorry, I could not finish. token=${secret} Authorization: Bearer ${secret}`,
    [],
    { outputLogDir: undefined, env: { OWL_ROOT: root, OWL_DATA_DIR: "state" } },
  );
  const result = await runner.runWorker(workerRequest());
  assert.equal(result.outcome, "failed");
  assert.ok(result.output_log_path, "failure carries the log path");
  assert.ok(result.output_log_path.startsWith(join(root, "state", "logs", "agent-output")));
  assert.ok(result.message.includes(result.output_log_path));
  assert.equal(result.message.includes(secret), false);
  const files = await readdir(join(root, "state", "logs", "agent-output"));
  assert.equal(files.length, 1);
  const body = await readFile(result.output_log_path, "utf8");
  assert.match(body, /role: worker/);
  assert.match(body, /Sorry, I could not finish/);
  assert.equal(body.includes(secret), false);
});

test("Without a data directory the failure is still reported, just without a log", async () => {
  const runner = runnerAnswering(() => "not json", [], { outputLogDir: undefined });
  const result = await runner.runWorker(workerRequest());
  assert.equal(result.outcome, "failed");
  assert.equal(result.output_log_path, undefined);
});

test("Every role prompt carries the Output language rule: Japanese by default, English on request", async () => {
  const hybridTask = { ...task, hybrid_mode: true };
  const finalizeInput = { work: { id: "work-1", title: "Archive Works" }, mode: "finalize", tasks: [task], reports: [] };
  for (const [language, expected] of [[undefined, "Japanese (日本語)"], ["ja", "Japanese (日本語)"], ["en", "English"]]) {
    const calls = [];
    const runner = runnerAnswering((template) => fillTemplate(template), calls);
    const withLanguage = (request) => (language ? { ...request, language } : request);
    await runner.runManagerPlan(withLanguage(managerRequest("plan")));
    await runner.runManagerPlan(withLanguage(finalizeInput));
    await runner.runWorker(withLanguage(workerRequest()));
    await runner.runWorker(withLanguage(workerRequest({ task: hybridTask, hybrid_mode: true })));
    await runner.runReviewer(withLanguage(reviewerRequest()));
    assert.ok(calls.length >= 5);
    for (const call of calls) {
      const section = call.prompt.slice(call.prompt.indexOf("## Output language\n"));
      assert.ok(call.prompt.includes("## Output language\n"), "prompt has an Output language section");
      assert.ok(section.includes(`Write every human-readable value in ${expected}:`), `${language}: ${section.slice(0, 120)}`);
    }
  }
});

test("Manager finalize: lessons use the new structured contract; a bare string is rejected", async () => {
  const finalizeInput = { work: { id: "work-1", title: "Archive Works" }, mode: "finalize", tasks: [task], reports: [] };
  const lesson = {
    lesson: "Check the full migration series before reserving a number.",
    basis: "Two Works clashed over the same migration number.",
    applies_to: "Schema changes across multiple Works.",
    kind: "rule_candidate",
    topic: "",
    procedure: "",
    rule_text: "Check the full migration series before reserving a number.",
    rule_scope: "worker",
    keywords: [],
  };
  const missing = { item: "Renumber the migration.", reason: "007 is taken.", fix: "Use 010." };
  const calls = [];
  const ok = await runnerAnswering((template) => ({
    verdict: { ...fillTemplate(template.verdict), verdict: "incomplete", missing: [missing], lessons: [lesson] },
  }), calls).runManagerPlan(finalizeInput);
  assert.deepEqual(ok.verdict.missing, [missing]);
  assert.deepEqual(ok.verdict.lessons, [lesson]);

  const lessonSchema = MANAGER_FINALIZE_OUTPUT_SCHEMA.properties.verdict.properties.lessons.items;
  assert.deepEqual(Object.keys(lessonSchema.properties), [
    "lesson", "basis", "applies_to", "kind", "topic", "procedure", "rule_text", "rule_scope", "keywords",
  ]);
  assert.deepEqual(lessonSchema.properties.kind.enum, ["procedure", "fact", "decision", "pitfall", "rule_candidate"]);
  assert.deepEqual(lessonSchema.properties.rule_scope.enum, ["all", "manager", "designer", "worker", "reviewer", "advisor"]);
  assert.equal(Object.hasOwn(lessonSchema.properties, "proposes_rule"), false);

  const instructions = instructionsSection(calls[0].prompt);
  assert.ok(instructions.includes("Include in lessons only insights reusable in future Works. Exclude one-off circumstances, facts unique to this Work, and points that can be readily derived again."));
  assert.ok(instructions.includes("Use kind=procedure with procedure text for reusable steps. Use fact/decision/pitfall with topic for durable facts, reasoned decisions, and failure patterns. Use rule_candidate with rule_text/rule_scope only for short binding instructions; a rule_candidate becomes a rule only after Owner approval."));
  assert.match(instructions, /Propose a skill only when a multi-step procedure can be reused/u);

  await assert.rejects(
    runnerAnswering((template) => ({
      verdict: { ...fillTemplate(template.verdict), verdict: "incomplete", missing: [missing], lessons: [{ ...lesson, proposes_rule: true }] },
    })).runManagerPlan(finalizeInput),
    (error) => error.code === "manager_plan_invalid" && error.reason === "manager_output_schema:verdict.lessons[0].proposes_rule:not_allowed",
  );

  await assert.rejects(
    runnerAnswering((template) => ({ verdict: { ...fillTemplate(template.verdict), lessons: ["Pin the migration number early."] } })).runManagerPlan(finalizeInput),
    (error) => error.code === "manager_plan_invalid" && error.reason === "manager_output_schema:verdict.lessons[0]:expected_object_got_string",
  );
  await assert.rejects(
    runnerAnswering((template) => ({ verdict: { ...fillTemplate(template.verdict), verdict: "incomplete", missing: [{ item: "Renumber." }] } })).runManagerPlan(finalizeInput),
    (error) => error.code === "manager_plan_invalid" && error.reason === "manager_output_schema:verdict.missing[0].reason:missing",
  );
});

test("Manager finalize: verdict complete with non-empty missing, and incomplete with empty missing, are rejected", async () => {
  const finalizeInput = { work: { id: "work-1", title: "Archive Works" }, mode: "finalize", tasks: [task], reports: [] };
  const missing = { item: "Renumber the migration.", reason: "007 is taken.", fix: "Use 010." };
  const inconsistent = (error) =>
    error.code === "manager_plan_invalid" && error.reason === "manager_output_schema:verdict.missing:inconsistent_with_verdict";
  await assert.rejects(
    runnerAnswering((template) => ({ verdict: { ...fillTemplate(template.verdict), verdict: "complete", missing: [missing] } })).runManagerPlan(finalizeInput),
    inconsistent,
  );
  await assert.rejects(
    runnerAnswering((template) => ({ verdict: { ...fillTemplate(template.verdict), verdict: "incomplete", missing: [] } })).runManagerPlan(finalizeInput),
    inconsistent,
  );
  const ok = await runnerAnswering((template) => ({ verdict: { ...fillTemplate(template.verdict), verdict: "incomplete", missing: [missing] } })).runManagerPlan(finalizeInput);
  assert.equal(ok.verdict.verdict, "incomplete");
});

test("Worker: remaining issues and verification are structured; a bare string or a missing method is rejected", async () => {
  const issue = { issue: "Index not added.", impact: "Archive lookups stay slow.", next_step: "Add an index on archived_at." };
  const ok = await runnerAnswering((template) => ({ ...fillTemplate(template), remaining_issues: [issue] })).runWorker(workerRequest());
  assert.equal(ok.outcome, "success", ok.message);
  assert.deepEqual(ok.report.remaining_issues, [issue]);
  assert.equal(typeof ok.report.verification.method, "string");

  const bareIssue = await runnerAnswering((template) => ({ ...fillTemplate(template), remaining_issues: ["Index not added."] })).runWorker(workerRequest());
  assert.equal(bareIssue.error_key, "runtime:report_invalid:worker_output_schema:remaining_issues[0]:expected_object_got_string");

  const noMethod = await runnerAnswering((template) => ({ ...fillTemplate(template), verification: { passed: true } })).runWorker(workerRequest());
  assert.equal(noMethod.error_key, "runtime:report_invalid:worker_output_schema:verification.method:missing");
});

test("Designer uses the Worker report contract, its own provider role, and the document path", async () => {
  const calls = [];
  const request = {
    invocation_id: "designer-1",
    work_id: "work-1",
    task_id: "task-1",
    attempt: 1,
    context: {
      task: { ...task, type: "design" },
      design_document_path: "/tmp/owl-data/designs/work-1/task-1.md",
      worktree: "/tmp/owl-worktree",
      dependency_reports: [{ task_id: "dependency-1", design_document_path: "/tmp/owl-data/designs/work-1/dependency-1.md" }],
    },
  };
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  const result = await runner.runDesigner(request);
  assert.equal(result.outcome, "success", result.message);
  assert.equal(result.report_valid, true);
  assert.equal(calls[0].role, "designer");
  assert.equal(calls[0].env.OWL_AGENT_ROLE, "designer");
  assert.deepEqual(calls[0].structured_output_schema.required, WORKER_REPORT_SCHEMA.required);
  assert.match(calls[0].prompt, /You are the Owl Designer/u);
  assert.match(calls[0].prompt, /design_document_path/u);
  assert.match(calls[0].prompt, /self-reviewed against the Task's acceptance criteria/u);
  assert.equal(renderedInput(calls[0].prompt, "Task").context.design_document_path, request.context.design_document_path);
  assert.match(instructionsSection(calls[0].prompt), /Rules are binding; context\.knowledge is reference information/u);

  const prompt = buildDesignerRolePrompt({ task: { ...task, type: "design" }, context: { design_document_path: request.context.design_document_path, knowledge: "Design notes" } }, "en");
  assert.equal(renderedInput(prompt, "Task").context.knowledge, "Design notes");
  assert.deepEqual(renderedTemplate(prompt), renderedTemplate(calls[0].prompt));
});

/** The "## Instructions" section of a rendered role prompt. */
function instructionsSection(prompt) {
  const start = prompt.indexOf("## Instructions\n");
  assert.notEqual(start, -1, "prompt has an Instructions section");
  return prompt.slice(start, prompt.indexOf("\n\n## ", start));
}

test("Every role prompt carries the Working style section once, between Instructions and Output template", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runManagerPlan(managerRequest("plan"));
  await runner.runManagerPlan(managerRequest("replan", { failed_task_ids: [] }));
  await runner.runManagerPlan({ work: { id: "work-1", title: "Archive Works" }, mode: "finalize", tasks: [task], reports: [] });
  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "plan" }));
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "verdict", executor_results: executorResults }));
  await runner.runReviewer(reviewerRequest());
  assert.equal(calls.length, 7);
  const section = [WORKING_STYLE_HEADING, ...WORKING_STYLE_RULES].join("\n");
  for (const { prompt } of calls) {
    const at = prompt.indexOf(`${WORKING_STYLE_HEADING}\n`);
    assert.ok(at > prompt.indexOf("## Instructions\n"), "after Instructions");
    assert.ok(at < prompt.indexOf(TEMPLATE_HEADING), "before Output template");
    assert.equal(prompt.split(`${WORKING_STYLE_HEADING}\n`).length, 2, "exactly once");
    assert.ok(prompt.includes(section), "every rule is present");
  }
});

test("Only the Worker prompt carries the minimal-code rules; the Hybrid plan and Reviewer get one line each", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "plan" }));
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "verdict", executor_results: executorResults }));
  await runner.runReviewer(reviewerRequest());
  const [worker, plan, verdict, reviewer] = calls.map((call) => call.prompt);
  const workerInstructions = instructionsSection(worker);
  for (const rule of MINIMAL_CODE_RULES) assert.ok(workerInstructions.includes(rule), rule);
  assert.ok(
    workerInstructions.indexOf(MINIMAL_CODE_RULES.at(-1)) < workerInstructions.indexOf("context.rules holds the rules"),
    "the rules come before the Worker context instructions",
  );
  for (const prompt of [plan, verdict, reviewer]) assert.equal(prompt.includes(MINIMAL_CODE_RULES[0]), false);
  assert.ok(instructionsSection(plan).includes("Plan the fewest subtasks that satisfy the acceptance criteria"));
  assert.ok(instructionsSection(reviewer).includes("report it as a minor finding; it is not by itself a reason to fail."));
});

test("role prompts keep unrelated existing failures outside Task verification", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runManagerPlan(managerRequest("plan"));
  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "plan" }));
  await runner.runReviewer(reviewerRequest());
  const [manager, worker, hybrid, reviewer] = calls.map((call) => instructionsSection(call.prompt));
  assert.match(manager, /require instead that the Task adds no new failures/u);
  assert.match(manager, /Reviewer sends such failures to the backlog/u);
  assert.match(worker, /report it in remaining_issues as pre-existing; it does not make verification\.passed false/u);
  assert.match(hybrid, /Tell each Executor not to edit unrelated failing tests/u);
  assert.match(reviewer, /report one minor finding per failing test or check file that says so, listing every failing case in that file, with pre_existing true and file set to the failing test or check file \(empty string when no file applies\), never as major/u);
  assert.match(reviewer, /Other findings have pre_existing false/u);
  assert.match(reviewer, /or an acceptance criterion names that test or check; a criterion that only says the whole test suite must pass does not name it/u);
  assert.match(reviewer, /Never stash, reset or check out anything in the Task's workspace/u);
});

test("The Reviewer prompt carries changed_files: an instruction line, null by default, and the given list when known", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);

  await runner.runReviewer(reviewerRequest());
  const withoutFiles = renderedInput(calls[0].prompt, "Task and Worker report");
  assert.equal(withoutFiles.changed_files, null);

  await runner.runReviewer(reviewerRequest({ changed_files: ["migrations/007.sql", "src/index.ts"] }));
  const withFiles = renderedInput(calls[1].prompt, "Task and Worker report");
  assert.deepEqual(withFiles.changed_files, ["migrations/007.sql", "src/index.ts"]);

  assert.equal(withoutFiles.previous_minor_findings, null);
  const previous = [{ severity: "minor", pre_existing: false, file: "a.ts", line: 1, problem: "Rename x.", reason: "r", fix: "f" }];
  await runner.runReviewer(reviewerRequest({ previous_minor_findings: previous }));
  assert.deepEqual(renderedInput(calls[2].prompt, "Task and Worker report").previous_minor_findings, previous);
  assert.ok(instructionsSection(calls[2].prompt).includes("report it again with the same file and the same problem wording"));

  assert.ok(
    instructionsSection(calls[0].prompt).includes(
      "changed_files lists the files the Worker changed (null when unknown); read those files in the workspace.",
    ),
  );
});

test("Workspace tools: the block names the worktree for Worker, Designer, Hybrid phases and Reviewer, and is absent without one", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);

  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ worktree: "/tmp/worker-cwd" }));
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "plan", worktree: "/tmp/hybrid-plan-cwd" }));
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "verdict", executor_results: executorResults, worktree: "/tmp/hybrid-verdict-cwd" }));
  await runner.runReviewer(reviewerRequest());
  await runner.runReviewer(reviewerRequest({ worktree: "/tmp/reviewer-cwd" }));
  await runner.runDesigner({
    invocation_id: "designer-1",
    work_id: "work-1",
    task_id: "task-1",
    attempt: 1,
    context: { task: { ...task, type: "design" }, design_document_path: "/tmp/owl-data/designs/work-1/task-1.md", worktree: "/tmp/designer-cwd" },
  });
  const [
    workerNoTree, workerWithTree, hybridPlan, hybridVerdict, reviewerNoTree, reviewerWithTree, designer,
  ] = calls.map((call) => call.prompt);

  for (const prompt of [workerNoTree, reviewerNoTree]) {
    assert.equal(prompt.includes("## Workspace tools"), false);
  }
  for (const [prompt, cwd] of [
    [workerWithTree, "/tmp/worker-cwd"],
    [hybridPlan, "/tmp/hybrid-plan-cwd"],
    [hybridVerdict, "/tmp/hybrid-verdict-cwd"],
    [reviewerWithTree, "/tmp/reviewer-cwd"],
    [designer, "/tmp/designer-cwd"],
  ]) {
    const at = prompt.indexOf("## Workspace tools\n");
    assert.notEqual(at, -1, "prompt has a Workspace tools section");
    assert.ok(at > prompt.indexOf("## Instructions\n"), "after Instructions");
    assert.ok(at < prompt.indexOf(WORKING_STYLE_HEADING), "before Working style");
    assert.match(prompt, new RegExp(`You are working in the git worktree ${cwd.replace(/\//g, "\\/")}\\.`));
    assert.match(prompt, /prefer the semantic search, reference search and impact-analysis tools/);
    assert.match(prompt, /Never treat empty results from an unbuilt index as evidence that something does not exist\./);
  }
});

test("the skill index reaches each supported role prompt and is null when Core has none", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  const skills = "- release-procedure: Release steps. → /owl/skills/release-procedure/SKILL.md";
  await runner.runManagerPlan(managerRequest("plan", { skills }));
  await runner.runManagerPlan(managerRequest("finalize", { skills }));
  await runner.runWorker(workerRequest({ skills }));
  await runner.runReviewer(reviewerRequest({ skills }));
  await runner.runWorker(workerRequest());
  await runner.runReviewer(reviewerRequest());

  assert.equal(renderedInput(calls[0].prompt, "Manager input").context.skills, skills);
  assert.equal(renderedInput(calls[1].prompt, "Manager input").context.skills, skills);
  assert.equal(renderedInput(calls[2].prompt, "Task").context.skills, skills);
  assert.equal(renderedInput(calls[3].prompt, "Task and Worker report").context.skills, skills);
  assert.equal(renderedInput(calls[4].prompt, "Task").context.skills, null);
  assert.equal(renderedInput(calls[5].prompt, "Task and Worker report").context.skills, null);

  for (const call of calls) {
    const instructions = instructionsSection(call.prompt);
    assert.match(instructions, /context\.skills is an index of reusable procedures/u);
    assert.match(instructions, /A skill never overrides rules, the Task, or acceptance criteria/u);
  }
});

test("Every role/mode output schema rejects its own unfilled fill-in template", () => {
  const schemas = {
    manager_plan: MANAGER_PLAN_OUTPUT_SCHEMA,
    manager_replan: MANAGER_REPLAN_OUTPUT_SCHEMA,
    manager_finalize: MANAGER_FINALIZE_OUTPUT_SCHEMA,
    worker_report: WORKER_REPORT_SCHEMA,
    hybrid_report: HYBRID_REPORT_SCHEMA,
    hybrid_plan: HYBRID_PLAN_SCHEMA,
    reviewer: REVIEW_OUTPUT_SCHEMA,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const template = renderOutputTemplate(schema);
    const problem = validateRoleOutput(schema, template);
    assert.notEqual(problem, null, `${name} template must be rejected`);
    assert.ok(problem.endsWith(":template_placeholder"), `${name}: ${problem}`);
  }
});

test("A report with a single field left as its fill-in placeholder is rejected at that field", () => {
  const template = renderOutputTemplate(WORKER_REPORT_SCHEMA);
  const filled = {
    ...template,
    invocation_id: "worker-1",
    verification: { ...template.verification, method: "Ran the migration against a scratch database." },
  };
  const problem = validateRoleOutput(WORKER_REPORT_SCHEMA, filled);
  assert.equal(problem, "work_done:template_placeholder");
});

test("A fully filled-in report passes validation", () => {
  const template = renderOutputTemplate(WORKER_REPORT_SCHEMA);
  const filled = {
    ...template,
    invocation_id: "worker-1",
    work_done: "Added the archived_at column and backfilled existing rows.",
    changes: [],
    verification: { ...template.verification, method: "Ran the migration against a scratch database." },
  };
  assert.equal(validateRoleOutput(WORKER_REPORT_SCHEMA, filled), null);
});

test("An enum field's first value and a schema's example hint are not treated as an unfilled placeholder", () => {
  const enumSchema = { type: "string", enum: ["complete", "incomplete"], description: "verdict" };
  assert.equal(renderOutputTemplate(enumSchema), "complete");
  assert.equal(validateRoleOutput(enumSchema, "complete"), null);

  const exampleSchema = { type: "string", description: "dependency mode", example: "none" };
  assert.equal(renderOutputTemplate(exampleSchema), "none");
  assert.equal(validateRoleOutput(exampleSchema, "none"), null);
});

test("Review-loop guidance: one full review, lenient report wording, and enumerated coverage", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runReviewer(reviewerRequest());
  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "plan" }));
  await runner.runManagerPlan(managerRequest("plan"));
  await runner.runManagerPlan(managerRequest("replan"));
  const [reviewer, worker, hybridPlan, plan, replan] = calls.map((call) => call.prompt);

  assert.doesNotMatch(reviewer, /When in doubt/u);
  assert.match(reviewer, /report every issue you find in this one review/u);
  assert.match(reviewer, /Do not report the format, omissions, or wording of the Worker report as findings, not even as minor/u);
  assert.match(reviewer, /re-run the search named in verification\.method/u);

  assert.match(worker, /first enumerate the targets with a search/u);
  assert.match(worker, /name the search that enumerated them/u);
  assert.match(hybridPlan, /give each subtask the exact targets it owns/u);

  for (const prompt of [plan, replan]) assert.match(prompt, /name its concrete scope/u);
});
