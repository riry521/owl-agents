import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { approvedInstallArgvs } from "../../packages/core/dist/test-environment.js";
import { command } from "../helpers/core.mjs";
import { openTestRunCore, plannedTask, workerReport } from "../helpers/test-run-core.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The Owner's test_run is the test command; the agent, the Worker and the test processes are stubs.
// A failure that comes from the environment is investigated again and the tests run again; the Owner is asked only when that does not help.

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

/** A runner that fails every test file with exit 127 (command not found) while `state.broken` is set. */
function createEnvironmentRunner(state) {
  const calls = [];
  const run = async (argv, cwd) => {
    const file = argv[argv.length - 1];
    calls.push({ argv: [...argv], file, cwd });
    if (state.broken) return { exit_code: 127, timed_out: false, stdout: "", stderr: "node: command not found\n", duration_ms: 1 };
    const name = file.replace(/^tests\//u, "").replace(/\.test\.mjs$/u, "");
    return { exit_code: 0, timed_out: false, stdout: `TAP version 13\nok 1 - ${name}\n`, stderr: "", duration_ms: 1 };
  };
  return { run, calls };
}

/** An agent that plans one Task; `investigate(request, n)` answers each test setup investigation. */
function createAgent({ state, investigate }) {
  const workerRequests = [];
  const investigations = [];
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } },
    runWorker: async (request) => {
      workerRequests.push(request);
      await writeFile(join(request.context.worktree, "src/a.mjs"), `export const a = ${workerRequests.length + 1};\n`);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, ["src/a.mjs"]) };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
    runTestSetupInvestigation: async (request) => {
      investigations.push(request);
      const output = investigate(request, investigations.length, state);
      return { ok: true, invocation_id: request.invocation_id, investigation: output };
    },
  };
  return { agentRunner, workerRequests, investigations };
}

async function startWork(ctx) {
  const created = await ctx.core.createWork(ctx.envelope({ title: "Environment", summary: "x", size: "normal", project_id: ctx.projectId }, "work"));
  await ctx.core.startWork(created.data.work_id, { ...ctx.envelope({ mode: "normal" }, "start"), expected_version: created.version });
  return created.data.work_id;
}

const taskRuns = (db) => db.all("SELECT status FROM test_runs WHERE scope = 'task' ORDER BY rowid").map((row) => row.status);
const openDecision = (db) => db.get("SELECT id, state_version, options_json, reason FROM decisions WHERE status = 'open'");
const optionLabel = (decision, key) => JSON.parse(decision.options_json).find((option) => option.key === key).label;
const optionKeys = (decision) => JSON.parse(decision.options_json).map((option) => option.key);

test("a Task whose test environment fails is investigated again and verified again without asking the Owner", async (t) => {
  const state = { broken: true };
  const { run } = createEnvironmentRunner(state);
  const { agentRunner, workerRequests, investigations } = createAgent({ state, investigate: (_request, _n, s) => { s.broken = false; return READY(); } });
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-task-test-environment-" });
  const workId = await startWork(ctx);
  await workEnded(ctx.db);

  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(investigations.length, 1);
  assert.equal(investigations[0].trigger, "environment_failure");
  assert.equal(investigations[0].scope, "task");
  assert.equal(investigations[0].failure.signal, "exit_code_127");
  assert.equal(workerRequests.length, 1, "an environment failure is not the Worker's: no rework");
  assert.equal(ctx.db.all("SELECT id FROM decisions").length, 0);
  assert.equal(ctx.db.all("SELECT id FROM events WHERE type = 'verification.environment_blocked'").length, 0);
  const runs = taskRuns(ctx.db);
  assert.equal(runs[0], "error");
  assert.equal(runs[runs.length - 1], "passed");
});

test("an Owner-set test_run is repaired in place: the investigation runs as repair_explicit and the Owner's command is not changed", async (t) => {
  const state = { broken: true };
  const { run, calls } = createEnvironmentRunner(state);
  const { agentRunner, investigations } = createAgent({ state, investigate: (_request, _n, s) => { s.broken = false; return READY({ test_run: null }); } });
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-task-test-environment-explicit-" });
  await startWork(ctx);
  await workEnded(ctx.db);

  assert.equal(investigations.length, 1);
  assert.equal(investigations[0].mode, "repair_explicit");
  assert.deepEqual(investigations[0].explicit_test_run.file_argv, ["node", "--test", "{file}"]);
  assert.deepEqual(JSON.parse(ctx.db.get("SELECT test_run_json FROM projects WHERE id = ?", ctx.projectId).test_run_json).file_argv, ["node", "--test", "{file}"]);
  assert.ok(calls.some((call) => call.argv.join(" ").startsWith("node --test ")), "the Owner's command is what ran");
  assert.equal(ctx.db.get("SELECT state FROM works").state, "completed");
});

test("a test environment that stays broken goes to the Owner once; retrying after a manual fix verifies the Task again", async (t) => {
  const state = { broken: true };
  const { run } = createEnvironmentRunner(state);
  const { agentRunner, workerRequests, investigations } = createAgent({ state, investigate: () => READY({ missing: ["node 22"], attempts: [] }) });
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-task-test-environment-blocked-" });
  const workId = await startWork(ctx);

  const decision = await waitFor(() => openDecision(ctx.db), { timeoutMs: 30_000, message: "the test environment Decision" });
  assert.equal(investigations.length, 2, "max_reinvestigations investigations, then the Owner");
  assert.deepEqual(optionKeys(decision).filter((key) => key !== "cancel"), ["retry_test_setup"]);
  const task = ctx.db.get("SELECT id, status FROM tasks WHERE work_id = ?", workId);
  assert.equal(task.status, "judgement_waiting");
  assert.equal(workerRequests.length, 1);
  assert.equal(ctx.db.all("SELECT id FROM events WHERE type = 'verification.environment_blocked'").length, 1);
  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");

  state.broken = false;
  const answered = await ctx.core.answerDecision(decision.id, command({ answer: optionLabel(decision, "retry_test_setup"), option_key: "retry_test_setup", source_message_id: null }, `answer-${decision.id}`, decision.state_version));
  assert.deepEqual([...answered.data.resumed_task_ids], [task.id]);
  await workEnded(ctx.db);

  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(workerRequests.length, 1, "the same Worker report is verified again, no new Worker run");
  assert.equal(taskRuns(ctx.db).at(-1), "passed");
});

test("an install outside the Project is asked for in the Decision; approving it writes approved_at and verifies again", async (t) => {
  const state = { broken: true };
  const { run } = createEnvironmentRunner(state);
  const outside = [{ argv: ["brew", "install", "node@22"], reason: "node is missing" }];
  const { agentRunner, investigations } = createAgent({
    state,
    investigate: (request, _n, s) => {
      // After the approval the agent may run the install: the request then carries it in approved_installs.
      if (request.approved_installs.length > 0) { s.broken = false; return READY(); }
      return READY({ verdict: "needs_owner", outside_installs: outside, missing: ["node"], attempts: [] });
    },
  });
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-task-test-environment-approval-" });
  const workId = await startWork(ctx);

  const decision = await waitFor(() => openDecision(ctx.db), { timeoutMs: 30_000, message: "the approval Decision" });
  assert.equal(investigations.length, 1, "an install that needs approval stops the investigations");
  assert.deepEqual(optionKeys(decision).filter((key) => key !== "cancel"), ["approve_test_setup_installs", "retry_test_setup"]);
  const stored = () => JSON.parse(ctx.db.get("SELECT test_setup_json FROM tasks WHERE work_id = ?", workId).test_setup_json).outside_installs;
  assert.equal(stored()[0].decision_id, decision.id);
  assert.equal(stored()[0].approved_at ?? null, null);

  await ctx.core.answerDecision(decision.id, command({ answer: optionLabel(decision, "approve_test_setup_installs"), option_key: "approve_test_setup_installs", source_message_id: null }, `answer-${decision.id}`, decision.state_version));
  assert.equal(typeof stored()[0].approved_at, "string");
  assert.equal(ctx.db.all("SELECT id FROM events WHERE type = 'test_setup.installs_approved'").length, 1);
  await workEnded(ctx.db);

  assert.equal(ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(taskRuns(ctx.db).at(-1), "passed");

  // The approval does not depend on which record a later run selects, nor on any record existing: the Decision keeps it.
  assert.deepEqual(approvedInstallArgvs(ctx.db, workId), [outside[0].argv]);
  await ctx.db.createWriteLane().transact((tx) => {
    for (const table of ["projects", "works", "tasks"]) tx.run(`UPDATE ${table} SET test_setup_json = NULL`);
  });
  assert.deepEqual(approvedInstallArgvs(ctx.db, workId), [outside[0].argv]);
});
