import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { evaluateTaskTypePolicy } from "../../packages/core/dist/task-verification-policy.js";
import { DEFAULT_VERIFICATION_POLICY_SETTINGS } from "../../packages/shared/dist/verification-policy-settings.js";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function fixture(t) {
  const parent = await tempDir(t, "owl-base-sync-");
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
      if (sql.includes("FROM projects")) {
        return { canonical_path: project, base_branch: "main", allowed_roots_json: JSON.stringify([parent]), verification_plan_json: "[]" };
      }
      return undefined;
    },
  };
  const gateway = new GitWorktreeGateway(db, join(parent, "owl"));
  return { parent, project, gateway };
}

async function commitOnBase(project, file, content, message) {
  await writeFile(join(project, file), content);
  git(project, "add", ".");
  git(project, "commit", "-m", message);
}

async function workChange(gateway, file, content) {
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, file), content);
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
}

test("baseBranchFacts reports the head and the paths missing from the base", async (t) => {
  const { project, gateway } = await fixture(t);
  const facts = await gateway.baseBranchFacts({ work_id: "W", paths: ["README.md", "src/page.ts"] });
  assert.deepEqual({ ...facts, head: undefined }, { ok: true, head: undefined, missing_paths: ["src/page.ts"] });
  assert.equal(facts.head, git(project, "rev-parse", "refs/heads/main"));
});

test("mergeBaseIntoWorkBranch fast-forwards a Work branch that has no changes of its own", async (t) => {
  const { project, gateway } = await fixture(t);
  const created = await gateway.mergeBaseIntoWorkBranch({ work_id: "W" });
  assert.equal(created.ok, true, JSON.stringify(created));
  await commitOnBase(project, "page.ts", "export {};\n", "land page");
  const result = await gateway.mergeBaseIntoWorkBranch({ work_id: "W" });
  assert.deepEqual({ ...result, head: undefined }, { ok: true, merged: true, head: undefined });
  assert.equal(result.head, git(project, "rev-parse", "refs/heads/main"));
  assert.equal(git(project, "show", "owl/work/W/work:page.ts"), "export {};");
  const again = await gateway.mergeBaseIntoWorkBranch({ work_id: "W" });
  assert.equal(again.ok && again.merged, false, "a second sync changes nothing");
});

test("mergeBaseIntoWorkBranch makes a merge commit when the Work branch has its own changes", async (t) => {
  const { project, gateway } = await fixture(t);
  await workChange(gateway, "feature.txt", "work\n");
  await commitOnBase(project, "page.ts", "export {};\n", "land page");
  const result = await gateway.mergeBaseIntoWorkBranch({ work_id: "W" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(git(project, "show", "owl/work/W/work:page.ts"), "export {};");
  assert.equal(git(project, "show", "owl/work/W/work:feature.txt"), "work");
  assert.equal(git(project, "rev-list", "--parents", "-n", "1", "owl/work/W/work").split(" ").length, 3, "two parents");
});

test("mergeBaseIntoWorkBranch aborts a conflicting merge and leaves the Work branch untouched", async (t) => {
  const { project, gateway, parent } = await fixture(t);
  await workChange(gateway, "README.md", "work side\n");
  const workHead = git(project, "rev-parse", "owl/work/W/work");
  await commitOnBase(project, "README.md", "base side\n", "base edit");
  const result = await gateway.mergeBaseIntoWorkBranch({ work_id: "W" });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(git(project, "rev-parse", "owl/work/W/work"), workHead);
  const integration = join(parent, "owl", ".owl-workspaces", "W", "__work__");
  assert.equal(git(integration, "status", "--porcelain=v1"), "");
  assert.throws(() => git(integration, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
});

test("a Task that merged the base keeps only its own and conflict-resolved files, so the file limit is not exceeded", async (t) => {
  const { project, gateway } = await fixture(t);
  const settings = DEFAULT_VERIFICATION_POLICY_SETTINGS;
  const limit = settings.limits.max_files_per_check;
  await commitOnBase(project, "shared.md", "# shared\n", "add shared");
  await workChange(gateway, "shared.md", "# work\n");
  for (let i = 0; i < limit + 5; i += 1) await writeFile(join(project, `base-${i}.md`), `# base ${i}\n`);
  await writeFile(join(project, "shared.md"), "# base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "many base files");
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(task.ok, true, task.message);
  const request = { work_id: "W", task_id: "T2", worktree_path: task.worktree_path };
  await writeFile(join(task.worktree_path, "own.md"), "# own\n");
  git(task.worktree_path, "add", ".");
  git(task.worktree_path, "commit", "-m", "own change");
  assert.deepEqual(await gateway.changedPaths(request), ["own.md"]);
  assert.throws(() => git(task.worktree_path, "merge", "--no-ff", "-m", "merge base", "main"));
  await writeFile(join(task.worktree_path, "shared.md"), "# resolved\n");
  git(task.worktree_path, "add", ".");
  git(task.worktree_path, "commit", "-m", "merge base");
  const files = await gateway.changedPaths(request);
  assert.deepEqual(files, ["own.md", "shared.md"]);
  const result = await evaluateTaskTypePolicy({
    type: "doc", root: task.worktree_path, files, claimedChanges: [], spec: {}, mode: "sole", settings,
    runCommand: async () => ({ passed: true, exit_code: 0, stdout: "" }),
  });
  assert.equal(result.passed, true, result.error ?? "");
  assert.notEqual(result.error_key, "verification_limit_exceeded");
});
