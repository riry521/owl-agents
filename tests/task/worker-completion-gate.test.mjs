import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { evaluateWorkerCompletion } from "../../packages/core/dist/task-completion-gate.js";
import { WorkflowEngine } from "../../packages/core/dist/workflow-engine.js";
import { openTestDatabase } from "../helpers/db.mjs";
const normal = { hybrid: false, delegated_work_detected: false };

function report(overrides = {}, verification = {}) {
  return {
    kind: "report", schema_version: "1.1.0", invocation_id: "run", result: "success", work_done: "Done.",
    delegation: { decomposition: "x", delegated: [], retained: [] }, changes: [], remaining_issues: [],
    next_action: "none", needs_replanning: false, question_for_manager: null,
    verification: {
      status: "passed", method: "Checked.", checks: [{ name: "build", status: "passed", evidence: "ok" }],
      acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "e" }],
      integration_check: null, ...verification,
    },
    ...overrides,
  };
}

const integrationPassed = { status: "passed", evidence: "Integrated." };
const integrationRequired = { ...integrationPassed, required: true };

test("Completion Gate (Normal): only a fully passed success report passes", () => {
  assert.deepEqual(evaluateWorkerCompletion(report(), normal), { passed: true, reasons: [], error_key: null });
  const cases = [
    [report({ result: "partial" }), "worker_completion_gate_failed"],
    [report({ result: "failed" }), "worker_completion_gate_failed"],
    [report({ needs_replanning: true }), "worker_completion_gate_failed"],
    [report({ question_for_manager: "Which one?" }), "worker_completion_gate_failed"],
    [report({}, { status: "failed" }), "worker_verification_failed"],
    [report({}, { status: "blocked" }), "worker_verification_blocked"],
    [report({}, { acceptance: [{ criterion_id: "AC1", criterion: "c", status: "failed", evidence: "e" }] }), "worker_verification_failed"],
    [report({}, { checks: [{ name: "build", status: "blocked", evidence: "e" }] }), "worker_verification_blocked"],
    [report({}, { acceptance: [] }), "worker_verification_incomplete"],
  ];
  for (const [input, key] of cases) {
    const verdict = evaluateWorkerCompletion(input, normal);
    assert.equal(verdict.passed, false);
    assert.equal(verdict.error_key, key);
    assert.ok(verdict.reasons.length > 0);
  }
});

test("Completion Gate: a legacy 1.0.0 report is judged on verification.passed", () => {
  const legacy = (passed) => ({ ...report(), schema_version: "1.0.0", verification: { passed, method: "m" } });
  assert.equal(evaluateWorkerCompletion(legacy(true), normal).passed, true);
  assert.equal(evaluateWorkerCompletion(legacy(false), normal).error_key, "worker_verification_failed");
});

test("Completion Gate (Hybrid): a passed integration_check is required, not the Executor success count", () => {
  const hybrid = { hybrid: true, delegated_work_detected: false };
  assert.equal(evaluateWorkerCompletion(report({}, { integration_check: integrationPassed }), hybrid).passed, true);
  // No delegated child and no observed subagent: integration_check is not required even in Hybrid.
  assert.equal(evaluateWorkerCompletion(report(), hybrid).passed, true);
  const delegatedReport = (verification = {}) => report({ delegation: { decomposition: "x", delegated: [{ child_id: "c1", instruction: "i", provider: "p", model: "m" }], retained: [] } }, verification);
  assert.equal(evaluateWorkerCompletion(delegatedReport(), hybrid).error_key, "hybrid_integration_verification_missing");
  assert.equal(evaluateWorkerCompletion(delegatedReport({ integration_check: integrationPassed }), hybrid).passed, true);
  assert.equal(evaluateWorkerCompletion(delegatedReport({ integration_check: { status: "failed", evidence: "x" } }), hybrid).error_key, "hybrid_integration_verification_missing");
  assert.equal(evaluateWorkerCompletion(delegatedReport({ integration_check: { status: "blocked", evidence: "x" } }), hybrid).passed, false);
  const manyExecutors = report({ delegation: { decomposition: "x", delegated: [1, 2, 3].map((n) => ({ child_id: `c${n}`, instruction: "i", provider: "p", model: "m" })), retained: [] } });
  assert.equal(evaluateWorkerCompletion(manyExecutors, hybrid).passed, false);
});

test("Completion Gate (Subagent): observed subagents need integration; no observation never fails a Task", () => {
  const observed = { hybrid: false, delegated_work_detected: true };
  assert.equal(evaluateWorkerCompletion(report(), observed).error_key, "hybrid_integration_verification_missing");
  assert.equal(evaluateWorkerCompletion(report({}, { integration_check: integrationRequired }), observed).passed, true);
  for (const check of [integrationPassed, { ...integrationPassed, required: false }]) {
    assert.equal(evaluateWorkerCompletion(report({}, { integration_check: check }), observed).passed, true);
  }
  for (const check of [null, { status: "failed", evidence: "x" }, { status: "blocked", evidence: "x" }]) {
    assert.equal(evaluateWorkerCompletion(report({}, { integration_check: check }), observed).error_key, "hybrid_integration_verification_missing");
  }
  const declared = report({ delegation: { decomposition: "x", delegated: [], retained: [], own_subagents_used: true } }, { integration_check: integrationPassed });
  assert.equal(evaluateWorkerCompletion(declared, normal).passed, true);
  // The watcher could not list processes: nothing observed, the report decides.
  assert.equal(evaluateWorkerCompletion(report(), normal).passed, true);
});

async function openWorkflow(t, { hybrid = false, launchHybrid = hybrid, childRuns } = {}) {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-completion-gate-" });
  // The Task type policy inspects the Task worktree, so the Task owns one valid code file.
  await writeFile(join(root, "a.mjs"), "export const x = 1;\n");
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('work-1', 'owner:default', 'Work', '', 'normal', 'running', '[]', '[]', ?, ?)", now, now);
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, created_at, updated_at)
       VALUES ('task-1', 'work-1', 'Task', 'code', 'running', 'normal', '', '', ?, ?, ?)`, root, now, now);
    tx.run(
      `INSERT INTO artifacts (id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, version_no, created_at)
       VALUES ('artifact-1', 'work-1', 'task-1', 'a.mjs', 'generated', 1, ?, 1, 'text/javascript', 1, ?)`, "a".repeat(64), now);
    if (hybrid) tx.run("INSERT INTO settings (owner_id, key, value_json, schema_version, updated_at) VALUES ('owner:default', 'hybrid_mode', 'true', '1.0.0', ?)", now);
  });
  let reviewerRuns = 0;
  const agentRunner = {
    runReviewer: async (request) => {
      reviewerRuns += 1;
      return { outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id }, review: { verdict: "pass", findings: [], tests: {} } };
    },
  };
  const workflow = new WorkflowEngine({ db, agentRunner, childRuns });
  const seedRun = (id, parent = null, origin = null, status = parent ? "exited" : "running") => db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO agent_runs (id, work_id, task_id, parent_agent_id, role, origin, provider, model, status, created_at, updated_at)
     VALUES (?, 'work-1', 'task-1', ?, ?, ?, 'test', 'test', ?, ?, ?)`,
    id, parent, parent ? "executor" : "worker", origin, status, now, now));
  const count = (sql, ...args) => db.get(sql, ...args).n;
  const events = (type) => count("SELECT COUNT(*) AS n FROM events WHERE task_id = 'task-1' AND type = ?", type);
  const succeed = (runId, body) => workflow.recordWorkerResult("work-1", "task-1", runId, { outcome: "success", report_valid: true, report: body }, 1, null, launchHybrid);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  return { db, workflow, seedRun, count, events, succeed, settle, reviewerRuns: () => reviewerRuns };
}

test("Workflow: a success claim with a failed verification starts no Reviewer and never reaches verifying", async (t) => {
  const w = await openWorkflow(t);
  await w.seedRun("run-1");
  await w.succeed("run-1", report({}, { status: "failed" }));
  await w.settle();
  assert.equal(w.reviewerRuns(), 0);
  assert.equal(w.count("SELECT COUNT(*) AS n FROM agent_runs WHERE role = 'reviewer'"), 0);
  assert.equal(w.events("verification.started"), 0);
  assert.equal(w.events("agent.exited"), 0);
  assert.notEqual(w.db.get("SELECT status FROM tasks WHERE id = 'task-1'").status, "verifying");
  const failure = JSON.parse(w.db.get("SELECT payload_json FROM events WHERE task_id = 'task-1' AND type = 'task.failure.classified'").payload_json);
  assert.equal(failure.error_key, "worker_verification_failed");
  assert.equal(failure.retry_allowed, true);
  assert.match(failure.gate_reasons.join("; "), /verification\.status is failed/u);
  assert.equal(failure.reason, undefined);
});

test("Workflow: blocked and incomplete verification use their own error keys", async (t) => {
  for (const [verification, key] of [[{ status: "blocked" }, "worker_verification_blocked"], [{ acceptance: [] }, "worker_verification_incomplete"]]) {
    const w = await openWorkflow(t);
    await w.seedRun("run-1");
    await w.succeed("run-1", report({}, verification));
    assert.equal(JSON.parse(w.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, key);
    assert.equal(w.reviewerRuns(), 0);
  }
});

test("Workflow: a structured verification that passes without a Project starts the Reviewer", async (t) => {
  const w = await openWorkflow(t);
  await w.seedRun("run-1");
  await w.succeed("run-1", report());
  assert.equal(w.events("verification.completed"), 1);
  assert.equal(JSON.parse(w.db.get("SELECT payload_json FROM events WHERE type = 'verification.completed'").payload_json).outcome, "pass");
  assert.equal(w.events("task.failure.classified"), 0);
  assert.equal(w.reviewerRuns(), 1);
});

test("Workflow: reprocessing the same agentRunId does not duplicate gate or verification events", async (t) => {
  const failing = await openWorkflow(t);
  await failing.seedRun("run-1");
  await failing.succeed("run-1", report({}, { status: "failed" }));
  await failing.succeed("run-1", report({}, { status: "failed" }));
  assert.equal(failing.events("task.failure.classified"), 1);
  assert.equal(failing.count("SELECT failure_count AS n FROM tasks WHERE id = 'task-1'"), 1);

  const passing = await openWorkflow(t);
  await passing.seedRun("run-1");
  await passing.succeed("run-1", report());
  await passing.succeed("run-1", report());
  assert.equal(passing.events("verification.started"), 1);
  assert.equal(passing.events("verification.completed"), 1);
  assert.equal(passing.events("agent.exited"), 1);
});

test("Workflow (Hybrid): a missing integration_check is rejected; the Executor success count is not used", async (t) => {
  const w = await openWorkflow(t, { hybrid: true });
  await w.seedRun("run-1");
  await w.seedRun("exec-1", "run-1", "spawned");
  await w.succeed("run-1", report({ delegation: { decomposition: "x", delegated: [{ child_id: "c1", instruction: "i", provider: "p", model: "m" }], retained: [] } }));
  assert.equal(JSON.parse(w.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, "hybrid_integration_verification_missing");
  assert.equal(w.reviewerRuns(), 0);

  const ok = await openWorkflow(t, { hybrid: true });
  await ok.seedRun("run-1");
  await ok.succeed("run-1", report({}, { integration_check: integrationPassed }));
  assert.equal(ok.events("verification.started"), 1);
  assert.equal(ok.reviewerRuns(), 1);
});

test("Workflow (Subagent): an observed subagent with no integration_check is rejected", async (t) => {
  const w = await openWorkflow(t);
  await w.seedRun("run-1");
  await w.seedRun("sub-1", "run-1", "observed");
  await w.succeed("run-1", report());
  assert.equal(JSON.parse(w.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, "hybrid_integration_verification_missing");
  assert.equal(w.reviewerRuns(), 0);

  const ok = await openWorkflow(t);
  await ok.seedRun("run-1");
  await ok.seedRun("sub-1", "run-1", "observed");
  await ok.succeed("run-1", report({}, { integration_check: integrationRequired }));
  assert.equal(ok.reviewerRuns(), 1);

  const notRequired = await openWorkflow(t);
  await notRequired.seedRun("run-1");
  await notRequired.seedRun("sub-1", "run-1", "observed");
  await notRequired.succeed("run-1", report({}, { integration_check: integrationPassed }));
  assert.equal(notRequired.reviewerRuns(), 1);
});

test("Workflow: a Worker with a still-running hook-detected child starts no Reviewer", async (t) => {
  const w = await openWorkflow(t);
  await w.seedRun("run-1");
  await w.seedRun("sub-1", "run-1", "observed", "running");
  await w.db.createWriteLane().transact((tx) => tx.run("UPDATE agent_runs SET hook_agent_id = 'h1' WHERE id = 'sub-1'"));
  await w.succeed("run-1", report({}, { integration_check: integrationRequired }));
  assert.equal(JSON.parse(w.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, "worker_children_incomplete");
  assert.equal(w.reviewerRuns(), 0);
});

test("Workflow (Children): every unfinished, unknown or unreported child, at any depth, keeps the parent from the Reviewer", async (t) => {
  const done = { id: "c1", status: "completed" };
  const withChildren = (ids) => report({ delegation: { decomposition: "x", delegated: ids.map((id) => ({ child_id: id, instruction: "i", provider: "p", model: "m" })), retained: [] } }, { integration_check: integrationRequired });
  const nested = [["exec-1", "run-1", "spawned", "exited"]];
  const cases = [
    ["running dispatched child", [{ ...done, status: "running" }], [], withChildren(["c1"]), false],
    ["unknown dispatched status", [{ ...done, status: "mystery" }], [], withChildren(["c1"]), false],
    ["unreported dispatched child", [done], [], withChildren([]), false],
    // The observed child sits under the dispatched executor, not directly under the Worker.
    ["running observed grandchild", [done], [["exec-1", "run-1", "spawned", "running"], ["sub-1", "exec-1", "observed", "running"]], withChildren(["c1"]), false],
    ["running hook child under a finished executor", [done], [["exec-1", "run-1", "spawned", "exited"], ["sub-1", "exec-1", "observed", "running"]], withChildren(["c1"]), false],
    ["all children terminal", [done, { id: "c2", status: "failed" }], [...nested, ["sub-1", "exec-1", "observed", "exited"]], withChildren(["c1", "c2"]), true],
  ];
  for (const [name, dispatched, runs, body, passes] of cases) {
    const w = await openWorkflow(t, { childRuns: { list: () => dispatched } });
    await w.seedRun("run-1");
    for (const [id, parent, origin, status] of runs) await w.seedRun(id, parent, origin, status);
    // Hook-detected children stay running until their own stop hook; the process scan must not close them.
    await w.db.createWriteLane().transact((tx) => tx.run("UPDATE agent_runs SET hook_agent_id = 'h-' || id WHERE origin = 'observed'"));
    // A regular scan landing before the Worker's gate must not end a running hook child either.
    await w.workflow.scanSubagents([]);
    await w.succeed("run-1", body);
    await w.settle();
    assert.equal(w.reviewerRuns(), passes ? 1 : 0, name);
    assert.equal(w.events("task.failure.classified"), passes ? 0 : 1, name);
    const status = w.db.get("SELECT status FROM tasks WHERE id = 'task-1'").status;
    if (passes) assert.equal(status, "completed", name);
    else assert.ok(status !== "verifying" && status !== "completed", `${name}: ${status}`);
    if (!passes) assert.equal(JSON.parse(w.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, "worker_children_incomplete", name);
  }
});

test("Workflow: a failing success report that also asks for replanning records the gate error_key and reasons", async (t) => {
  for (const extra of [{ needs_replanning: true }, { question_for_manager: "Which one?" }]) {
    const w = await openWorkflow(t);
    await w.seedRun("run-1");
    await w.succeed("run-1", report(extra, { status: "failed" }));
    await w.settle();
    const row = w.db.get("SELECT payload_json FROM events WHERE task_id = 'task-1' AND type = 'task.replan_requested'");
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload.error_key, "worker_verification_failed");
    assert.ok(payload.gate_reasons.length > 0);
    assert.equal(w.reviewerRuns(), 0);
    assert.equal(w.events("verification.started"), 0);
  }
});

test("Workflow (Hybrid): the gate uses the mode the Worker was launched with, not the current setting", async (t) => {
  const settingOff = await openWorkflow(t, { hybrid: false, launchHybrid: true });
  await settingOff.seedRun("run-1");
  await settingOff.succeed("run-1", report({ delegation: { decomposition: "x", delegated: [{ child_id: "c1", instruction: "i", provider: "p", model: "m" }], retained: [] } }));
  assert.equal(JSON.parse(settingOff.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, "hybrid_integration_verification_missing");
  assert.equal(settingOff.reviewerRuns(), 0);

  const settingOn = await openWorkflow(t, { hybrid: true, launchHybrid: false });
  await settingOn.seedRun("run-1");
  await settingOn.succeed("run-1", report());
  assert.equal(settingOn.events("task.failure.classified"), 0);
  assert.equal(settingOn.reviewerRuns(), 1);
});
