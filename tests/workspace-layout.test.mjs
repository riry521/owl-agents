import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../packages/core/dist/git-gateway.js";
import { resolveWorkspacesRoot, WorkspaceLayout } from "../packages/core/dist/workspace-layout.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

test("resolveWorkspacesRoot prefers a non-empty OWL_WORKSPACES_DIR over the default", () => {
  const home = "/home/owl-user";
  assert.equal(resolveWorkspacesRoot({}, home), join(home, ".owl", "workspaces"));
  assert.equal(resolveWorkspacesRoot({ OWL_WORKSPACES_DIR: "" }, home), join(home, ".owl", "workspaces"));
  assert.equal(resolveWorkspacesRoot({ OWL_WORKSPACES_DIR: "   " }, home), join(home, ".owl", "workspaces"));
  assert.equal(resolveWorkspacesRoot({ OWL_WORKSPACES_DIR: "/custom/dir" }, home), resolve("/custom/dir"));
  assert.equal(resolveWorkspacesRoot({ OWL_WORKSPACES_DIR: "relative/dir" }, home), resolve("relative/dir"));
});

test("resolveWorkspacesRoot falls back to a per-process temporary directory under the Node test runner", () => {
  const home = "/home/owl-user";
  const env = { NODE_TEST_CONTEXT: "child-v8" };
  const root = resolveWorkspacesRoot(env, home);
  assert.notEqual(root, join(home, ".owl", "workspaces"));
  assert.ok(root.startsWith(tmpdir()) || root.startsWith(realpathSync(tmpdir())));
  assert.equal(resolveWorkspacesRoot(env, home), root);
  assert.equal(resolveWorkspacesRoot({ ...env, OWL_WORKSPACES_DIR: "/custom/dir" }, home), resolve("/custom/dir"));
});

test("WorkspaceLayout.roots() dedupes when root and legacyRoot are the same", () => {
  const legacyOnly = WorkspaceLayout.legacyOnly("/tmp/owl-root-example");
  assert.equal(legacyOnly.roots().length, 1);
  assert.equal(legacyOnly.roots()[0], legacyOnly.root);
  assert.equal(legacyOnly.root, legacyOnly.legacyRoot);

  const split = new WorkspaceLayout("/tmp/new-root", "/tmp/legacy-root");
  assert.deepEqual(split.roots(), [resolve("/tmp/new-root"), resolve("/tmp/legacy-root")]);
});

test("workDir prefers an existing legacy directory, otherwise falls back to the current root", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-layout-workdir-")));
  const root = join(parent, "root");
  const legacyRoot = join(parent, "legacy");
  const layout = new WorkspaceLayout(root, legacyRoot);

  // Neither exists yet: falls back to the current root.
  assert.equal(layout.workDir("W1"), join(root, "W1"));

  // Once a legacy directory for this Work exists, it takes priority.
  await mkdir(join(legacyRoot, "W1"), { recursive: true });
  assert.equal(layout.workDir("W1"), join(legacyRoot, "W1"));

  // A different Work with no legacy directory still resolves under the current root.
  assert.equal(layout.workDir("W2"), join(root, "W2"));

  assert.equal(layout.taskPath("W2", "T1"), join(root, "W2", "T1"));
  assert.equal(layout.integrationPath("W2"), join(root, "W2", "__work__"));
});

test("advisorDir prefers an existing legacy advisor directory, otherwise falls back to the current root", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-layout-advisordir-")));
  const root = join(parent, "root");
  const legacyRoot = join(parent, "legacy");
  const layout = new WorkspaceLayout(root, legacyRoot);

  assert.equal(layout.advisorDir("conv-1"), join(root, "advisor", "conv-1"));

  await mkdir(join(legacyRoot, "advisor", "conv-1"), { recursive: true });
  assert.equal(layout.advisorDir("conv-1"), join(legacyRoot, "advisor", "conv-1"));
  assert.equal(layout.advisorDir("conv-2"), join(root, "advisor", "conv-2"));
});

test("contains and rootOf identify which root (if any) holds a given path", () => {
  const root = resolve("/tmp/owl-layout-contains-root");
  const legacyRoot = resolve("/tmp/owl-layout-contains-legacy");
  const layout = new WorkspaceLayout(root, legacyRoot);

  assert.equal(layout.contains(join(root, "W1", "T1")), true);
  assert.equal(layout.contains(join(legacyRoot, "W2")), true);
  assert.equal(layout.contains(root), true);
  assert.equal(layout.contains("/tmp/elsewhere"), false);

  assert.equal(layout.rootOf(join(root, "W1")), root);
  assert.equal(layout.rootOf(join(legacyRoot, "W2")), legacyRoot);
  assert.equal(layout.rootOf("/tmp/elsewhere"), null);
});

test("Task worktrees are created under the current root when no legacy directory exists for the Work", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-layout-newroot-")));
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const workspacesRoot = join(parent, "workspaces");
  const legacyRoot = join(owlRoot, ".owl-workspaces");
  const layout = new WorkspaceLayout(workspacesRoot, legacyRoot);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot, undefined, undefined, layout);

  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.worktree_path, join(workspacesRoot, "W", "T1"));
});

test("Task worktrees reuse a Work's existing legacy directory even when a current root is configured", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-layout-legacyprefer-")));
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const workspacesRoot = join(parent, "workspaces");
  const legacyRoot = join(owlRoot, ".owl-workspaces");
  const layout = new WorkspaceLayout(workspacesRoot, legacyRoot);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot, undefined, undefined, layout);

  // Simulate a Work whose worktrees were already registered under the legacy root.
  const legacyGateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot, undefined, undefined, WorkspaceLayout.legacyOnly(owlRoot));
  const legacyPrepared = await legacyGateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(legacyPrepared.ok, true, legacyPrepared.message);
  assert.equal(legacyPrepared.worktree_path, join(legacyRoot, "W", "T1"));

  // A second Task on the same Work, via the layout that also knows about the current root,
  // should still land in the legacy directory since it already exists.
  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.worktree_path, join(legacyRoot, "W", "T2"));
});

test("listWorkspaces returns entries from both the current root and the legacy root", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-layout-listworkspaces-")));
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const workspacesRoot = join(parent, "workspaces");
  const legacyRoot = join(owlRoot, ".owl-workspaces");
  const layout = new WorkspaceLayout(workspacesRoot, legacyRoot);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot, undefined, undefined, layout);

  // One Work lands under the legacy root (pre-existing legacy directory)...
  const legacyGateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot, undefined, undefined, WorkspaceLayout.legacyOnly(owlRoot));
  const legacyPrepared = await legacyGateway.prepareWorktree({ work_id: "WLegacy", task_id: "T1" });
  assert.equal(legacyPrepared.ok, true, legacyPrepared.message);

  // ...and another lands under the current root, since it has no legacy directory.
  const newPrepared = await gateway.prepareWorktree({ work_id: "WNew", task_id: "T1" });
  assert.equal(newPrepared.ok, true, newPrepared.message);

  const entries = await gateway.listWorkspaces();
  const paths = entries.map((entry) => entry.path).sort();
  assert.deepEqual(paths, [join(legacyRoot, "WLegacy", "T1"), join(workspacesRoot, "WNew", "T1")].sort());
});
