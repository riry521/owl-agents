import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { waitFor } from "../helpers/wait.mjs";

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
}

test("completing a merged Work deletes every Owl branch of the Work and its workspace directory", async (t) => {
  const { root, db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async (request) => ({
        outcome: "success",
        report_valid: true,
        report: {
          tasks: request.tasks ?? [],
          event: null,
          verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] },
        },
      }),
      runWorker: async () => ({ outcome: "failed", message: "unexpected worker call" }),
      runReviewer: async () => ({ outcome: "failed", message: "unexpected reviewer call" }),
      runAdvisor: async () => ({ reply: "" }),
    },
    dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-merge-branch-cleanup-", start: true });

  const project = join(root, "project");
  await mkdir(project);
  git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const oldMain = git(project, "rev-parse", "main");
  const registered = await core.createProject(commandEnvelope({
    name: "Branch cleanup project",
    canonical_path: project,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, "project"));
  const created = await core.createWork(commandEnvelope({
    title: "Branch cleanup",
    summary: "Integrate two Tasks after one failed attempt.",
    size: "normal",
    project_id: registered.data.id,
  }, "work"));
  const workId = created.data.work_id;
  const gateway = core.gitGateway();

  const integrated = createUlid();
  const failed = createUlid();
  const retried = createUlid();
  for (const [taskId, file] of [[integrated, "first.txt"], [retried, "retry.txt"]]) {
    const task = await gateway.prepareWorktree({ work_id: workId, task_id: taskId });
    assert.equal(task.ok, true, task.message);
    await writeFile(join(task.worktree_path, file), `${file}\n`);
    const result = await gateway.integrateTask({ work_id: workId, task_id: taskId, worktree_path: task.worktree_path });
    assert.equal(result.merged, true, result.message);
  }
  const failedTask = await gateway.prepareWorktree({ work_id: workId, task_id: failed });
  assert.equal(failedTask.ok, true, failedTask.message);
  await writeFile(join(failedTask.worktree_path, "abandoned.txt"), "failed attempt\n");
  git(failedTask.worktree_path, "add", "abandoned.txt");
  git(failedTask.worktree_path, "commit", "-m", "failed attempt");
  assert.notEqual(git(project, "branch", "--list", "owl/*"), "");

  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    const insertTask = (id, status, managerTaskId, retryNo, worktreePath) => tx.run(
      `INSERT INTO tasks
         (id, work_id, title, type, status, priority, context, acceptance,
          state_version, failure_count, same_error_count, review_round, worker_generation,
          created_at, updated_at, retry_no, manager_task_id, worktree_path, worktree_state)
       VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
      id, workId, managerTaskId, status, now, now, retryNo, managerTaskId, worktreePath, worktreePath ? "active" : null,
    );
    insertTask(integrated, "completed", "T1", 0, null);
    insertTask(failed, "cancelled", "T2", 0, failedTask.worktree_path);
    insertTask(retried, "completed", "T2", 1, null);
    for (const taskId of [integrated, retried]) {
      const runId = createUlid();
      tx.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
         VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)`,
        runId, workId, taskId, now, now,
      );
      tx.run(
        `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
         VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
        createUlid(), runId, JSON.stringify({ kind: "report", result: "success", work_done: "Done." }), "0".repeat(64), now,
      );
    }
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  const expectedBranches = {
    [`owl/task/${workId}/${integrated}`]: git(project, "rev-parse", `owl/task/${workId}/${integrated}`),
    [`owl/task/${workId}/${failed}`]: git(project, "rev-parse", `owl/task/${workId}/${failed}`),
    [`owl/task/${workId}/${retried}`]: git(project, "rev-parse", `owl/task/${workId}/${retried}`),
    [`owl/work/${workId}/work`]: git(project, "rev-parse", `owl/work/${workId}/work`),
  };

  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  const mergeCommit = git(project, "rev-parse", "main");
  assert.equal(git(project, "rev-parse", "main^1"), oldMain);
  assert.equal(git(project, "log", "--first-parent", "--format=%H", "-1", "main"), mergeCommit);
  assert.equal(git(project, "show", "main:first.txt"), "first.txt");
  assert.equal(git(project, "show", "main:retry.txt"), "retry.txt");
  assert.throws(() => git(project, "cat-file", "-e", "main:abandoned.txt"));

  const deletedEvent = await waitFor(() => db.get(
    "SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.branches_deleted'",
    workId,
  ));
  assert.ok(deletedEvent, "the branch deletion is recorded");
  assert.deepEqual(JSON.parse(deletedEvent.payload_json).deleted_branches, expectedBranches);
  assert.equal(git(project, "branch", "--list", "owl/*"), "");
  assert.equal(existsSync(join(root, ".owl-workspaces", workId)), false);
  assert.equal(git(project, "worktree", "list", "--porcelain").includes(".owl-workspaces"), false);

  const completed = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.completed'", workId).payload_json);
  assert.equal(completed.merge.old_base_commit, oldMain);
  assert.equal(completed.merge.new_base_commit, mergeCommit);
  assert.equal(completed.merge.merge_commit, mergeCommit);
  assert.deepEqual(completed.merge.verification_commands_run, []);
});
