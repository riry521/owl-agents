import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";

import { createTestRepo, git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function fixture(t, { projectless = false } = {}) {
  const parent = await tempDir(t, "owl-fix-snapshot-");
  const project = await createTestRepo(t, { files: { "a.txt": "a1\na2\na3\n", "b.txt": "b\n", "worker.txt": "w1\nw2\n" } });
  const db = {
    get(sql) {
      if (sql.includes("SELECT project_id FROM works")) return { project_id: projectless ? null : "project-1" };
      if (sql.includes("FROM projects")) {
        return projectless ? undefined : { canonical_path: project, base_branch: "main", allowed_roots_json: JSON.stringify([join(project, "..")]), verification_plan_json: "[]" };
      }
      return undefined;
    },
  };
  const gateway = new GitWorktreeGateway(db, join(parent, "owl"));
  const prepared = projectless ? null : await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  if (prepared) assert.equal(prepared.ok, true, prepared.message);
  return { gateway, path: prepared?.worktree_path, request: { work_id: "W", task_id: "T1", worktree_path: prepared?.worktree_path } };
}

test("reviewer changes are measured and undone while the Worker's uncommitted changes stay", async (t) => {
  const { gateway, path, request } = await fixture(t);
  // Worker's uncommitted work, present before the snapshot.
  await writeFile(join(path, "worker.txt"), "w1\nw2\nw3\n");
  await writeFile(join(path, "worker-new.txt"), "new\n");
  const porcelainBefore = git(path, "status", "--porcelain=v1", "--untracked-files=all");
  const indexBefore = git(path, "ls-files", "--stage");

  const snapshot = await gateway.snapshotTaskWorktree(request);
  assert.equal(snapshot.ok, true, snapshot.message);
  assert.equal(snapshot.head, git(path, "rev-parse", "HEAD"));
  assert.equal(git(path, "ls-files", "--stage"), indexBefore, "the real index is not changed");

  const clean = await gateway.diffTaskWorktreeSince(request, snapshot);
  assert.deepEqual(clean.files, []);

  // Reviewer: edit one line (+1/-1), add a file, delete a file, add a binary.
  await writeFile(join(path, "a.txt"), "a1\nCHANGED\na3\n");
  await writeFile(join(path, "added.txt"), "x\ny\n");
  await rm(join(path, "b.txt"));
  await writeFile(join(path, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
  await mkdir(join(path, "sub"), { recursive: true });
  await writeFile(join(path, "sub", "n.txt"), "n\n");
  await writeFile(join(path, "worker-new.txt"), "new\nmore\n");

  const diff = await gateway.diffTaskWorktreeSince(request, snapshot);
  assert.equal(diff.ok, true, diff.message);
  const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), ["a.txt", "added.txt", "b.txt", "bin.dat", "sub/n.txt", "worker-new.txt"]);
  assert.deepEqual([byPath["a.txt"].status, byPath["a.txt"].added_lines, byPath["a.txt"].deleted_lines], ["M", 1, 1]);
  assert.deepEqual([byPath["added.txt"].status, byPath["added.txt"].added_lines], ["A", 2]);
  assert.deepEqual([byPath["b.txt"].status, byPath["b.txt"].deleted_lines], ["D", 1]);
  assert.equal(byPath["bin.dat"].binary, true);
  assert.equal(diff.files.reduce((sum, file) => sum + file.added_lines + file.deleted_lines, 0), 1 + 1 + 2 + 1 + 1 + 1);
  assert.equal(git(path, "ls-files", "--stage"), indexBefore, "diffing leaves the real index alone");

  const restored = await gateway.restoreTaskWorktree(request, snapshot);
  assert.equal(restored.ok, true, restored.message);
  assert.equal(restored.verified, true);
  assert.equal(restored.tree, snapshot.tree);
  assert.equal(git(path, "status", "--porcelain=v1", "--untracked-files=all"), porcelainBefore);
  assert.equal(await readFile(join(path, "worker.txt"), "utf8"), "w1\nw2\nw3\n");
  assert.equal(await readFile(join(path, "worker-new.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(path, "b.txt"), "utf8"), "b\n");
});

test("a commit made after the snapshot is undone and the Worker's changes remain", async (t) => {
  const { gateway, path, request } = await fixture(t);
  await writeFile(join(path, "worker.txt"), "w1\nw2\nw3\n");
  const porcelainBefore = git(path, "status", "--porcelain=v1");
  const snapshot = await gateway.snapshotTaskWorktree(request);

  await writeFile(join(path, "a.txt"), "z\n");
  git(path, "add", "a.txt");
  git(path, "commit", "-m", "reviewer commit");
  const diff = await gateway.diffTaskWorktreeSince(request, snapshot);
  assert.notEqual(diff.head, snapshot.head);
  assert.deepEqual(diff.files.map((file) => file.path), ["a.txt"]);

  const restored = await gateway.restoreTaskWorktree(request, snapshot);
  assert.equal(restored.verified, true);
  assert.equal(git(path, "rev-parse", "HEAD"), snapshot.head);
  assert.equal(git(path, "status", "--porcelain=v1"), porcelainBefore);
  assert.equal(await readFile(join(path, "worker.txt"), "utf8"), "w1\nw2\nw3\n");
});

test("a Project-less Work gets ok: false from all three operations", async (t) => {
  const { gateway } = await fixture(t, { projectless: true });
  const request = { work_id: "W", task_id: "T1" };
  const snapshot = { head: "0".repeat(40), tree: "0".repeat(40) };
  assert.equal((await gateway.snapshotTaskWorktree(request)).ok, false);
  assert.equal((await gateway.diffTaskWorktreeSince(request, snapshot)).ok, false);
  assert.equal((await gateway.restoreTaskWorktree(request, snapshot)).ok, false);
});
