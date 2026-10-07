import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createTaskPlanInTransaction, createWorkInTransaction, NoopGitGateway, WorkflowEngine } from "../../packages/core/dist/index.js";
import { resolveRoleModel } from "../../packages/core/dist/workflow-engine.js";
import { buildDesignerRolePrompt, DESIGNER_REPORT_SCHEMA, normalizeWorkerResponseWithFeedback } from "../../packages/agent-runtime/dist/worker.js";
import { readDesignBlocked } from "../../packages/shared/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_REMAKE_LIMIT_SETTINGS } from "../../packages/shared/dist/remake-limit-settings.js";
import { createTestCore } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

test("a lead Work assigns design Tasks to Lead Designer without changing other Tasks", async (t) => {
  const { db } = await openTestDatabase(t, { prefix: "owl-designer-tier-" });
  const work = await db.createWriteLane().transact((tx) => {
    const created = createWorkInTransaction(tx, {
      title: "Lead design", summary: "Use Lead Designer", size: "normal", project_id: null, design_mode: "lead",
    });
    createTaskPlanInTransaction(tx, created.id, [
      { id: "D1", title: "Design", type: "design", acceptance: "Design exists", depends_on: [] },
      { id: "W1", title: "Implement", type: "code", acceptance: "Code exists", depends_on: ["D1"] },
    ]);
    return created;
  });
  assert.equal(db.get("SELECT design_mode FROM works WHERE id = ?", work.id).design_mode, "lead");
  assert.deepEqual(db.all("SELECT type, lead_designer_start_round AS start FROM tasks WHERE work_id = ? ORDER BY created_at, manager_task_id", work.id), [
    { type: "design", start: 0 },
    { type: "code", start: null },
  ]);
});

test("Designer and Lead Designer keep independent model settings", async (t) => {
  const { db } = await openTestDatabase(t, { prefix: "owl-designer-models-" });
  await db.createWriteLane().transact((tx) => {
    const now = new Date().toISOString();
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
    "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
    JSON.stringify({ version: 1, roles: [
      { role: "designer", provider: "anthropic", model: "ordinary-model", effort: "medium" },
      { role: "lead_designer", provider: "anthropic", model: "strong-model", effort: "high" },
    ] }), now,
  );
  });
  assert.equal(resolveRoleModel(db, "designer").model, "ordinary-model");
  assert.equal(resolveRoleModel(db, "lead_designer").model, "strong-model");
});

test("Lead Designer prompt identifies the escalation and retains design restrictions", () => {
  const prompt = buildDesignerRolePrompt({
    task: { id: "T1", work_id: "W1", title: "Architecture", type: "design", acceptance: "Complete design" },
    context: { design_document_path: "/tmp/design.md", design_tier: "lead", reviewer_findings: [] },
  });
  assert.match(prompt, /Owl Lead Designer/);
  assert.match(prompt, /two failed reviews/);
  assert.match(prompt, /Do not modify any file in the repository/);
});

test("workflow launch records the configured model and tier for each design Task", async (t) => {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-designer-dispatch-" });
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const workflow = new WorkflowEngine({
    db, owlRoot: root, dataDir: root, git: new NoopGitGateway(),
    agentRunner: { runDesigner: async () => gate },
  });
  t.after(async () => {
    release({ outcome: "failed", report_valid: false, message: "test stopped", skill_feedback: null });
    await workflow.stop();
  });
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Mixed design", summary: "x", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const tasks = createTaskPlanInTransaction(tx, work.id, [
      { id: "D1", title: "Ordinary", type: "design", acceptance: "Document", depends_on: [] },
      { id: "D2", title: "Lead", type: "design", acceptance: "Document", depends_on: [] },
    ]);
    tx.run("UPDATE tasks SET lead_designer_start_round = 0 WHERE id = ?", tasks[1].id);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "designer", provider: "anthropic", model: "ordinary-model", effort: "medium" },
        { role: "lead_designer", provider: "anthropic", model: "strong-model", effort: "high" },
      ] }), new Date().toISOString());
    return work.id;
  });
  workflow.start();
  await workflow.resolveDependencies(workId);
  assert.equal((await workflow.launchReady(workId)).length, 2);
  assert.deepEqual(db.all("SELECT design_tier, model FROM agent_runs WHERE work_id = ? ORDER BY model", workId), [
    { design_tier: "standard", model: "ordinary-model" },
    { design_tier: "lead", model: "strong-model" },
  ]);
});

const designRequest = (context = {}) => ({
  task: { id: "D1", work_id: "w", title: "Design", status: "running", type: "design", state_version: 0, updated_at: "2026-10-06T00:00:00.000Z", parent_task_id: null, acceptance: "Document", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [] },
  context: { design_document_path: "/tmp/design.md", ...context },
});

function designerTemplate() {
  const prompt = buildDesignerRolePrompt(designRequest());
  const body = prompt.slice(prompt.indexOf("## Output template\n") + "## Output template\n".length);
  const fill = (value) => {
    if (typeof value === "string") return /^<.+>$/.test(value) ? `filled ${value.slice(1, -1)}` : value;
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
    return value;
  };
  return fill(JSON.parse(body.slice(body.indexOf("\n{") + 1, body.indexOf("\n}\n") + 2)));
}

const blocked = { cause_kind: "wrong_premise", cause: "The premise is wrong.", repeated_findings: [{ summary: "Premise", times: 3 }], question: "Which way?", options: [{ label: "A", description: "Do A" }, { label: "B", description: "Do B" }], recommended_option: 0 };
const respond = (payload) => ({ adapter: "claude-cli/v1", stdout: JSON.stringify(payload), stderr: "", exit_code: 0, signal: null, format: "plain-text" });

test("the Designer prompt always carries the design_blocked instruction", () => {
  const prompt = buildDesignerRolePrompt(designRequest());
  assert.match(prompt, /set design_blocked \(cause_kind, cause, repeated_findings, question, options, recommended_option\)/);
  assert.doesNotMatch(prompt, /Core has stopped remaking this design/);
});

test("a stopped design asks the Designer to fill design_blocked without rewriting", () => {
  const prompt = buildDesignerRolePrompt(designRequest({ design_stop: { rejections: 2, limit: 2, review_history: [{ round: 1, findings: [{ target: "t", file: "f", line: 1, problem: "p", reason: "r", fix: "x" }] }] } }));
  assert.match(prompt, /Core has stopped remaking this design/);
  assert.match(prompt, /Attempt\.design_stop/);
  assert.match(prompt, /design_blocked must not be null in this run/);
  assert.match(prompt, /"id": "F1"/);
});

test("DESIGNER_REPORT_SCHEMA accepts design_blocked and WORKER_REPORT_SCHEMA does not", () => {
  const template = designerTemplate();
  const accepted = normalizeWorkerResponseWithFeedback(respond({ ...template, design_blocked: blocked }), "run-1", false, undefined, DESIGNER_REPORT_SCHEMA);
  assert.deepEqual(accepted.report.design_blocked, blocked);
  assert.equal(normalizeWorkerResponseWithFeedback(respond({ ...template, design_blocked: null }), "run-1", false, undefined, DESIGNER_REPORT_SCHEMA).report.design_blocked, undefined);
  assert.throws(() => normalizeWorkerResponseWithFeedback(respond({ ...template, design_blocked: { ...blocked, cause_kind: "other" } }), "run-1", false, undefined, DESIGNER_REPORT_SCHEMA));
  assert.throws(() => normalizeWorkerResponseWithFeedback(respond({ ...template, design_blocked: blocked }), "run-1"));
});

test("readDesignBlocked rejects an out-of-range recommended_option", () => {
  assert.deepEqual(readDesignBlocked(blocked), blocked);
  assert.equal(readDesignBlocked({ ...blocked, recommended_option: 2 }), null);
});

// ---- end to end: a design Task stopped after escalation ----
const e2eEnvelope = (payload, suffix, expectedVersion = 0) => ({ request_id: createUlid(), idempotency_key: `test:${suffix}:${createUlid()}`, expected_version: expectedVersion, payload });
const e2eReport = (invocationId, extra = {}) => ({
  kind: "report", schema_version: "1.0.0", invocation_id: invocationId, result: "success", work_done: "Done.", changes: [],
  verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null, ...extra,
});
const e2eRejection = () => {
  const review = { verdict: "fix_required", summary: "Premise is wrong.", findings: [{ severity: "major", pre_existing: false, file: "design.md", problem: "Wrong premise.", fix: "Rethink." }], tests: {} };
  return { outcome: "failed", report_valid: true, report: { kind: "review", ...review }, review };
};

async function runDesignStop(t, { stopRun, settings, normalRun }) {
  const calls = { reviewer: 0, designer: 0, stopRuns: 0, tiers: [], manager: [] };
  const agentRunner = withNecessity({
    runManagerPlan: async (request) => (calls.manager.push(JSON.stringify(request)), request.context?.mode === "plan")
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Design", type: "design", acceptance: "A design document exists.", depends_on: [], required_sections: [], required_tests: [], replaces: [] }] } }
      : { outcome: "failed", message: "unexpected manager call" },
    runDesigner: async (request) => {
      calls.designer += 1;
      calls.tiers.push(request.context.design_tier);
      await mkdir(dirname(request.context.design_document_path), { recursive: true });
      await writeFile(request.context.design_document_path, `# Design ${calls.designer}\n`);
      if (request.context.design_stop) {
        calls.stopRuns += 1;
        return stopRun(request);
      }
      if (normalRun) return normalRun(request);
      return { outcome: "success", report_valid: true, report: e2eReport(request.invocation_id, { changes: [{ file: request.context.design_document_path, action: "created" }] }) };
    },
    runWorker: async () => ({ outcome: "failed", message: "no code" }),
    runReviewer: async () => (calls.reviewer += 1, e2eRejection()),
    runAdvisor: async () => ({ reply: "" }),
  });
  const { db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-design-stop-", start: true });
  if (settings) await core.setRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, ...settings });
  const created = await core.createWork(e2eEnvelope({ title: "design stop", summary: "x", size: "normal", project_id: null }, "create"));
  await core.startWork(created.data.work_id, e2eEnvelope({ mode: "normal" }, "start", created.version));
  const workId = created.data.work_id;
  const waiting = await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId)?.state === "judgement_waiting", { timeoutMs: 20_000, message: "the Work waits for the Owner" });
  assert.ok(waiting);
  await new Promise((r) => setTimeout(r, 300));
  return { db, core, workId, calls };
}

test("after escalation one Lead rejection stops the design: report-only run, then a structured Decision", async (t) => {
  const { db, core, workId, calls } = await runDesignStop(t, {
    stopRun: (request) => ({ outcome: "success", report_valid: true, report: e2eReport(request.invocation_id, { design_blocked: blocked }) }),
  });
  assert.equal(calls.stopRuns, 1, "exactly one report-only Designer run");
  assert.equal(calls.tiers.at(-2), "lead", "the last remake was the Lead run");
  const designerRuns = calls.designer;
  const task = db.get("SELECT status, lead_review_rejections, design_stop_json FROM tasks WHERE work_id = ?", workId);
  assert.equal(task.status, "judgement_waiting");
  assert.equal(task.lead_review_rejections, 1);
  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision, "a Decision is open");
  assert.deepEqual(JSON.parse(decision.design_block_json), { cause_kind: "wrong_premise", repeated_findings: [{ summary: "Premise", times: 3 }] }, "the cause is stored as data");
  assert.deepEqual(core.listDecisions({ status: "open" }).data[0].design_block, { cause_kind: "wrong_premise", repeated_findings: [{ summary: "Premise", times: 3 }] });
  const text = JSON.stringify(decision);
  assert.match(text, /The premise is wrong\./);
  assert.match(text, /Which way\?/);
  assert.match(text, /option_1/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.designer, designerRuns, "the Designer is not restarted while the Owner decides");
  // The Web sends only the label "A"; the Manager must still learn what it stands for.
  const before = calls.manager.length;
  await core.answerDecision(decision.id, e2eEnvelope({ answer: "A", option_key: "option_1", source_message_id: null }, "answer", decision.state_version));
  await waitFor(() => calls.manager.slice(before).some((request) => request.includes("Do A")), { timeoutMs: 20_000, message: "the Manager replan carries the chosen option's description" });
  assert.ok(calls.manager.slice(before).some((request) => request.includes("Which way?")), "and the question it answers");
});

test("the Decision still opens when the report-only run returns invalid output or fails", async (t) => {
  const { db, workId } = await runDesignStop(t, { stopRun: () => ({ outcome: "failed", report_valid: false, message: "invalid output" }) });
  assert.equal(db.get("SELECT status FROM tasks WHERE work_id = ?", workId).status, "judgement_waiting");
  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision, "the Decision opens without the writer's report");
  assert.equal(decision.design_block_json, null);
  assert.match(JSON.stringify(decision), /cancel/);
});

test("a Designer that reports design_blocked opens a Decision without a Reviewer or a remake", async (t) => {
  const { db, core, workId, calls } = await runDesignStop(t, {
    normalRun: (request) => ({ outcome: "success", report_valid: true, report: e2eReport(request.invocation_id, { result: "failed", design_blocked: blocked }) }),
  });
  assert.equal(calls.designer, 1, "the Designer is not run again");
  assert.equal(calls.reviewer, 0, "no Reviewer is started");
  assert.equal(db.get("SELECT status FROM tasks WHERE work_id = ?", workId).status, "judgement_waiting");
  assert.deepEqual(core.listDecisions({ status: "open" }).data[0].design_block, { cause_kind: "wrong_premise", repeated_findings: [{ summary: "Premise", times: 3 }] });
  assert.match(JSON.stringify(db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId)), /The premise is wrong\./);
});

for (const [name, invalid] of [["an unknown cause_kind", { ...blocked, cause_kind: "other" }], ["a missing cause", { ...blocked, cause: undefined }]]) {
  test(`a Designer design_blocked with ${name} is not an early stop: the normal flow runs`, async (t) => {
    const { db, workId, calls } = await runDesignStop(t, {
      normalRun: (request) => ({ outcome: "success", report_valid: true, report: e2eReport(request.invocation_id, { design_blocked: invalid }) }),
    });
    assert.ok(calls.reviewer >= 1, "the Reviewer still runs on the design");
    assert.ok(calls.designer > 1, "the Designer is remade by the normal rejection flow");
    // Any Decision comes from the Reviewer rejection stop, never from the invalid design_blocked.
    const decision = db.get("SELECT design_block_json FROM decisions WHERE work_id = ? AND status = 'open'", workId);
    assert.ok(!decision || decision.design_block_json === null || JSON.parse(decision.design_block_json).cause_kind !== "other");
  });
}

test("with the limit set to 2 the first Lead rejection is remade and the second stops", async (t) => {
  const { db, workId, calls } = await runDesignStop(t, {
    settings: { lead_review_rejections: 2 },
    stopRun: (request) => ({ outcome: "success", report_valid: true, report: e2eReport(request.invocation_id, { design_blocked: blocked }) }),
  });
  assert.equal(db.get("SELECT lead_review_rejections AS n FROM tasks WHERE work_id = ?", workId).n, 2);
  assert.equal(calls.tiers.filter((tier) => tier === "lead").length >= 2, true, "a second Lead run happened before the stop");
});
