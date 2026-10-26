import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { command } from "../helpers/core.mjs";
import { assertOpenedOnceAfterExplanation, createExplainer } from "../helpers/decision-explanation.mjs";
import { openTestRunCore, phaseOf, plannedTask, workerReport } from "../helpers/test-run-core.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The Task's own test run passes; only the test run on the integrated Work checkout meets a broken environment.
// It is investigated again and run again; when that does not help, the Owner is asked and the Manager is not.

const READY = (over = {}) => ({
  verdict: "ready",
  setup_argvs: [],
  test_run: { mode: "per_file", file_argv: ["node", "--test", "--test-reporter=tap", "{file}"], test_patterns: ["tests/**/*.test.mjs"], cwd: "." },
  executables: [],
  confirm_files: ["tests/a.test.mjs"],
  probe_argvs: [],
  sources: [],
  attempts: [{ argv: ["node", "--version"], cwd: ".", exit_code: 0, summary: "checked node" }],
  installed: [],
  outside_installs: [],
  missing: [],
  notes: "",
  ...over,
});

const workEnded = (db) => waitFor(() => db.get("SELECT id FROM works WHERE state IN ('completed', 'cancelled')"), { timeoutMs: 30_000, message: "the Work to end" });

/** Test files fail with exit 127 in the Work checkout while `state.broken` is set; every other place runs them fine. */
function createWorkEnvironmentRunner(state) {
  const calls = [];
  const run = async (argv, cwd) => {
    const file = argv[argv.length - 1];
    const phase = phaseOf(cwd);
    calls.push({ file, phase });
    if (state.broken && phase === "work") return { exit_code: 127, timed_out: false, stdout: "", stderr: "node: command not found\n", duration_ms: 1 };
    const name = file.replace(/^tests\//u, "").replace(/\.test\.mjs$/u, "");
    return { exit_code: 0, timed_out: false, stdout: `TAP version 13\nok 1 - ${name}\n`, stderr: "", duration_ms: 1 };
  };
  return { run, calls };
}

function createAgent({ state, investigate }) {
  const managerModes = [];
  const investigations = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      managerModes.push(request.mode);
      return request.mode === "finalize"
        ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
        : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } };
    },
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "src/a.mjs"), "export const a = 2;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, ["src/a.mjs"]) };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
    runTestSetupInvestigation: async (request) => {
      investigations.push(request);
      return { ok: true, invocation_id: request.invocation_id, investigation: investigate(request, investigations.length, state) };
    },
  };
  return { agentRunner, managerModes, investigations };
}

async function startWork(ctx) {
  const created = await ctx.core.createWork(ctx.envelope({ title: "Integration environment", summary: "x", size: "normal", project_id: ctx.projectId }, "work"));
  await ctx.core.startWork(created.data.work_id, { ...ctx.envelope({ mode: "normal" }, "start"), expected_version: created.version });
  return created.data.work_id;
}

const workRuns = (db) => db.all("SELECT status FROM test_runs WHERE scope = 'work' ORDER BY rowid").map((row) => row.status);
const integrationEvents = (db) => db.all("SELECT payload_json FROM events WHERE type = 'work.integration_verification_completed' ORDER BY sequence").map((row) => JSON.parse(row.payload_json));

test("a broken test environment in the Work's integration verification is investigated again and the Work goes on", async (t) => {
  const state = { broken: true };
  const { run } = createWorkEnvironmentRunner(state);
  const { agentRunner, managerModes, investigations } = createAgent({ state, investigate: (_request, _n, s) => { s.broken = false; return READY(); } });
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-work-test-environment-" });
  const workId = await startWork(ctx);
  await workEnded(ctx.db);

  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(investigations.length, 1);
  assert.equal(investigations[0].scope, "work");
  assert.equal(investigations[0].trigger, "environment_failure");
  assert.equal(investigations[0].mode, "repair_explicit");
  assert.equal(ctx.db.all("SELECT id FROM decisions").length, 0);
  assert.deepEqual(managerModes.filter((mode) => mode !== "finalize").length, 1, "the Manager planned once and was not asked to repair");
  assert.deepEqual(integrationEvents(ctx.db).map((event) => event.routed_to), ["final_manager"]);
  const runs = workRuns(ctx.db);
  assert.equal(runs[0], "error");
  assert.equal(runs.at(-1), "passed");
});

test("a test environment that stays broken in the integration verification goes to the Owner, not to the Manager", async (t) => {
  const state = { broken: true };
  const { run } = createWorkEnvironmentRunner(state);
  const { agentRunner, managerModes, investigations } = createAgent({ state, investigate: () => READY({ missing: ["node 22"], attempts: [] }) });
  const explainer = createExplainer();
  agentRunner.runDecisionExplanation = explainer.runDecisionExplanation;
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-work-test-environment-blocked-" });
  const workId = await startWork(ctx);

  const decision = await waitFor(() => ctx.db.get("SELECT id, state_version, options_json, scope FROM decisions WHERE status = 'open'"), { timeoutMs: 30_000, message: "the test environment Decision" });
  // The notice waits for the explanation and is emitted once; a Work's test environment has no Task or report to send.
  await assertOpenedOnceAfterExplanation(ctx.db, decision.id, explainer);
  assert.equal(explainer.requests[0].kind, "test_environment");
  assert.equal(explainer.requests[0].task, null);
  assert.equal(investigations.length, 2);
  assert.deepEqual(JSON.parse(decision.options_json).map((option) => option.key).filter((key) => key !== "cancel"), ["retry_test_setup"]);
  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  assert.equal(managerModes.filter((mode) => mode !== "finalize").length, 1, "no Manager replan for an environment failure");
  assert.deepEqual(integrationEvents(ctx.db).map((event) => event.routed_to), ["owner"]);
  assert.equal(ctx.db.all("SELECT id FROM events WHERE type = 'system.alert' AND payload_json LIKE '%work_integration_verification_failed%'").length, 0);

  state.broken = false;
  const label = JSON.parse(decision.options_json).find((option) => option.key === "retry_test_setup").label;
  await ctx.core.answerDecision(decision.id, command({ answer: label, option_key: "retry_test_setup", source_message_id: null }, `answer-${decision.id}`, decision.state_version));
  await workEnded(ctx.db);

  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(managerModes.filter((mode) => mode !== "finalize").length, 1);
  assert.equal(workRuns(ctx.db).at(-1), "passed");
});
