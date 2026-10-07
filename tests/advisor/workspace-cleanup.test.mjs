import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { createTestDatabase } from "../helpers/db.mjs";
import { createTestRepo, git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function fixture(t) {
  const parent = await tempDir(t, "owl-advisor-sweep-");
  const projectPath = await createTestRepo(t, { prefix: "owl-advisor-sweep-repo-", files: { "README.md": "base\n" } });
  const owlRoot = join(parent, "owl");
  await mkdir(owlRoot, { recursive: true });
  const db = createTestDatabase(owlRoot);
  t.after(() => db.close());
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
      "project:1", "owner:default", "Project", projectPath, JSON.stringify([parent, projectPath]), now, now,
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

test("sweepAdvisorWorkspaces keeps a live (not ended) session's workspace and branch", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-live", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-live" });
  assert.equal(prepared.ok, true, prepared.message);
  await insertAdvisorSession(writeLane, "session:live", "conv-live", "running", prepared.worktree_path);

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result, { removed_workspaces: [], removed_branches: [] });
  await access(prepared.worktree_path);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-live"), /owl\/advisor\/conv-live/);
});

test("sweepAdvisorWorkspaces removes a clean, fully merged, ended session's workspace and branch", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
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

test("sweepAdvisorWorkspaces keeps an ended session's workspace that has uncommitted changes", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
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

test("sweepAdvisorWorkspaces keeps an ended session's workspace whose branch has commits not yet in base", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
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

test("sweepAdvisorWorkspaces removes an empty stray directory that is not a registered worktree", async (t) => {
  const { owlRoot, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "stray-empty");
  const strayPath = join(owlRoot, ".owl-workspaces", "advisor", "stray-empty");
  await mkdir(strayPath, { recursive: true });

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, [strayPath]);
  await assert.rejects(access(strayPath), "the empty stray directory is removed");
});

test("sweepAdvisorWorkspaces keeps a non-empty stray directory that is not a registered worktree", async (t) => {
  const { owlRoot, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "stray-full");
  const strayPath = join(owlRoot, ".owl-workspaces", "advisor", "stray-full");
  await mkdir(strayPath, { recursive: true });
  await writeFile(join(strayPath, "leftover.txt"), "leftover\n");

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, []);
  assert.equal(await readFile(join(strayPath, "leftover.txt"), "utf8"), "leftover\n");
});

test("sweepAdvisorWorkspaces deletes a merged owl/advisor branch left behind once its worktree is gone", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-orphan", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-orphan" });
  assert.equal(prepared.ok, true, prepared.message);
  git(projectPath, "worktree", "remove", "--force", prepared.worktree_path);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-orphan"), /owl\/advisor\/conv-orphan/);

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_branches, ["owl/advisor/conv-orphan"]);
  assert.equal(git(projectPath, "branch", "--list", "owl/advisor/conv-orphan"), "");
});

test("prepareAdvisorWorkspace recreates a swept conversation's workspace fresh from base", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
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

async function forgetConversation(writeLane, id) {
  await writeLane.transact((tx) => {
    tx.run("DELETE FROM conversations WHERE id = ?", id);
  });
}

test("sweepAdvisorWorkspaces leaves a clean, merged workspace of a conversation this database does not know", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-foreign", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-foreign" });
  assert.equal(prepared.ok, true, prepared.message);
  await forgetConversation(writeLane, "conv-foreign");

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result, { removed_workspaces: [], removed_branches: [] });
  await access(prepared.worktree_path);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-foreign"), /owl\/advisor\/conv-foreign/);
});

test("sweepAdvisorWorkspaces leaves an empty stray directory of an unknown conversation", async (t) => {
  const { owlRoot, gateway } = await fixture(t);
  const strayPath = join(owlRoot, ".owl-workspaces", "advisor", "stray-foreign");
  await mkdir(strayPath, { recursive: true });

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, []);
  await access(strayPath);
});

test("sweepAdvisorWorkspaces keeps a merged owl/advisor branch of an unknown conversation", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-foreign-branch", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-foreign-branch" });
  assert.equal(prepared.ok, true, prepared.message);
  git(projectPath, "worktree", "remove", "--force", prepared.worktree_path);
  await forgetConversation(writeLane, "conv-foreign-branch");

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_branches, []);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-foreign-branch"), /owl\/advisor\/conv-foreign-branch/);
});

test("prepareAdvisorWorkspace recreates the worktree when an empty unregistered directory sits at its path", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-empty-dir", { workId: "work:1" });
  const first = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-empty-dir" });
  assert.equal(first.ok, true, first.message);
  git(projectPath, "worktree", "remove", "--force", first.worktree_path);
  await mkdir(first.worktree_path, { recursive: true });

  const second = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-empty-dir" });
  assert.equal(second.ok, true, second.message);
  assert.equal(git(second.worktree_path, "show", "HEAD:README.md"), "base");
});

test("prepareAdvisorWorkspace still refuses a non-empty unregistered directory at its path", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-full-dir", { workId: "work:1" });
  const first = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-full-dir" });
  assert.equal(first.ok, true, first.message);
  git(projectPath, "worktree", "remove", "--force", first.worktree_path);
  await mkdir(first.worktree_path, { recursive: true });
  await writeFile(join(first.worktree_path, "keep.txt"), "keep\n");

  const second = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-full-dir" });
  assert.equal(second.ok, false);
  assert.match(second.message, /not registered with Git/);
  assert.equal(await readFile(join(first.worktree_path, "keep.txt"), "utf8"), "keep\n");
});
