import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../packages/core/dist/git-gateway.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasBranch(project, branch) {
  try {
    git(project, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-work-cleanup-")));
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

test("merged Work cleanup force-deletes its Work and every Task branch, records their commits, and is idempotent", async () => {
  const { project, gateway } = await fixture();
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

test("cleanup keeps a Work branch that has not been merged into the Project base", async () => {
  const { project, gateway } = await fixture();
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

test("cleanup refuses a merged branch that remains checked out in another worktree", async () => {
  const { project, owlRoot, gateway } = await fixture();
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

test("abortIntegrationMerge aborts an interrupted merge in the integration worktree", async () => {
  const { project, owlRoot, gateway } = await fixture();
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

test("workHasUnmergedChanges sees commits in Work and Task branches outside the base", async () => {
  const { project, gateway } = await fixture();
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

test("deleteWorkWorkspaces removes worktrees and deleteWorkBranches then removes all Work and Task branches", async () => {
  const { project, gateway } = await fixture();
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

test("deleteWorkWorkspaces backs up leftover Task changes when the commit is refused", async () => {
  const { project, owlRoot, gateway } = await fixture();
  const task = await gateway.prepareWorktree({ work_id: "W5", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  const signer = join(project, ".git", "reject-signing.sh");
  await writeFile(signer, "#!/bin/sh\necho 'commits are refused here' >&2\nexit 1\n", { mode: 0o755 });
  git(project, "config", "gpg.program", signer);
  git(project, "config", "commit.gpgsign", "true");
  await mkdir(join(task.worktree_path, "notes"), { recursive: true });
  await writeFile(join(task.worktree_path, "notes", "draft.md"), "unfinished\n");
  git(task.worktree_path, "add", "notes/draft.md");

  const cleanup = await gateway.deleteWorkWorkspaces({ work_id: "W5" });

  assert.equal(cleanup.ok, true, cleanup.message);
  assert.equal(git(project, "worktree", "list", "--porcelain").includes(".owl-workspaces/W5/"), false);
  assert.equal(git(project, "log", "--format=%s", "owl/task/W5/T1").includes("owl: complete task"), false, "the refused commit was not forced");
  const backups = join(owlRoot, "data", "outputs", "W5", "_uncommitted-changes");
  const [saved] = await readdir(backups);
  assert.equal(await readFile(join(backups, saved, "notes", "draft.md"), "utf8"), "unfinished\n");
});

test("deleteWorkWorkspaces ignores an empty ignored directory but still stops at an ignored file", async () => {
  const { project, gateway } = await fixture();
  await writeFile(join(project, ".git", "info", "exclude"), "docs/designs/\n");
  const task = await gateway.prepareWorktree({ work_id: "W6", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await mkdir(join(task.worktree_path, "docs", "designs", "old"), { recursive: true });
  await writeFile(join(task.worktree_path, "docs", "designs", "old", "memo.md"), "keep me\n");

  const blocked = await gateway.deleteWorkWorkspaces({ work_id: "W6" });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.details.worktrees[0].ignored_paths, ["docs/designs/"]);

  await rm(join(task.worktree_path, "docs", "designs", "old", "memo.md"));
  const cleanup = await gateway.deleteWorkWorkspaces({ work_id: "W6" });
  assert.equal(cleanup.ok, true, cleanup.message);
  assert.equal(git(project, "worktree", "list", "--porcelain").includes(".owl-workspaces/W6/"), false);
});
