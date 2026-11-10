import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { evaluateWorkerCompletion, goalOnlyShortfallReport, observedSubagentsNeedingIntegration } from "../../packages/core/dist/task-completion-gate.js";
import { normalizeWorkerResponseWithFeedback } from "../../packages/agent-runtime/dist/worker.js";
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

test("Completion Gate (Normal): a passed success report passes", () => {
  assert.deepEqual(evaluateWorkerCompletion(report(), normal), { passed: true, reasons: [], error_key: null });
});

test("Completion Gate (Hybrid): a passed integration_check is required outside Hybrid runs; Hybrid runs leave delegated work to agent-runtime", () => {
  const hybrid = { hybrid: true, delegated_work_detected: false };
  assert.equal(evaluateWorkerCompletion(report({}, { integration_check: integrationPassed }), hybrid).passed, true);
  // No delegated child and no observed subagent: integration_check is not required even in Hybrid.
  assert.equal(evaluateWorkerCompletion(report(), hybrid).passed, true);
  const delegatedReport = (verification = {}) => report({ delegation: { decomposition: "x", delegated: [{ child_id: "c1", instruction: "i", provider: "p", model: "m" }], retained: [] } }, verification);
  // In a Hybrid run correctReportSemantics lowers a delegated success without a passed integration_check, so the gate does not look.
  assert.equal(evaluateWorkerCompletion(delegatedReport(), hybrid).passed, true);
  assert.equal(evaluateWorkerCompletion(delegatedReport(), normal).error_key, "hybrid_integration_verification_missing");
  assert.equal(evaluateWorkerCompletion(delegatedReport({ integration_check: integrationPassed }), normal).passed, true);
  assert.equal(evaluateWorkerCompletion(delegatedReport({ integration_check: { status: "failed", evidence: "x" } }), normal).error_key, "hybrid_integration_verification_missing");
  assert.equal(evaluateWorkerCompletion(delegatedReport({ integration_check: { status: "blocked", evidence: "x" } }), normal).passed, false);
  const declared = report({ delegation: { decomposition: "x", delegated: [], retained: [], own_subagents_used: true } });
  assert.equal(evaluateWorkerCompletion(declared, hybrid).error_key, "hybrid_integration_verification_missing");
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

async function openWorkflow(t, { hybrid = false, launchHybrid = hybrid, childRuns, criteria } = {}) {
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
    if (criteria) tx.run("UPDATE tasks SET acceptance_criteria_json = ? WHERE id = 'task-1'", JSON.stringify(criteria));
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

test("Workflow: a success claim the gate rejects starts no Reviewer and never reaches verifying", async (t) => {
  const w = await openWorkflow(t);
  await w.seedRun("run-1");
  await w.seedRun("sub-1", "run-1", "observed");
  await w.succeed("run-1", report());
  await w.settle();
  assert.equal(w.reviewerRuns(), 0);
  assert.equal(w.count("SELECT COUNT(*) AS n FROM agent_runs WHERE role = 'reviewer'"), 0);
  assert.equal(w.events("verification.started"), 0);
  assert.equal(w.events("agent.exited"), 0);
  assert.notEqual(w.db.get("SELECT status FROM tasks WHERE id = 'task-1'").status, "verifying");
  const failure = JSON.parse(w.db.get("SELECT payload_json FROM events WHERE task_id = 'task-1' AND type = 'task.failure.classified'").payload_json);
  assert.equal(failure.error_key, "hybrid_integration_verification_missing");
  assert.equal(failure.retry_allowed, true);
  assert.match(failure.gate_reasons.join("; "), /integration_check is not present/u);
  assert.equal(failure.reason, undefined);
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
  await failing.seedRun("sub-1", "run-1", "observed");
  await failing.succeed("run-1", report());
  await failing.succeed("run-1", report());
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
  await w.succeed("run-1", report({ delegation: { decomposition: "x", delegated: [], retained: [], own_subagents_used: true } }));
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

test("Workflow (Hybrid): the gate uses the mode the Worker was launched with, not the current setting", async (t) => {
  const delegatedBody = report({ delegation: { decomposition: "x", delegated: [{ child_id: "c1", instruction: "i", provider: "p", model: "m" }], retained: [] } });
  // Launched outside Hybrid (setting on now): the gate sees the delegated work and rejects the missing integration_check.
  const launchedNormal = await openWorkflow(t, { hybrid: true, launchHybrid: false });
  await launchedNormal.seedRun("run-1");
  await launchedNormal.succeed("run-1", delegatedBody);
  assert.equal(JSON.parse(launchedNormal.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, "hybrid_integration_verification_missing");
  assert.equal(launchedNormal.reviewerRuns(), 0);

  // Launched in Hybrid (setting off now): agent-runtime owns this check, so the gate does not stop it.
  const launchedHybrid = await openWorkflow(t, { hybrid: false, launchHybrid: true });
  await launchedHybrid.seedRun("run-1");
  await launchedHybrid.succeed("run-1", delegatedBody);
  assert.equal(launchedHybrid.events("task.failure.classified"), 0);
});

// Goal criteria: the Task's stored criteria decide what is a goal, never the report's own requirement.
const criterion = (id, requirement) => ({ id, text: `criterion ${id}`, check: "c", serves: "s", if_omitted: "i", check_weight: "light", weight_reason: "", ...(requirement ? { requirement } : {}) });
const GOAL_CRITERIA = [criterion("AC1"), criterion("AC2", "goal")];
const goalUnmet = (id, shortfall_reason) => ({ criterion_id: id, criterion: "c", status: "goal_unmet", evidence: "e", ...(shortfall_reason === undefined ? {} : { shortfall_reason }) });
const passedAc = (id) => ({ criterion_id: id, criterion: "c", status: "passed", evidence: "e" });
const withGoalUnmet = (...items) => report({}, { acceptance: items });

test("Workflow: a goal_unmet goal passes the gate, starts the Reviewer and stores the shortfall on the Task", async (t) => {
  const w = await openWorkflow(t, { criteria: GOAL_CRITERIA });
  await w.seedRun("run-1");
  await w.succeed("run-1", withGoalUnmet(passedAc("AC1"), goalUnmet("AC2", " only 6 branches ")));
  assert.equal(w.events("task.failure.classified"), 0);
  assert.equal(w.reviewerRuns(), 1);
  assert.deepEqual(JSON.parse(w.db.get("SELECT goal_shortfalls_json AS j FROM tasks WHERE id = 'task-1'").j), [
    { criterion_id: "AC2", text: "criterion AC2", reason: "only 6 branches", source: "worker" },
  ]);
});

const gateRow = (id, over = {}) => ({ id, parent_agent_id: null, provider: "claude", hook_agent_id: null, tool_program: null, ...over });
const classifyReport = (over = {}, extra = {}, integration = null) => report(
  { delegation: { decomposition: "x", delegated: [], retained: [], tool_subagents: [{ cli: "claude", tool: "tools/review.sh", reason: "review.sh runs claude -p for its own review step", ...over }], ...extra } },
  { integration_check: integration },
);
const needing = (r, rows) => observedSubagentsNeedingIntegration(r, rows).map((row) => row.id);

test("Completion Gate (Subagent): tool-internal CLIs need no integration_check; the Worker's own and hook-reported ones do", () => {
  const auto = gateRow("a", { tool_program: "edit-team" });
  const shell = gateRow("s");
  const nested = gateRow("n", { parent_agent_id: "s", provider: "codex" });
  const hook = gateRow("h", { hook_agent_id: "h1" });
  assert.deepEqual(needing(report(), [auto]), []);
  assert.deepEqual(needing(report(), [shell]), ["s"]);
  assert.deepEqual(needing(classifyReport(), [shell, nested]), []);
  assert.deepEqual(needing(classifyReport({ cli: "codex" }), [shell]), ["s"]);
  assert.deepEqual(needing(classifyReport(), [hook]), ["h"]);
  assert.deepEqual(needing(classifyReport({ reason: "  " }), [shell]), ["s"]);
  assert.deepEqual(needing(classifyReport({ cli: "/usr/local/bin/claude" }), [shell]), []);
  const gate = (rows) => evaluateWorkerCompletion(report(), { hybrid: false, delegated_work_detected: needing(report(), rows).length > 0 });
  assert.equal(gate([auto]).passed, true);
  assert.equal(gate([shell]).error_key, "hybrid_integration_verification_missing");
});

test("Completion Gate: own_subagents_used and delegated keep integration_check mandatory when every observed CLI is tool-internal", () => {
  const rows = [gateRow("a", { tool_program: "edit-team" }), gateRow("s")];
  const child = [{ child_id: "c1", instruction: "i", provider: "p", model: "m" }];
  for (const extra of [{ own_subagents_used: true }, { delegated: child }]) {
    for (const [integration, key] of [[null, "hybrid_integration_verification_missing"], [integrationPassed, null]]) {
      const r = classifyReport({}, extra, integration);
      assert.deepEqual(needing(r, rows), []);
      const verdict = evaluateWorkerCompletion(r, { hybrid: false, delegated_work_detected: false });
      assert.equal(verdict.error_key, key);
    }
  }
});

test("Workflow (Subagent): a CLI found inside a non-shell program is stored and needs no integration_check after it exits; a shell-only or direct one does", async (t) => {
  const cases = [
    ["python", [{ pid: 5000010, ppid: 5000000, args: "/bin/bash -c python3 /opt/tools/edit-team run" }, { pid: 5000011, ppid: 5000010, args: "python3 /opt/tools/edit-team run" }, { pid: 5000012, ppid: 5000011, args: "codex exec" }], "edit-team", true],
    ["shell", [{ pid: 5000020, ppid: 5000000, args: "/bin/zsh -c codex exec hi" }, { pid: 5000021, ppid: 5000020, args: "codex exec" }], null, false],
    ["direct", [{ pid: 5000030, ppid: 5000000, args: "codex exec" }], null, false],
  ];
  for (const [name, tree, program, passes] of cases) {
    const w = await openWorkflow(t);
    await w.seedRun("run-1");
    await w.db.createWriteLane().transact((tx) => tx.run("UPDATE agent_runs SET pid = 5000000 WHERE id = 'run-1'"));
    await w.workflow.scanSubagents([{ pid: 5000000, ppid: 1, args: "claude -p --output-format stream-json" }, ...tree]);
    assert.deepEqual(w.db.all("SELECT tool_program FROM agent_runs WHERE origin = 'observed'").map((row) => row.tool_program), [program], name);
    await w.succeed("run-1", report());
    await w.settle();
    assert.equal(w.reviewerRuns(), passes ? 1 : 0, name);
    if (!passes) assert.equal(JSON.parse(w.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, "hybrid_integration_verification_missing", name);
  }
});

test("Workflow (Subagent): a report classification lets a shell-only CLI pass; a hook-reported child still needs integration_check", async (t) => {
  const run = async (body, hook = false) => {
    const w = await openWorkflow(t);
    await w.seedRun("run-1");
    await w.seedRun("sub-1", "run-1", "observed");
    await w.db.createWriteLane().transact((tx) => tx.run(`UPDATE agent_runs SET provider = 'claude'${hook ? ", hook_agent_id = 'h1'" : ""} WHERE id = 'sub-1'`));
    await w.succeed("run-1", body);
    await w.settle();
    return w;
  };
  assert.equal((await run(classifyReport())).reviewerRuns(), 1);
  for (const w of [await run(report()), await run(classifyReport(), true)]) {
    assert.equal(w.reviewerRuns(), 0);
    assert.equal(JSON.parse(w.db.get("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").payload_json).error_key, "hybrid_integration_verification_missing");
  }
});

// Preservation table: the same payloads run through the production order (agent-runtime normalizes, Core lifts a
// goal-only shortfall, the gate runs on success only). Its expectations must hold before and after the gate's
// duplicated checks were removed.
const PIPELINE_CRITERIA = [criterion("AC1"), criterion("AC2", "goal")];
const PIPELINE_GOAL_IDS = ["AC2"];
const asProvider = (payload) => ({ adapter: "claude", stdout: JSON.stringify(payload), stderr: "", exit_code: 0, signal: null, format: "plain-text" });
const child = (id) => ({ child_id: id, instruction: "i", provider: "p", model: "m" });
const base = (over = {}, verification = {}) => ({
  kind: "report", schema_version: "1.1.0", invocation_id: "i", result: "success", work_done: "Done.",
  delegation: { decomposition: "x", delegated: [], retained: [] }, changes: [], remaining_issues: [], next_action: "none",
  needs_replanning: false, question_for_manager: null, external_blocker: null, pending_process: null,
  verification: {
    status: "passed", method: "Checked.", checks: [{ name: "build", status: "passed", evidence: "ok" }],
    acceptance: [{ criterion_id: "AC1", status: "passed", evidence: "e" }, { criterion_id: "AC2", status: "passed", evidence: "e" }],
    integration_check: null, ...verification,
  },
  ...over,
});
const acceptanceWith = (ac1, ac2) => [{ criterion_id: "AC1", status: "passed", evidence: "e", ...ac1 }, { criterion_id: "AC2", status: "passed", evidence: "e", ...ac2 }];
const withDelegated = (verification = {}, over = {}) => base({ delegation: { decomposition: "x", delegated: [child("c1")], retained: [], ...over } }, verification);
const done = (id) => ({ id, kind: "dispatched", status: "completed" });

function pipeline(payload, { hybrid = false, children = [], detected = false } = {}) {
  let normalized;
  try {
    normalized = normalizeWorkerResponseWithFeedback(asProvider(payload), "i", hybrid, { acceptance_criteria: PIPELINE_CRITERIA });
  } catch (error) {
    return { rejected: `${error.reason ?? ""} ${error.message}` };
  }
  let body = normalized.report;
  if (goalOnlyShortfallReport(body, { goal_criterion_ids: PIPELINE_GOAL_IDS })) {
    body = { ...body, result: "success", verification: { ...body.verification, status: "passed" } };
  }
  const gate = body.result === "success"
    ? evaluateWorkerCompletion(body, { hybrid, delegated_work_detected: detected, children, goal_criterion_ids: PIPELINE_GOAL_IDS }).error_key
    : "not_run";
  return { result: body.result, corrections: normalized.corrections.map((c) => c.rule), gate };
}

const UNPASSED_V = "success_with_unpassed_verification";
const UNPASSED_I = "success_with_unpassed_item";
const MISSING = "hybrid_integration_verification_missing";
const INCOMPLETE = "worker_children_incomplete";
const ok = { result: "success", corrections: [], gate: null };
const partial = (...corrections) => ({ result: "partial", corrections, gate: "not_run" });
const gated = (gate) => ({ result: "success", corrections: [], gate });
const ownSubagents = () => base({ delegation: { decomposition: "x", delegated: [], retained: [], own_subagents_used: true } });

test("Pipeline preservation P1-P22: results, corrections and gate keys do not depend on which layer checks them", () => {
  const withReason = { shortfall_reason: "only 6 branches" };
  const rows = {
    P1: [pipeline(base()), ok],
    P2: [pipeline(base({}, { status: "failed" })), partial(UNPASSED_V)],
    P3: [pipeline(base({}, { status: "blocked", acceptance: acceptanceWith({ status: "blocked" }, {}) })), partial(UNPASSED_V, UNPASSED_I)],
    P4: [pipeline(base({}, { status: "failed", checks: [{ name: "build", status: "failed", evidence: "x" }] })), partial(UNPASSED_V, UNPASSED_I)],
    P5: [pipeline(base({}, { status: "blocked", acceptance: acceptanceWith({ status: "unverifiable", unverifiable_reason: "outside the Task" }, {}) })), partial(UNPASSED_V, UNPASSED_I)],
    P6: [pipeline(base({ needs_replanning: true })), partial("success_with_needs_replanning")],
    P7: [pipeline(base({ question_for_manager: "Which?" })), partial("success_with_question_for_manager")],
    P8: [pipeline(base({}, { acceptance: acceptanceWith({}, { status: "goal_unmet", ...withReason }) })), ok],
    P10: [pipeline(base({}, { acceptance: acceptanceWith({ status: "goal_unmet", ...withReason }, {}) })), partial(UNPASSED_I)],
    P11: [pipeline(base({}, { acceptance: acceptanceWith({}, { status: "failed", evidence: "only 6" }) })), ok],
    P12: [pipeline(base({ result: "partial" }, { acceptance: acceptanceWith({}, { status: "goal_unmet", ...withReason }) })), ok],
    P13: [pipeline(withDelegated(), { hybrid: true, children: [done("c1")] }), partial("hybrid_ok_without_passed_integration")],
    P14: [pipeline(withDelegated({ integration_check: integrationPassed }), { hybrid: true, children: [done("c1")] }), ok],
    P15: [pipeline(withDelegated({ integration_check: integrationPassed }), { hybrid: true, children: [{ ...done("c1"), status: "running" }] }), gated(INCOMPLETE)],
    P16: [pipeline(withDelegated({ integration_check: integrationPassed }), { hybrid: true, children: [done("c1"), done("c2")] }), gated(INCOMPLETE)],
    P17: [pipeline(ownSubagents()), gated(MISSING)],
    P18: [pipeline(base(), { detected: true }), gated(MISSING)],
    P19: [pipeline(withDelegated(), { children: [done("c1")] }), gated(MISSING)],
    P20: [pipeline(ownSubagents(), { children: [{ id: "o1", kind: "observed", status: "running" }] }), gated(MISSING)],
    P21: [pipeline(ownSubagents(), { hybrid: true }), gated(MISSING)],
  };
  for (const [name, [actual, expected]] of Object.entries(rows)) assert.deepEqual(actual, expected, name);
  const rejected = (payload) => pipeline(payload).rejected;
  assert.match(rejected(base({}, { acceptance: acceptanceWith({}, { status: "goal_unmet" }) })), /goal_unmet_without_reason/u, "P9");
  assert.match(rejected(base({}, { acceptance: [{ criterion_id: "AC1", status: "passed", evidence: "e" }] })), /worker_acceptance_criterion_ids/u, "P22");
});
