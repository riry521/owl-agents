import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";
import { providerSchema } from "../packages/agent-runtime/dist/role-contract.js";
import { MANAGER_FINALIZE_OUTPUT_SCHEMA, MANAGER_PLAN_OUTPUT_SCHEMA, MANAGER_REPLAN_OUTPUT_SCHEMA } from "../packages/agent-runtime/dist/manager.js";
import { WORKER_REPORT_SCHEMA, HYBRID_REPORT_SCHEMA } from "../packages/agent-runtime/dist/worker.js";
import { REVIEW_OUTPUT_SCHEMA } from "../packages/agent-runtime/dist/reviewer.js";
import { openDatabase } from "../packages/db/dist/index.js";
import { SkillBox } from "../packages/core/dist/skill-box.js";
import { WorkflowEngine } from "../packages/core/dist/workflow-engine.js";
import { dependencyContext } from "../packages/core/dist/task-context.js";

const migrations = join(process.cwd(), "packages/db/migrations");

const used = [{ name: "release-procedure", verdict: "helpful", note: "The ordering helped." }];
const proposals = [{ kind: "new", target: null, summary: "Release routine", steps_or_diff: "Check the version, update the changelog, tag the release.", evidence: "The process used several repeatable steps." }];

function fill(value) {
  if (typeof value === "string") return /^<.+>$/.test(value) ? `filled ${value.slice(1, -1)}` : value;
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
  return value;
}

function outputTemplate(prompt) {
  const start = prompt.indexOf("## Output template\n");
  const body = prompt.slice(start + "## Output template\n".length);
  const jsonStart = body.indexOf("\n{") + 1;
  const jsonEnd = body.indexOf("\n}\n") + 2;
  return JSON.parse(body.slice(jsonStart, jsonEnd));
}

function runnerWith(answer, calls = [], adapter = "claude-cli/v1") {
  return createAgentRunner({
    adapter,
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        const response = answer(outputTemplate(request.prompt), request);
        return { adapter: request.adapter, stdout: JSON.stringify(response), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
}

const task = {
  id: "task-1", work_id: "work-1", title: "Release", status: "running", type: "code", state_version: 0,
  updated_at: "2026-09-24T00:00:00.000Z", parent_task_id: null, acceptance: "Release the package.",
  review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [],
};

function asFeedback(template, _request) {
  const output = fill(template);
  if (Object.hasOwn(output, "skills_used")) output.skills_used = used;
  if (Object.hasOwn(output, "skill_proposals")) output.skill_proposals = proposals;
  return output;
}

function coreWorkerRequest(context = {}) {
  return { invocation_id: "worker-run", work_id: "work-1", task_id: "task-1", attempt: 1, context: { task, ...context } };
}

function coreReviewerRequest(context = {}) {
  return {
    invocation_id: "reviewer-run", work_id: "work-1", task_id: "task-1", attempt: 1, review_round: 1,
    context: { task, report: { kind: "report", schema_version: "1.0.0", invocation_id: "worker-run", result: "success", work_done: "done", changes: [], verification: { passed: true, method: "checked" }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null }, ...context },
  };
}

test("all strict role schemas include skill fields as required provider properties", () => {
  for (const [schema, fields] of [
    [WORKER_REPORT_SCHEMA, ["skills_used", "skill_proposals"]],
    [HYBRID_REPORT_SCHEMA, ["skills_used", "skill_proposals"]],
    [REVIEW_OUTPUT_SCHEMA, ["skills_used", "skill_proposals"]],
    [MANAGER_PLAN_OUTPUT_SCHEMA, ["skills_used"]],
    [MANAGER_REPLAN_OUTPUT_SCHEMA, ["skills_used"]],
    [MANAGER_FINALIZE_OUTPUT_SCHEMA, ["skills_used", "skill_proposals"]],
  ]) {
    const output = providerSchema(schema);
    for (const field of fields) {
      assert.ok(output.properties[field]);
      assert.ok(output.required.includes(field));
    }
    assert.equal(output.additionalProperties, false);
    assert.deepEqual(output.required, Object.keys(output.properties));
  }
});

test("Worker and Reviewer skill output is returned separately from stored reports and reviews", async () => {
  const worker = await runnerWith(asFeedback).runWorker(coreWorkerRequest());
  assert.equal(worker.outcome, "success", worker.message);
  assert.deepEqual(worker.skill_feedback, { skills_used: used, skill_proposals: proposals });
  assert.equal(Object.hasOwn(worker.report, "skills_used"), false);
  assert.equal(Object.hasOwn(worker.report, "skill_proposals"), false);

  const reviewer = await runnerWith(asFeedback).runReviewer(coreReviewerRequest());
  assert.equal(reviewer.outcome, "success", reviewer.message);
  assert.deepEqual(reviewer.skill_feedback, { skills_used: used, skill_proposals: proposals });
  assert.equal(Object.hasOwn(reviewer.review, "skills_used"), false);
  assert.equal(Object.hasOwn(reviewer.review, "skill_proposals"), false);
  assert.equal(Object.hasOwn(reviewer.report, "skills_used"), false);
});

test("skills_used instructions limit entries to Skill Box skills for every role", async () => {
  const calls = [];
  const runner = runnerWith(asFeedback, calls);
  await runner.runWorker(coreWorkerRequest());
  await runner.runReviewer(coreReviewerRequest());
  await runner.runManagerPlan({
    invocation_id: "manager-plan-run", work_id: "work-1", task_id: null, attempt: 1,
    context: { mode: "plan", work: { id: "work-1", title: "Release" } },
  });
  assert.equal(calls.length, 3);
  for (const call of calls) assert.match(call.prompt, /Only list Skill Box skills that appear in the context\.skills index; never list plugin or process skills/u);
});

test("Manager plan and final output return skill feedback separately", async () => {
  const calls = [];
  const runner = runnerWith(asFeedback, calls, "codex-cli/v1");
  const planned = await runner.runManagerPlan({
    invocation_id: "manager-plan-run", work_id: "work-1", task_id: null, attempt: 1,
    context: { mode: "plan", work: { id: "work-1", title: "Release" } },
  });
  assert.equal(planned.outcome, "success", planned.message);
  assert.deepEqual(planned.skill_feedback, { skills_used: used, skill_proposals: [] });
  assert.equal(Object.hasOwn(planned.report, "skills_used"), false);

  const finalized = await runner.runManagerPlan({
    invocation_id: "manager-final-run", work_id: "work-1", task_id: null, attempt: 1,
    context: { mode: "finalize", work: { id: "work-1", title: "Release" }, tasks: [], reports: [] },
  });
  assert.equal(finalized.outcome, "success", finalized.message);
  assert.deepEqual(finalized.skill_feedback, { skills_used: used, skill_proposals: proposals });
  assert.equal(Object.hasOwn(finalized.report, "skills_used"), false);
  assert.ok(calls.every((call) => call.structured_output_schema.properties.skills_used));
});

test("legacy role outputs without skill fields stay valid and return null feedback", async () => {
  const legacy = (template) => {
    const output = fill(template);
    delete output.skills_used;
    delete output.skill_proposals;
    return output;
  };
  const worker = await runnerWith(legacy).runWorker(coreWorkerRequest());
  assert.equal(worker.outcome, "success", worker.message);
  assert.equal(worker.skill_feedback, null);

  const reviewer = await runnerWith(legacy).runReviewer(coreReviewerRequest());
  assert.equal(reviewer.outcome, "success", reviewer.message);
  assert.equal(reviewer.skill_feedback, null);

  const manager = await runnerWith(legacy).runManagerPlan({
    invocation_id: "manager-legacy", work_id: "work-1", task_id: null, attempt: 1,
    context: { mode: "plan", work: { id: "work-1", title: "Release" } },
  });
  assert.equal(manager.outcome, "success", manager.message);
  assert.equal(manager.skill_feedback, null);
});

async function openUsageDatabase(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-skill-feedback-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('work-1', 'owner:default', 'Work', '', 'normal', 'running', '[]', '[]', ?, ?)", now, now);
  });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, now };
}

async function seedRun(db, now, id, taskId = null) {
  if (taskId !== null && !db.get("SELECT id FROM tasks WHERE id = ?", taskId)) {
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, 'work-1', 'Task', 'code', 'running', 'normal', '', '', ?, ?)`,
      taskId, now, now,
    ));
  }
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
     VALUES (?, 'work-1', ?, 'worker', 'test', 'test', 'running', ?, ?)`,
    id, taskId, now, now,
  ));
}

function skillFiles(revisionText) {
  return { "SKILL.md": `---\nname: release-procedure\ndescription: Release steps.\nscope: global\ntags:\n  - release\n---\n${revisionText}\n` };
}

test("feedback merges with reads in either order and keeps the first revision", async (t) => {
  const { root, db, now } = await openUsageDatabase(t);
  const warnings = [];
  const skillBox = new SkillBox({ db, owlRoot: root, logger: { warn: (message) => warnings.push(message), error() {} } });
  await seedRun(db, now, "run-read-first");
  await seedRun(db, now, "run-feedback-first");
  const meta = { description: "Release steps.", tags: ["release"], scope: "global" };
  await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("version one"), meta, actor: "user", action: "create", reason: "initial", trial: false });

  const feedback = {
    skills_used: [
      { name: "release-procedure", verdict: "helpful", note: "The ordering helped." },
      { name: "missing-skill", verdict: "helpful", note: "Unknown names are ignored." },
      { name: "superpowers:writing-plans", verdict: "helpful", note: "Plugin skills are ignored." },
    ],
    skill_proposals: [proposals[0], { ...proposals[0], kind: "update", target: "release-procedure", summary: "Update release steps" }],
  };
  await skillBox.recordRead("run-read-first", ["release-procedure"]);
  await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("version two"), meta, actor: "user", action: "update", reason: "revision two", trial: false });
  await skillBox.recordFeedback("run-read-first", feedback);

  const feedbackOnly = { skills_used: [{ name: "release-procedure", verdict: "misleading", note: "The old command was wrong." }], skill_proposals: [] };
  await skillBox.recordFeedback("run-feedback-first", feedbackOnly);
  await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("version three"), meta, actor: "user", action: "update", reason: "revision three", trial: false });
  await skillBox.recordRead("run-feedback-first", ["release-procedure"]);
  await skillBox.recordFeedback("unknown-run", feedback);

  const first = db.get("SELECT * FROM skill_usages WHERE agent_run_id = 'run-read-first'");
  const second = db.get("SELECT * FROM skill_usages WHERE agent_run_id = 'run-feedback-first'");
  assert.equal(db.all("SELECT skill_name FROM skill_usages WHERE agent_run_id = 'run-read-first'").length, 1);
  assert.deepEqual(warnings, []);
  assert.equal(first.revision, 1);
  assert.equal(first.read_detected, 1);
  assert.equal(first.verdict, "helpful");
  assert.equal(second.revision, 2);
  assert.equal(second.read_detected, 1);
  assert.equal(second.verdict, "misleading");
  assert.equal(db.get("SELECT use_count FROM skills WHERE name = 'release-procedure'").use_count, 2);
  const inserted = db.all("SELECT * FROM skill_proposals ORDER BY created_at, id");
  assert.equal(inserted.length, 2);
  assert.ok(inserted.every((proposal) => proposal.status === "pending"));
  assert.ok(inserted.every((proposal) => proposal.source_agent_run_id === "run-read-first" && proposal.source_work_id === "work-1"));
  assert.deepEqual(inserted.map((proposal) => proposal.target_skill).sort(), ["release-procedure", null].sort());
});

test("insertProposals stores source fingerprints and schedules the Curator", async (t) => {
  const { root, db } = await openUsageDatabase(t);
  let scheduled = 0;
  const skillBox = new SkillBox({
    db,
    owlRoot: root,
    logger: { warn() {}, error() {} },
    onProposalsInserted: () => { scheduled += 1; },
  });

  const [id] = await skillBox.insertProposals(null, "work-1", null, [
    { ...proposals[0], source_fingerprint: "lesson-fingerprint-1" },
  ]);
  const row = db.get("SELECT payload_json, source_work_id, source_agent_run_id FROM skill_proposals WHERE id = ?", id);
  assert.equal(row.source_work_id, "work-1");
  assert.equal(row.source_agent_run_id, null);
  assert.equal(JSON.parse(row.payload_json).source_fingerprint, "lesson-fingerprint-1");
  assert.equal(scheduled, 1);
});

test("insertProposals reuses applied and rejected rows by source work and procedure fingerprint", async (t) => {
  const { root, db } = await openUsageDatabase(t);
  let scheduled = 0;
  const skillBox = new SkillBox({
    db,
    owlRoot: root,
    logger: { warn() {}, error() {} },
    onProposalsInserted: () => { scheduled += 1; },
  });

  for (const status of ["applied", "rejected"]) {
    const procedure = { ...proposals[0], steps_or_diff: `${proposals[0].steps_or_diff} (${status})` };
    const [originalId] = await skillBox.insertProposals(null, "work-1", null, [
      { ...procedure, source_fingerprint: `source-${status}` },
    ]);
    await db.createWriteLane().transact((tx) => tx.run("UPDATE skill_proposals SET status = ? WHERE id = ?", status, originalId));

    const [reusedId] = await skillBox.insertProposals(null, "work-1", null, [procedure]);
    assert.equal(reusedId, originalId);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM skill_proposals WHERE source_work_id = 'work-1'").count, status === "applied" ? 1 : 2);
  }
  assert.equal(scheduled, 2, "only newly inserted proposals schedule the Curator");
});

test("feedback recording failures do not prevent a Task transition", async (t) => {
  const { db, now } = await openUsageDatabase(t);
  await seedRun(db, now, "worker-run", "task-1");
  const workflow = new WorkflowEngine({
    db,
    agentRunner: {},
    skillBox: { recordFeedback: async () => { throw new Error("bookkeeping unavailable"); } },
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  t.after(() => { console.warn = originalWarn; });
  await workflow.recordWorkerResult("work-1", "task-1", "worker-run", {
    outcome: "failed",
    failure_class: "deterministic",
    error_key: "worker_failure",
    retry_allowed: false,
    report_valid: false,
    message: "work failed",
    skill_feedback: { skills_used: [], skill_proposals: [proposals[0]] },
  }, 1);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(db.get("SELECT status FROM tasks WHERE id = 'task-1'").status, "judgement_waiting");
});

test("skill fields from a Worker run stay out of stored reports and dependency reports", async (t) => {
  const { db, now } = await openUsageDatabase(t);
  await seedRun(db, now, "worker-run", "task-1");
  const workflow = new WorkflowEngine({ db, agentRunner: {}, skillBox: { recordFeedback: async () => undefined, renderIndex: () => null } });
  const result = await runnerWith(asFeedback).runWorker(coreWorkerRequest());
  assert.deepEqual(result.skill_feedback, { skills_used: used, skill_proposals: proposals });
  await workflow.recordWorkerResult("work-1", "task-1", "worker-run", result, 1);

  const stored = JSON.parse(db.get("SELECT payload_json FROM reports WHERE agent_run_id = 'worker-run'").payload_json);
  assert.equal(Object.hasOwn(stored, "skills_used"), false);
  assert.equal(Object.hasOwn(stored, "skill_proposals"), false);

  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'completed' WHERE id = 'task-1'");
    tx.run(`INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
            VALUES ('task-2', 'work-1', 'Next', 'code', 'ready', 'normal', '', '', ?, ?)`, now, now);
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('task-2', 'task-1')");
  });
  const { dependency_reports: dependencyReports } = dependencyContext(db, "task-2");
  assert.equal(dependencyReports.length, 1);
  assert.ok(dependencyReports.every((report) => !Object.hasOwn(report, "skills_used") && !Object.hasOwn(report, "skill_proposals")));
});
