import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { GitWorktreeGateway } from "../packages/core/dist/git-gateway.js";
import { openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

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

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-advisor-sweep-")));
  const projectPath = await projectRepo(parent);
  const owlRoot = join(parent, "owl");
  await mkdir(owlRoot, { recursive: true });
  const db = openDatabase(join(owlRoot, "owl.db"));
  db.migrate(migrations);
  const writeLane = db.createWriteLane();
  const gateway = new GitWorktreeGateway(db, owlRoot);
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    tx.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, '[]', '[]', ?, ?)`,
      "project:1", "owner:default", "Project", projectPath, JSON.stringify([parent]), now, now,
    );
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('work:1', 'owner:default', 'project:1', 'Work', 'x', 'normal', 'running', '[]', '[]', ?, ?)`,
      now, now,
    );
  });
  return { parent, projectPath, owlRoot, db, writeLane, gateway };
}

async function insertConversation(writeLane, id, { workId = null } = {}) {
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run(
      "INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, 'owner:default', ?, 'web', 1, ?, ?)",
      id, workId, now, now,
    );
  });
}

async function insertAdvisorSession(writeLane, id, conversationId, status, workspacePath) {
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO advisor_sessions (id, status, conversation_id, last_activity_at, workspace_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, status, conversationId, now, workspacePath, now, now,
    );
  });
}

test("sweepAdvisorWorkspaces keeps a live (not ended) session's workspace and branch", async () => {
  const { projectPath, writeLane, gateway } = await fixture();
  await insertConversation(writeLane, "conv-live", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-live" });
  assert.equal(prepared.ok, true, prepared.message);
  await insertAdvisorSession(writeLane, "session:live", "conv-live", "running", prepared.worktree_path);

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result, { removed_workspaces: [], removed_branches: [] });
  await access(prepared.worktree_path);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-live"), /owl\/advisor\/conv-live/);
});

test("sweepAdvisorWorkspaces removes a clean, fully merged, ended session's workspace and branch", async () => {
  const { projectPath, writeLane, gateway } = await fixture();
  await insertConversation(writeLane, "conv-ended", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-ended" });
  assert.equal(prepared.ok, true, prepared.message);
  await insertAdvisorSession(writeLane, "session:ended", "conv-ended", "ended", prepared.worktree_path);

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, [prepared.worktree_path]);
  assert.deepEqual(result.removed_branches, []);
  await assert.rejects(access(prepared.worktree_path), "the workspace directory is removed");
  assert.equal(git(projectPath, "branch", "--list", "owl/advisor/conv-ended"), "", "its branch is deleted too");
});

test("sweepAdvisorWorkspaces keeps an ended session's workspace that has uncommitted changes", async () => {
  const { projectPath, writeLane, gateway } = await fixture();
  await insertConversation(writeLane, "conv-dirty", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-dirty" });
  await insertAdvisorSession(writeLane, "session:dirty", "conv-dirty", "ended", prepared.worktree_path);
  await writeFile(join(prepared.worktree_path, "draft.txt"), "uncommitted\n");

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, []);
  await access(prepared.worktree_path);
  assert.equal(await readFile(join(prepared.worktree_path, "draft.txt"), "utf8"), "uncommitted\n");
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-dirty"), /owl\/advisor\/conv-dirty/);
});

test("sweepAdvisorWorkspaces keeps an ended session's workspace whose branch has commits not yet in base", async () => {
  const { projectPath, writeLane, gateway } = await fixture();
  await insertConversation(writeLane, "conv-unmerged", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-unmerged" });
  await insertAdvisorSession(writeLane, "session:unmerged", "conv-unmerged", "ended", prepared.worktree_path);
  await writeFile(join(prepared.worktree_path, "advisor-note.txt"), "advisor work\n");
  git(prepared.worktree_path, "add", "advisor-note.txt");
  git(prepared.worktree_path, "commit", "-m", "advisor commit");

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, []);
  await access(prepared.worktree_path);
  assert.equal(git(prepared.worktree_path, "show", "HEAD:advisor-note.txt"), "advisor work");
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-unmerged"), /owl\/advisor\/conv-unmerged/);
});

test("sweepAdvisorWorkspaces removes an empty stray directory that is not a registered worktree", async () => {
  const { owlRoot, gateway } = await fixture();
  const strayPath = join(owlRoot, ".owl-workspaces", "advisor", "stray-empty");
  await mkdir(strayPath, { recursive: true });

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, [strayPath]);
  await assert.rejects(access(strayPath), "the empty stray directory is removed");
});

test("sweepAdvisorWorkspaces keeps a non-empty stray directory that is not a registered worktree", async () => {
  const { owlRoot, gateway } = await fixture();
  const strayPath = join(owlRoot, ".owl-workspaces", "advisor", "stray-full");
  await mkdir(strayPath, { recursive: true });
  await writeFile(join(strayPath, "leftover.txt"), "leftover\n");

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, []);
  assert.equal(await readFile(join(strayPath, "leftover.txt"), "utf8"), "leftover\n");
});

test("sweepAdvisorWorkspaces deletes a merged owl/advisor branch left behind once its worktree is gone", async () => {
  const { projectPath, writeLane, gateway } = await fixture();
  await insertConversation(writeLane, "conv-orphan", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-orphan" });
  assert.equal(prepared.ok, true, prepared.message);
  git(projectPath, "worktree", "remove", "--force", prepared.worktree_path);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-orphan"), /owl\/advisor\/conv-orphan/);

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_branches, ["owl/advisor/conv-orphan"]);
  assert.equal(git(projectPath, "branch", "--list", "owl/advisor/conv-orphan"), "");
});

test("prepareAdvisorWorkspace recreates a swept conversation's workspace fresh from base", async () => {
  const { projectPath, writeLane, gateway } = await fixture();
  await insertConversation(writeLane, "conv-recreate", { workId: "work:1" });
  const first = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-recreate" });
  assert.equal(first.ok, true, first.message);
  await insertAdvisorSession(writeLane, "session:recreate", "conv-recreate", "ended", first.worktree_path);

  const swept = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(swept.removed_workspaces, [first.worktree_path]);
  assert.equal(git(projectPath, "branch", "--list", "owl/advisor/conv-recreate"), "");

  const second = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-recreate" });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.worktree_path, first.worktree_path);
  assert.match(second.message, /Prepared Advisor branch/, "it is branched fresh from base, not reused");
  assert.equal(git(second.worktree_path, "show", "HEAD:README.md"), "base");
});
