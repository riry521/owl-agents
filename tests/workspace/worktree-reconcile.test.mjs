import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { reconcileWorktrees } from "../../packages/core/dist/index.js";
import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";
import { git } from "../helpers/git.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

async function projectRepo(parent) {
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  return project;
}

function fakeDatabase(parent, project) {
  return {
    get(sql) {
      if (sql.includes("SELECT project_id FROM works")) return { project_id: "project-1" };
      if (sql.includes("FROM projects")) return { canonical_path: project, base_branch: "main", allowed_roots_json: JSON.stringify([parent]) };
      return undefined;
    },
  };
}

function noProject() {
  return { get: () => undefined };
}

// --- Gateway-level behavior ------------------------------------------------

test("discardTaskWorktree commits uncommitted changes to the Task branch and removes the worktree", async (t) => {
  const parent = await tempDir(t, "owl-discard-");
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot);

  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(prepared.ok, true, prepared.message);
  await writeFile(join(prepared.worktree_path, "notes.txt"), "captured before discard\n");

  const result = await gateway.discardTaskWorktree({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });
  assert.equal(result.ok, true, result.message);
  await assert.rejects(access(prepared.worktree_path), "the worktree directory is removed");

  // The branch is never deleted, and it now carries the uncommitted change.
  const branches = git(project, "branch", "--list", "owl/task/W/T1");
  assert.match(branches, /owl\/task\/W\/T1/);
  assert.equal(git(project, "show", "owl/task/W/T1:notes.txt"), "captured before discard");
});

test("discardTaskWorktree reports a rejected preservation commit with its stderr", async (t) => {
  const parent = await tempDir(t, "owl-discard-commit-failure-");
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));
  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  await writeFile(join(prepared.worktree_path, "notes.txt"), "keep this until it can be committed\n");
  await addRejectingSigner(project);

  const result = await gateway.discardTaskWorktree({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });

  assert.equal(result.ok, false);
  assert.equal(result.failure_kind, "commit_failure");
  assert.match(result.stderr_tail, /blocked by test signer/);
  assert.match(result.message, /blocked by test signer/);
  await access(prepared.worktree_path);
});

test("discardTaskWorktree is a no-op when the worktree is already gone", async (t) => {
  const parent = await tempDir(t, "owl-discard-absent-");
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));

  const result = await gateway.discardTaskWorktree({ work_id: "W", task_id: "never-prepared", worktree_path: null });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.recorded, false);
});

test("discardTaskWorktree retains a Project-less Task's isolated workspace", async (t) => {
  const parent = await tempDir(t, "owl-discard-noproject-");
  const owlRoot = join(parent, "owl");
  const gateway = new GitWorktreeGateway(noProject(), owlRoot);

  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(prepared.ok, true, prepared.message);
  await writeFile(join(prepared.worktree_path, "artifact.txt"), "keep me\n");

  const result = await gateway.discardTaskWorktree({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });
  assert.equal(result.ok, true, result.message);
  assert.equal(await readFile(join(prepared.worktree_path, "artifact.txt"), "utf8"), "keep me\n");
});

test("removeIntegrationWorktree removes a Work's integration worktree after a Task merges into it, keeping the Work branch", async (t) => {
  const parent = await tempDir(t, "owl-remove-integration-");
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot);

  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  await writeFile(join(prepared.worktree_path, "feature.txt"), "from T1\n");
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
  const integrationPath = join(owlRoot, ".owl-workspaces", "W", "__work__");
  await access(integrationPath); // still present right after a merge

  const removal = await gateway.removeIntegrationWorktree({ work_id: "W" });
  assert.equal(removal.ok, true, removal.message);
  await assert.rejects(access(integrationPath), "the integration worktree is removed");
  assert.equal(git(project, "show", "owl/work/W/work:feature.txt"), "from T1");
});

test("listWorkspaces lists Task and integration directories and excludes the Advisor workspace", async (t) => {
  const parent = await tempDir(t, "owl-list-workspaces-");
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot);

  await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  const other = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  await gateway.integrateTask({ work_id: "W", task_id: "T2", worktree_path: other.worktree_path });
  await mkdir(join(owlRoot, ".owl-workspaces", "advisor", "conv-1"), { recursive: true });

  const entries = await gateway.listWorkspaces();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.deepEqual(byPath.get(join(owlRoot, ".owl-workspaces", "W", "T1")), {
    work_id: "W", task_id: "T1", path: join(owlRoot, ".owl-workspaces", "W", "T1"),
  });
  assert.deepEqual(byPath.get(join(owlRoot, ".owl-workspaces", "W", "__work__")), {
    work_id: "W", task_id: null, path: join(owlRoot, ".owl-workspaces", "W", "__work__"),
  });
  assert.equal([...byPath.keys()].some((path) => path.includes("advisor")), false, "the advisor workspace is excluded");
});

// --- Reconciler behavior -----------------------------------------------

async function reconcileFixture(t) {
  const { root: parent, db } = await openTestDatabase(t, { prefix: "owl-reconcile-" });
  const projectPath = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  await mkdir(owlRoot, { recursive: true });
  const writeLane = db.createWriteLane();
  const gateway = new GitWorktreeGateway(db, owlRoot);
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    tx.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, '[]', '[]', ?, ?)`,
      "project:1", "owner:default", "Project", projectPath, JSON.stringify([parent]), now, now,
    );
  });
  return { parent, projectPath, owlRoot, db, writeLane, gateway };
}

async function insertWork(writeLane, id, { projectId = "project:1", state = "running" } = {}) {
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', ?, 'Work', 'x', 'normal', ?, '[]', '[]', ?, ?)`,
      id, projectId, state, now, now,
    );
  });
}

async function insertTask(writeLane, id, workId, { status, worktreeState = null, worktreePath = null, workerGeneration = 0 }) {
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO tasks
         (id, work_id, title, type, status, priority, context, acceptance,
          worker_generation, worktree_path, worktree_state, created_at, updated_at)
       VALUES (?, ?, 'Task', 'code', ?, 'normal', '', 'Done.', ?, ?, ?, ?, ?)`,
      id, workId, status, workerGeneration, worktreePath, worktreeState, now, now,
    );
  });
}

async function addRejectingSigner(projectPath) {
  // A repository-local signing program that always fails makes every commit fail.
  const program = join(projectPath, ".git", "reject-signing.sh");
  await writeFile(program, "#!/bin/sh\nprintf '%s\\n' 'blocked by test signer' >&2\nexit 1\n");
  await chmod(program, 0o755);
  git(projectPath, "config", "gpg.program", program);
  git(projectPath, "config", "commit.gpgsign", "true");
}

async function recordMergedCompletion(writeLane, db, workId) {
  const now = new Date().toISOString();
  const sequence = db.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events").next;
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, created_at)
       VALUES (?, ?, ?, 'work.completed', ?, ?, 'handled', ?)`,
      createUlid(), sequence, `test-completed:${workId}`, workId,
      JSON.stringify({ work_id: workId, merge: { base_branch: "main", merge_commit: "a".repeat(40) } }), now,
    );
    return null;
  });
}

async function prepareMergedConflictWork({ projectPath, owlRoot, db, writeLane, gateway }, workId = "W") {
  await insertWork(writeLane, workId, { state: "completed" });
  const workBranch = `owl/work/${workId}/work`;
  git(projectPath, "branch", workBranch, "main");
  const task = await gateway.prepareWorktree({ work_id: workId, task_id: "cancelled-conflict" });
  assert.equal(task.ok, true, task.message);
  const integrationPath = join(owlRoot, ".owl-workspaces", workId, "__work__");
  await mkdir(dirname(integrationPath), { recursive: true });
  git(projectPath, "worktree", "add", integrationPath, workBranch);

  await mkdir(join(task.worktree_path, "docs", "designs"), { recursive: true });
  await writeFile(join(task.worktree_path, "docs", "designs", "x.md"), "staged content must be discarded after merge\n");
  git(task.worktree_path, "add", "docs/designs/x.md");
  await addRejectingSigner(projectPath);
  await insertTask(writeLane, "cancelled-conflict", workId, {
    status: "cancelled",
    worktreeState: "conflict_retained",
    worktreePath: task.worktree_path,
  });
  await recordMergedCompletion(writeLane, db, workId);
  return { taskWorktree: task.worktree_path, integrationPath, workDir: join(owlRoot, ".owl-workspaces", workId) };
}

async function insertActiveAgentRun(writeLane, id, workId, taskId) {
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'test', 'test', 'running', ?, ?)`,
      id, workId, taskId, now, now,
    );
  });
}

test("reconcileWorktrees discards a superseded Task's worktree, keeps its branch, and does nothing on a second pass", async (t) => {
  const { projectPath, db, writeLane, gateway } = await reconcileFixture(t);
  await insertWork(writeLane, "W", { state: "running" });
  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  await writeFile(join(prepared.worktree_path, "partial.txt"), "left uncommitted when superseded\n");

  await insertTask(writeLane, "T1", "W", { status: "cancelled", worktreeState: "active", worktreePath: prepared.worktree_path });

  const first = await reconcileWorktrees({ db, writeLane, git: gateway }, { work_id: "W", reason: "replan_applied" });
  assert.deepEqual(first, { discarded: ["T1"], skipped: [] });
  await assert.rejects(access(prepared.worktree_path));
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", "T1").worktree_state, "discarded");
  const events = db.all("SELECT type FROM events WHERE task_id = ?", "T1");
  assert.deepEqual(events.map((row) => row.type), ["task.worktree.discarded"]);
  assert.equal(git(projectPath, "show", "owl/task/W/T1:partial.txt"), "left uncommitted when superseded");

  const second = await reconcileWorktrees({ db, writeLane, git: gateway }, { work_id: "W", reason: "replan_applied" });
  assert.deepEqual(second, { discarded: [], skipped: [] });
  assert.equal(db.all("SELECT type FROM events WHERE task_id = ?", "T1").length, 1, "the event is recorded only once");
});

test("reconcileWorktrees leaves a non-terminal Task's worktree, and a terminal Task's worktree with an active agent run, untouched", async (t) => {
  const { db, writeLane, gateway } = await reconcileFixture(t);
  await insertWork(writeLane, "W", { state: "running" });
  const running = await gateway.prepareWorktree({ work_id: "W", task_id: "still-running" });
  const busy = await gateway.prepareWorktree({ work_id: "W", task_id: "cancelled-but-busy" });

  await insertTask(writeLane, "still-running", "W", { status: "running", worktreeState: "active", worktreePath: running.worktree_path });
  await insertTask(writeLane, "cancelled-but-busy", "W", { status: "cancelled", worktreeState: "active", worktreePath: busy.worktree_path });
  await insertActiveAgentRun(writeLane, "run:1", "W", "cancelled-but-busy");

  const result = await reconcileWorktrees({ db, writeLane, git: gateway }, { work_id: "W", reason: "work_cancelled" });
  assert.deepEqual(result, { discarded: [], skipped: ["cancelled-but-busy"] });
  await access(running.worktree_path);
  await access(busy.worktree_path);
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", "still-running").worktree_state, "active");
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", "cancelled-but-busy").worktree_state, "active");
});

test("reconcileWorktrees removes a completed Work's integration worktree while its Task branches remain", async (t) => {
  const { owlRoot, db, writeLane, gateway } = await reconcileFixture(t);
  await insertWork(writeLane, "W", { state: "completed" });
  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  await writeFile(join(prepared.worktree_path, "done.txt"), "merged\n");
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);

  await insertTask(writeLane, "T1", "W", { status: "completed", worktreeState: "merged", worktreePath: null });

  const integrationPath = join(owlRoot, ".owl-workspaces", "W", "__work__");
  await access(integrationPath);
  const result = await reconcileWorktrees({ db, writeLane, git: gateway, owlRoot, dataDir: join(owlRoot, "data") }, { work_id: "W", reason: "work_completed" });
  assert.deepEqual(result, { discarded: [], skipped: [] });
  await assert.rejects(access(integrationPath), "the integration worktree is removed");
});

test("a merged Work discards staged cancelled Task changes without committing them", async (t) => {
  const fixture = await reconcileFixture(t);
  const { projectPath, owlRoot, db, writeLane, gateway } = fixture;
  const paths = await prepareMergedConflictWork(fixture);

  const result = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir: join(owlRoot, "data") },
    { work_id: "W", reason: "work_completed" },
  );

  assert.deepEqual(result, { discarded: ["cancelled-conflict"], skipped: [] });
  await assert.rejects(access(paths.taskWorktree));
  await assert.rejects(access(paths.integrationPath));
  await assert.rejects(access(paths.workDir));
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", "cancelled-conflict").worktree_state, "discarded");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.worktree.discarded'", "cancelled-conflict").n, 1);

  const branches = await gateway.deleteMergedWorkBranches({ work_id: "W" });
  assert.equal(branches.ok, true, branches.message);
  assert.deepEqual(Object.keys(branches.deleted_branches).sort(), ["owl/task/W/cancelled-conflict", "owl/work/W/work"]);
  assert.equal(git(projectPath, "branch", "--list", "owl/*"), "");
});

test("startup discards every leftover of a completed merged Work before deleting its branches", async (t) => {
  const fixture = await reconcileFixture(t);
  const { projectPath, owlRoot, db, gateway } = fixture;
  const paths = await prepareMergedConflictWork(fixture);
  const { core } = await createTestCore(t, {
    db,
    owlRoot,
    git: gateway,
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed", message: "unexpected manager call" }),
      runWorker: async () => ({ outcome: "failed", message: "unexpected worker call" }),
      runReviewer: async () => ({ outcome: "failed", message: "unexpected reviewer call" }),
      runAdvisor: async () => ({ reply: "" }),
    },
    dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 },
  });

  try {
    await core.start();
    await disablePlanQuality(db);

    await assert.rejects(access(paths.taskWorktree));
    await assert.rejects(access(paths.integrationPath));
    await assert.rejects(access(paths.workDir));
    assert.equal(git(projectPath, "branch", "--list", "owl/*"), "");
    assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", "cancelled-conflict").worktree_state, "discarded");
    assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.worktree.discarded'", "cancelled-conflict").n, 1);
    const deleted = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", "W").payload_json);
    assert.deepEqual(Object.keys(deleted.deleted_branches).sort(), ["owl/task/W/cancelled-conflict", "owl/work/W/work"]);
  } finally {
    // The fixture closes the db before the Core's own cleanup runs, so the Core stops first here.
    await core.stop({ force: true });
  }
});

test("reconcileWorktrees removes a completed Work's now-empty directory once its Task and integration worktrees are gone", async (t) => {
  const { owlRoot, db, writeLane, gateway } = await reconcileFixture(t);
  await insertWork(writeLane, "W", { state: "completed" });
  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  await writeFile(join(prepared.worktree_path, "done.txt"), "merged\n");
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
  await insertTask(writeLane, "T1", "W", { status: "completed", worktreeState: "merged", worktreePath: null });

  const workDir = join(owlRoot, ".owl-workspaces", "W");
  await access(workDir); // only the integration worktree is left in it

  const result = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir: join(owlRoot, "data") },
    { work_id: "W", reason: "work_completed" },
  );
  assert.deepEqual(result, { discarded: [], skipped: [] });
  await assert.rejects(access(workDir), "the now-empty Work directory is removed");

  // A second pass finds nothing left (the directory is already gone); rmdir's
  // ENOENT is not reported as a failure.
  const second = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir: join(owlRoot, "data") },
    { work_id: "W", reason: "work_completed" },
  );
  assert.deepEqual(second, { discarded: [], skipped: [] });
});

test("reconcileWorktrees keeps a completed Work's directory while a busy Task's worktree still lives in it", async (t) => {
  const { owlRoot, db, writeLane, gateway } = await reconcileFixture(t);
  await insertWork(writeLane, "W", { state: "completed" });
  const busy = await gateway.prepareWorktree({ work_id: "W", task_id: "cancelled-but-busy" });
  await insertTask(writeLane, "cancelled-but-busy", "W", { status: "cancelled", worktreeState: "active", worktreePath: busy.worktree_path });
  await insertActiveAgentRun(writeLane, "run:1", "W", "cancelled-but-busy");

  const workDir = join(owlRoot, ".owl-workspaces", "W");
  const result = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir: join(owlRoot, "data") },
    { work_id: "W", reason: "work_completed" },
  );
  assert.deepEqual(result, { discarded: [], skipped: ["cancelled-but-busy"] });
  await access(busy.worktree_path);
  await access(workDir); // rmdir on a non-empty directory is a no-op, never a failure
});

test("a full-tree reconcile removes a terminal Work's now-empty directory at startup", async (t) => {
  const { owlRoot, db, writeLane, gateway } = await reconcileFixture(t);
  await insertWork(writeLane, "W", { state: "cancelled" });
  const ghost = await gateway.prepareWorktree({ work_id: "W", task_id: "ghost" });
  await access(ghost.worktree_path);

  const workDir = join(owlRoot, ".owl-workspaces", "W");
  const result = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir: join(owlRoot, "data") },
    { reason: "startup" },
  );
  assert.deepEqual(result, { discarded: ["ghost"], skipped: [] });
  await assert.rejects(access(workDir), "the now-empty Work directory is removed once its only worktree is gone");
});

test("a full-tree reconcile discards a worktree whose Task row no longer exists", async (t) => {
  const { db, writeLane, gateway } = await reconcileFixture(t);
  await insertWork(writeLane, "W", { state: "running" });
  const ghost = await gateway.prepareWorktree({ work_id: "W", task_id: "ghost" });
  await access(ghost.worktree_path);

  const result = await reconcileWorktrees({ db, writeLane, git: gateway }, { reason: "startup" });
  assert.deepEqual(result, { discarded: ["ghost"], skipped: [] });
  await assert.rejects(access(ghost.worktree_path));
  assert.equal(db.all("SELECT type FROM events").length, 0, "an orphaned Task with no row emits no event");
});

// --- Core wiring ---------------------------------------------------------

function workerReport(invocationId, changes) {
  return {
    kind: "report", schema_version: "1.0.0", invocation_id: invocationId, result: "success",
    work_done: "Done.", changes, verification: { passed: true, method: "Checked the result." }, remaining_issues: [], next_action: "none",
    needs_replanning: false, question_for_manager: null,
  };
}

test("a Work's integration worktree is removed once it completes through Core", async (t) => {
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Implement", type: "code", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [] },
        ] } },
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "code.mjs"), "export {};\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: "code.mjs", action: "added" }]) };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { root, db, core } = await createTestCore(t, {
    agentRunner,
    dispatcher: { tick_interval_ms: 25 },
  }, { prefix: "owl-reconcile-core-" });
  const project = await projectRepo(root);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    tx.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, '[]', '[]', ?, ?)`,
      "project:core", "owner:default", "Core", project, JSON.stringify([root]), now, now,
    );
  });

  await core.start();
  await disablePlanQuality(db);
  const created = await core.createWork(command({ title: "Reconcile", summary: "x", size: "normal", project_id: "project:core" }, "test:reconcile-core-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, command({ mode: "normal" }, "test:reconcile-core-start", created.version));

  await waitFor(() => {
    const work = db.get("SELECT state FROM works WHERE id = ?", workId);
    return work?.state === "completed" ? work : null;
  }, { timeoutMs: 15_000, message: "the Work to complete" });
  const integrationPath = join(root, ".owl-workspaces", workId, "__work__");
  const removed = await waitFor(async () => (await access(integrationPath).then(() => false, () => true)) ? true : null, { timeoutMs: 5_000, message: "the integration worktree to be removed" });
  assert.equal(removed, true, "the integration worktree is removed once the Work completes");
  const deleted = await waitFor(() => db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", workId), { timeoutMs: 15_000, message: "the branches-deleted event" });
  const workCommit = JSON.parse(deleted.payload_json).deleted_branches[`owl/work/${workId}/work`];
  assert.ok(workCommit);
  assert.equal(git(project, "show", `${workCommit}:code.mjs`), "export {};");
});

test("a full-tree reconcile leaves a Task worktree of a Work this database has no row for", async (t) => {
  const { db, writeLane, gateway } = await reconcileFixture(t);
  await insertWork(writeLane, "W", { state: "running" });
  const foreign = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(foreign.ok, true, foreign.message);
  await writeLane.transact((tx) => {
    tx.run("DELETE FROM works WHERE id = 'W'");
  });

  const result = await reconcileWorktrees({ db, writeLane, git: gateway }, { reason: "startup" });
  assert.deepEqual(result, { discarded: [], skipped: [] });
  await access(foreign.worktree_path);
});

test("Core reconcile does not report a workspace of a Work this database has no row for", async (t) => {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-reconcile-foreign-" });
  const project = await projectRepo(root);
  const { core } = await createTestCore(t, { db, owlRoot: join(root, "owl") });

  const foreignGateway = new GitWorktreeGateway(fakeDatabase(root, project), join(root, "owl"));
  const foreign = await foreignGateway.prepareWorktree({ work_id: "FOREIGN", task_id: "T1" });
  assert.equal(foreign.ok, true, foreign.message);

  const outcome = await core.runWorktreeReconcile(undefined, "startup");
  assert.equal(outcome.verified, true);
  assert.deepEqual(outcome.failures, []);
  await access(foreign.worktree_path);
});
