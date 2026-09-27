import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GitLanes } from "../packages/core/dist/index.js";
import { GitWorktreeGateway } from "../packages/core/dist/git-gateway.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(cwd, ...args) {
  try {
    return { ok: true, output: git(cwd, ...args) };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

async function projectRepo(parent, name = "repo") {
  const project = join(parent, name);
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  return project;
}

/** Each Work id maps to the Project repository at `projects[workId]`. */
function fakeDatabase(parent, projects) {
  return {
    get(sql, id) {
      if (sql.includes("SELECT project_id FROM works")) return projects[id] ? { project_id: id } : { project_id: null };
      if (sql.includes("FROM projects")) {
        return { canonical_path: projects[id], base_branch: "main", allowed_roots_json: JSON.stringify([parent]) };
      }
      return undefined;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Record the start and end of every git invocation the gateway makes. */
function traceGit(gateway, { delayMs = 0, hold = null } = {}) {
  const calls = [];
  const original = gateway.git.bind(gateway);
  gateway.git = async (cwd, args) => {
    const call = { cwd, args, start: performance.now(), end: null };
    calls.push(call);
    if (hold) await hold(cwd, args);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      return await original(cwd, args);
    } finally {
      call.end = performance.now();
    }
  };
  return calls;
}

function overlapping(calls) {
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  return sorted.some((call, index) => index > 0 && call.start < sorted[index - 1].end);
}

test("a conflicting merge is aborted before another Task of the same repository merges", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-git-lane-merge-")));
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, { W: project }), owlRoot);
  const a = await gateway.prepareWorktree({ work_id: "W", task_id: "A" });
  const b = await gateway.prepareWorktree({ work_id: "W", task_id: "B" });
  const c = await gateway.prepareWorktree({ work_id: "W", task_id: "C" });
  await writeFile(join(a.worktree_path, "README.md"), "A\n");
  await writeFile(join(b.worktree_path, "README.md"), "B\n");
  await writeFile(join(c.worktree_path, "c.txt"), "C\n");

  const first = await gateway.integrateTask({ work_id: "W", task_id: "A", worktree_path: a.worktree_path });
  assert.equal(first.merged, true, first.message);

  const [conflicting, clean] = await Promise.all([
    gateway.integrateTask({ work_id: "W", task_id: "B", worktree_path: b.worktree_path }),
    gateway.integrateTask({ work_id: "W", task_id: "C", worktree_path: c.worktree_path }),
  ]);
  assert.equal(conflicting.merged, false);
  assert.equal(conflicting.aborted, true, conflicting.abort_message);
  assert.equal(conflicting.worktree_removed, false);
  assert.equal(clean.merged, true, clean.message);
  assert.equal(clean.worktree_removed, true, clean.removal_message);

  assert.equal(git(project, "show", "owl/work/W/work:README.md"), "A");
  assert.equal(git(project, "show", "owl/work/W/work:c.txt"), "C");
  await access(b.worktree_path);
  await assert.rejects(access(c.worktree_path), "the merged Task worktree is removed");
  assert.equal(tryGit(join(owlRoot, ".owl-workspaces", "W", "__work__"), "rev-parse", "-q", "--verify", "MERGE_HEAD").ok, false);
});

test("worktrees of one repository are prepared one git call at a time", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-git-lane-prepare-")));
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, { W: project }), join(parent, "owl"));
  const calls = traceGit(gateway, { delayMs: 20 });

  const prepared = await Promise.all(["T1", "T2", "T3"].map((taskId) => gateway.prepareWorktree({ work_id: "W", task_id: taskId })));
  assert.ok(prepared.every((result) => result.ok), prepared.map((result) => result.message).join("\n"));
  assert.ok(calls.length >= 3);
  assert.equal(overlapping(calls), false, "git calls on one repository never overlap");
  const listed = git(project, "worktree", "list", "--porcelain");
  for (const result of prepared) assert.ok(listed.includes(`worktree ${result.worktree_path}`), result.worktree_path);
});

test("a merge left in progress in the integration worktree is aborted before the next merge", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-git-lane-leftover-")));
  const project = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, { W: project }), owlRoot);
  const a = await gateway.prepareWorktree({ work_id: "W", task_id: "A" });
  const c = await gateway.prepareWorktree({ work_id: "W", task_id: "C" });
  await writeFile(join(a.worktree_path, "README.md"), "A\n");
  await writeFile(join(c.worktree_path, "c.txt"), "C\n");
  assert.equal((await gateway.integrateTask({ work_id: "W", task_id: "A", worktree_path: a.worktree_path })).merged, true);

  // Leave a conflicted merge behind in the integration worktree.
  git(project, "branch", "other", "main");
  const other = join(parent, "other");
  git(project, "worktree", "add", other, "other");
  await writeFile(join(other, "README.md"), "other\n");
  git(other, "commit", "-am", "conflicting change");
  const integration = join(owlRoot, ".owl-workspaces", "W", "__work__");
  assert.equal(tryGit(integration, "merge", "--no-edit", "other").ok, false);
  assert.equal(tryGit(integration, "rev-parse", "-q", "--verify", "MERGE_HEAD").ok, true);

  const result = await gateway.integrateTask({ work_id: "W", task_id: "C", worktree_path: c.worktree_path });
  assert.equal(result.merged, true, result.message);
  assert.equal(git(project, "show", "owl/work/W/work:README.md"), "A");
  assert.equal(git(project, "show", "owl/work/W/work:c.txt"), "C");
});

test("different repositories do not wait for each other", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-git-lane-separate-")));
  const first = await projectRepo(parent, "first");
  const second = await projectRepo(parent, "second");
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, { W1: first, W2: second }), join(parent, "owl"));
  const blocked = deferred();
  traceGit(gateway, { hold: (cwd) => (cwd === first ? blocked.promise : undefined) });

  const pending = gateway.prepareWorktree({ work_id: "W1", task_id: "T" });
  const other = await gateway.prepareWorktree({ work_id: "W2", task_id: "T" });
  assert.equal(other.ok, true, other.message);
  blocked.resolve();
  assert.equal((await pending).ok, true);
});

test("a failed operation does not stop later operations on the same lane", async () => {
  const lanes = new GitLanes();
  const order = [];
  const failing = lanes.run("repo", async () => {
    order.push("first");
    throw new Error("boom");
  });
  const next = lanes.run("repo", async () => {
    order.push("second");
    return 2;
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 2);
  assert.deepEqual(order, ["first", "second"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(lanes.busy("repo"), false);
});
