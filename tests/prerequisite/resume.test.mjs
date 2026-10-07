import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../packages/shared/dist/progress-guard-settings.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A waiting Task is released by the Core tick when its prerequisite holds, by a
// finished Task/Work or a merge without waiting for the interval, and by the
// Owner. Unreachable, expired and conflicting waits open an Owner Decision.

const QUESTION = "page-format.ts does not exist yet; wait for it to land on main?";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** waitFor with this file's 15 second limit. */
const until = (read, message) => waitFor(read, { timeoutMs: 15_000, message });

const workerReport = (invocationId, question) => ({
  kind: "report",
  schema_version: "1.0.0",
  invocation_id: invocationId,
  result: question ? "partial" : "success",
  work_done: "Done.",
  changes: [],
  verification: { passed: true, method: "Checked." },
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: question ?? null,
});

const planTask = (extra = {}) => ({ id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false, ...extra });

/**
 * The first Worker run that is not gated asks QUESTION, the Manager retries it with
 * `state.wait()`'s wait_for, later Worker runs succeed. `state.gate` holds Workers
 * started while it is set until `release()` is called.
 */
function makeRunner() {
  const state = { workerCalls: 0, replans: 0, gate: null, worktrees: [], contexts: [], wait: () => null };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        state.replans += 1;
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask({ wait_for: state.wait() })] } };
      }
      return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
    },
    runWorker: async (request) => {
      const gate = state.gate;
      if (gate) {
        await gate;
        await mkdir(join(request.context.worktree, "src"), { recursive: true });
        await writeFile(join(request.context.worktree, "src/other.mjs"), "export const o = 1;\n");
        return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, null) };
      }
      state.workerCalls += 1;
      state.worktrees.push(request.context.worktree);
      state.contexts.push(JSON.stringify(request.context));
      state.pageFormatPresent = state.pageFormatPresent ?? [];
      state.pageFormatPresent.push(existsSync(join(request.context.worktree, "src/page-format.ts")));
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      await writeFile(join(request.context.worktree, "src/feature.mjs"), "export const f = 1;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, state.workerCalls === 1 ? QUESTION : null) };
    },
    runReviewer: async () => {
      const review = { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function openFixture(t, { withProject = false, settings = {} } = {}) {
  const runner = makeRunner();
  const { root, db, core } = await createTestCore(t, { agentRunner: runner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-prereq-resume-", start: true });
  // The tick interval and deadline are measured with Date.now(); skew it instead of sleeping.
  const realNow = Date.now;
  const clock = { skewMs: 0 };
  Date.now = () => realNow() + clock.skewMs;
  t.after(() => {
    Date.now = realNow;
  });
  await disablePlanQuality(db);
  await core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, ...settings });
  const ctx = { root, db, core, runner, clock, projectId: null, project: null };
  if (withProject) {
    const project = join(root, "project");
    await mkdir(project);
    git(project, "init", "--initial-branch=main");
    git(project, "config", "user.name", "Test");
    git(project, "config", "user.email", "test@example.invalid");
    await writeFile(join(project, "README.md"), "base\n");
    git(project, "add", ".");
    git(project, "commit", "-m", "initial");
    const registered = await core.createProject(command({ name: "prereq project", canonical_path: project, base_branch: "main", allowed_roots: [root], verification_plan: [] }, "project"));
    ctx.projectId = registered.data.id;
    ctx.project = project;
  }
  return ctx;
}

async function startWork(ctx, suffix, projectId = null) {
  const created = await ctx.core.createWork(command({ title: suffix, summary: "Exercise prerequisite release.", size: "normal", project_id: projectId }, `${suffix}-create`));
  await ctx.core.startWork(created.data.work_id, command({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

/** A condition on another Work that never finishes: a wait only the deadline or the Owner ends (an owner condition would open a Decision at once). */
async function openWorkCondition(ctx, suffix, description = "Owner confirms") {
  const other = await ctx.core.createWork(command({ title: "other-" + suffix, summary: "The Work being waited for.", size: "normal", project_id: null }, "other-" + suffix));
  const number = ctx.db.get("SELECT display_number FROM works WHERE id = ?", other.data.work_id).display_number;
  return { kind: "work", target: "#" + number, paths: [], description };
}

const task = (db, workId) => db.get("SELECT id, status, no_progress_count, prerequisite_json FROM tasks WHERE work_id = ?", workId);
const eventCount = (db, workId, type) => db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = ?", workId, type).n;
const waitingFor = (db, workId) => until(() => task(db, workId)?.status === "waiting" && task(db, workId)?.prerequisite_json);

/** A Work in another place whose Worker is held until the returned release() runs. */
async function startGatedOtherWork(ctx) {
  let release;
  ctx.runner.state.gate = new Promise((resolveGate) => { release = resolveGate; });
  const workId = await startWork(ctx, "other");
  const taskId = await until(() => ctx.db.get("SELECT id FROM tasks WHERE work_id = ? AND status = 'running'", workId)?.id);
  assert.ok(taskId, "the other Work's Task runs");
  ctx.runner.state.gate = null;
  return { workId, taskId, release };
}

test("a task condition releases the wait the moment the other Task completes, and the Worker starts once", async (t) => {
  const ctx = await openFixture(t, { settings: { prerequisite_check_interval_seconds: 3600 } });
  const other = await startGatedOtherWork(ctx);
  ctx.runner.state.wait = () => ({ reason: "needs the other Task", conditions: [{ kind: "task", target: other.taskId, paths: [], description: "other Task completes" }] });
  const workId = await startWork(ctx, "task-wait");
  assert.ok(await waitingFor(ctx.db, workId), "the Task waits");
  await sleep(300);
  assert.equal(ctx.runner.state.workerCalls, 1, "nothing starts while the other Task is unfinished");

  other.release();
  assert.ok(await until(() => ctx.runner.state.workerCalls >= 2), "the Worker started again after the other Task completed (interval is 1h, so the event woke it)");
  assert.ok(await until(() => task(ctx.db, workId).status === "completed"));
  assert.equal(eventCount(ctx.db, workId, "task.prerequisite_satisfied"), 1);
  assert.equal(ctx.runner.state.workerCalls, 2, "exactly one more Worker run");
  assert.equal(task(ctx.db, workId).prerequisite_json, null);
  const satisfied = JSON.parse(ctx.db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.prerequisite_satisfied'", workId).payload_json);
  assert.equal(satisfied.task_id, task(ctx.db, workId).id);
});

test("a base_branch condition is released by the periodic check, and the base is merged into the Work branch first", async (t) => {
  const ctx = await openFixture(t, { withProject: true });
  ctx.runner.state.wait = () => ({ reason: "needs page-format.ts on main", conditions: [{ kind: "base_branch", target: "", paths: ["src/page-format.ts"], description: "page-format.ts on main" }] });
  const workId = await startWork(ctx, "base-wait", ctx.projectId);
  assert.ok(await waitingFor(ctx.db, workId), "the Task waits");
  const spec = JSON.parse(task(ctx.db, workId).prerequisite_json);
  assert.equal(spec.base_head, git(ctx.project, "rev-parse", "refs/heads/main"));
  await sleep(300);
  assert.equal(ctx.runner.state.workerCalls, 1);

  await mkdir(join(ctx.project, "src"));
  await writeFile(join(ctx.project, "src/page-format.ts"), "export const fmt = 1;\n");
  git(ctx.project, "add", ".");
  git(ctx.project, "commit", "-m", "land page-format");
  ctx.clock.skewMs = 120_000;

  assert.ok(await until(() => ctx.runner.state.workerCalls >= 2), "the Worker started after the periodic check saw the file");
  assert.equal(ctx.runner.state.pageFormatPresent[1], true, "the Task worktree already holds the base's file");
  assert.equal(git(ctx.project, "show", `owl/work/${workId}/work:src/page-format.ts`), "export const fmt = 1;");
  assert.equal(eventCount(ctx.db, workId, "task.prerequisite_satisfied"), 1);
});

test("prerequisite_sync_base=false releases the wait without merging the base", async (t) => {
  const ctx = await openFixture(t, { withProject: true, settings: { prerequisite_sync_base: false } });
  ctx.runner.state.wait = () => ({ reason: "needs page-format.ts on main", conditions: [{ kind: "base_branch", target: "", paths: ["src/page-format.ts"], description: "page-format.ts on main" }] });
  const workId = await startWork(ctx, "nosync-wait", ctx.projectId);
  assert.ok(await waitingFor(ctx.db, workId));
  await mkdir(join(ctx.project, "src"));
  await writeFile(join(ctx.project, "src/page-format.ts"), "export const fmt = 1;\n");
  git(ctx.project, "add", ".");
  git(ctx.project, "commit", "-m", "land page-format");
  ctx.clock.skewMs = 120_000;
  assert.ok(await until(() => ctx.runner.state.workerCalls >= 2));
  assert.equal(ctx.runner.state.pageFormatPresent[1], false, "the base was not merged");
  assert.throws(() => git(ctx.project, "show", `owl/work/${workId}/work:src/page-format.ts`));
});

test("a base sync conflict opens a sync_conflict Decision and keeps the Task from starting", async (t) => {
  const ctx = await openFixture(t, { withProject: true });
  ctx.core.gitGateway().mergeBaseIntoWorkBranch = async () => ({ ok: false, conflict: true, message: "CONFLICT in README.md" });
  ctx.runner.state.wait = () => ({ reason: "needs page-format.ts on main", conditions: [{ kind: "base_branch", target: "", paths: ["README.md"], description: "README on main" }] });
  // README.md exists already, so the condition holds at the first evaluation and the sync runs.
  const workId = await startWork(ctx, "conflict-wait", ctx.projectId);
  assert.ok(await until(() => ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting"), "the Work waits for the Owner");
  assert.equal(task(ctx.db, workId).status, "judgement_waiting");
  const expired = JSON.parse(ctx.db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.prerequisite_expired'", workId).payload_json);
  assert.equal(expired.kind, "sync_conflict");
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 1);
  assert.equal(ctx.runner.state.workerCalls, 1);
});

test("an expired deadline opens a Decision; the Task and the Work are judgement_waiting", async (t) => {
  const ctx = await openFixture(t, { settings: { prerequisite_max_wait_hours: 1 } });
  const condition = await openWorkCondition(ctx, "deadline");
  ctx.runner.state.wait = () => ({ reason: "needs the Owner", conditions: [condition] });
  const workId = await startWork(ctx, "deadline");
  assert.ok(await waitingFor(ctx.db, workId));
  await sleep(200);
  assert.equal(task(ctx.db, workId).status, "waiting", "not expired yet");
  ctx.clock.skewMs = 2 * 3_600_000;
  assert.ok(await until(() => ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting"));
  assert.equal(task(ctx.db, workId).status, "judgement_waiting");
  const expired = JSON.parse(ctx.db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.prerequisite_expired'", workId).payload_json);
  assert.equal(expired.kind, "deadline");
  const decisions = ctx.db.all("SELECT scope, issuer_role, reason, options_json FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].scope, "work");
  assert.equal(decisions[0].issuer_role, "core");
  assert.deepEqual(JSON.parse(decisions[0].options_json).map((option) => option.key).slice(0, 1), ["retry"]);
  assert.equal(eventCount(ctx.db, workId, "decision.opened"), 1, "announced once");
  assert.equal(ctx.runner.state.workerCalls, 1);
});

test("a target that is cancelled makes the wait unreachable: Decision, no Worker", async (t) => {
  const ctx = await openFixture(t);
  const other = await startGatedOtherWork(ctx);
  ctx.runner.state.wait = () => ({ reason: "needs the other Task", conditions: [{ kind: "task", target: other.taskId, paths: [], description: "other Task completes" }] });
  const workId = await startWork(ctx, "unreachable");
  assert.ok(await waitingFor(ctx.db, workId));
  await ctx.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", other.taskId);
    return null;
  });
  ctx.clock.skewMs = 120_000;
  assert.ok(await until(() => ctx.db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting"));
  assert.equal(task(ctx.db, workId).status, "judgement_waiting");
  const expired = JSON.parse(ctx.db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.prerequisite_expired'", workId).payload_json);
  assert.equal(expired.kind, "unreachable");
  assert.equal(ctx.runner.state.workerCalls, 1);
  other.release();
});

test("the Owner resumes an owner wait: mark cleared, count 0, the message reaches the Worker, repeat is idempotent", async (t) => {
  const ctx = await openFixture(t);
  const condition = await openWorkCondition(ctx, "owner-resume");
  ctx.runner.state.wait = () => ({ reason: "needs the Owner", conditions: [condition] });
  const workId = await startWork(ctx, "owner-resume");
  assert.ok(await waitingFor(ctx.db, workId));
  ctx.clock.skewMs = 600_000;
  await sleep(300);
  assert.equal(task(ctx.db, workId).status, "waiting", "an owner condition never resolves by itself");
  assert.equal(task(ctx.db, workId).no_progress_count, 1);

  const taskId = task(ctx.db, workId).id;
  const key = `resume:${createUlid()}`;
  const response = await ctx.core.resumePrerequisiteWait(taskId, { message: "Go ahead, main has it now.", idempotencyKey: key, actor: "owner" });
  assert.equal(response.data.resumed, true);
  assert.ok(await until(() => ctx.runner.state.workerCalls >= 2), "the Worker started again");
  assert.match(ctx.runner.state.contexts[1], /Go ahead, main has it now\./, "the message is owner guidance for the Worker");
  assert.doesNotMatch(ctx.runner.state.contexts[0], /Go ahead/);
  assert.ok(await until(() => task(ctx.db, workId).status === "completed"));
  assert.equal(task(ctx.db, workId).no_progress_count, 0);
  assert.equal(task(ctx.db, workId).prerequisite_json, null);
  const resumed = JSON.parse(ctx.db.get("SELECT payload_json FROM events WHERE task_id = ? AND type = 'task.prerequisite_resumed'", taskId).payload_json);
  assert.deepEqual({ message: resumed.message, actor: resumed.actor }, { message: "Go ahead, main has it now.", actor: "owner" });

  const again = await ctx.core.resumePrerequisiteWait(taskId, { message: "Go ahead, main has it now.", idempotencyKey: key, actor: "owner" });
  assert.deepEqual(again.data, response.data, "the same key returns the same result");
  assert.equal(eventCount(ctx.db, workId, "task.prerequisite_resumed"), 1);
});

test("resumePrerequisiteWait rejects a Task that does not wait on a prerequisite", async (t) => {
  const ctx = await openFixture(t);
  const workId = await startWork(ctx, "not-waiting");
  const taskId = await until(() => ctx.db.get("SELECT id FROM tasks WHERE work_id = ?", workId)?.id);
  await assert.rejects(
    () => ctx.core.resumePrerequisiteWait(taskId, { message: null, idempotencyKey: `resume:${createUlid()}`, actor: "owner" }),
    (error) => error.code === "invalid_state_transition",
  );
  await assert.rejects(
    () => ctx.core.resumePrerequisiteWait("no-such-task", { message: null, idempotencyKey: `resume:${createUlid()}`, actor: "owner" }),
    (error) => error.code === "not_found" || /not found/i.test(error.message),
  );
});

test("completions of different Tasks of one Work each wake the waiter without waiting for the interval", async (t) => {
  const ctx = await openFixture(t, { settings: { prerequisite_check_interval_seconds: 3600 } });
  const other = await startGatedOtherWork(ctx);
  const secondId = createUlid();
  await ctx.db.createWriteLane().transact((tx) => {
    tx.run("CREATE TEMP TABLE second_task AS SELECT * FROM tasks WHERE id = ?", other.taskId);
    tx.run("UPDATE second_task SET id = ?, status = 'running'", secondId);
    tx.run("INSERT INTO tasks SELECT * FROM second_task");
    tx.run("DROP TABLE second_task");
    return null;
  });
  ctx.runner.state.wait = () => ({
    reason: "needs both Tasks",
    conditions: [
      { kind: "task", target: secondId, paths: [], description: "second completes" },
      { kind: "task", target: other.taskId, paths: [], description: "first completes" },
    ],
  });
  const workId = await startWork(ctx, "two-task-wait");
  assert.ok(await waitingFor(ctx.db, workId));
  const complete = (id) => ctx.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'completed' WHERE id = ?", id);
    return null;
  });
  await complete(secondId);
  ctx.core.wakePrerequisiteWaiters(other.workId, false);
  await sleep(300);
  assert.equal(ctx.runner.state.workerCalls, 1, "one of two conditions holds");
  await complete(other.taskId);
  ctx.core.wakePrerequisiteWaiters(other.workId, false);
  assert.ok(await until(() => ctx.runner.state.workerCalls >= 2), "the second completion woke the waiter (interval is 1h)");
  assert.equal(eventCount(ctx.db, workId, "task.prerequisite_satisfied"), 1);
  other.release();
});

for (const [name, result, expectDecision] of [
  ["conflict", { ok: false, conflict: true, message: "CONFLICT in README.md" }, true],
  ["failure", { ok: false, conflict: false, message: "git exploded" }, false],
]) {
  test(`an Owner resume whose base sync hits a ${name} keeps the wait and starts no Worker`, async (t) => {
    const ctx = await openFixture(t, { withProject: true });
    const condition = await openWorkCondition(ctx, `resume-sync-${name}`);
    ctx.runner.state.wait = () => ({ reason: "needs the Owner and base", conditions: [
      condition,
      { kind: "base_branch", target: "", paths: ["src/never.ts"], description: "never lands" },
    ] });
    const workId = await startWork(ctx, `resume-sync-${name}`, ctx.projectId);
    assert.ok(await waitingFor(ctx.db, workId));
    ctx.core.gitGateway().mergeBaseIntoWorkBranch = async () => result;
    const taskId = task(ctx.db, workId).id;
    await assert.rejects(
      () => ctx.core.resumePrerequisiteWait(taskId, { message: "go", idempotencyKey: `resume:${createUlid()}`, actor: "owner" }),
      (error) => error.code === "invalid_state_transition",
    );
    await sleep(200);
    assert.equal(ctx.runner.state.workerCalls, 1);
    assert.equal(eventCount(ctx.db, workId, "task.prerequisite_resumed"), 0);
    if (expectDecision) {
      assert.equal(task(ctx.db, workId).status, "judgement_waiting");
      assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 1);
    } else {
      assert.equal(task(ctx.db, workId).status, "waiting");
      assert.notEqual(task(ctx.db, workId).prerequisite_json, null);
    }
  });
}
