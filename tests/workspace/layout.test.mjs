import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { resolveWorkspacesRoot, WorkspaceLayout } from "../../packages/core/dist/workspace-layout.js";
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

test("WorkspaceLayout.underOwlRoot resolves the default root under the Owl root", () => {
  const layout = WorkspaceLayout.underOwlRoot("/tmp/owl-root-example");
  assert.equal(layout.root, resolve("/tmp/owl-root-example", ".owl-workspaces"));
  assert.equal(new WorkspaceLayout("/tmp/new-root").root, resolve("/tmp/new-root"));
});

test("empty ids and ids of only dots resolve to a directory below their parent, never to the parent or above it", async (t) => {
  const parent = await tempDir(t, "owl-layout-dots-");
  const layout = new WorkspaceLayout(join(parent, "root"));
  const below = (base, path) => path.startsWith(`${base}/`) && path.length > base.length + 1;
  for (const id of ["", ".", ".."]) {
    assert.ok(below(layout.root, layout.workDir(id)), `workDir(${id})`);
    assert.ok(below(layout.workDir("work"), layout.taskPath("work", id)), `taskPath(work, ${id})`);
    assert.ok(below(join(layout.root, "advisor"), layout.advisorSharedDir(id)), `advisorSharedDir(${id})`);
  }
});

test("workDir, taskPath and integrationPath resolve under the root", () => {
  const root = resolve("/tmp/owl-layout-workdir");
  const layout = new WorkspaceLayout(root);
  assert.equal(layout.workDir("W1"), join(root, "W1"));
  assert.equal(layout.taskPath("W2", "T1"), join(root, "W2", "T1"));
  assert.equal(layout.integrationPath("W2"), join(root, "W2", "__work__"));
});

test("advisorSharedDir and advisorHomeDir resolve under the root", () => {
  const root = resolve("/tmp/owl-layout-advisordir");
  const layout = new WorkspaceLayout(root);
  assert.equal(layout.advisorSharedDir("repo-1"), join(root, "advisor", "shared", "repo-1"));
  assert.equal(layout.advisorHomeDir(), join(root, "advisor", "home"));
});

test("contains identifies whether a path is inside the root", () => {
  const root = resolve("/tmp/owl-layout-contains-root");
  const layout = new WorkspaceLayout(root);
  assert.equal(layout.contains(join(root, "W1", "T1")), true);
  assert.equal(layout.contains(root), true);
  assert.equal(layout.contains("/tmp/elsewhere"), false);
});

test("Task worktrees are created under the configured root", async (t) => {
  const parent = await tempDir(t, "owl-layout-newroot-");
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const workspacesRoot = join(parent, "workspaces");
  const layout = new WorkspaceLayout(workspacesRoot);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot, undefined, undefined, layout);

  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.worktree_path, join(workspacesRoot, "W", "T1"));
});

test("listWorkspaces returns entries under the root", async (t) => {
  const parent = await tempDir(t, "owl-layout-listworkspaces-");
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const workspacesRoot = join(parent, "workspaces");
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), owlRoot, undefined, undefined, new WorkspaceLayout(workspacesRoot));

  const prepared = await gateway.prepareWorktree({ work_id: "WNew", task_id: "T1" });
  assert.equal(prepared.ok, true, prepared.message);

  const entries = await gateway.listWorkspaces();
  assert.deepEqual(entries.map((entry) => entry.path), [join(workspacesRoot, "WNew", "T1")]);
});

test("the per-process scratch root created under the test runner is removed when the process exits", () => {
  const script = `import(${JSON.stringify(new URL("../../packages/core/dist/workspace-layout.js", import.meta.url).href)}).then((m) => { const dir = m.defaultOwlRoot(); console.log(dir + "|" + require("node:fs").existsSync(dir)); });`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" } });
  assert.equal(result.status, 0, result.stderr);
  const [dir, existedWhileRunning] = result.stdout.trim().split("|");
  assert.equal(existedWhileRunning, "true");
  assert.match(dir, /owl-test-root-/);
  assert.equal(existsSync(dir), false);
});
