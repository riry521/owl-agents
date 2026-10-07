import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

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

/** Advance the Work branch past a Task's start point by completing another Task. */
async function advanceWorkBranch(gateway, workId, taskId, fileName, content) {
  const prepared = await gateway.prepareWorktree({ work_id: workId, task_id: taskId });
  assert.equal(prepared.ok, true, prepared.message);
  await writeFile(join(prepared.worktree_path, fileName), content);
  const integrated = await gateway.integrateTask({ work_id: workId, task_id: taskId, worktree_path: prepared.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
}

test("a Task worktree left behind by an earlier attempt catches up to the Work branch on reuse", async (t) => {
  const parent = await tempDir(t, "owl-worktree-reuse-");
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));

  // T2 starts before any Work branch exists, so it branches from main.
  const firstPrepare = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(firstPrepare.ok, true, firstPrepare.message);

  // T3 runs to completion in the meantime, moving the Work branch ahead of
  // the point T2 started from.
  await advanceWorkBranch(gateway, "W", "T3", "other.txt", "from T3\n");

  // T2's worktree is reused (e.g. after a restart); it should be caught up
  // with the Work branch before it is handed back to a Worker.
  const reused = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(reused.ok, true, reused.message);
  assert.equal(reused.worktree_path, firstPrepare.worktree_path);
  assert.equal(await readFile(join(reused.worktree_path, "other.txt"), "utf8"), "from T3\n");
  // Throws (non-zero exit) unless the Work branch's tip is now an ancestor of T2's HEAD.
  git(reused.worktree_path, "merge-base", "--is-ancestor", "owl/work/W/work", "HEAD");
});

test("uncommitted changes in a reused Task worktree are checkpointed before catching up", async (t) => {
  const parent = await tempDir(t, "owl-worktree-checkpoint-");
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));

  const firstPrepare = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(firstPrepare.ok, true, firstPrepare.message);
  await writeFile(join(firstPrepare.worktree_path, "wip.txt"), "work in progress\n");
  const statusBefore = git(firstPrepare.worktree_path, "status", "--porcelain=v1");
  assert.notEqual(statusBefore, "", "wip.txt starts out uncommitted");

  await advanceWorkBranch(gateway, "W", "T3", "other.txt", "from T3\n");

  const reused = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(reused.ok, true, reused.message);
  assert.equal(await readFile(join(reused.worktree_path, "wip.txt"), "utf8"), "work in progress\n", "the uncommitted work is retained");
  assert.equal(await readFile(join(reused.worktree_path, "other.txt"), "utf8"), "from T3\n", "the Work branch's tip is picked up");
  assert.equal(git(reused.worktree_path, "status", "--porcelain=v1"), "", "the checkpoint commit leaves the worktree clean");
  assert.match(git(reused.worktree_path, "log", "--format=%s", "-2"), /owl: checkpoint task T2/, "the uncommitted work was checkpointed before merging");
});

test("a Task worktree that conflicts with the Work branch is reported without leaving a merge in progress", async (t) => {
  const parent = await tempDir(t, "owl-worktree-conflict-");
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));

  const firstPrepare = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(firstPrepare.ok, true, firstPrepare.message);
  await writeFile(join(firstPrepare.worktree_path, "README.md"), "T2 version\n");

  // T3 changes the same file differently and gets merged into the Work
  // branch first.
  const t3 = await gateway.prepareWorktree({ work_id: "W", task_id: "T3" });
  assert.equal(t3.ok, true, t3.message);
  await writeFile(join(t3.worktree_path, "README.md"), "T3 version\n");
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T3", worktree_path: t3.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);

  const reused = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(reused.ok, false);
  assert.equal(reused.failure_kind, "work_sync_conflict");
  assert.match(reused.message, /conflicts with the Work branch/);

  // The abort left no merge in progress and T2's own edit is intact.
  assert.throws(() => git(firstPrepare.worktree_path, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
  assert.equal(await readFile(join(firstPrepare.worktree_path, "README.md"), "utf8"), "T2 version\n");
});
