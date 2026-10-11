import assert from "node:assert/strict";
import { test } from "node:test";

import { runCoreTests } from "../../packages/core/dist/core-test-run.js";
import { classifyTestFailure, policyTestEnvironment } from "../../packages/core/dist/test-environment.js";
import { DEFAULT_TEST_RUN_SETTINGS } from "../../packages/shared/dist/test-run-settings.js";
import { DEFAULT_TEST_SETUP_SETTINGS } from "../../packages/shared/dist/test-setup-settings.js";
import { git } from "../helpers/git.mjs";
import { TEST_RUN_SETTINGS, createStubTestRunner, openTestRunCore } from "../helpers/test-run-core.mjs";

// A failure caused by the environment is told apart from one caused by the code, before any baseline is taken.

const signals = DEFAULT_TEST_SETUP_SETTINGS.environment;
const evidence = (overrides = {}) => ({ phase: "run", argv: ["pytest"], exit_code: 1, timed_out: false, spawn_error: null, output_tail: "", ...overrides });
const classify = (overrides, custom = signals) => classifyTestFailure(evidence(overrides), custom);

test("an install that needs approval is an environment failure with signal needs_approval, even when timed_out is set", () => {
  assert.deepEqual(
    classify({ spawn_error: "install_needs_approval: pip install x", timed_out: true }),
    { kind: "environment", signal: "needs_approval", evidence: "install_needs_approval: pip install x" },
  );
});

test("a timeout is a code failure, even when the output matches an environment pattern", () => {
  assert.deepEqual(classify({ timed_out: true, exit_code: 127, output_tail: "command not found" }), { kind: "code" });
});

test("a command that did not start is an environment failure with signal spawn_error", () => {
  assert.deepEqual(classify({ spawn_error: "spawn pytest ENOENT" }), { kind: "environment", signal: "spawn_error", evidence: "spawn pytest ENOENT" });
});

test("a failing setup or prepare step is an environment failure named after its phase", () => {
  assert.equal(classify({ phase: "setup", exit_code: 1, output_tail: "boom" }).signal, "setup_failed");
  assert.equal(classify({ phase: "prepare", exit_code: 2, output_tail: "boom" }).signal, "prepare_failed");
});

test("an exit code listed in the settings is an environment failure, and the list is taken from the settings", () => {
  assert.equal(classify({ exit_code: 126 }).kind, "environment");
  assert.equal(classify({ exit_code: 127 }).kind, "environment");
  assert.equal(classify({ exit_code: 1 }).kind, "code");
  assert.equal(classify({ exit_code: 3 }, { ...signals, exit_codes: [3] }).kind, "environment");
});

test("an output pattern from the settings matches without regard to case", () => {
  assert.equal(classify({ output_tail: "E   MODULENOTFOUNDERROR: No module named 'pytest'" }).kind, "environment");
  assert.equal(classify({ output_tail: "zsh: Command Not Found: pytest" }).kind, "environment");
  assert.equal(classify({ output_tail: "custom marker" }, { ...signals, patterns: ["custom marker"] }).kind, "environment");
  assert.equal(classify({ output_tail: "custom marker" }).kind, "code");
});

test("anything else is a code failure", () => {
  assert.deepEqual(classify({ output_tail: "AssertionError: expected 1 to equal 2" }), { kind: "code" });
});

const settings = { ...DEFAULT_TEST_RUN_SETTINGS, ...TEST_RUN_SETTINGS };

async function coreRun(t, run, extra) {
  const baselineCalls = [];
  const ctx = await openTestRunCore(t, { agentRunner: {}, runner: run, prefix: "owl-env-classify-" });
  const created = await ctx.core.createWork(ctx.envelope({ title: "W", summary: "x", size: "small", project_id: ctx.projectId }, "work"));
  const workId = created.data.work_id;
  const baselineRunner = async (...args) => { baselineCalls.push(args[1]); return run(...args); };
  const outcome = await runCoreTests(
    { db: ctx.db, writeLane: ctx.db.createWriteLane(), workspaceRoot: ctx.root, baselineRunner, baselineLocks: new Map() },
    {
      scope: "work", project_id: ctx.projectId, work_id: workId, task_id: null, agent_run_id: null, root: ctx.repo, commit: "c",
      base_commit: git(ctx.repo, "rev-parse", "HEAD").trim(), repo: ctx.repo, changed_files: [], work_changed_files: [], required_tests: [],
      force_full: "all", settings, run, ...extra,
    },
  );
  return { ...ctx, outcome, baselineCalls };
}

const missingTool = (file) => file === "tests/b.test.mjs";
const toolMissingRunner = () => {
  const stub = createStubTestRunner(() => false);
  return async (argv, cwd, ...rest) => (missingTool(argv[argv.length - 1])
    ? { exit_code: 127, timed_out: false, stdout: "", stderr: "env: pytest: No such file or directory\n", duration_ms: 1 }
    : stub.run(argv, cwd, ...rest));
};

test("runCoreTests reports an environment failure, records the run as error and does not take a baseline", async (t) => {
  const { outcome, db, baselineCalls } = await coreRun(t, toolMissingRunner(), { environment_signals: signals });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.environment.signal, "exit_code_127");
  assert.deepEqual(outcome.environment.argv, ["node", "--test", "tests/b.test.mjs"]);
  assert.match(outcome.environment.evidence, /No such file or directory/u);
  assert.deepEqual(baselineCalls, []);
  assert.equal(db.get("SELECT status FROM test_runs WHERE id = ?", outcome.run_id).status, "error");
});

test("runCoreTests classifies nothing when no signals are given, and a code failure leaves environment null", async (t) => {
  const plain = await coreRun(t, toolMissingRunner(), {});
  assert.equal(plain.outcome.environment, null);
  assert.equal(plain.outcome.status, "failed");

  const stub = createStubTestRunner((file) => file === "tests/b.test.mjs");
  const code = await coreRun(t, stub.run, { environment_signals: signals, work_changed_files: ["tests/b.test.mjs"] });
  assert.equal(code.outcome.environment, null);
  assert.equal(code.outcome.status, "failed");
});

test("a failing setup step is an environment failure", async (t) => {
  const stub = createStubTestRunner(() => false);
  const run = async (argv, cwd, ...rest) => (argv[0] === "setup-tool"
    ? { exit_code: 1, timed_out: false, stdout: "", stderr: "no network\n", duration_ms: 1 }
    : stub.run(argv, cwd, ...rest));
  const { outcome } = await coreRun(t, run, { environment_signals: signals, settings: { ...settings, setup_argvs: [["setup-tool", "install"]] } });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.environment.signal, "setup_failed");
  assert.deepEqual(outcome.environment.argv, ["setup-tool", "install"]);
});

test("a failed policy:test command is classified; Core-run checks without argv and code failures are not", () => {
  const check = (overrides) => ({ command_id: "policy:test", passed: false, detail: "failed", ...overrides });
  const policy = (...checks) => ({ checks });
  const found = policyTestEnvironment(policy(check({ argv: ["pytest", "t.py"], exit_code: 127, stderr: "pytest: command not found" })), signals);
  assert.equal(found?.signal, "exit_code_127");
  assert.deepEqual(found?.argv, ["pytest", "t.py"]);
  assert.equal(policyTestEnvironment(policy(check({ exit_code: 127 })), signals), null);
  assert.equal(policyTestEnvironment(policy(check({ argv: ["pytest"], exit_code: 1, stderr: "assert 1 == 2" })), signals), null);
  // A command that did not start comes back with exit_code -1; its spawn error still marks the environment.
  const spawn = policyTestEnvironment(policy(check({ argv: ["pytest"], exit_code: -1, spawn_error: "spawn pytest ENOENT" })), signals);
  assert.deepEqual(spawn, { signal: "spawn_error", evidence: "spawn pytest ENOENT", argv: ["pytest"] });
});
