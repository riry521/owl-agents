import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { NoopGitGateway } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}`, expectedVersion);
}

/** Build a Core (on a new db and root, or on the given ones for a restart) with a fast dispatcher tick. */
function createCore(t, agentRunner, git, { db, owlRoot, dispatcher = {} } = {}) {
  return createTestCore(t, { agentRunner, git, db, owlRoot, dispatcher: { tick_interval_ms: 25, ...dispatcher } }, { prefix: "owl-integration-repair-" });
}

function insertProject(transaction, id) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO owners (id, display_name, created_at, updated_at)
     VALUES ('owner:default', 'Test Owner', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    now, now,
  );
  transaction.run(
    `INSERT INTO projects
       (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
     VALUES (?, 'owner:default', ?, ?, 'main', '[]', '[]', '[]', ?, ?)`,
    id, id, `/tmp/owl-fake-project-${id}`, now, now,
  );
}

function insertTask(transaction, workId, {
  id, status, managerTaskId, title, type = "code", reviewOverride = null,
  worktreeState = null, worktreePath = null, reviewRound = 0,
}) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO tasks
       (id, work_id, title, type, status, review_override, priority, context, acceptance,
        state_version, failure_count, same_error_count, review_round, worker_generation,
        created_at, updated_at, retry_no, manager_task_id, worktree_state, worktree_path)
     VALUES (?, ?, ?, ?, ?, ?, 'normal', '', 'Done.', 0, 0, 0, ?, 0, ?, ?, 0, ?, ?, ?)`,
    id, workId, title, type, status, reviewOverride, reviewRound, now, now, managerTaskId, worktreeState, worktreePath,
  );
}

function insertAgentRun(transaction, workId, taskId, { id, role, status = "running" }) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO agent_runs
       (id, work_id, task_id, role, provider, model, status, pid, process_start_time, process_cmdline_sha256, fencing_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', 'test', ?, NULL, NULL, NULL, ?, ?, ?)`,
    id, workId, taskId, role, status, id, now, now,
  );
}

async function createRunningWork(core, db, suffix, projectId = null) {
  const created = await core.createWork(commandEnvelope({ title: `Repair ${suffix}`, summary: "x", size: "normal", project_id: projectId }, `${suffix}-create`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
  });
  return workId;
}

function workerReport(invocationId, extra = {}) {
  return {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Done.",
    changes: [],
    verification: { passed: true, method: "Checked the result." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
    ...extra,
  };
}

const noopAgentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unexpected manager call" }),
  runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "test_stop", retry_allowed: true, message: "stop here" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

/** A controllable GitGateway: which Task branches are already merged is set per test, and every integrateTask/removeWorktree call is recorded. */
class FakeGit extends NoopGitGateway {
  constructor() {
    super();
    this.merged = new Map();
    this.integrateTaskCalls = [];
    this.removeWorktreeCalls = [];
  }
  async prepareWorktree(request) {
    const worktree_path = join(tmpdir(), "owl-fake-git-worktrees", request.task_id ?? "work");
    await mkdir(worktree_path, { recursive: true });
    return { ...(await super.prepareWorktree(request)), worktree_path };
  }
  async taskBranchMerged(request) {
    if (!request.task_id) return null;
    return this.merged.has(request.task_id) ? this.merged.get(request.task_id) : null;
  }
  async integrateTask(request) {
    this.integrateTaskCalls.push(request);
    return super.integrateTask(request);
  }
  async removeWorktree(request) {
    this.removeWorktreeCalls.push(request);
    return super.removeWorktree(request);
  }
}

test("a verifying Task without review whose branch is already merged completes on startup without relaunching a Worker", async (t) => {
  const git = new FakeGit();
  const { db, core } = await createCore(t, noopAgentRunner, git);
  const workId = await createRunningWork(core, db, "verify-no-review");
  const taskId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: taskId, status: "verifying", managerTaskId: "T1", title: "No review", type: "doc", worktreeState: "active" });
  });
  git.merged.set(taskId, true);

  await core.start();

  const task = db.get("SELECT status, worktree_state FROM tasks WHERE id = ?", taskId);
  assert.equal(task.status, "completed");
  assert.equal(task.worktree_state, "merged");
  assert.ok(
    db.get("SELECT 1 AS found FROM events WHERE type = 'verification.completed' AND task_id = ? AND idempotency_key = ?", taskId, `startup-integration:${taskId}`),
    "the repair is recorded as a normal verification.completed event",
  );
  assert.equal(
    db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = ?", taskId).count,
    0,
    "no Worker or Reviewer run is ever created for a Task repaired straight to completed",
  );
  assert.ok(git.removeWorktreeCalls.some((call) => call.task_id === taskId));
});

test("a verifying Task with review whose branch is already merged completes on startup and its orphaned Reviewer run is closed as failed", async (t) => {
  const git = new FakeGit();
  const { db, core } = await createCore(t, noopAgentRunner, git);
  const workId = await createRunningWork(core, db, "verify-review");
  const taskId = createUlid();
  const reviewerRunId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: taskId, status: "verifying", managerTaskId: "T1", title: "Needs review", type: "code", worktreeState: "active" });
    insertAgentRun(transaction, workId, taskId, { id: reviewerRunId, role: "reviewer" });
  });
  git.merged.set(taskId, true);

  await core.start();

  const task = db.get("SELECT status, worktree_state FROM tasks WHERE id = ?", taskId);
  assert.equal(task.status, "completed");
  assert.equal(task.worktree_state, "merged");
  assert.ok(
    db.get("SELECT 1 AS found FROM events WHERE type = 'review.passed' AND task_id = ? AND idempotency_key = ?", taskId, `startup-integration:${taskId}`),
  );
  assert.equal(
    db.get("SELECT status FROM agent_runs WHERE id = ?", reviewerRunId).status,
    "failed",
    "the crashed Reviewer's own run is closed out by the ordinary orphan sweep, not left running or marked completed",
  );
  assert.ok(git.removeWorktreeCalls.some((call) => call.task_id === taskId));
});

test("a completed Task whose worktree is still marked active is repaired on startup, and a later restart does not repeat it", async (t) => {
  const git = new FakeGit();
  const { root, db, core } = await createCore(t, noopAgentRunner, git);

  const projectId = createUlid();
  await db.createWriteLane().transact((transaction) => insertProject(transaction, projectId));
  const noProjectWorkId = await createRunningWork(core, db, "repair-no-project", null);
  const projectWorkId = await createRunningWork(core, db, "repair-project", projectId);

  const retainedTaskId = createUlid();
  const mergedTaskId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, noProjectWorkId, { id: retainedTaskId, status: "completed", managerTaskId: "T1", title: "No project", type: "test", worktreeState: "active" });
    insertTask(transaction, projectWorkId, { id: mergedTaskId, status: "completed", managerTaskId: "T1", title: "Has project", type: "test", worktreeState: "active" });
  });
  git.merged.set(mergedTaskId, true);

  await core.start();

  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", retainedTaskId).worktree_state, "retained");
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", mergedTaskId).worktree_state, "merged");
  assert.ok(git.removeWorktreeCalls.some((call) => call.task_id === mergedTaskId));

  const repairEventCount = () => db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'task.worktree_repaired'").count;
  assert.equal(repairEventCount(), 2, "exactly one repair event per Task");

  await core.stop({ force: true });
  const { core: secondCore } = await createCore(t, noopAgentRunner, git, { db, owlRoot: root });
  try {
    await secondCore.start();
    assert.equal(repairEventCount(), 2, "a later restart does not repeat a repair once worktree_state has moved on");
  } finally {
    // The first Core's cleanup closes the db, so the restarted Core must stop before that.
    await secondCore.stop({ force: true });
  }
});

test("integrateTask reuses an already-merged Task branch instead of merging it again", async (t) => {
  const git = new FakeGit();
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "unexpected manager call" }),
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "out.test.mjs"), "export {};\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "success", report_valid: true, report: { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } }, review: { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createCore(t, agentRunner, git, { dispatcher: { tick_interval_ms: 25 } });

  const projectId = createUlid();
  await db.createWriteLane().transact((transaction) => insertProject(transaction, projectId));
  const workId = await createRunningWork(core, db, "already-merged", projectId);
  const taskId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: taskId, status: "ready", managerTaskId: "T1", title: "Already merged", type: "test" });
  });
  git.merged.set(taskId, true);

  await core.start();

  const task = await waitFor(() => {
    const row = db.get("SELECT status, worktree_state FROM tasks WHERE id = ?", taskId);
    return row.status === "completed" ? row : undefined;
  }, { timeoutMs: 5_000, message: "the Task to complete" });
  assert.equal(task.worktree_state, "merged");
  assert.equal(git.integrateTaskCalls.length, 0, "an already-merged Task branch is not merged again");
  assert.ok(git.removeWorktreeCalls.some((call) => call.task_id === taskId));
});
