import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { workerPromptInputs } from "../../packages/agent-runtime/dist/worker.js";
import {
  RAW_STDERR_MARKER, RAW_STDOUT_MARKER, TEST_RUN_SETTINGS, createStubTestRunner, openTestRunCore, plannedTask, workerReport,
} from "../helpers/test-run-core.mjs";
import { waitFor } from "../helpers/wait.mjs";

// Task verification runs Project test files through Core's stub runner. The Worker is told which tests
// failed and why in one line, never the raw output, and the re-check runs only what matters.

test("a Task's failed test is reworked from names and error gists, then re-checked with only the failed and related files", async (t) => {
  const workerRequests = [];
  let fixed = false;
  const { run, calls } = createStubTestRunner((file, phase) => file === "tests/b.test.mjs" && phase === "task" && !fixed);
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } },
    runWorker: async (request) => {
      workerRequests.push(request);
      // First attempt breaks b; the rework touches src/b.mjs again, so only b is related to it.
      fixed = workerRequests.length > 1;
      // Attempt 1 changes a, b and c; the rework changes only b.
      const touched = workerRequests.length === 1 ? ["a", "b", "c"] : ["b"];
      for (const name of touched) await writeFile(join(request.context.worktree, `src/${name}.mjs`), `export const ${name} = ${workerRequests.length + 1};\n`);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, touched.map((name) => `src/${name}.mjs`)) };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-task-core-test-run-" });
  const created = await core.createWork(envelope({ title: "Rework", summary: "x", size: "normal", project_id: projectId }, "work"));
  const workId = created.data.work_id;
  await core.startWork(workId, { ...envelope({ mode: "normal" }, "start"), expected_version: created.version });

  await waitFor(() => workerRequests.length >= 2 && db.all("SELECT id FROM test_runs WHERE scope = 'task'").length >= 2, { timeoutMs: 30_000, message: "the second Task test run" });

  // The rework prompt: failed test name and error gist, no raw output.
  const failure = workerRequests[1].context.verification_failure;
  assert.ok(failure, "the Worker gets the verification failure as fix context");
  const prompt = JSON.stringify(workerPromptInputs(workerRequests[1]));
  const raw = JSON.stringify(failure);
  for (const text of [prompt, raw]) {
    assert.doesNotMatch(text, new RegExp(RAW_STDOUT_MARKER, "u"));
    assert.doesNotMatch(text, new RegExp(RAW_STDERR_MARKER, "u"));
    assert.doesNotMatch(text, /output_tail|\\"stdout\\"|\\"stderr\\"/u);
  }
  const promptFailure = workerPromptInputs(workerRequests[1]).find((slot) => slot.name === "Attempt").value.verification_failure;
  assert.deepEqual(
    promptFailure.test_failures.failures.map(({ file, name, message }) => ({ file, name, message })),
    [{ file: "tests/b.test.mjs", name: "b works", message: "expected 1 to equal 2 in b" }],
  );
  assert.equal(promptFailure.test_failures.omitted_count, 0);

  // First check: b failed; the baseline check of b passed, so the failure is in scope.
  const runs = db.all("SELECT id, status, selection_json FROM test_runs WHERE scope = 'task' ORDER BY rowid");
  assert.equal(runs[0].status, "failed");
  assert.deepEqual(JSON.parse(runs[0].selection_json).files, ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"]);

  // Re-check: the previously failed file only; the two unrelated passing files are never run again.
  assert.equal(runs[1].status, "passed");
  const second = JSON.parse(runs[1].selection_json);
  assert.deepEqual(second.previous_failed, ["tests/b.test.mjs"]);
  assert.deepEqual(second.files, ["tests/b.test.mjs"]);
  assert.deepEqual(db.all("SELECT file FROM test_run_files WHERE run_id = ?", runs[1].id).map((row) => row.file), ["tests/b.test.mjs"]);
  // a and c passed on the first check and are not touched by the rework: they ran once each, b twice.
  const taskCalls = calls.filter((call) => call.phase === "task").map((call) => call.file);
  assert.equal(taskCalls.filter((file) => file === "tests/a.test.mjs").length, 1);
  assert.equal(taskCalls.filter((file) => file === "tests/c.test.mjs").length, 1);
});

test("the Reviewer gets Core's test result as core_tests with the failed test name and error gist, and no raw output", async (t) => {
  const reviewerRequests = [];
  // b fails on the base branch too, so Task verification passes and the Reviewer runs with the failure listed.
  const { run } = createStubTestRunner((file) => file === "tests/b.test.mjs");
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } },
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "src/b.mjs"), "export const b = 2;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, ["src/b.mjs"]) };
    },
    runReviewer: async (request) => {
      reviewerRequests.push(request);
      return { outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id }, review: { verdict: "pass", findings: [], tests: {} } };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const checkCommands = [[process.execPath, "-e", "console.log('CHECK_STDOUT_MARKER')"], [process.execPath, "-e", "console.error('CHECK_STDERR_MARKER')"]];
  const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-reviewer-core-tests-", testPolicy: { check_commands: checkCommands } });
  const created = await core.createWork(envelope({ title: "Reviewer input", summary: "x", size: "normal", project_id: projectId }, "work"));
  await core.startWork(created.data.work_id, { ...envelope({ mode: "normal" }, "start"), expected_version: created.version });

  await waitFor(() => reviewerRequests.length >= 1, { timeoutMs: 30_000, message: "the Reviewer run" });

  const coreTests = reviewerRequests[0].context.core_tests;
  assert.ok(coreTests, "the Reviewer gets Core's test run");
  assert.ok(coreTests.pre_existing.failures.some((failure) => failure.file === "tests/b.test.mjs" && failure.name === "b works" && failure.message === "expected 1 to equal 2 in b"));
  assert.doesNotMatch(JSON.stringify(coreTests), new RegExp(`${RAW_STDOUT_MARKER}|${RAW_STDERR_MARKER}`, "u"));

  // Passing check_commands are kept in verification.check_commands, not mixed into verification.commands.
  const { verification } = JSON.parse(db.get("SELECT payload_json FROM events WHERE type = 'verification.completed' ORDER BY rowid LIMIT 1").payload_json);
  assert.equal(verification.check_commands.filter((check) => check.passed === true).length, checkCommands.length);
  assert.ok(verification.commands.every((command) => !String(command.command_id).startsWith("check:")));

  const coreChecks = reviewerRequests[0].context.core_checks;
  assert.equal(coreChecks.check_commands.length, checkCommands.length);
  assert.ok(coreChecks.check_commands.every((check) => typeof check.command_id === "string" && check.passed === true));
  assert.ok(Array.isArray(coreChecks.policy_checks));
  assert.ok(coreChecks.policy_checks.every((check) => !String(check.command_id).startsWith("check:")));
  assert.doesNotMatch(JSON.stringify(coreChecks), /CHECK_STDOUT_MARKER|CHECK_STDERR_MARKER|"stdout"|"stderr"/u);
});

const criterion = (kind) => ({
  id: "AC1", text: "Code works.", check: "Look.", serves: "x", if_omitted: "y", check_weight: "light", weight_reason: "", kind,
});

async function runUntilVerified(t, { kind, taskType = "code", check, workerFiles, testRun, projectCheckArgv }) {
  const workerRequests = [];
  const { run } = createStubTestRunner(() => false);
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ ...plannedTask("T1"), type: taskType, ...(kind === undefined ? {} : { acceptance_criteria: [criterion(kind)] }) }] } },
    runWorker: async (request) => {
      workerRequests.push(request);
      const files = workerFiles(workerRequests.length);
      for (const [file, content] of Object.entries(files)) await writeFile(join(request.context.worktree, file), content);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, Object.keys(files)) };
    },
    runReviewer: async (request) => ({ outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id }, review: { verdict: "pass", findings: [], tests: {} } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-task-core-check-", ...(testRun === undefined ? {} : { testRun }), ...(projectCheckArgv === undefined ? {} : { projectCheckArgv }), ...(check === undefined ? {} : { testPolicy: { check_commands: [check] } }) });
  const created = await core.createWork(envelope({ title: "Check", summary: "x", size: "normal", project_id: projectId }, "work"));
  await core.startWork(created.data.work_id, { ...envelope({ mode: "normal" }, "start"), expected_version: created.version });
  await waitFor(() => db.all("SELECT id FROM events WHERE type = 'verification.completed'").length >= 1, { timeoutMs: 30_000, message: "a verification" });
  const verified = JSON.parse(db.get("SELECT payload_json FROM events WHERE type = 'verification.completed' ORDER BY rowid LIMIT 1").payload_json);
  return { db, workerRequests, verified, removed: () => db.all("SELECT payload_json FROM events WHERE type = 'task.unrequested_tests_removed'").map((row) => JSON.parse(row.payload_json)) };
}

test("a test file added by a Task without a spec_test criterion is removed and logged; kept with one; existing files are untouched", async (t) => {
  for (const kind of [undefined, "work_check"]) {
    const { workerRequests, verified, removed } = await runUntilVerified(t, { kind, workerFiles: () => ({ "tests/new.test.mjs": "x\n", "tests/a.test.mjs": "changed\n" }) });
    assert.equal(workerRequests.length, 1, "removal does not send the Task back");
    assert.equal(verified.outcome, "pass");
    assert.deepEqual(removed().map(({ files, reason }) => ({ files, reason })), [{ files: ["tests/new.test.mjs"], reason: "no_spec_test_criterion" }]);
    assert.equal(await readFile(join(workerRequests[0].context.worktree, "tests/new.test.mjs"), "utf8").catch(() => null), null);
    assert.equal(await readFile(join(workerRequests[0].context.worktree, "tests/a.test.mjs"), "utf8"), "changed\n");
  }
  const { workerRequests, removed } = await runUntilVerified(t, { kind: "spec_test", workerFiles: () => ({ "tests/new.test.mjs": "x\n" }) });
  assert.deepEqual(removed(), []);
  assert.equal(await readFile(join(workerRequests[0].context.worktree, "tests/new.test.mjs"), "utf8"), "x\n");
});
test("a test-type Task with only an unrequested added test still passes after removal", async (t) => {
  const { verified, removed } = await runUntilVerified(t, { taskType: "test", workerFiles: () => ({ "tests/new.test.mjs": "x\n" }) });
  assert.deepEqual(removed().map(({ files, reason }) => ({ files, reason })), [{ files: ["tests/new.test.mjs"], reason: "no_spec_test_criterion" }]);
  assert.equal(verified.outcome, "pass");
});

test("unrequested tests are removed before the Project verification plan runs, and also when test_run mode is off", async (t) => {
  // The Project check fails while the added test file exists, so it only passes if the removal ran first.
  const projectCheckArgv = [process.execPath, "-e", "process.exit(require('fs').existsSync('tests/new.test.mjs') ? 1 : 0)"];
  for (const testRun of [undefined, { ...TEST_RUN_SETTINGS, mode: "off" }]) {
    const { workerRequests, removed } = await runUntilVerified(t, { testRun, projectCheckArgv, workerFiles: () => ({ "tests/new.test.mjs": "x\n" }) });
    assert.equal(workerRequests.length, 1, "removal ahead of the plan does not send the Task back");
    assert.deepEqual(removed().map(({ files }) => files), [["tests/new.test.mjs"]]);
  }
});

test("a failing check_command fails verification with check_failed and its output reaches the next Worker; a passing one lets the Task through", async (t) => {
  const check = [process.execPath, "-e", "require('fs').existsSync('fixed.txt') || (console.error('CHECK_MARKER_OUTPUT'), process.exit(1))"];
  const { db, workerRequests } = await runUntilVerified(t, { check, workerFiles: (attempt) => (attempt === 1 ? { "src/a.mjs": "export const a = 2;\n" } : { "fixed.txt": "ok\n" }) });
  await waitFor(() => workerRequests.length >= 2, { timeoutMs: 30_000, message: "the second Worker" });
  const failure = workerRequests[1].context.verification_failure;
  assert.equal(failure.error_key, "check_failed");
  assert.match(JSON.stringify(failure), /CHECK_MARKER_OUTPUT/u);
  await waitFor(() => db.all("SELECT id FROM events WHERE type = 'verification.completed'").length >= 2, { timeoutMs: 30_000, message: "the second verification" });
  assert.equal(workerRequests.length, 2, "the check passes after the fix, so no third attempt");
});

test("a git failure before the Core test run is logged and fails verification instead of silently skipping the tests", async (t) => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args); };
  const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const saved = names.map((name) => process.env[name]);
  t.after(() => {
    console.error = original;
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  });
  // An invalid status mode makes `git status` fail in Core's own check while the worktree stays a valid checkout.
  const { db, verified } = await runUntilVerified(t, {
    workerFiles: () => {
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "status.showUntrackedFiles";
      process.env.GIT_CONFIG_VALUE_0 = "bogus";
      return { "src/a.mjs": "export const a = 2;\n" };
    },
  });
  assert.equal(verified.verification.passed, false);
  assert.equal(verified.verification.test_run.status, "error");
  assert.match(String(verified.verification.error), /git failed/u);
  assert.ok(errors.some((args) => /git failed before the Core test run/u.test(String(args[0])) && args[1] instanceof Error));
  assert.equal(db.all("SELECT id FROM test_runs").length, 0);
});
