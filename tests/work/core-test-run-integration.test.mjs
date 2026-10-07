import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { createUlid } from "../../packages/db/dist/index.js";
import {
  RAW_STDERR_MARKER, RAW_STDOUT_MARKER, createStubTestRunner, REPO_FILES, openTestRunCore, phaseOf, plannedTask, workerReport,
} from "../helpers/test-run-core.mjs";
import { waitFor } from "../helpers/wait.mjs";

// Core's test run on the integrated Work branch: a failure goes back to the Manager as fix Tasks only,
// the re-run covers the failed and related files, and failures that were already there never stop the Work.

const complete = { verdict: "complete", summary: "Done.", missing: [], lessons: [] };
const workState = (db, workId) => db.get("SELECT state FROM works WHERE id = ?", workId).state;
const workRuns = (db, workId) => db.all("SELECT id, status, selection_json FROM test_runs WHERE work_id = ? AND scope = 'work' ORDER BY rowid", workId);
const runFiles = (db, runId) => db.all("SELECT file FROM test_run_files WHERE run_id = ? ORDER BY file", runId).map((row) => row.file);
const testRunBacklog = (db, workId) => db.all("SELECT id FROM backlog_items WHERE work_id = ? AND source = 'test_run'", workId);
const quarantine = (db, projectId) => db.all("SELECT file, classified_by, removal_work_id FROM test_quarantine WHERE project_id = ? ORDER BY file", projectId);

async function startWork(core, projectId, envelope) {
  const created = await core.createWork(envelope({ title: "Core tests", summary: "x", size: "normal", project_id: projectId }, "work"));
  const workId = created.data.work_id;
  await core.startWork(workId, { ...envelope({ mode: "normal" }, "start"), expected_version: created.version });
  return workId;
}

test("a failing Work-level test run makes the Manager add only fix Tasks, and the re-run covers the failed and related files", async (t) => {
  let fixed = false;
  let t1AgentRunsAtReplan = null;
  let replanTasksReturned = null;
  const replanRequests = [];
  const { run, calls } = createStubTestRunner((file, phase) => file === "tests/b.test.mjs" && phase === "work" && !fixed);
  const holder = {};
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "finalize") return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: complete } };
      if (request.mode === "replan") {
        replanRequests.push(request);
        t1AgentRunsAtReplan = holder.db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = (SELECT id FROM tasks WHERE manager_task_id = 'T1')").n;
        replanTasksReturned = [plannedTask("T2", "Fix b")];
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: replanTasksReturned } };
      }
      return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } };
    },
    runWorker: async (request) => {
      const fixing = request.task?.manager_task_id === "T2" || replanRequests.length > 0;
      fixed = fixing;
      await writeFile(join(request.context.worktree, "src/b.mjs"), `export const b = ${fixing ? 3 : 2};\n`);
      if (!fixing) await writeFile(join(request.context.worktree, "src/a.mjs"), "export const a = 2;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, fixing ? ["src/b.mjs"] : ["src/b.mjs", "src/a.mjs"]) };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-work-core-test-run-" });
  holder.db = db;
  const workId = await startWork(core, projectId, envelope);

  await waitFor(() => workState(db, workId) === "completed", { timeoutMs: 60_000, message: "the Work to complete" });

  // The Manager replan got names and gists only, and added only the fix Task.
  assert.equal(replanRequests.length, 1);
  const verification = replanRequests[0].context.work_verification;
  assert.deepEqual(verification.core_tests.failed_files, ["tests/b.test.mjs"]);
  assert.deepEqual(verification.core_tests.failures.failures.map(({ file, name }) => ({ file, name })), [{ file: "tests/b.test.mjs", name: "b works" }]);
  const replanText = JSON.stringify(replanRequests[0].context);
  assert.doesNotMatch(replanText, new RegExp(`${RAW_STDOUT_MARKER}|${RAW_STDERR_MARKER}`, "u"));
  assert.deepEqual(replanTasksReturned.map((task) => task.id), ["T2"]);
  const tasks = db.all("SELECT manager_task_id, status FROM tasks WHERE work_id = ? ORDER BY manager_task_id", workId);
  assert.deepEqual(tasks, [{ manager_task_id: "T1", status: "completed" }, { manager_task_id: "T2", status: "completed" }]);

  // The finished Task was not run again: its agent runs did not grow with the replan and the fix.
  const t1AgentRunsAfter = db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = (SELECT id FROM tasks WHERE manager_task_id = 'T1' AND work_id = ?)", workId).n;
  assert.ok(t1AgentRunsAtReplan >= 1);
  assert.equal(t1AgentRunsAfter, t1AgentRunsAtReplan);

  // First Work run: the tests related to what the Work changed (a and b). Second: the failed file and what the fix
  // touched since, not the passing file the fix left alone.
  const [first, second, ...rest] = workRuns(db, workId);
  assert.equal(rest.length, 0);
  assert.equal(first.status, "failed");
  // The Work's first run is the whole suite.
  assert.equal(JSON.parse(first.selection_json).full_reason, "first_work_run");
  assert.deepEqual(runFiles(db, first.id), ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"]);
  assert.equal(second.status, "passed");
  const selection = JSON.parse(second.selection_json);
  assert.equal(selection.mode, "selected");
  assert.deepEqual(selection.previous_failed, ["tests/b.test.mjs"]);
  assert.deepEqual(runFiles(db, second.id), ["tests/b.test.mjs"]);
  const workCalls = calls.filter((call) => call.phase === "work");
  assert.deepEqual(workCalls.map((call) => call.file), ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs", "tests/b.test.mjs"]);
  assert.equal(workCalls.filter((call) => call.file === "tests/c.test.mjs").length, 1);
});

/**
 * b fails at the Task, at the Work and (baseline) at the base commit, or is known to the latest nightly
 * run; c fails once on the Work branch for real, which forces a second Work-level run that touches b again.
 */
async function preExistingScenario(t, source) {
  let fixed = false;
  const { run, calls } = createStubTestRunner((file, phase) => {
    if (file === "tests/b.test.mjs") return source === "baseline" ? true : phase !== "baseline";
    return file === "tests/c.test.mjs" && phase === "work" && !fixed;
  });
  const replans = [];
  const finalizes = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "finalize") {
        finalizes.push(request);
        return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: complete } };
      }
      if (request.mode === "replan") {
        replans.push(request);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [plannedTask("T2", "Fix c")] } };
      }
      return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } };
    },
    runWorker: async (request) => {
      const fixing = replans.length > 0;
      fixed = fixing;
      // Both attempts touch b and c, so every Work-level run selects b (which keeps failing, as before).
      await writeFile(join(request.context.worktree, "src/c.mjs"), `export const c = ${fixing ? 3 : 2};\n`);
      await writeFile(join(request.context.worktree, "src/b.mjs"), `export const b = ${fixing ? 3 : 2};\n`);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, ["src/c.mjs", "src/b.mjs"]) };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const ctx = await openTestRunCore(t, { agentRunner, runner: run, prefix: `owl-work-pre-existing-${source}-` });
  if (source === "nightly") {
    const now = new Date().toISOString();
    const failures = [{ file: "tests/b.test.mjs", name: "b works", line: 3, message: "expected 1 to equal 2 in b" }];
    await ctx.db.createWriteLane().transact((tx) => {
      tx.run(
        "INSERT INTO nightly_test_runs (id, project_id, status, started_at, finished_at, failures_json) VALUES (?, ?, 'failed', ?, ?, ?)",
        createUlid(), ctx.projectId, now, now, JSON.stringify(failures),
      );
      return null;
    });
  }
  const workId = await startWork(ctx.core, ctx.projectId, ctx.envelope);
  await waitFor(() => workState(ctx.db, workId) === "completed", { timeoutMs: 60_000, message: "the Work to complete" });
  return { ...ctx, workId, calls, replans, finalizes };
}

for (const source of ["baseline", "nightly"]) {
  test(`a test failing in the ${source} is pre-existing: the Work goes on to the Final Manager and it is quarantined and skipped, not backlogged`, async (t) => {
    const { db, projectId, workId, calls, replans, finalizes } = await preExistingScenario(t, source);

    const [first, second, ...rest] = workRuns(db, workId);
    assert.equal(rest.length, 0);
    // The Task-level run already quarantined b, so the Work-level runs skip it and only c is judged.
    assert.equal(first.status, "failed");
    assert.equal(replans.length, 1);
    assert.deepEqual(replans[0].context.work_verification.core_tests.failed_files, ["tests/c.test.mjs"]);
    assert.equal(second.status, "passed");
    for (const run of [first, second]) {
      assert.ok(!runFiles(db, run.id).includes("tests/b.test.mjs"));
      assert.deepEqual(JSON.parse(run.selection_json).quarantined, ["tests/b.test.mjs"]);
    }
    assert.equal(finalizes.length, 1);
    assert.equal(workState(db, workId), "completed");
    assert.deepEqual(quarantine(db, projectId).map((row) => [row.file, row.classified_by]), [["tests/b.test.mjs", source]]);
    assert.equal(testRunBacklog(db, workId).length, 0);
    assert.equal(calls.some((call) => call.phase === "baseline" && call.file === "tests/a.test.mjs"), false);
  });
}

test("a Work whose only failure is pre-existing reaches the Final Manager on the first Work-level run", async (t) => {
  const { run } = createStubTestRunner((file) => file === "tests/b.test.mjs");
  let finalizes = 0;
  const holder = { workerRuns: 0 };
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "finalize") {
        finalizes += 1;
        // A repeat Work-level run with nothing failed and nothing changed selects nothing: no new record, no new item.
        holder.runsBefore = workRuns(holder.db, holder.workId).length;
        holder.again = await holder.core.workflow.runWorkCoreTests(holder.workId);
        return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: complete } };
      }
      return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } };
    },
    runWorker: async (request) => {
      const fixing = holder.workerRuns++ > 0;
      await writeFile(join(request.context.worktree, "src/b.mjs"), `export const b = ${fixing ? 3 : 2};\n`);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, ["src/b.mjs"]) };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-work-pre-existing-only-" });
  holder.core = core;
  holder.db = db;
  holder.workId = await startWork(core, projectId, envelope);
  await waitFor(() => workState(db, holder.workId) === "completed", { timeoutMs: 60_000, message: "the Work to complete" });

  assert.equal(finalizes, 1);
  // The Work-level run that found b pre-existing adds no fix Task; the Work goes straight to the Final Manager with T1 as its only Task.
  assert.equal(db.all("SELECT id FROM tasks WHERE work_id = ?", holder.workId).length, 1);
  assert.equal(holder.workerRuns, 1);
  assert.equal(db.all("SELECT id FROM works").length, 1);
  const [first] = workRuns(db, holder.workId);
  assert.equal(first.status, "passed");
  assert.equal(testRunBacklog(db, holder.workId).length, 0);
  assert.deepEqual(quarantine(db, projectId).map((row) => row.file), ["tests/b.test.mjs"]);
  assert.equal(holder.again.outcome.status, "skipped");
  assert.equal(workRuns(db, holder.workId).length, holder.runsBefore);
});

// A Project without test_run: Core detects how to run the tests, saves what it found, and an explicit test_run wins.

const NODE_PACKAGE = JSON.stringify({ scripts: { test: "node --test", build: "tsc" } });
const passingAgents = (touch) => ({
  runManagerPlan: async (request) => request.mode === "finalize"
    ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: complete } }
    : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } },
  runWorker: async (request) => {
    await writeFile(join(request.context.worktree, touch), "export const a = 2;\n");
    return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [touch]) };
  },
  runReviewer: async (request) => ({
    outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
    review: { verdict: "pass", findings: [], tests: {} },
  }),
  runAdvisor: async () => ({ reply: "" }),
});

async function runDetectedWork(t, { files, testRun, touch }) {
  const stub = createStubTestRunner(() => false);
  const argvs = [];
  const runner = async (argv, cwd, ...rest) => {
    argvs.push({ argv: [...argv], phase: phaseOf(cwd) });
    return stub.run(argv, cwd, ...rest);
  };
  const ctx = await openTestRunCore(t, { agentRunner: passingAgents(touch), runner, prefix: "owl-detected-test-run-", files, ...(testRun === undefined ? {} : { testRun }) });
  const workId = await startWork(ctx.core, ctx.projectId, ctx.envelope);
  await waitFor(() => workState(ctx.db, workId) === "completed", { timeoutMs: 60_000, message: "the Work to complete" });
  const detected = ctx.db.get("SELECT test_run_detected_json AS json FROM projects WHERE id = ?", ctx.projectId).json;
  return { ...ctx, workId, argvs, detected: detected === null ? null : JSON.parse(detected) };
}

test("a Project without test_run gets Task and Work test runs from detection, builds once per checkout and saves the detection", async (t) => {
  const { db, workId, argvs, detected } = await runDetectedWork(t, { files: { ...REPO_FILES, "package.json": NODE_PACKAGE }, testRun: null, touch: "src/a.mjs" });
  const scopes = db.all("SELECT scope FROM test_runs WHERE work_id = ? ORDER BY rowid", workId).map((row) => row.scope);
  assert.ok(scopes.includes("task") && scopes.includes("work"), `task and work runs recorded, got ${scopes}`);
  assert.equal(detected.rule_id, "node-test-runner");
  for (const phase of ["task", "work"]) {
    const indexes = argvs.flatMap((call, index) => call.phase === phase && call.argv.at(-1) === "build" ? [index] : []);
    assert.equal(indexes.length, 1, `one build in the ${phase} checkout`);
    const firstTest = argvs.findIndex((call) => call.phase === phase && call.argv.at(-1).endsWith(".test.mjs"));
    assert.ok(indexes[0] < firstTest, "build comes before the tests");
  }
});

test("an explicit test_run is used instead of detection and nothing is saved", async (t) => {
  const { argvs, detected } = await runDetectedWork(t, { files: { ...REPO_FILES, "package.json": NODE_PACKAGE }, touch: "src/a.mjs" });
  assert.equal(detected, null);
  assert.ok(argvs.some((call) => call.argv.join(" ") === "node --test tests/a.test.mjs"), "the explicit file_argv ran");
  assert.ok(!argvs.some((call) => call.argv.includes("--test-reporter=tap")), "the detected file_argv did not run");
});

test("a Project with no tests runs nothing and records why", async (t) => {
  const { db, workId, detected, argvs } = await runDetectedWork(t, { files: { "README.md": "hi\n" }, testRun: null, touch: "README.md" });
  assert.equal(db.all("SELECT id FROM test_runs WHERE work_id = ?", workId).length, 0);
  assert.equal(argvs.length, 0);
  assert.deepEqual([detected.enabled, detected.reason], [false, "no_test_marker"]);
  const events = db.all("SELECT payload_json FROM events WHERE work_id = ?", workId).map((row) => row.payload_json).join("\n");
  assert.match(events, /not_applicable/u);
});

test("a failed Work diff stops the Work-level test run as an error and goes to the Manager instead of completing", async (t) => {
  t.mock.method(GitWorktreeGateway.prototype, "diffPaths", async () => { throw new Error("diff broke"); });
  t.mock.method(console, "warn", () => undefined);
  const { run } = createStubTestRunner(() => false);
  const replanRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "replan") {
        replanRequests.push(request);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [plannedTask("T2", "Fix")] } };
      }
      if (request.mode === "finalize") return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: complete } };
      return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } };
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
  };
  const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-work-core-test-diff-" });
  const workId = await startWork(core, projectId, envelope);

  await waitFor(() => replanRequests.length >= 1, { timeoutMs: 60_000, message: "the Manager replan" });
  assert.equal(replanRequests[0].context.work_verification.core_tests.status, "error");
  assert.notEqual(workState(db, workId), "completed");
});
