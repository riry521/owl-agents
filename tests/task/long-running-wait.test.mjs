import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { buildWorkerPrompt } from "../../packages/agent-runtime/dist/worker.js";

import { evaluatePrerequisite } from "../../packages/core/dist/prerequisite-monitor.js";
import { evaluateRemakeGate } from "../../packages/core/dist/remake-gate.js";
import { lineageUsage } from "../../packages/core/dist/task-lineage.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { DEFAULT_PROGRESS_GUARD_SETTINGS, PROGRESS_GUARD_RANGES, readProgressGuardSettings, validateProgressGuardSettings } from "../../packages/shared/dist/progress-guard-settings.js";
import { PrerequisiteValidationError, validatePendingProcess, validatePrerequisiteSpec, validateWaitFor } from "../../packages/shared/dist/prerequisite.js";
import { DEFAULT_REMAKE_LIMIT_SETTINGS } from "../../packages/shared/dist/remake-limit-settings.js";

// A Worker that reports "partial" with pending_process is waiting for a long process, not failing:
// the Task waits (source "worker"), the wait uses none of the failure / no-progress / remake budgets,
// and its own limits (process_wait_max_count, process_wait_max_hours) keep the relaunching finite.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pending = (extra = {}) => ({
  description: "dry-run of the migration",
  command: "node scripts/dry-run.mjs",
  log_path: "tmp/run.log",
  done_path: "tmp/done",
  pid: null,
  expected_minutes: 45,
  ...extra,
});

const workerReport = (invocationId, result, extra = {}) => ({
  kind: "report",
  schema_version: "1.1.0",
  invocation_id: invocationId,
  result,
  work_done: "Done.",
  changes: [],
  verification: { passed: true, method: "Checked." },
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: null,
  ...extra,
});

/** `script` gives, per Worker launch (the last repeats), "pending", "partial" or "success". */
function runnerWith(script) {
  const state = { calls: 0, replans: 0, requests: [], worktree: null };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") {
        const task = { id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false };
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [task] } };
      }
      if (mode === "replan") state.replans += 1;
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      const kind = script[Math.min(state.calls, script.length - 1)];
      state.calls += 1;
      state.requests.push(request);
      state.worktree = request.context.worktree;
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      await writeFile(join(request.context.worktree, "src/feature.mjs"), "export const f = 1;\n");
      const report = kind === "pending"
        ? workerReport(request.invocation_id, "partial", { pending_process: pending() })
        : workerReport(request.invocation_id, kind);
      return { outcome: "success", report_valid: true, report };
    },
    runReviewer: async () => {
      const review = { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function openCore(t, runner, settings = {}) {
  const { db, core } = await createTestCore(t, { agentRunner: runner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-long-wait-", start: true });
  await disablePlanQuality(db);
  await core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, ...settings });
  return { db, core };
}

async function startWork(core) {
  const created = await core.createWork(command({ title: "long wait", summary: "Exercise a process wait.", size: "normal", project_id: null }, "test:create"));
  await core.startWork(created.data.work_id, command({ mode: "normal" }, "test:start", created.version));
  return created.data.work_id;
}

const task = (db, workId) => db.get("SELECT id, status, failure_count, no_progress_count, prerequisite_json FROM tasks WHERE work_id = ?", workId);
const eventCount = (db, workId, type) => db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = ?", workId, type).n;

/** Make the next Core check of the Work's waits run now (the per-Task interval is at least 10 seconds). */
async function checkNow(core, workId) {
  core.prerequisiteRecheck.add(workId);
  await core.checkPrerequisites(workId);
}

const waitsFor = (db, workId) => waitFor(() => task(db, workId)?.status === "waiting" && task(db, workId));

test("settings: process_wait_max_count / process_wait_max_hours have defaults, ranges and per-key fallback", () => {
  assert.equal(DEFAULT_PROGRESS_GUARD_SETTINGS.process_wait_max_count, 3);
  assert.equal(DEFAULT_PROGRESS_GUARD_SETTINGS.process_wait_max_hours, 6);
  assert.deepEqual(validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, process_wait_max_count: 0 }).process_wait_max_count, 0);
  for (const [key, bad] of [["process_wait_max_count", -1], ["process_wait_max_count", 21], ["process_wait_max_hours", 0], ["process_wait_max_hours", 73], ["process_wait_max_hours", 1.5]]) {
    assert.throws(() => validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, [key]: bad }), new RegExp(key));
  }
  assert.equal(PROGRESS_GUARD_RANGES.process_wait_max_hours.max, 72);
  const { process_wait_max_count: _count, ...partial } = DEFAULT_PROGRESS_GUARD_SETTINGS;
  assert.throws(() => validateProgressGuardSettings(partial), /exactly/);
  const read = readProgressGuardSettings({ ...partial, process_wait_max_hours: 999 });
  assert.equal(read.process_wait_max_count, 3, "a missing key reads as its default");
  assert.equal(read.process_wait_max_hours, 6, "an invalid key reads as its default");
});

test("validatePendingProcess / validatePrerequisiteSpec / validateWaitFor: shape and who may use a process wait", () => {
  assert.deepEqual(validatePendingProcess(pending()), { kind: "process", pid: null, done_path: "tmp/done", log_path: "tmp/run.log", description: "dry-run of the migration" });
  assert.equal(validatePendingProcess(pending({ done_path: null, pid: 42 })).pid, 42);
  for (const bad of [pending({ log_path: "/abs/run.log" }), pending({ done_path: "../done" }), pending({ done_path: null, pid: null }), pending({ pid: 0 }), pending({ description: "" }), null]) {
    assert.throws(() => validatePendingProcess(bad), PrerequisiteValidationError);
  }
  assert.throws(() => validateWaitFor({ reason: "r", conditions: [{ kind: "process", target: "", paths: [], description: "d" }] }), PrerequisiteValidationError);
  const spec = { reason: "r", source: "worker", conditions: [validatePendingProcess(pending())], base_head: null, deadline_at: "2030-01-01T00:00:00.000Z", replan_question: null };
  assert.equal(validatePrerequisiteSpec(spec).source, "worker");
  assert.throws(() => validatePrerequisiteSpec({ ...spec, source: "manager" }), PrerequisiteValidationError);
  assert.throws(() => validatePrerequisiteSpec({ ...spec, conditions: [{ kind: "owner", description: "d" }] }), PrerequisiteValidationError);
});

test("evaluatePrerequisite: a process wait ends with its done file or when the pid is gone, else it keeps waiting", () => {
  const condition = validatePendingProcess(pending({ pid: 777 }));
  const spec = { reason: "r", source: "worker", conditions: [condition], base_head: null, deadline_at: "2999-01-01T00:00:00.000Z", replan_question: null };
  const facts = (alive, files) => ({ taskStatus: () => undefined, workState: () => undefined, baseBranch: () => null, processAlive: () => alive, taskFileExists: (_id, path) => files.includes(path) });
  const now = "2026-01-01T00:00:00.000Z";
  assert.equal(evaluatePrerequisite(spec, facts(true, []), now, "T").verdict, "pending");
  assert.equal(evaluatePrerequisite(spec, facts(true, ["tmp/done"]), now, "T").verdict, "satisfied");
  assert.equal(evaluatePrerequisite(spec, facts(false, []), now, "T").verdict, "satisfied");
  assert.equal(evaluatePrerequisite({ ...spec, deadline_at: "2000-01-01T00:00:00.000Z" }, facts(true, []), now, "T").verdict, "expired");
});

test("a pending_process report holds the Task in waiting without using failure, no-progress or Manager budgets; the done file relaunches the Worker", async (t) => {
  const runner = runnerWith(["pending", "success"]);
  const { db, core } = await openCore(t, runner, { no_progress_limit: 1 });
  const workId = await startWork(core);
  const waiting = await waitsFor(db, workId);
  assert.ok(waiting, `the Task waits (status=${task(db, workId)?.status})`);

  const spec = JSON.parse(waiting.prerequisite_json);
  assert.equal(spec.source, "worker");
  assert.equal(spec.conditions[0].kind, "process");
  assert.equal(spec.conditions[0].done_path, "tmp/done");
  assert.equal(waiting.failure_count, 0);
  assert.equal(waiting.no_progress_count, 0, "(a) the wait is not a no-progress result, even with no_progress_limit 1");
  assert.equal(eventCount(db, workId, "task.process_wait_started"), 1);
  assert.equal(eventCount(db, workId, "task.failure.classified"), 0);
  assert.equal(eventCount(db, workId, "task.replan_requested"), 0);
  assert.equal(runner.state.replans, 0);
  const view = (await core.listTasks(workId, {})).data.find((item) => item.id === waiting.id);
  assert.equal(view.prerequisite.source, "worker");
  assert.equal(view.prerequisite.conditions[0].target, "tmp/done");
  const run = db.get("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'worker'", workId);
  assert.deepEqual({ ...run }, { status: "completed", outcome: "partial" });

  // The process is still running (no done file): the Task keeps waiting and its worktree is protected from the sweeper.
  await checkNow(core, workId);
  assert.equal(task(db, workId).status, "waiting");
  assert.equal(runner.state.calls, 1);
  const activity = core.workspaceActivity();
  assert.ok([...activity.tasks].some((key) => key.endsWith(`/${waiting.id}`)), "workspaceActivity keeps the waiting Task's worktree");

  await mkdir(join(runner.state.worktree, "tmp"), { recursive: true });
  await writeFile(join(runner.state.worktree, "tmp/done"), "");
  await checkNow(core, workId);
  assert.ok(await waitFor(() => task(db, workId)?.status === "completed"), `the Task completes (status=${task(db, workId)?.status})`);
  assert.equal(runner.state.calls, 2);
  const second = runner.state.requests[1].context;
  assert.equal(second.process_wait.log_path, "tmp/run.log");
  assert.equal(second.process_wait.done_path, "tmp/done");
  assert.ok(second.previous_report, "the relaunched Worker gets the previous report");
  assert.equal(task(db, workId).no_progress_count, 0);
  assert.equal(runner.state.replans, 0);

  // (a) the waiting launch is not a Worker launch for the lineage limits.
  const usage = lineageUsage(db, waiting.id, DEFAULT_REMAKE_LIMIT_SETTINGS);
  assert.equal(usage.worker_runs, 1, "2 launches, 1 of them only waited");
  assert.deepEqual(evaluateRemakeGate(usage, { ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_worker_runs: 2 }), { blocked: false });
});

test("process_wait_max_count ends the waits: the report after the last allowed wait opens an Owner Decision, no relaunch", async (t) => {
  const runner = runnerWith(["pending"]);
  const { db, core } = await openCore(t, runner, { process_wait_max_count: 1 });
  const workId = await startWork(core);
  assert.ok(await waitsFor(db, workId));
  await mkdir(join(runner.state.worktree, "tmp"), { recursive: true });
  await writeFile(join(runner.state.worktree, "tmp/done"), "");
  await checkNow(core, workId);
  assert.ok(await waitFor(() => runner.state.calls >= 2), "the Worker was relaunched once");
  assert.ok(await waitFor(() => task(db, workId)?.status === "judgement_waiting"), `the Task goes to the Owner (status=${task(db, workId)?.status})`);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 1, "one Decision is open");
  assert.equal(eventCount(db, workId, "task.failure.classified"), 0, "(c) the wait is not a failure");
  assert.equal(task(db, workId).failure_count, 0);
  assert.equal(task(db, workId).no_progress_count, 0);
  assert.equal(eventCount(db, workId, "task.replan_requested"), 0);
  await checkNow(core, workId);
  assert.equal(runner.state.calls, 2, "no further launch");
});

test("process_wait_max_count 0 turns the wait off", async (t) => {
  const runner = runnerWith(["pending"]);
  const { db, core } = await openCore(t, runner, { process_wait_max_count: 0 });
  const workId = await startWork(core);
  assert.ok(await waitFor(() => eventCount(db, workId, "task.failure.classified") > 0));
  assert.equal(eventCount(db, workId, "task.process_wait_started"), 0);
});

test("a wait past its deadline opens an Owner Decision instead of waiting forever", async (t) => {
  const runner = runnerWith(["pending"]);
  const { db, core } = await openCore(t, runner);
  const workId = await startWork(core);
  const waiting = await waitsFor(db, workId);
  assert.ok(waiting);
  const spec = JSON.parse(waiting.prerequisite_json);
  assert.ok(Date.parse(spec.deadline_at) - Date.now() > 5 * 3_600_000, "deadline = now + process_wait_max_hours (6)");
  const past = JSON.stringify({ ...spec, deadline_at: "2000-01-01T00:00:00.000Z" });
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET prerequisite_json = ? WHERE id = ?", past, waiting.id);
    return null;
  });
  await checkNow(core, workId);
  assert.equal(eventCount(db, workId, "task.prerequisite_expired"), 1);
  assert.equal(task(db, workId).status, "judgement_waiting");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  assert.equal(runner.state.calls, 1, "no Worker was started");
});

test("an ordinary partial report still counts as a failure", async (t) => {
  const runner = runnerWith(["partial"]);
  const { db, core } = await openCore(t, runner);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => eventCount(db, workId, "task.failure.classified") > 0));
  assert.equal(eventCount(db, workId, "task.process_wait_started"), 0);
  assert.ok(task(db, workId).failure_count >= 1);
  assert.notEqual(task(db, workId).status, "waiting");
});

test("the launch example in the Worker prompt survives the agent process group being killed and then writes the done file", async (t) => {
  const task = { id: "t", work_id: "w", title: "t", type: "code", status: "running", state_version: 0, updated_at: "", parent_task_id: null, acceptance: "a", context: "", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [] };
  const prompt = buildWorkerPrompt({ task, context: {} }, "en");
  const example = /for example `(perl [^`]*)`/.exec(prompt)?.[1];
  assert.ok(example, "the prompt shows a launch example");
  const dir = await tempDir(t, "owl-launch-example-");
  const done = join(dir, "done");
  const command = example.replace("<command>", "sleep 1").replace("<log>", join(dir, "log")).replace("<done_file>", done);
  // The agent runs the example in its own process group, as a provider session does.
  const agent = spawn("sh", ["-c", `${command}; sleep 30`], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-agent.pid, "SIGKILL"); } catch { /* already gone */ } });
  await sleep(300);
  process.kill(-agent.pid, "SIGKILL");
  let made = false;
  for (let i = 0; i < 50 && !made; i += 1) {
    await sleep(100);
    made = await access(done).then(() => true, () => false);
  }
  assert.ok(made, "done file written after the agent process group was killed");
});
