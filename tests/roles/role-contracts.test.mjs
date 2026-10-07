import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner, MINIMAL_CODE_RULES, WORKING_STYLE_HEADING, WORKING_STYLE_RULES } from "../../packages/agent-runtime/dist/index.js";
import { objectSchema, renderOutputTemplate, renderRolePrompt, splitRenderedPrompt, splitRolePrompt, validateRoleOutput } from "../../packages/agent-runtime/dist/role-contract.js";
import { MANAGER_PLAN_OUTPUT_SCHEMA, MANAGER_REPLAN_OUTPUT_SCHEMA, MANAGER_FINALIZE_OUTPUT_SCHEMA } from "../../packages/agent-runtime/dist/manager.js";
import { DESIGNER_REPORT_SCHEMA, WORKER_REPORT_SCHEMA, buildDesignerRolePrompt, buildWorkerPrompt } from "../../packages/agent-runtime/dist/worker.js";
import { buildReviewerPrompt, REVIEW_OUTPUT_SCHEMA } from "../../packages/agent-runtime/dist/reviewer.js";
import { validateReportEnvelope } from "../../packages/agent-runtime/dist/protocol.js";
import { tempDir } from "../helpers/temp.mjs";

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
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === "acceptance_criteria" ? entry.map((criterion, index) => ({ ...fillTemplate(criterion), id: `AC${index + 1}`, check_weight: "light", weight_reason: "" })) : fillTemplate(entry)]));
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

/** The JSON value of each "### <name>" input slot of a Worker, Designer or Reviewer prompt, in order. */
function renderedSlots(prompt) {
  const split = splitRolePrompt(prompt);
  assert.ok(split, "the prompt has an Input section");
  return split.inputs;
}

/** Task keys that change between attempts and so never belong to the Task slot. */
const VOLATILE_TASK_KEYS = ["status", "state_version", "updated_at", "failure_count", "worker_generation", "review_round"];

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
  acceptance_criteria: [{ id: "AC1", text: "Migration applies cleanly.", check: "Run the migration on a copy.", serves: "Add the column.", if_omitted: "The column is missing.", check_weight: "light", weight_reason: "" }],
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
      delegation: { decomposition: "Kept together for review.", delegated: [], retained: [{ part: "Whole Task", reason: "No independent part was identified." }] },
      remaining_issues: [],
      next_action: "none",
      needs_replanning: false,
      question_for_manager: null,
    },
    ...extraContext,
  },
});

test("Manager plan parses its rendered template and sends the schema to the provider", async () => {
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

test("Manager plan rejects an extra task key and a missing field with the schema path", async () => {
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

test("Manager replan parses its rendered template as task.replanned with fixed input keys", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  const result = await runner.runManagerPlan(managerRequest("replan", {
    trigger: { kind: "task_failed", tasks: [{ kind: "review_exhausted", task_id: "T1" }] },
    failed_task_ids: ["T1"],
    current_plan: [{ id: "T1", status: "failed" }],
    unexpected_key: "dropped",
  }));
  assert.equal(result.outcome, "success", result.message);
  assert.equal(result.report.event, "task.replanned");
  const prompt = calls[0].prompt;
  assert.match(prompt, /This is a REPLAN/);
  assert.equal(prompt.includes("unexpected_key"), false);
  assert.match(prompt, /"worker_questions": \[\]/);
  assert.match(prompt, /"base_merge_conflict": null/);
  // failed_tasks and final_verdict are fixed context keys like the others.
  const input = renderedInput(prompt, "Manager input");
  assert.deepEqual(Object.keys(input), ["mode", "work", "tasks", "reports", "notes", "trigger", "context"]);
  // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
  assert.deepEqual(Object.keys(input.context), [
    "start_mode", "failed_task_ids", "current_plan", "worker_questions", "base_merge_conflict", "owner_requests", "previous_output_feedback", "failed_tasks", "final_verdict", "work_verification", "backlog_items", "rules", "knowledge", "skills", "design_documents", "owner_replan_kind",
  ]);
  assert.deepEqual(input.context.failed_tasks, []);
  assert.equal(input.context.final_verdict, null);
  assert.deepEqual(input.trigger, { kind: "task_failed", tasks: [{ kind: "review_exhausted", task_id: "T1" }] });
  for (const kind of ["initial_plan", "task_failed", "queued_failed_tasks", "work_verification_failed", "owner_request", "final_check", "launch_conflict", "task_integration_failed", "review_exhausted"]) assert.match(prompt, new RegExp(`${kind}:|${kind} \\(`));
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

test("Manager replan passes tasks, the failed_tasks brief and final_verdict to the prompt as supplied", async () => {
  const calls = [];
  const brief = {
    task_id: "T1",
    manager_task_id: "T1",
    title: "Add archived_at column",
    acceptance_criteria: [{ id: "AC1", text: "Migration applies cleanly." }],
    failure: { kind: "verification_failed" },
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

test("Manager replan accepts an empty task list because the provider schema has no minItems", async () => {
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
  assert.equal(schema.properties.tasks.minItems, undefined, "an empty replan must be expressible");
  assert.deepEqual(schema.properties.tasks.items.required.includes("replaces"), true);
  assert.equal(schema.properties.tasks.items.additionalProperties, false);
  // The template shows the empty-replan option in the prompt.
  assert.match(calls[0].prompt, /return \{"tasks": \[\]\}/i);
});

test("Manager plan and replan reject an answer without replaces and carry replaces in the template", async () => {
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
      tasks: [{ ...fillTemplate(template.tasks[0]), required_sections: [], required_tests: [], replaces: "T1" }],
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

test("Manager finalize parses its rendered template into a verdict and rejects an off-enum verdict", async () => {
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

test("Manager finalize requires item_id and reason in unaddressed_backlog_items and parses a verdict without it as an empty list", async () => {
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

test("Worker parses its rendered template as a report and rejects a wrong field type", async () => {
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

test("the runtime rejects every malformed external_blocker and keeps a valid one", async () => {
  const valid = { kind: "pre_existing", summary: "s", evidence: "e", suggested_fix: "f" };
  const run = (mutate) => runnerAnswering((template) => mutate(fillTemplate(template))).runWorker(workerRequest());
  const withBlocker = (value) => (report) => ({ ...report, external_blocker: value });

  assert.deepEqual((await run(withBlocker(valid))).report.external_blocker, valid);
  assert.equal((await run(withBlocker(null))).outcome, "success");
  const rejected = {
    "external_blocker:missing": ({ external_blocker, ...rest }) => rest,
    "external_blocker:expected_object_or_null_got_string": withBlocker("x"),
    "external_blocker.kind:not_one_of_pre_existing|environment": withBlocker({ ...valid, kind: "other" }),
    "external_blocker.evidence:missing": withBlocker({ kind: valid.kind, summary: "s", suggested_fix: "f" }),
    "external_blocker.extra:not_allowed": withBlocker({ ...valid, extra: 1 }),
    "external_blocker.summary:empty": withBlocker({ ...valid, summary: "  " }),
  };
  for (const [suffix, mutate] of Object.entries(rejected)) {
    const result = await run(mutate);
    assert.equal(result.outcome, "failed");
    assert.ok(result.error_key.endsWith(`worker_output_schema:${suffix}`), `${suffix}: ${result.error_key}`);
  }
  const designer = fillTemplate(renderOutputTemplate(DESIGNER_REPORT_SCHEMA));
  assert.equal(validateRoleOutput(DESIGNER_REPORT_SCHEMA, { ...designer, external_blocker: valid }), "external_blocker:not_allowed");

  const { report } = await run(withBlocker(null));
  assert.throws(() => validateReportEnvelope({ ...report, external_blocker: "x" }), (error) => error.reason === "report_external_blocker_invalid");
});

test("Worker accepts a report even if skills_used contains an empty skill name", async () => {
  const ok = await runnerAnswering((template) => ({
    ...fillTemplate(template),
    skills_used: [{ name: "", verdict: "helpful", note: "" }],
  })).runWorker(workerRequest());
  assert.equal(ok.outcome, "success", ok.message);
});

test("Worker prompt input has fixed context keys with null or empty defaults, including verification_failure", async () => {
  const calls = [];
  await runnerAnswering((template) => fillTemplate(template), calls).runWorker(workerRequest({ worktree: "/tmp/worker-cwd", hybrid_mode: false }));
  const slots = renderedSlots(calls[0].prompt);
  assert.deepEqual(Object.keys(slots), ["Project", "Task", "Dependencies", "Attempt"]);
  assert.deepEqual(slots.Project, { rules: null, skills: null, knowledge: null, check_commands: [] });
  assert.match(instructionsSection(calls[0].prompt), /Keep a new test file only when a criterion's kind is spec_test.*run every command in Project\.check_commands/su);
  // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
  assert.deepEqual(Object.keys(slots.Task), ["id", "work_id", "title", "type", "acceptance_criteria", "context", "manager_notes", "necessity", "parent_task_id", "depends_on"]);
  assert.deepEqual(slots.Task.acceptance_criteria, task.acceptance_criteria);
  assert.equal("acceptance" in slots.Task, false);
  for (const key of VOLATILE_TASK_KEYS) assert.equal(key in slots.Task, false, `Task has no ${key}`);
  assert.deepEqual(slots.Dependencies, { dependencies: [], artifact_paths: [] });
  assert.deepEqual(slots.Attempt, {
    review_round: 0,
    owner_guidance: [],
    previous_report: null,
    reviewer_findings: [],
    verification_failure: null,
    process_wait: null,
  });
  assert.match(calls[0].prompt, /If Attempt\.verification_failure is non-null, the previous attempt failed Core verification/);
  assert.match(instructionsSection(calls[0].prompt), /Rules are binding; Project\.knowledge is reference information/u);

  // Rendered text cut at the slot headings: four slots in order, rules, skills and knowledge only in Project.
  const knowledge = "Relevant notes";
  const suppliedPrompt = buildWorkerPrompt({ task, context: { knowledge, rules: "[absolute] R1", skills: "- s1" } }, "en");
  const cut = splitRenderedPrompt(suppliedPrompt);
  assert.deepEqual(cut.slots.map((slot) => slot.name), ["Project", "Task", "Dependencies", "Attempt"]);
  assert.ok(suppliedPrompt.includes("## Input\n\n### Project\n"));
  for (const [name, text] of cut.slots.map((slot) => [slot.name, slot.text])) {
    for (const needle of ["R1", "s1", knowledge]) assert.equal(text.includes(needle), name === "Project", `${needle} only in Project, found in ${name}`);
  }
  assert.equal(renderedSlots(suppliedPrompt).Project.knowledge, knowledge);
  const dependencyReport = {
    task_id: "T0", manager_task_id: "T0", title: "Schema", work_done: "Created the table.",
    changes: [{ file: "schema.sql", action: "created" }], remaining_issues: [], design_document_path: null,
  };
  const verificationFailure = { source: "project_verification_plan", commands: [{ command_id: "test", passed: false, exit_code: 1 }], error: null };
  const supplied = [];
  await runnerAnswering((template) => fillTemplate(template), supplied).runWorker(workerRequest({
    task: { ...task, depends_on: ["T0"] },
    dependency_reports: [dependencyReport],
    artifact_paths: ["schema.sql"],
    verification_failure: verificationFailure,
    knowledge,
  }));
  const suppliedSlots = renderedSlots(supplied[0].prompt);
  assert.equal(suppliedSlots.Project.knowledge, knowledge);
  assert.deepEqual(suppliedSlots.Task.depends_on, ["T0"]);
  assert.deepEqual(suppliedSlots.Dependencies, { dependencies: [dependencyReport], artifact_paths: ["schema.sql"] });
  assert.deepEqual(suppliedSlots.Attempt.verification_failure, verificationFailure);
});

test("Worker rejects a fenced answer because the parser is strict", async () => {
  const bad = await runnerAnswering((template) => `\`\`\`json\n${JSON.stringify(template)}\n\`\`\``).runWorker(workerRequest());
  assert.equal(bad.outcome, "failed");
  assert.match(bad.error_key, /^runtime:report_invalid:worker_stdout_not_single_json_object/);
});

test("Hybrid Worker uses the normal report schema and gets dispatch instructions in one prompt", async () => {
  const hybrid = { hybrid_mode: true };
  const calls = [];
  const ok = await runnerAnswering((template) => fillTemplate(template), calls).runWorker(workerRequest(hybrid));
  assert.equal(ok.outcome, "success", ok.message);
  assert.ok(ok.report.delegation);
  assert.ok(calls[0].structured_output_schema.required.includes("delegation"));
  assert.ok(calls[0].structured_output_schema.required.includes("skills_used"));
  assert.match(calls[0].prompt, /[Uu]se Owl's dispatch tool to start all ready independent parts/u);
  assert.match(calls[0].prompt, /Use wait on every dispatched run and receive all results/u);
  assert.equal(calls.length, 1);

  const bad = await runnerAnswering((template) => {
    const { delegation: _delegation, ...withoutDelegation } = fillTemplate(template);
    return withoutDelegation;
  }).runWorker(workerRequest(hybrid));
  assert.equal(bad.outcome, "failed");
  assert.match(bad.error_key, /delegation/u);
});

test("Reviewer parses its rendered template and rejects a string line number or a null file", async () => {
  const calls = [];
  const ok = await runnerAnswering((template) => fillTemplate(template), calls).runReviewer(reviewerRequest());
  assert.equal(ok.outcome, "success", ok.message);
  assert.equal(ok.review.findings[0].line, 0);
  const reviewKnowledgeCalls = [];
  await runnerAnswering((template) => fillTemplate(template), reviewKnowledgeCalls).runReviewer(reviewerRequest({ knowledge: "Relevant notes" }));
  assert.equal(renderedSlots(reviewKnowledgeCalls[0].prompt).Project.knowledge, "Relevant notes");
  assert.equal(calls[0].structured_output_schema.properties.findings.items.properties.line.type, "integer");
  const findingSchema = calls[0].structured_output_schema.properties.findings.items;
  assert.equal(findingSchema.properties.pre_existing, undefined);
  assert.ok(findingSchema.required.includes("subject"));
  assert.deepEqual(findingSchema.properties.subject.enum, ["test_result", "other"]);

  const missingSubject = await runnerAnswering((template) => {
    const filled = fillTemplate(template);
    return { ...filled, findings: filled.findings.map(({ subject, ...finding }) => finding) };
  }).runReviewer(reviewerRequest());
  assert.equal(missingSubject.error_key, "runtime:review_invalid:review_output_schema:findings[0].subject:missing");

  const unknownSubject = await runnerAnswering((template) => {
    const filled = fillTemplate(template);
    return { ...filled, findings: [{ ...filled.findings[0], subject: "pre_existing" }] };
  }).runReviewer(reviewerRequest());
  assert.match(unknownSubject.error_key, /^runtime:review_invalid:review_output_schema:findings\[0\]\.subject/u);

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
  assert.equal(renderedSlots(calls[0].prompt).Project.knowledge, null);
  assert.match(instructionsSection(calls[0].prompt), /Rules are binding; Project\.knowledge is reference information/u);

  // Three slots in order; volatile Task keys stay out; rules, skills and knowledge appear only in Project.
  const volatileTask = { ...task, status: "running", state_version: 3, updated_at: "2026-01-01T00:00:00Z", failure_count: 1, worker_generation: 2, review_round: 1 };
  const slotted = buildReviewerPrompt({ task: volatileTask, report: reviewerRequest().context.report, knowledge: "KNOW-MARK", context: "[absolute] RULE-MARK", skills: "- SKILL-MARK" }, "en");
  const cut = splitRenderedPrompt(slotted);
  assert.deepEqual(cut.slots.map((slot) => slot.name), ["Project", "Task", "Review"]);
  const reviewSlots = renderedSlots(slotted);
  for (const key of VOLATILE_TASK_KEYS) assert.equal(key in reviewSlots.Task, false, `Reviewer Task has no ${key}`);
  for (const slot of cut.slots) {
    for (const needle of ["RULE-MARK", "SKILL-MARK", "KNOW-MARK"]) assert.equal(slot.text.includes(needle), slot.name === "Project", `${needle} only in Project, found in ${slot.name}`);
  }

  const knowledge = "Relevant notes";
  const base = reviewerRequest();
  const suppliedPrompt = buildReviewerPrompt({
    task: base.context.task,
    report: base.context.report,
    knowledge,
  }, "en");
  assert.equal(renderedSlots(suppliedPrompt).Project.knowledge, knowledge);
});

test("Reviewer reviews a Designer's external document without changing Worker review prompts", async () => {
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
  const input = renderedSlots(calls[0].prompt).Review;
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

test("Hybrid Worker prompt instructs one session to dispatch, wait for and check delegated work", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runWorker(workerRequest({ hybrid_mode: true }));
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /[Uu]se Owl's dispatch tool/u);
  assert.match(calls[0].prompt, /wait on every dispatched run/u);
  assert.match(calls[0].prompt, /integrate the work, and check it together/u);
  assert.match(calls[0].prompt, /provider and model/u);
});

test("an answer that breaks the contract is kept redacted in the agent-output log", async (t) => {
  const root = await tempDir(t, "owl-output-log-");
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

test("a contract failure is still reported without a log when there is no data directory", async () => {
  const runner = runnerAnswering(() => "not json", [], { outputLogDir: undefined });
  const result = await runner.runWorker(workerRequest());
  assert.equal(result.outcome, "failed");
  assert.equal(result.output_log_path, undefined);
});

test("every role prompt carries the Output language rule with Japanese by default and English on request", async () => {
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

test("Manager finalize accepts structured lessons and rejects a bare string", async () => {
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
  // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
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

test("Manager finalize rejects a complete verdict with non-empty missing and an incomplete verdict with empty missing", async () => {
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

test("Worker requires structured remaining issues and verification and rejects a bare string or a missing method", async () => {
  const issue = { issue: "Index not added.", impact: "Archive lookups stay slow.", next_step: "Add an index on archived_at." };
  const ok = await runnerAnswering((template) => ({ ...fillTemplate(template), remaining_issues: [issue] })).runWorker(workerRequest());
  assert.equal(ok.outcome, "success", ok.message);
  assert.deepEqual(ok.report.remaining_issues, [issue]);
  assert.equal(typeof ok.report.verification.method, "string");

  const bareIssue = await runnerAnswering((template) => ({ ...fillTemplate(template), remaining_issues: ["Index not added."] })).runWorker(workerRequest());
  assert.equal(bareIssue.error_key, "runtime:report_invalid:worker_output_schema:remaining_issues[0]:expected_object_got_string");

  const noMethod = await runnerAnswering((template) => ({ ...fillTemplate(template), verification: { status: "passed", acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "e" }], checks: [], integration_check: null } })).runWorker(workerRequest());
  assert.equal(noMethod.error_key, "runtime:report_invalid:worker_output_schema:verification.method:missing");
});

test("Designer uses the Worker report contract, its own provider role and the document path", async () => {
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
  assert.deepEqual(calls[0].structured_output_schema.required, WORKER_REPORT_SCHEMA.required.filter((key) => key !== "external_blocker"));
  assert.match(calls[0].prompt, /You are the Owl Designer/u);
  assert.match(calls[0].prompt, /design_document_path/u);
  assert.match(calls[0].prompt, /self-reviewed against the Task's acceptance criteria/u);
  assert.deepEqual(splitRenderedPrompt(calls[0].prompt).slots.map((slot) => slot.name), ["Project", "Task", "Dependencies", "Attempt"]);
  assert.equal(renderedSlots(calls[0].prompt).Task.design_document_path, request.context.design_document_path);
  assert.match(instructionsSection(calls[0].prompt), /Rules are binding; Project\.knowledge is reference information/u);

  const prompt = buildDesignerRolePrompt({ task: { ...task, type: "design" }, context: { design_document_path: request.context.design_document_path, knowledge: "Design notes" } }, "en");
  assert.equal(renderedSlots(prompt).Project.knowledge, "Design notes");
  assert.deepEqual(renderedTemplate(prompt), renderedTemplate(calls[0].prompt));
});

/** The "## Instructions" section of a rendered role prompt. */
function instructionsSection(prompt) {
  const start = prompt.indexOf("## Instructions\n");
  assert.notEqual(start, -1, "prompt has an Instructions section");
  return prompt.slice(start, prompt.indexOf("\n\n## ", start));
}

test("every role prompt carries the Working style section once between Instructions and Output template", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runManagerPlan(managerRequest("plan"));
  await runner.runManagerPlan(managerRequest("replan", { failed_task_ids: [] }));
  await runner.runManagerPlan({ work: { id: "work-1", title: "Archive Works" }, mode: "finalize", tasks: [task], reports: [] });
  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ hybrid_mode: true }));
  await runner.runReviewer(reviewerRequest());
  assert.equal(calls.length, 6);
  const section = [WORKING_STYLE_HEADING, ...WORKING_STYLE_RULES].join("\n");
  for (const { prompt } of calls) {
    const at = prompt.indexOf(`${WORKING_STYLE_HEADING}\n`);
    assert.ok(at > prompt.indexOf("## Instructions\n"), "after Instructions");
    assert.ok(at < prompt.indexOf(TEMPLATE_HEADING), "before Output template");
    assert.equal(prompt.split(`${WORKING_STYLE_HEADING}\n`).length, 2, "exactly once");
    assert.ok(prompt.includes(section), "every rule is present");
  }
});

test("Worker and Hybrid Worker prompts carry the minimal-code rules while the Reviewer prompt does not", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ hybrid_mode: true }));
  await runner.runReviewer(reviewerRequest());
  const [worker, hybrid, reviewer] = calls.map((call) => call.prompt);
  const workerInstructions = instructionsSection(worker);
  for (const rule of MINIMAL_CODE_RULES) assert.ok(workerInstructions.includes(rule), rule);
  assert.ok(
    workerInstructions.indexOf(MINIMAL_CODE_RULES.at(-1)) < workerInstructions.indexOf("Project.rules holds the rules"),
    "the rules come before the Worker context instructions",
  );
  const hybridInstructions = instructionsSection(hybrid);
  for (const rule of MINIMAL_CODE_RULES) assert.ok(hybridInstructions.includes(rule), rule);
  assert.equal(reviewer.includes(MINIMAL_CODE_RULES[0]), false);
  assert.match(hybridInstructions, /[Uu]se Owl's dispatch tool/u);
  assert.ok(instructionsSection(reviewer).includes("report it as a minor finding; it is not by itself a reason to fail."));
});

test("role prompts keep unrelated existing failures outside Task verification", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runManagerPlan(managerRequest("plan"));
  await runner.runManagerPlan(managerRequest("replan", { failed_task_ids: [] }));
  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ hybrid_mode: true }));
  await runner.runReviewer(reviewerRequest());
  const [manager, replan, worker, hybrid, reviewer] = calls.map((call) => instructionsSection(call.prompt));
  for (const prompt of [manager, replan]) {
    assert.match(prompt, /have the Task that finds it fix or update that test in the same Task, and do not defer it to the backlog/u);
  }
  assert.match(manager, /require the build and the tests related to what the Task changes/u);
  assert.doesNotMatch(manager, /adds no new failures/u);
  assert.match(manager, /do not require comparing failures with the base branch \(main\)/u);
  assert.match(manager, /Reviewer sends such failures to the backlog/u);
  assert.match(worker, /Never run the whole test suite, a test directory or a glob of test files: Core runs the tests related to your changes/u);
  assert.match(worker, /Do not compare results with the base branch/u);
  assert.doesNotMatch(worker, /fails without your changes/u);
  assert.match(worker, /report it in remaining_issues as pre-existing and say so in verification\.method/u);
  assert.match(hybrid, /[Uu]se Owl's dispatch tool/u);
  assert.match(hybrid, /check it together/u);
  assert.match(reviewer, /Do not run the Project's tests; the hook denies the Project's test commands/u);
  assert.match(reviewer, /Judge tests only from Review\.core_tests/u);
  assert.match(reviewer, /Set subject to test_result on any finding about a test or check result/u);
  assert.match(reviewer, /Never send the Task back, and never report a finding, because of a test the Worker added only to check its own work or because a test asserts a hardcoded value/u);
  assert.match(reviewer, /do not repeat a passed check, and re-run the commands or searches the evidence names only when the report's evidence and the workspace disagree/u);
  assert.match(reviewer, /run commands only for what Review\.core_checks and Review\.core_tests do not cover/u);
  assert.doesNotMatch(reviewer, /when it matters, re-run the commands/u);
  assert.doesNotMatch(reviewer, /by inspecting the workspace and running commands/u);
  assert.doesNotMatch(reviewer, /pre_existing true/u);
  assert.doesNotMatch(reviewer, /temporary detached worktree/u);
});

test("the Reviewer prompt carries changed_files as an instruction line, null by default and the given list when known", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);

  await runner.runReviewer(reviewerRequest());
  const withoutFiles = renderedSlots(calls[0].prompt).Review;
  assert.equal(withoutFiles.changed_files, null);

  await runner.runReviewer(reviewerRequest({ changed_files: ["migrations/007.sql", "src/index.ts"] }));
  const withFiles = renderedSlots(calls[1].prompt).Review;
  assert.deepEqual(withFiles.changed_files, ["migrations/007.sql", "src/index.ts"]);

  assert.equal(withoutFiles.previous_minor_findings, null);
  const previous = [{ severity: "minor", subject: "other", file: "a.ts", line: 1, problem: "Rename x.", reason: "r", fix: "f" }];
  await runner.runReviewer(reviewerRequest({ previous_minor_findings: previous }));
  assert.deepEqual(renderedSlots(calls[2].prompt).Review.previous_minor_findings, previous);
  assert.ok(instructionsSection(calls[2].prompt).includes("report it again with the same file and the same problem wording"));

  assert.ok(
    instructionsSection(calls[0].prompt).includes(
      "changed_files lists the files the Worker changed (null when unknown); read those files in the workspace.",
    ),
  );

  assert.deepEqual(withoutFiles.owner_guidance, []);
  const guidance = [{ decision: "d", answer: "Owner の方針に従う" }];
  await runner.runReviewer(reviewerRequest({ owner_guidance: guidance }));
  assert.deepEqual(renderedSlots(calls[3].prompt).Review.owner_guidance, guidance);
  assert.match(instructionsSection(calls[3].prompt), /Review\.owner_guidance is non-empty.*take priority over the Task's context, acceptance criteria and manager_notes: never report a finding, and never send the Task back/u);
});

test("the Workspace tools block names the worktree for Worker, Designer, Hybrid Worker and Reviewer prompts", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);

  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ worktree: "/tmp/worker-cwd" }));
  await runner.runWorker(workerRequest({ hybrid_mode: true, worktree: "/tmp/hybrid-worker-cwd" }));
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
    workerNoTree, workerWithTree, hybridWorker, reviewerNoTree, reviewerWithTree, designer,
  ] = calls.map((call) => call.prompt);

  for (const prompt of [workerNoTree, reviewerNoTree]) {
    assert.equal(prompt.includes("## Workspace tools"), false);
  }
  for (const [prompt, cwd] of [
    [workerWithTree, "/tmp/worker-cwd"],
    [hybridWorker, "/tmp/hybrid-worker-cwd"],
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
  assert.equal(renderedSlots(calls[2].prompt).Project.skills, skills);
  assert.equal(renderedSlots(calls[3].prompt).Project.skills, skills);
  assert.equal(renderedSlots(calls[4].prompt).Project.skills, null);
  assert.equal(renderedSlots(calls[5].prompt).Project.skills, null);

  for (const call of calls) {
    const instructions = instructionsSection(call.prompt);
    assert.match(instructions, /(?:context|Project)\.skills is an index of reusable procedures/u);
    assert.match(instructions, /A skill never overrides rules, the Task, or acceptance criteria/u);
  }
});

test("every role output schema rejects its own unfilled fill-in template", () => {
  const schemas = {
    manager_plan: MANAGER_PLAN_OUTPUT_SCHEMA,
    manager_replan: MANAGER_REPLAN_OUTPUT_SCHEMA,
    manager_finalize: MANAGER_FINALIZE_OUTPUT_SCHEMA,
    worker_report: WORKER_REPORT_SCHEMA,
    reviewer: REVIEW_OUTPUT_SCHEMA,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const template = renderOutputTemplate(schema);
    const problem = validateRoleOutput(schema, template);
    assert.notEqual(problem, null, `${name} template must be rejected`);
    assert.ok(problem.endsWith(":template_placeholder"), `${name}: ${problem}`);
  }
});

test("a report with a single field left as its fill-in placeholder is rejected at that field", () => {
  const template = renderOutputTemplate(WORKER_REPORT_SCHEMA);
  const filled = {
    ...template,
    invocation_id: "worker-1",
    verification: { ...fillTemplate(template.verification), method: "Ran the migration against a scratch database." },
  };
  const problem = validateRoleOutput(WORKER_REPORT_SCHEMA, filled);
  assert.equal(problem, "work_done:template_placeholder");
});

test("a fully filled-in report passes validation", () => {
  const template = renderOutputTemplate(WORKER_REPORT_SCHEMA);
  const filled = {
    ...template,
    invocation_id: "worker-1",
    work_done: "Added the archived_at column and backfilled existing rows.",
    delegation: fillTemplate(template.delegation),
    changes: [],
    verification: { ...fillTemplate(template.verification), method: "Ran the migration against a scratch database." },
  };
  assert.equal(validateRoleOutput(WORKER_REPORT_SCHEMA, filled), null);
});

test("an enum field's first value and a schema's example hint are not treated as an unfilled placeholder", () => {
  const enumSchema = { type: "string", enum: ["complete", "incomplete"], description: "verdict" };
  assert.equal(renderOutputTemplate(enumSchema), "complete");
  assert.equal(validateRoleOutput(enumSchema, "complete"), null);

  const exampleSchema = { type: "string", description: "dependency mode", example: "none" };
  assert.equal(renderOutputTemplate(exampleSchema), "none");
  assert.equal(validateRoleOutput(exampleSchema, "none"), null);
});

test("the review-loop guidance asks for one full review, lenient report wording and enumerated coverage", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runReviewer(reviewerRequest());
  await runner.runWorker(workerRequest());
  await runner.runWorker(workerRequest({ hybrid_mode: true }));
  await runner.runManagerPlan(managerRequest("plan"));
  await runner.runManagerPlan(managerRequest("replan"));
  const [reviewer, worker, hybridWorker, plan, replan] = calls.map((call) => call.prompt);

  assert.doesNotMatch(reviewer, /When in doubt/u);
  assert.match(reviewer, /report every issue you find in this one review/u);
  assert.match(reviewer, /Do not report the format, omissions, or wording of the Worker report as findings, not even as minor/u);
  assert.match(reviewer, /re-run the search only when the report's evidence and the workspace disagree/u);
  assert.doesNotMatch(reviewer, /re-run the search named in verification\.method/u);

  assert.match(worker, /first enumerate the targets with a search/u);
  assert.match(worker, /name the search that enumerated them/u);
  assert.match(hybridWorker, /[Uu]se Owl's dispatch tool/u);
  assert.match(hybridWorker, /wait on every dispatched run/u);

  for (const prompt of [plan, replan]) assert.match(prompt, /name its concrete scope/u);
});

test("test-placement rules appear in the Worker, Manager and Reviewer prompts", async () => {
  const calls = [];
  const runner = runnerAnswering((template) => fillTemplate(template), calls);
  await runner.runReviewer(reviewerRequest());
  await runner.runWorker(workerRequest());
  await runner.runManagerPlan(managerRequest("plan"));
  await runner.runManagerPlan(managerRequest("replan"));
  const [reviewer, worker, plan, replan] = calls.map((call) => call.prompt);

  assert.match(worker, /add them to the existing feature test file, fix an existing test that checks the same thing, and create a new test file only for a new feature/u);
  assert.match(worker, /run `pnpm test:layout` yourself and fix any violation on the spot/u);
  for (const manager of [plan, replan]) {
    assert.match(manager, /add them to the existing feature test file or fix the existing test that checks the same thing; a new test file only for a new feature/u);
  }
  assert.match(reviewer, /Never send the Worker back, and never report a finding \(not even a minor one for the backlog\), because of where a test file is placed or because a test duplicates another/u);
});
