import assert from "node:assert/strict";
import { test } from "node:test";

import { workerPromptInputs } from "../../packages/agent-runtime/dist/worker.js";
import { ROLE_INPUT_LAYERS } from "../../packages/agent-runtime/dist/role-contract.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { dependencyContext, readDependencyReport } from "../../packages/core/dist/task-context.js";
import { ContextBuilder } from "../../packages/core/dist/context-builder.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { necessityFor, criteriaFor } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};
const LONG = `${"x".repeat(900)}TAIL-MARKER`;

async function seededDependency(t) {
  const { db, core, root } = await createTestCore(t, { agentRunner }, { prefix: "owl-work-context-", start: true });
  const workId = (await core.createWork(command({ title: "W", summary: "", size: "small", project_id: null }, "wc:work"))).data.work_id;
  const now = "2026-09-27T00:00:00.000Z";
  const dep = "01TASKAAAAAAAAAAAAAAAAAAAA";
  const main = "01TASKBBBBBBBBBBBBBBBBBBBB";
  const runId = createUlid();
  const report = { result: "success", work_done: LONG, changes: [{ file: "a.ts", action: "LONG-ACTION" }], remaining_issues: [{ issue: "OPEN-ISSUE", impact: "LONG-IMPACT", next_step: "n" }], verification: { evidence: "FULL-ONLY-EVIDENCE" } };
  await db.createWriteLane().transact((tx) => {
    for (const [id, status] of [[dep, "completed"], [main, "waiting"]]) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, created_at, updated_at)
         VALUES (?, ?, ?, 'code', ?, 'normal', '', '', '/repo', ?, ?)`, id, workId, id, status, now, now);
    }
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", main, dep);
    tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'p', 'm', 'completed', ?, ?)", runId, workId, dep, now, now);
    tx.run("INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1.1.0', 'success', ?, ?, 1, ?)", createUlid(), runId, JSON.stringify(report), "a".repeat(64), now);
  });
  return { db, root, main };
}

test("dependencies are summarised by default and the full report is read through report_path", async (t) => {
  const { db, root, main } = await seededDependency(t);
  const [entry] = dependencyContext(db, main, root).dependency_reports;
  const input = JSON.stringify(workerPromptInputs({ context: { dependency_reports: [entry] } }));
  assert.ok(!input.includes("TAIL-MARKER") && !input.includes("FULL-ONLY-EVIDENCE"), "full report must not be in the Input");
  assert.ok(input.includes(entry.report_path));
  assert.equal(entry.work_done.length, 600);
  assert.ok(entry.work_done.endsWith("…"));
  // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
  assert.deepEqual(Object.keys(entry), ["task_id", "manager_task_id", "title", "work_done", "changed_files", "open_issues", "design_document_path", "report_path"]);
  assert.deepEqual(entry.changed_files, ["a.ts"]);
  assert.deepEqual(entry.open_issues, ["OPEN-ISSUE"]);
  assert.ok(!input.includes("LONG-ACTION") && !input.includes("LONG-IMPACT"), "changes and remaining_issues details stay out");
  const full = readDependencyReport(entry.report_path);
  assert.equal(full.work_done, LONG);
  assert.equal(full.verification.evidence, "FULL-ONLY-EVIDENCE");
});

test("the summary length follows the setting passed in", async (t) => {
  const { db, root, main } = await seededDependency(t);
  assert.equal(dependencyContext(db, main, root, 50).dependency_reports[0].work_done.length, 50);
  assert.equal(dependencyContext(db, main, root, 5000).dependency_reports[0].work_done, LONG);
});

test("the role budget given to ContextBuilder sets how far the dependency summary is cut", async (t) => {
  const { db, root, main } = await seededDependency(t);
  const taskRow = db.get("SELECT * FROM tasks WHERE id = ?", main);
  const budget = (n) => { const b = { dependency_summary_max_chars: n }; return { worker: b, designer: b, reviewer: b }; };
  const summary = async (n) => (await new ContextBuilder(db, root, {}, () => budget(n)).buildWorkerContext("worker", taskRow.work_id, main, taskRow)).dependency_reports[0].work_done;
  assert.equal((await summary(40)).length, 40);
  assert.equal(await summary(5000), LONG);
  assert.equal((await new ContextBuilder(db, root).buildWorkerContext("worker", taskRow.work_id, main, taskRow)).dependency_reports[0].work_done.length, 600);
});

test("the Owner's free-text answer reaches the Reviewer context as owner_guidance, like the Worker's", async (t) => {
  const { db, root, main } = await seededDependency(t);
  const taskRow = db.get("SELECT * FROM tasks WHERE id = ?", main);
  const now = "2026-09-27T00:00:00.000Z";
  const decision = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state, options_json, allow_free_text, issuer_role, created_at)
       VALUES (?, ?, 'task', 'resolved', ?, 'Reason', 'Q?', 'T', 'S', '[]', 1, 'core', ?)`, decision, taskRow.work_id, JSON.stringify([main]), now);
    tx.run("INSERT INTO decision_answers (id, decision_id, answerer_id, answer_json, source, received_at) VALUES (?, ?, 'owner:default', ?, 'web', ?)",
      createUlid(), decision, JSON.stringify({ answer: "OWNER-CHANGED-POLICY" }), now);
  });
  const builder = new ContextBuilder(db, root);
  const reviewer = await builder.buildReviewerContext(taskRow.work_id, taskRow, [], []);
  const worker = await builder.buildWorkerContext("worker", taskRow.work_id, main, taskRow);
  assert.equal(reviewer.owner_guidance[0].answer, "OWNER-CHANGED-POLICY");
  assert.deepEqual(reviewer.owner_guidance, worker.owner_guidance);
});

test("Reviewer findings reach the Worker only in the dynamic Attempt column", () => {
  const findings = [{ file: "src/a.ts", line: 7, severity: "major", target: "deliverable", subject: "other", problem: "FINDING-SUMMARY", reason: "FINDING-SCENARIO", fix: "x" }];
  const inputs = workerPromptInputs({
    task: { title: "T", acceptance: "A", context: "" },
    context: { rules: "r", dependency_reports: [], reviewer_findings: findings, previous_report: { result: "success", work_done: "prev", changes: [], remaining_issues: [] } },
  });
  const holders = inputs.filter((slot) => JSON.stringify(slot.value).includes("FINDING-SCENARIO"));
  assert.deepEqual(holders.map((slot) => slot.name), ["Attempt"]);
  assert.equal(ROLE_INPUT_LAYERS.Attempt, "dynamic");
  assert.deepEqual(holders[0].value.reviewer_findings.map((f) => [f.id, f.file, f.line, f.problem]), [["F1", "src/a.ts", 7, "FINDING-SUMMARY"]]);
});

test("the Fix Packet numbers the findings, drops scoring and trims the previous report", () => {
  const finding = (n, extra) => ({ severity: "major", target: "deliverable", scope: "in_scope", subject: "other", file: `f${n}.ts`, line: n, problem: `P${n}`, reason: `R${n}`, fix: `X${n}`, ...extra });
  const context = {
    reviewer_findings: [finding(1), finding(0, { line: 0 }), finding(3, { target: "report" })],
    previous_report: {
      result: "success", work_done: "DONE", delegation: { retained: ["DELEGATION-ONLY"] },
      changes: [{ file: "a.ts", action: "ACT", extra: "CHANGE-EXTRA" }],
      remaining_issues: [{ issue: "I", impact: "M", next_step: "N" }],
      verification: { evidence: "FULL-ONLY-EVIDENCE" },
    },
    verification_failure: null,
    process_wait: { done_path: "d" },
  };
  const inputs = workerPromptInputs({ context });
  const attempt = inputs.find((slot) => slot.name === "Attempt").value;
  assert.deepEqual(attempt.reviewer_findings.map((f) => [f.id, f.file, f.line, f.target]), [["F1", "f1.ts", 1, "deliverable"], ["F2", "f0.ts", null, "deliverable"], ["F3", "f3.ts", 3, "report"]]);
  assert.deepEqual(Object.keys(attempt.reviewer_findings[0]), ["id", "target", "file", "line", "problem", "reason", "fix"]);
  assert.deepEqual(attempt.previous_report, { result: "success", work_done: "DONE", changes: [{ file: "a.ts", action: "ACT" }], remaining_issues: [{ issue: "I", impact: "M", next_step: "N" }] });
  assert.deepEqual(attempt.process_wait, { done_path: "d" });
  const rest = JSON.stringify(inputs.filter((slot) => slot.name !== "Attempt"));
  assert.ok(!rest.includes("P1") && !rest.includes("FULL-ONLY-EVIDENCE"), "findings stay in the Attempt field only");
});

test("the Worker context carries the researcher settings and the Designer context does not", async (t) => {
  const planned = (id, type) => ({
    id, title: `${id} title`, type, necessity: necessityFor(), acceptance_criteria: criteriaFor("Done; verified by the test."),
    depends_on: [], context: "", notes: "", review: false, required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [],
  });
  const requests = {};
  const stop = { outcome: "failed", failure_class: "deterministic", error_key: "x", retry_allowed: false, message: "Stops here in this test." };
  const runner = {
    runManagerPlan: async (request) => (request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planned("T1", "code"), planned("D1", "design")] } }
      : { outcome: "failed", message: "The Manager stops here in this test." },
    runWorker: async (request) => { requests.worker = request; return stop; },
    runDesigner: async (request) => { requests.designer = request; return stop; },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { core } = await createTestCore(t, { agentRunner: runner, max_parallel: 4, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-work-context-research-", start: true });
  const created = await core.createWork(command({ title: "W", summary: "x", size: "normal", project_id: null }, "wc:research:create"));
  await core.startWork(created.data.work_id, command({ mode: "normal" }, "wc:research:start", created.version));
  await waitFor(() => requests.worker && requests.designer);
  assert.deepEqual(requests.worker.context.research_subagent, core.getChildRunSettings().research_subagent);
  assert.equal("research_subagent" in requests.designer.context, false);
});
