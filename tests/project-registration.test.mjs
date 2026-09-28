import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../packages/core/dist/git-gateway.js";
import {
  initializeExistingProjectFolder,
  initializeNewProjectFolder,
  inspectProjectFolder,
} from "../apps/server/dist/project-registration.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("existing repositories get their base branch detected without modifying their checkout", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owl-project-existing-git-"));
  const project = join(parent, "repo");
  await mkdir(project);
  git(project, "init", "--initial-branch=develop");
  await writeFile(join(project, "README.md"), "hello\n");
  git(project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "README.md");
  git(project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
  await writeFile(join(project, "draft.txt"), "keep this uncommitted\n");

  const inspection = await inspectProjectFolder(project);
  assert.equal(inspection.kind, "git_ready");
  assert.equal(inspection.canonical_path, await realpath(project));
  assert.equal(inspection.base_branch, "develop");
  assert.equal(inspection.has_uncommitted_changes, true);
  assert.equal(inspection.uncommitted_file_count, 1);
  assert.equal(git(project, "status", "--short").includes("draft.txt"), true);
});

test("initializing an existing folder creates a local snapshot and excludes common secrets", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owl-project-no-git-"));
  const project = join(parent, "repo");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "node_modules", "sample"), { recursive: true });
  await writeFile(join(project, "src", "index.ts"), "export const answer = 42;\n");
  await writeFile(join(project, ".env"), "SECRET=value\n");
  await writeFile(join(project, "node_modules", "sample", "index.js"), "ignored\n");

  const before = await inspectProjectFolder(project);
  assert.equal(before.kind, "not_git");
  assert.deepEqual(before.initial_files, ["src/index.ts"]);
  assert.ok(before.excluded_files.some((path) => path.startsWith(".env")));

  const setup = await initializeExistingProjectFolder(project);
  assert.equal(setup.base_branch, "main");
  assert.equal(git(project, "branch", "--show-current"), "main");
  assert.deepEqual(git(project, "ls-files").split("\n"), ["src/index.ts"]);
  assert.equal(await readFile(join(project, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal((await inspectProjectFolder(project)).kind, "git_ready");

  const worktree = join(parent, "worktree");
  git(project, "worktree", "add", "-b", "owl/test", worktree, "main");
  assert.equal(await readFile(join(worktree, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
});

test("new projects get a main branch and empty initial commit for worktree creation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owl-project-new-"));
  const project = join(parent, "new-repo");

  const setup = await initializeNewProjectFolder(project);
  assert.deepEqual(setup, { canonical_path: await realpath(project), base_branch: "main", created_directory: true });
  assert.equal(git(project, "branch", "--show-current"), "main");
  assert.equal(git(project, "rev-list", "--count", "main"), "1");
  assert.equal(git(project, "ls-tree", "--name-only", "HEAD"), "");

  const worktree = join(parent, "worktree");
  git(project, "worktree", "add", "-b", "owl/test", worktree, "main");
  assert.equal(git(worktree, "rev-parse", "HEAD"), git(project, "rev-parse", "main"));
});

test("a Work without a Project gets an isolated workspace", async () => {
  const owlRoot = await mkdtemp(join(tmpdir(), "owl-work-without-project-"));
  const database = { get: () => ({ project_id: null }) };
  const gateway = new GitWorktreeGateway(database, owlRoot);

  const result = await gateway.prepareWorktree({ work_id: "work-no-project", task_id: "task-1" });
  assert.equal(result.ok, true);
  assert.equal(result.recorded, false);
  assert.match(result.worktree_path, /^.*\.owl-workspaces\/work-no-project\/task-1$/u);
  assert.equal((await lstat(result.worktree_path)).isDirectory(), true);
});

test("Advisor uses a non-Git registered Project directory directly", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owl-advisor-non-git-project-"));
  const project = join(parent, "existing-folder");
  const owlRoot = join(parent, "owl-app");
  await mkdir(project);
  await mkdir(owlRoot);
  const database = {
    get(sql) {
      if (sql.includes("SELECT work_id FROM conversations")) return { work_id: "work-advisor-non-git" };
      if (sql.includes("SELECT project_id FROM works")) return { project_id: "project-advisor-non-git" };
      if (sql.includes("FROM projects")) {
        return { canonical_path: project, base_branch: "main", allowed_roots_json: JSON.stringify([parent]) };
      }
      return undefined;
    },
  };
  try {
    const gateway = new GitWorktreeGateway(database, owlRoot);
    const result = await gateway.prepareAdvisorWorkspace({ conversation_id: "conversation-advisor-non-git" });
    assert.equal(result.ok, true);
    assert.equal(result.worktree_path, await realpath(project));
    assert.match(result.message, /not a Git repository/u);
    await assert.rejects(lstat(join(owlRoot, ".owl-workspaces", "advisor", "conversation-advisor-non-git")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
