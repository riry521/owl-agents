import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function fixture(t, toolState) {
  const parent = await tempDir(t, "owl-tool-state-");
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base\n");
  await writeFile(join(project, ".gitignore"), ".index/\n");
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
          worktree_tool_state_json: JSON.stringify(toolState),
        };
      }
      return undefined;
    },
  };
  return { project, gateway: new GitWorktreeGateway(db, join(parent, "owl")) };
}

test("prepareWorktree reports whether it created the Task worktree", async (t) => {
  const { gateway } = await fixture(t, []);
  const first = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(first.ok, true, first.message);
  assert.equal(first.created, true);
  const again = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(again.ok, true, again.message);
  assert.notEqual(again.created, true);
});

test("Task commits leave out untracked tool state but keep tracked files the tools touch", async (t) => {
  const { project, gateway } = await fixture(t, ["tags", "README.md", "cache/"]);
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, "tags"), "generated\n");
  await mkdir(join(task.worktree_path, "cache"));
  await writeFile(join(task.worktree_path, "cache", "data"), "generated\n");
  await writeFile(join(task.worktree_path, "README.md"), "changed by the agent\n");
  await writeFile(join(task.worktree_path, "feature.txt"), "feature\n");

  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
  const files = git(project, "ls-tree", "-r", "--name-only", "owl/work/W/work").split("\n").sort();
  assert.deepEqual(files, [".gitignore", "README.md", "feature.txt"]);
  assert.equal(git(project, "show", "owl/work/W/work:README.md"), "changed by the agent");

  assert.equal(await gateway.taskBranchMerged({ work_id: "W", task_id: "T1" }), true);
});

test("a Task worktree holding only ignored tool state can be discarded", async (t) => {
  const { gateway } = await fixture(t, [".index/"]);
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await mkdir(join(task.worktree_path, ".index"));
  await writeFile(join(task.worktree_path, ".index", "db"), "index\n");

  const discarded = await gateway.discardTaskWorktree({ work_id: "W", task_id: "T1", worktree_path: task.worktree_path, discard_changes: true });
  assert.equal(discarded.ok, true, discarded.message);
});

test("ignored content that is not tool state still stops the discard", async (t) => {
  const { gateway } = await fixture(t, []);
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await mkdir(join(task.worktree_path, ".index"));
  await writeFile(join(task.worktree_path, ".index", "db"), "index\n");

  const discarded = await gateway.discardTaskWorktree({ work_id: "W", task_id: "T1", worktree_path: task.worktree_path, discard_changes: true });
  assert.equal(discarded.ok, false);
  assert.match(discarded.message, /Ignored contents remain/);
});

test("Task commits succeed when the tool state is ignored by .gitignore", async (t) => {
  const { project, gateway } = await fixture(t, [".index/", ".index/cache/"]);
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await mkdir(join(task.worktree_path, ".index", "cache"), { recursive: true });
  await writeFile(join(task.worktree_path, ".index", "cache", "db"), "index\n");
  await writeFile(join(task.worktree_path, "feature.txt"), "feature\n");

  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
  const files = git(project, "ls-tree", "-r", "--name-only", "owl/work/W/work").split("\n").sort();
  assert.deepEqual(files, [".gitignore", "README.md", "feature.txt"]);
});

test("a leftover Task directory that Git no longer tracks as a worktree can be discarded", async (t) => {
  const { project, gateway } = await fixture(t, []);
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, "feature.txt"), "feature\n");
  await rm(join(task.worktree_path, ".git"));
  git(project, "worktree", "prune");

  const discarded = await gateway.discardTaskWorktree({ work_id: "W", task_id: "T1", worktree_path: task.worktree_path, discard_changes: true });
  assert.equal(discarded.ok, true, discarded.message);
});
