import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { reconcileWorktrees } from "../../packages/core/dist/index.js";
import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { saveProjectlessWorkOutputs } from "../../packages/core/dist/outputs-store.js";
import { openTestDatabase } from "../helpers/db.mjs";

async function fixture(t) {
  const { root: owlRoot, db } = await openTestDatabase(t, { prefix: "owl-outputs-" });
  const dataDir = join(owlRoot, "data");
  const writeLane = db.createWriteLane();
  const gateway = new GitWorktreeGateway(db, owlRoot);
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
  });
  return { owlRoot, dataDir, db, writeLane, gateway };
}

async function insertWork(writeLane, id, { state = "running" } = {}) {
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', NULL, 'Work', 'x', 'normal', ?, '[]', '[]', ?, ?)`,
      id, state, now, now,
    );
  });
}

async function setWorkState(writeLane, id, state) {
  await writeLane.transact((tx) => {
    tx.run("UPDATE works SET state = ?, updated_at = ? WHERE id = ?", state, new Date().toISOString(), id);
  });
}

async function insertTask(writeLane, id, workId, { status, updatedAt }) {
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO tasks
         (id, work_id, title, type, status, priority, context, acceptance,
          worker_generation, created_at, updated_at)
       VALUES (?, ?, 'Task', 'code', ?, 'normal', '', 'Done.', 0, ?, ?)`,
      id, workId, status, updatedAt, updatedAt,
    );
  });
}

async function insertDependency(writeLane, taskId, dependsOnTaskId) {
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", taskId, dependsOnTaskId);
  });
}

async function readText(path) {
  return readFile(path, "utf8");
}

async function dirExists(path) {
  return readdir(path).then(() => true, () => false);
}

test("a Task that depends on the current owner overwrites its file; an unrelated Task's conflicting version is kept alongside it", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W1", { state: "running" });
  await insertTask(writeLane, "T1", "W1", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });
  await insertTask(writeLane, "T2", "W1", { status: "completed", updatedAt: "2030-01-01T00:00:01.000Z" });
  await insertTask(writeLane, "T3", "W1", { status: "completed", updatedAt: "2030-01-01T00:00:02.000Z" });
  await insertDependency(writeLane, "T2", "T1");

  const t1 = await gateway.prepareWorktree({ work_id: "W1", task_id: "T1" });
  await writeFile(join(t1.worktree_path, "shared.txt"), "from T1");
  const t2 = await gateway.prepareWorktree({ work_id: "W1", task_id: "T2" });
  await writeFile(join(t2.worktree_path, "shared.txt"), "from T2");
  const t3 = await gateway.prepareWorktree({ work_id: "W1", task_id: "T3" });
  await writeFile(join(t3.worktree_path, "shared.txt"), "from T3");

  await setWorkState(writeLane, "W1", "completed");
  const result = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir },
    { work_id: "W1", reason: "work_completed" },
  );
  assert.deepEqual(result, { discarded: [], skipped: [] });

  const workspaceDir = join(owlRoot, ".owl-workspaces", "W1");
  assert.equal(await dirExists(workspaceDir), false, "the Work's isolated workspaces are removed");

  const outputsDir = join(dataDir, "outputs", "W1");
  assert.equal(await readText(join(outputsDir, "shared.txt")), "from T2", "T2 overwrote T1's file because it depends on T1");
  assert.equal(await readText(join(outputsDir, "shared.T3.txt")), "from T3", "T3's unrelated, conflicting version is saved alongside it");
});

test("the conflict file is named with the later Task's short id, and the earlier Task's version is untouched", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W2", { state: "running" });
  await insertTask(writeLane, "task-aaaaaaaa1111", "W2", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });
  await insertTask(writeLane, "task-bbbbbbbb2222", "W2", { status: "completed", updatedAt: "2030-01-01T00:00:01.000Z" });

  const first = await gateway.prepareWorktree({ work_id: "W2", task_id: "task-aaaaaaaa1111" });
  await writeFile(join(first.worktree_path, "shared.txt"), "from first");
  const second = await gateway.prepareWorktree({ work_id: "W2", task_id: "task-bbbbbbbb2222" });
  await writeFile(join(second.worktree_path, "shared.txt"), "from second");

  await setWorkState(writeLane, "W2", "completed");
  const saved = await saveProjectlessWorkOutputs({ db, owlRoot, dataDir }, "W2");
  assert.equal(saved, true);

  const outputsDir = join(dataDir, "outputs", "W2");
  assert.equal(await readText(join(outputsDir, "shared.txt")), "from first", "the existing file is kept as-is");
  assert.equal(
    await readText(join(outputsDir, `shared.${"task-bbbbbbbb2222".slice(-8)}.txt`)),
    "from second",
    "the later, unrelated version is saved alongside it, named with the Task's short id",
  );
});

test("files Owl writes under .git in an isolated workspace are excluded from the outputs folder", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W3", { state: "running" });
  await insertTask(writeLane, "T1", "W3", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });

  const prepared = await gateway.prepareWorktree({ work_id: "W3", task_id: "T1" });
  await writeFile(join(prepared.worktree_path, "code.ts"), "export {};\n");
  await mkdir(join(prepared.worktree_path, ".git"), { recursive: true });
  await writeFile(join(prepared.worktree_path, ".git", "HEAD"), "ref: refs/heads/main\n");

  await setWorkState(writeLane, "W3", "completed");
  const saved = await saveProjectlessWorkOutputs({ db, owlRoot, dataDir }, "W3");
  assert.equal(saved, true);

  const outputsDir = join(dataDir, "outputs", "W3");
  assert.equal(await readText(join(outputsDir, "code.ts")), "export {};\n");
  assert.equal(await dirExists(join(outputsDir, ".git")), false, "the .git directory is not copied into the outputs folder");
});

test("a Task's isolated workspace is removed only after its files are verified in the outputs folder", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W4", { state: "running" });
  await insertTask(writeLane, "T1", "W4", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });

  const prepared = await gateway.prepareWorktree({ work_id: "W4", task_id: "T1" });
  await mkdir(join(prepared.worktree_path, "src"), { recursive: true });
  await writeFile(join(prepared.worktree_path, "src", "app.ts"), "export const x = 1;\n");

  const workspaceDir = join(owlRoot, ".owl-workspaces", "W4");
  assert.equal(await dirExists(workspaceDir), true);

  await setWorkState(writeLane, "W4", "completed");
  const saved = await saveProjectlessWorkOutputs({ db, owlRoot, dataDir }, "W4");
  assert.equal(saved, true);

  assert.equal(await dirExists(workspaceDir), false);
  assert.equal(await readText(join(dataDir, "outputs", "W4", "src", "app.ts")), "export const x = 1;\n");

  // Calling it again once the workspace is gone is a harmless no-op.
  const second = await saveProjectlessWorkOutputs({ db, owlRoot, dataDir }, "W4");
  assert.equal(second, true);
});

test("a save that cannot complete leaves the isolated workspace and any existing outputs folder untouched", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W5", { state: "running" });

  // Seed an existing outputs folder, as if an earlier Work had already been saved.
  const outputsDir = join(dataDir, "outputs", "W5");
  await mkdir(outputsDir, { recursive: true });
  await writeFile(join(outputsDir, "keep.txt"), "baseline");

  await insertTask(writeLane, "TA", "W5", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });
  await insertTask(writeLane, "TB", "W5", { status: "completed", updatedAt: "2030-01-01T00:00:01.000Z" });
  const a = await gateway.prepareWorktree({ work_id: "W5", task_id: "TA" });
  await writeFile(join(a.worktree_path, "conflict"), "A");
  const b = await gateway.prepareWorktree({ work_id: "W5", task_id: "TB" });
  await mkdir(join(b.worktree_path, "conflict"), { recursive: true });
  await writeFile(join(b.worktree_path, "conflict", "nested.txt"), "B");

  await setWorkState(writeLane, "W5", "completed");
  const saved = await saveProjectlessWorkOutputs({ db, owlRoot, dataDir }, "W5");
  assert.equal(saved, false, "TA's file and TB's directory collide at the same path, so the save cannot complete");

  const workspaceDir = join(owlRoot, ".owl-workspaces", "W5");
  assert.equal(await dirExists(workspaceDir), true, "the isolated workspaces are kept for a retry");
  assert.equal(await readText(join(outputsDir, "keep.txt")), "baseline", "the existing outputs folder is left intact");

  const outputsRoot = join(dataDir, "outputs");
  const leftovers = (await readdir(outputsRoot)).filter((name) => name !== "W5");
  assert.deepEqual(leftovers, [], "no staging or backup directories are left behind");
});

test("a startup sweep saves and removes a terminal Project-less Work's workspace, leaving a running one untouched", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W6", { state: "completed" });
  await insertTask(writeLane, "T1", "W6", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });
  const done = await gateway.prepareWorktree({ work_id: "W6", task_id: "T1" });
  await writeFile(join(done.worktree_path, "result.txt"), "finished");

  await insertWork(writeLane, "W7", { state: "running" });
  await insertTask(writeLane, "T2", "W7", { status: "running", updatedAt: "2030-01-01T00:00:00.000Z" });
  const running = await gateway.prepareWorktree({ work_id: "W7", task_id: "T2" });
  await writeFile(join(running.worktree_path, "wip.txt"), "still going");

  const result = await reconcileWorktrees({ db, writeLane, git: gateway, owlRoot, dataDir }, { reason: "startup" });
  assert.deepEqual(result.discarded, ["W6:outputs"]);

  assert.equal(await dirExists(join(owlRoot, ".owl-workspaces", "W6")), false);
  assert.equal(await readText(join(dataDir, "outputs", "W6", "result.txt")), "finished");
  assert.equal(await dirExists(join(owlRoot, ".owl-workspaces", "W7")), true, "a running Work's workspace is left untouched");
  assert.equal(await readText(join(running.worktree_path, "wip.txt")), "still going");
});

test("reopening a completed Work and completing it again keeps the outputs an earlier save already wrote", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W8", { state: "running" });
  await insertTask(writeLane, "T1", "W8", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });
  const t1 = await gateway.prepareWorktree({ work_id: "W8", task_id: "T1" });
  await writeFile(join(t1.worktree_path, "keep1.txt"), "v1");

  await setWorkState(writeLane, "W8", "completed");
  const firstResult = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir },
    { work_id: "W8", reason: "work_completed" },
  );
  assert.deepEqual(firstResult, { discarded: [], skipped: [] });
  assert.equal(await dirExists(join(owlRoot, ".owl-workspaces", "W8")), false);
  assert.equal(await readText(join(dataDir, "outputs", "W8", "keep1.txt")), "v1");

  // Reopen: the Work leaves its terminal state and a new Task is added and runs.
  await setWorkState(writeLane, "W8", "running");
  await insertTask(writeLane, "T2", "W8", { status: "completed", updatedAt: "2030-01-01T00:00:05.000Z" });
  const t2 = await gateway.prepareWorktree({ work_id: "W8", task_id: "T2" });
  await writeFile(join(t2.worktree_path, "keep2.txt"), "v2");

  await setWorkState(writeLane, "W8", "completed");
  const secondResult = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir },
    { work_id: "W8", reason: "work_completed" },
  );
  assert.deepEqual(secondResult, { discarded: [], skipped: [] });
  assert.equal(await dirExists(join(owlRoot, ".owl-workspaces", "W8")), false);
  assert.equal(await readText(join(dataDir, "outputs", "W8", "keep1.txt")), "v1", "the first round's file is kept");
  assert.equal(await readText(join(dataDir, "outputs", "W8", "keep2.txt")), "v2", "the second round's file is added");
});

test("a cancelled Work's in-progress Task file is saved to the outputs folder, not deleted with its workspace", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W9", { state: "running" });
  await insertTask(writeLane, "T1", "W9", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });
  await insertTask(writeLane, "T2", "W9", { status: "running", updatedAt: "2030-01-01T00:00:01.000Z" });

  const t1 = await gateway.prepareWorktree({ work_id: "W9", task_id: "T1" });
  await writeFile(join(t1.worktree_path, "done.txt"), "finished by T1");
  const t2 = await gateway.prepareWorktree({ work_id: "W9", task_id: "T2" });
  await writeFile(join(t2.worktree_path, "wip.txt"), "still being written by T2");

  await setWorkState(writeLane, "W9", "cancelled");
  const result = await reconcileWorktrees(
    { db, writeLane, git: gateway, owlRoot, dataDir },
    { work_id: "W9", reason: "work_cancelled" },
  );
  assert.deepEqual(result, { discarded: [], skipped: [] });

  assert.equal(await dirExists(join(owlRoot, ".owl-workspaces", "W9")), false, "the cancelled Work's isolated workspaces are removed");
  const outputsDir = join(dataDir, "outputs", "W9");
  assert.equal(await readText(join(outputsDir, "done.txt")), "finished by T1");
  assert.equal(await readText(join(outputsDir, "wip.txt")), "still being written by T2", "T2's unfinished file is saved, not lost");
});

test("a non-completed Task never overwrites a completed Task's file; its conflicting version is kept alongside it", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W10", { state: "running" });
  await insertTask(writeLane, "T1", "W10", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });
  await insertTask(writeLane, "T2", "W10", { status: "failed", updatedAt: "2030-01-01T00:00:01.000Z" });

  const t1 = await gateway.prepareWorktree({ work_id: "W10", task_id: "T1" });
  await writeFile(join(t1.worktree_path, "shared.txt"), "from the completed Task");
  const t2 = await gateway.prepareWorktree({ work_id: "W10", task_id: "T2" });
  await writeFile(join(t2.worktree_path, "shared.txt"), "from the failed Task");

  await setWorkState(writeLane, "W10", "cancelled");
  const saved = await saveProjectlessWorkOutputs({ db, owlRoot, dataDir }, "W10");
  assert.equal(saved, true);

  const outputsDir = join(dataDir, "outputs", "W10");
  assert.equal(await readText(join(outputsDir, "shared.txt")), "from the completed Task", "the failed Task never overwrites it");
  assert.equal(
    await readText(join(outputsDir, "shared.T2.txt")),
    "from the failed Task",
    "its own version is kept alongside, named with its short id",
  );
});

test("a workspace directory that matches no Task at all is folded into the outputs folder rather than dropped", async (t) => {
  const { owlRoot, dataDir, db, writeLane, gateway } = await fixture(t);
  await insertWork(writeLane, "W11", { state: "running" });
  await insertTask(writeLane, "T1", "W11", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });

  const t1 = await gateway.prepareWorktree({ work_id: "W11", task_id: "T1" });
  await writeFile(join(t1.worktree_path, "result.txt"), "from T1");
  const stray = await gateway.prepareWorktree({ work_id: "W11", task_id: null });
  await writeFile(join(stray.worktree_path, "notes.txt"), "from a non-Task directory");

  await setWorkState(writeLane, "W11", "completed");
  const saved = await saveProjectlessWorkOutputs({ db, owlRoot, dataDir }, "W11");
  assert.equal(saved, true);

  const outputsDir = join(dataDir, "outputs", "W11");
  assert.equal(await readText(join(outputsDir, "result.txt")), "from T1");
  assert.equal(await readText(join(outputsDir, "notes.txt")), "from a non-Task directory", "the stray directory's file is saved, not dropped");
});
