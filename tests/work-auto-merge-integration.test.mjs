import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}:${createUlid()}`,
    expected_version: expectedVersion,
    payload,
  };
}

function workerReport(invocationId) {
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
  };
}

function managerComplete(request) {
  return {
    outcome: "success",
    report_valid: true,
    report: {
      tasks: request.tasks ?? [],
      event: null,
      verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] },
    },
  };
}

async function waitFor(read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value || Date.now() >= deadline) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

async function openFixture(t, { verificationPlan = [], beforeFinalize = async () => {}, onWorker = async () => {} } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-work-auto-merge-")));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? (await beforeFinalize(request), managerComplete(request))
      : { outcome: "failed", message: `Unexpected Manager mode: ${request.mode}` },
    runWorker: async (request) => {
      await onWorker(request);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async (request) => ({
      outcome: "success",
      report_valid: true,
      report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({
    db,
    agentRunner,
    version: "test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await core.start();

  const project = join(root, "project");
  await mkdir(project);
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base version\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");

  const registered = await core.createProject(commandEnvelope({
    name: "Auto merge integration project",
    canonical_path: project,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: verificationPlan,
  }, "project"));
  const mergeCalls = [];
  const gateway = core.gitGateway();
  const mergeWorkIntoBase = gateway.mergeWorkIntoBase.bind(gateway);
  gateway.mergeWorkIntoBase = async (request) => {
    mergeCalls.push(request.work_id);
    return mergeWorkIntoBase(request);
  };
  return { root, project, db, core, projectId: registered.data.id, mergeCalls };
}

async function startSmallWork(core, projectId, suffix) {
  const created = await core.createWork(commandEnvelope({
    title: `Auto merge ${suffix}`,
    summary: "Write the requested output file.",
    size: "small",
    project_id: projectId,
  }, `${suffix}-create`));
  await core.startWork(created.data.work_id, commandEnvelope({ mode: "small" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

async function waitForTerminalDecision(db, workId) {
  const state = await waitFor(() => {
    const value = db.get("SELECT state FROM works WHERE id = ?", workId)?.state;
    return value === "completed" || value === "judgement_waiting" ? value : null;
  });
  assert.ok(state, `Work reached completion or judgement_waiting (state=${db.get("SELECT state FROM works WHERE id = ?", workId)?.state})`);
  return state;
}

test("Core auto-merges a completed Project Work into main and cleans its integration worktree and branch", async (t) => {
  const { project, db, core, projectId, mergeCalls } = await openFixture(t, {
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.txt"), "feature from Core\n"),
  });
  const oldMain = git(project, "rev-parse", "refs/heads/main");
  const workId = await startSmallWork(core, projectId, "success");
  const integrationPath = join(dirname(project), ".owl-workspaces", workId, "__work__");

  const workState = await waitForTerminalDecision(db, workId);
  assert.equal(workState, "completed", JSON.stringify({
    alert: db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence DESC LIMIT 1", workId),
    decision: db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId),
    task: db.get("SELECT status, worktree_path, last_error_key FROM tasks WHERE work_id = ?", workId),
  }));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.deepEqual(mergeCalls, [workId]);
  assert.notEqual(git(project, "rev-parse", "refs/heads/main"), oldMain);
  assert.equal(git(project, "show", "main:feature.txt"), "feature from Core");
  assert.match(git(project, "log", "main", "--format=%s"), /owl: complete task /u);
  const mergeCommit = git(project, "rev-parse", "refs/heads/main");
  assert.deepEqual(git(project, "log", "--first-parent", "--format=%H", "-2", "main").split("\n"), [mergeCommit, oldMain]);
  assert.equal(git(project, "rev-parse", "main^1"), oldMain);

  const cleanupComplete = await waitFor(() =>
    !existsSync(integrationPath) && git(project, "branch", "--list", `owl/work/${workId}/work`) === "",
  );
  assert.equal(cleanupComplete, true, "Core removes the integration worktree and Work branch after completion");
  assert.equal(git(project, "worktree", "list", "--porcelain").includes(integrationPath), false);
  assert.equal(git(project, "branch", "--list", `owl/work/${workId}/work`), "");
  assert.equal(await waitFor(() => git(project, "branch", "--list", "owl/*") === ""), true);
  assert.ok(await waitFor(() => db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", workId)));
  assert.equal(existsSync(join(dirname(project), ".owl-workspaces", workId)), false);
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE work_id = ?", workId).worktree_state, "merged");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.worktree.discarded'", workId).n, 0);
});

test("Core completion discards a merged Work's leftover worktree past a rejecting pre-commit hook and deletes its branches", async (t) => {
  let workId;
  let leftoverPath;
  const { project, db, core, projectId } = await openFixture(t, {
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.txt"), "feature from Core\n"),
    beforeFinalize: async () => {
      const leftover = await core.gitGateway().prepareWorktree({ work_id: workId, task_id: "cancelled-leftover" });
      assert.equal(leftover.ok, true, leftover.message);
      leftoverPath = leftover.worktree_path;
      await mkdir(join(leftoverPath, "docs", "designs"), { recursive: true });
      await writeFile(join(leftoverPath, "docs", "designs", "x.md"), "staged content the hook rejects\n");
      git(leftoverPath, "add", "docs/designs/x.md");
      const hookPath = join(project, ".git", "hooks", "pre-commit");
      await writeFile(hookPath, "#!/bin/sh\nprintf '%s\\n' 'blocked by test pre-commit hook' >&2\nexit 1\n");
      await chmod(hookPath, 0o755);
      const now = new Date().toISOString();
      await db.createWriteLane().transact((tx) => {
        tx.run(
          `INSERT INTO tasks
             (id, work_id, title, type, status, priority, context, acceptance,
              worker_generation, worktree_path, worktree_state, created_at, updated_at)
           VALUES (?, ?, 'Leftover', 'code', 'cancelled', 'normal', '', 'Done.', 0, ?, 'conflict_retained', ?, ?)`,
          "cancelled-leftover", workId, leftoverPath, now, now,
        );
        return null;
      });
    },
  });
  workId = await startSmallWork(core, projectId, "hook-leftover");

  assert.equal(await waitForTerminalDecision(db, workId), "completed");
  assert.ok(await waitFor(() => db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", workId)));
  assert.equal(git(project, "branch", "--list", "owl/*"), "");
  assert.equal(existsSync(leftoverPath), false);
  assert.equal(existsSync(join(dirname(project), ".owl-workspaces", workId)), false);
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", "cancelled-leftover").worktree_state, "discarded");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert'", workId).n, 0);
});

test("Core leaves a conflicting Project Work waiting, preserves main, and aborts the integration merge", async (t) => {
  let mainBeforeMerge;
  const { project, db, core, projectId, mergeCalls } = await openFixture(t, {
    onWorker: async (request) => writeFile(join(request.context.worktree, "README.md"), "Work version\n"),
    beforeFinalize: async () => {
      await writeFile(join(project, "README.md"), "conflicting main version\n");
      git(project, "add", "README.md");
      git(project, "commit", "-m", "conflicting main edit");
      mainBeforeMerge = git(project, "rev-parse", "refs/heads/main");
    },
  });
  const workId = await startSmallWork(core, projectId, "conflict");

  assert.equal(await waitForTerminalDecision(db, workId), "judgement_waiting");
  assert.deepEqual(mergeCalls, [workId]);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), mainBeforeMerge);
  assert.equal(git(project, "show", "main:README.md"), "conflicting main version");
  assert.notEqual(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");

  const decision = db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision);
  assert.match(decision.reason, /README\.md/u);
  const alert = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence DESC LIMIT 1", workId);
  const payload = JSON.parse(alert.payload_json);
  assert.equal(payload.kind, "work_merge_failed");
  assert.equal(payload.merge_kind, "conflict");
  assert.deepEqual(payload.conflicting_files, ["README.md"]);

  const integrationPath = join(dirname(project), ".owl-workspaces", workId, "__work__");
  assert.ok(git(project, "worktree", "list", "--porcelain").includes(integrationPath));
  for (const worktree of [project, integrationPath]) {
    const gitDir = git(worktree, "rev-parse", "--git-dir");
    const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(worktree, gitDir);
    assert.equal(existsSync(join(absoluteGitDir, "MERGE_HEAD")), false, `no MERGE_HEAD in ${absoluteGitDir}`);
  }
});

test("Core keeps main unchanged and opens a Decision when Project verification fails", async (t) => {
  const verificationPlan = [{
    command_id: "fail-check",
    argv: ["node", "-e", "const failed = process.cwd().endsWith('__work__'); if (failed) console.error('verification failed'); process.exit(failed ? 7 : 0)"],
    cwd: ".",
    env_allowlist: [],
    timeout_seconds: 15,
    stdout_limit: 1_024,
    stderr_limit: 1_024,
    expected_exit_codes: [0],
    executor: "core",
  }];
  const { project, db, core, projectId, mergeCalls } = await openFixture(t, {
    verificationPlan,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.txt"), "feature from Core\n"),
  });
  const oldMain = git(project, "rev-parse", "refs/heads/main");
  const workId = await startSmallWork(core, projectId, "verification-failed");

  assert.equal(await waitForTerminalDecision(db, workId), "judgement_waiting");
  assert.deepEqual(mergeCalls, [workId]);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldMain);
  assert.notEqual(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  const decision = db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision);
  assert.match(decision.reason, /fail-check/u);
  assert.match(decision.reason, /verification failed/u);
  const alert = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence DESC LIMIT 1", workId);
  const payload = JSON.parse(alert.payload_json);
  assert.equal(payload.kind, "work_merge_failed");
  assert.equal(payload.merge_kind, "verification_failed");
});

test("Core skips Project merge for a Project-less Work while saving outputs and removing its workspace", async (t) => {
  const { root, project, db, core, mergeCalls } = await openFixture(t, {
    onWorker: async (request) => {
      await mkdir(join(request.context.worktree, "out"), { recursive: true });
      await writeFile(join(request.context.worktree, "out", "result.txt"), "saved without a Project\n");
    },
  });
  const oldMain = git(project, "rev-parse", "refs/heads/main");
  const worktreesBefore = git(project, "worktree", "list", "--porcelain");
  const branchesBefore = git(project, "branch", "--list");
  const workId = await startSmallWork(core, null, "projectless");

  assert.equal(await waitForTerminalDecision(db, workId), "completed");
  assert.deepEqual(mergeCalls, []);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldMain);
  assert.equal(git(project, "worktree", "list", "--porcelain"), worktreesBefore);
  assert.equal(git(project, "branch", "--list"), branchesBefore);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type LIKE '%merge%'", workId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND payload_json LIKE '%work_merge_%'", workId).n, 0);
  // Outputs are saved by the worktree reconciler after the Work completes.
  const outputPath = join(root, "data", "outputs", workId, "out", "result.txt");
  assert.ok(await waitFor(() => existsSync(outputPath) && !existsSync(join(root, ".owl-workspaces", workId))), "outputs saved and workspace removed");
  assert.equal(await readFile(outputPath, "utf8"), "saved without a Project\n");
});
