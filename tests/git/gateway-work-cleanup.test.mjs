import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

function hasBranch(project, branch) {
  try {
    git(project, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

async function fixture(t) {
  const parent = await tempDir(t, "owl-work-cleanup-");
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const db = {
    get(sql) {
      if (sql.includes("SELECT project_id FROM works")) return { project_id: "project-1" };
      if (sql.includes("SELECT state, state_version FROM works")) return { state: "running", state_version: 1 };
      if (sql.includes("FROM projects")) {
        return {
          canonical_path: project,
          base_branch: "main",
          allowed_roots_json: JSON.stringify([parent]),
          verification_plan_json: "[]",
        };
      }
      return undefined;
    },
  };
  const owlRoot = join(parent, "owl");
  return { project, owlRoot, gateway: new GitWorktreeGateway(db, owlRoot) };
}

async function addWorkChange(gateway, workId = "W") {
  const task = await gateway.prepareWorktree({ work_id: workId, task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, "feature.txt"), "Work feature\n");
  const integrated = await gateway.integrateTask({ work_id: workId, task_id: "T1", worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
}

test("merged Work cleanup force-deletes its Work and every Task branch, records their commits, and is idempotent", async (t) => {
  const { project, gateway } = await fixture(t);
  await addWorkChange(gateway);

  const merged = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(merged.kind, "merged", merged.message);
  const beforeRemoval = await gateway.deleteMergedWorkBranches({ work_id: "W" });
  assert.equal(beforeRemoval.ok, false);
  assert.match(beforeRemoval.message, /owl\/work\/W\/work/);
  assert.equal(hasBranch(project, "owl/work/W/work"), true);
  assert.equal(hasBranch(project, "owl/task/W/T1"), true);

  const removed = await gateway.removeIntegrationWorktree({ work_id: "W" });
  assert.equal(removed.ok, true, removed.message);

  git(project, "branch", "owl/task/W/T2", "main");
  git(project, "checkout", "owl/task/W/T2");
  await writeFile(join(project, "abandoned.txt"), "never integrated\n");
  git(project, "add", "abandoned.txt");
  git(project, "commit", "-m", "abandoned Task change");
  git(project, "checkout", "main");
  const expected = {
    "owl/task/W/T1": git(project, "rev-parse", "owl/task/W/T1"),
    "owl/task/W/T2": git(project, "rev-parse", "owl/task/W/T2"),
    "owl/work/W/work": git(project, "rev-parse", "owl/work/W/work"),
  };

  const cleanup = await gateway.deleteMergedWorkBranches({ work_id: "W" });
  assert.equal(cleanup.ok, true, cleanup.message);
  assert.deepEqual(cleanup.deleted_branches, expected);
  assert.equal(git(project, "branch", "--list", "owl/*"), "");

  const repeated = await gateway.deleteMergedWorkBranches({ work_id: "W" });
  assert.equal(repeated.ok, true, repeated.message);
  assert.deepEqual(repeated.deleted_branches, {});
});

test("cleanup keeps a Work branch that has not been merged into the Project base", async (t) => {
  const { project, gateway } = await fixture(t);
  await addWorkChange(gateway);
  const removed = await gateway.removeIntegrationWorktree({ work_id: "W" });
  assert.equal(removed.ok, true, removed.message);

  await writeFile(join(project, "base-only.txt"), "base advanced\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "advance base separately");

  const cleanup = await gateway.deleteMergedWorkBranches({ work_id: "W" });
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.message, /owl\/work\/W\/work/);
  assert.equal(hasBranch(project, "owl/work/W/work"), true);
  assert.equal(hasBranch(project, "owl/task/W/T1"), true);
});

test("cleanup refuses a merged branch that remains checked out in another worktree", async (t) => {
  const { project, owlRoot, gateway } = await fixture(t);
  await addWorkChange(gateway);
  const merged = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(merged.kind, "merged", merged.message);
  const integration = await gateway.removeIntegrationWorktree({ work_id: "W" });
  assert.equal(integration.ok, true, integration.message);

  const externalWorktree = join(owlRoot, "external-worktree");
  await mkdir(owlRoot, { recursive: true });
  git(project, "worktree", "add", externalWorktree, "owl/work/W/work");

  const cleanup = await gateway.deleteMergedWorkBranches({ work_id: "W" });
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.message, /still checked out in a worktree/);
  assert.equal(hasBranch(project, "owl/work/W/work"), true);

  git(project, "worktree", "remove", externalWorktree);
  const retried = await gateway.deleteMergedWorkBranches({ work_id: "W" });
  assert.equal(retried.ok, true, retried.message);
  assert.equal(hasBranch(project, "owl/work/W/work"), false);
});

test("abortIntegrationMerge aborts an interrupted merge in the integration worktree", async (t) => {
  const { project, owlRoot, gateway } = await fixture(t);
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, "README.md"), "conflicting Work change\n");
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);

  await writeFile(join(project, "README.md"), "conflicting base\n");
  git(project, "add", "README.md");
  git(project, "commit", "-m", "conflicting base edit");
  const integrationPath = join(owlRoot, ".owl-workspaces", "W", "__work__");
  assert.throws(() => git(integrationPath, "merge", "main"));
  assert.doesNotThrow(() => git(integrationPath, "rev-parse", "-q", "--verify", "MERGE_HEAD"));

  const aborted = await gateway.abortIntegrationMerge({ work_id: "W" });
  assert.equal(aborted.ok, true, aborted.message);
  assert.throws(() => git(integrationPath, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
});

test("workHasUnmergedChanges sees commits in Work and Task branches outside the base", async (t) => {
  const { project, gateway } = await fixture(t);
  await addWorkChange(gateway, "W3");

  assert.equal(await gateway.workHasUnmergedChanges({ work_id: "W3" }), true);
  const merged = await gateway.mergeWorkIntoBase({ work_id: "W3" });
  assert.equal(merged.kind, "merged", merged.message);
  assert.equal(await gateway.workHasUnmergedChanges({ work_id: "W3" }), false);

  git(project, "checkout", "-b", "owl/task/W3/T2", "main");
  await writeFile(join(project, "task-only.txt"), "not integrated\n");
  git(project, "add", "task-only.txt");
  git(project, "commit", "-m", "task-only change");
  git(project, "checkout", "main");
  assert.equal(await gateway.workHasUnmergedChanges({ work_id: "W3" }), true);
});

test("deleteWorkWorkspaces removes worktrees and deleteWorkBranches then removes all Work and Task branches", async (t) => {
  const { project, gateway } = await fixture(t);
  await addWorkChange(gateway, "W4");
  assert.equal(hasBranch(project, "owl/work/W4/work"), true);
  assert.equal(hasBranch(project, "owl/task/W4/T1"), true);

  const cleanup = await gateway.deleteWorkWorkspaces({ work_id: "W4" });

  assert.equal(cleanup.ok, true, cleanup.message);
  assert.equal(hasBranch(project, "owl/work/W4/work"), true);
  assert.equal(git(project, "worktree", "list", "--porcelain").includes(".owl-workspaces/W4/"), false);

  const branches = await gateway.deleteWorkBranches({ work_id: "W4", project_id: "project-1" });
  assert.equal(branches.ok, true, branches.message);
  assert.equal(hasBranch(project, "owl/work/W4/work"), false);
  assert.equal(hasBranch(project, "owl/task/W4/T1"), false);
  assert.equal(git(project, "worktree", "list", "--porcelain").includes(".owl-workspaces/W4/"), false);
});

test("deleteWorkWorkspaces removes the whole Work directory with uncommitted edits and ignored files, and leaves outside files alone", async (t) => {
  const { project, owlRoot, gateway } = await fixture(t);
  await writeFile(join(project, ".git", "info", "exclude"), "dist/\n");
  const task = await gateway.prepareWorktree({ work_id: "W5", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await mkdir(join(task.worktree_path, "dist"), { recursive: true });
  await writeFile(join(task.worktree_path, "dist", "main.js"), "ignored build output\n");
  await writeFile(join(task.worktree_path, "README.md"), "uncommitted edit\n");
  const outside = join(owlRoot, "outside.txt");
  await writeFile(outside, "outside content\n");
  await symlink(outside, join(task.worktree_path, "link.txt"));
  const mainBefore = git(project, "rev-parse", "main");

  const cleanup = await gateway.deleteWorkWorkspaces({ work_id: "W5" });

  assert.equal(cleanup.ok, true, cleanup.message);
  await assert.rejects(access(join(owlRoot, ".owl-workspaces", "W5")));
  assert.equal(git(project, "worktree", "list", "--porcelain").includes(".owl-workspaces/W5/"), false);
  assert.equal(await readFile(outside, "utf8"), "outside content\n");
  assert.equal(git(project, "rev-parse", "main"), mainBefore);
});
