import assert from "node:assert/strict";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { GitLanes } from "../../packages/core/dist/git-lane.js";
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

/** A pre-shared-worktree, per-conversation Advisor worktree and branch, as older Owl versions created them. */
function addLegacyAdvisorWorktree({ projectPath, owlRoot }, conversationId) {
  const worktreePath = join(owlRoot, ".owl-workspaces", "advisor", conversationId);
  git(projectPath, "worktree", "add", "-b", `owl/advisor/${conversationId}`, worktreePath, "main");
  return { ok: true, worktree_path: worktreePath };
}

async function insertProject(writeLane, id, path, allowedRoots) {
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, 'owner:default', ?, ?, 'main', ?, '[]', '[]', ?, ?)`,
      id, id, path, JSON.stringify(allowedRoots), now, now,
    );
  });
}

async function insertWork(writeLane, id, projectId) {
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', ?, 'Work', 'x', 'normal', 'running', '[]', '[]', ?, ?)`,
      id, projectId, now, now,
    );
  });
}

function sharedWorktreeEntries(repoPath) {
  return git(repoPath, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ") && line.includes("/advisor/shared/"));
}

function advisorBranches(repoPath) {
  return git(repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads/owl/advisor/").split("\n").filter(Boolean);
}

function commitOnMain(repoPath, name) {
  return git(repoPath, "commit", "--allow-empty", "-m", name) && git(repoPath, "rev-parse", "main");
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
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
  await insertConversation(writeLane, "conv-live", { workId: "work:1" });
  const prepared = addLegacyAdvisorWorktree(fx, "conv-live");
  assert.equal(prepared.ok, true, prepared.message);
  await insertAdvisorSession(writeLane, "session:live", "conv-live", "running", prepared.worktree_path);

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result, { removed_workspaces: [], removed_branches: [] });
  await access(prepared.worktree_path);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-live"), /owl\/advisor\/conv-live/);
});

test("sweepAdvisorWorkspaces removes a clean, fully merged, ended session's workspace and branch", async (t) => {
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
  await insertConversation(writeLane, "conv-ended", { workId: "work:1" });
  const prepared = addLegacyAdvisorWorktree(fx, "conv-ended");
  assert.equal(prepared.ok, true, prepared.message);
  await insertAdvisorSession(writeLane, "session:ended", "conv-ended", "ended", prepared.worktree_path);

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, [prepared.worktree_path]);
  assert.deepEqual(result.removed_branches, []);
  await assert.rejects(access(prepared.worktree_path), "the workspace directory is removed");
  assert.equal(git(projectPath, "branch", "--list", "owl/advisor/conv-ended"), "", "its branch is deleted too");
});

test("sweepAdvisorWorkspaces keeps an ended session's workspace that has uncommitted changes", async (t) => {
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
  await insertConversation(writeLane, "conv-dirty", { workId: "work:1" });
  const prepared = addLegacyAdvisorWorktree(fx, "conv-dirty");
  await insertAdvisorSession(writeLane, "session:dirty", "conv-dirty", "ended", prepared.worktree_path);
  await writeFile(join(prepared.worktree_path, "draft.txt"), "uncommitted\n");

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_workspaces, []);
  await access(prepared.worktree_path);
  assert.equal(await readFile(join(prepared.worktree_path, "draft.txt"), "utf8"), "uncommitted\n");
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-dirty"), /owl\/advisor\/conv-dirty/);
});

test("sweepAdvisorWorkspaces keeps an ended session's workspace whose branch has commits not yet in base", async (t) => {
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
  await insertConversation(writeLane, "conv-unmerged", { workId: "work:1" });
  const prepared = addLegacyAdvisorWorktree(fx, "conv-unmerged");
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
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
  await insertConversation(writeLane, "conv-orphan", { workId: "work:1" });
  const prepared = addLegacyAdvisorWorktree(fx, "conv-orphan");
  assert.equal(prepared.ok, true, prepared.message);
  git(projectPath, "worktree", "remove", "--force", prepared.worktree_path);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-orphan"), /owl\/advisor\/conv-orphan/);

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_branches, ["owl/advisor/conv-orphan"]);
  assert.equal(git(projectPath, "branch", "--list", "owl/advisor/conv-orphan"), "");
});

test("prepareAdvisorWorkspace recreates the shared worktree fresh from base after it was removed", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-recreate", { workId: "work:1" });
  const first = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-recreate" });
  assert.equal(first.ok, true, first.message);
  git(projectPath, "worktree", "remove", "--force", first.worktree_path);

  const second = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-recreate" });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.worktree_path, first.worktree_path);
  assert.equal(second.synced, true);
  assert.equal(git(second.worktree_path, "show", "HEAD:README.md"), "base");
});

async function forgetConversation(writeLane, id) {
  await writeLane.transact((tx) => {
    tx.run("DELETE FROM conversations WHERE id = ?", id);
  });
}

test("sweepAdvisorWorkspaces leaves a clean, merged workspace of a conversation this database does not know", async (t) => {
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
  await insertConversation(writeLane, "conv-foreign", { workId: "work:1" });
  const prepared = addLegacyAdvisorWorktree(fx, "conv-foreign");
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
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
  await insertConversation(writeLane, "conv-foreign-branch", { workId: "work:1" });
  const prepared = addLegacyAdvisorWorktree(fx, "conv-foreign-branch");
  assert.equal(prepared.ok, true, prepared.message);
  git(projectPath, "worktree", "remove", "--force", prepared.worktree_path);
  await forgetConversation(writeLane, "conv-foreign-branch");

  const result = await gateway.sweepAdvisorWorkspaces();
  assert.deepEqual(result.removed_branches, []);
  assert.match(git(projectPath, "branch", "--list", "owl/advisor/conv-foreign-branch"), /owl\/advisor\/conv-foreign-branch/);
});

test("prepareAdvisorWorkspace recreates the worktree when an empty unregistered directory sits at its path", async (t) => {
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
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
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
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

test("prepareAdvisorWorkspace shares one worktree across conversations of the same repository", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-a", { workId: "work:1" });
  await insertWork(writeLane, "work:3", "project:1");
  await insertConversation(writeLane, "conv-b", { workId: "work:3" });
  const a = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-a" });
  const b = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-b" });
  const byProject = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-a", project_id: "project:1" });

  for (const prepared of [a, b, byProject]) assert.equal(prepared.ok, true, prepared.message);
  assert.equal(a.kind, "worktree");
  assert.equal(b.worktree_path, a.worktree_path);
  assert.equal(byProject.worktree_path, a.worktree_path);
  assert.equal(sharedWorktreeEntries(projectPath).length, 1);
  assert.equal(advisorBranches(projectPath).length, 1);
});

test("prepareAdvisorWorkspace shares one worktree, branch and git lane between a main checkout and a differently named linked worktree registered as separate Projects", async (t) => {
  const fx = await fixture(t);
  const { parent, projectPath, owlRoot, db, writeLane } = fx;
  const linkedPath = join(parent, "another-name-checkout");
  git(projectPath, "worktree", "add", "-b", "linked-checkout", linkedPath, "main");
  await insertProject(writeLane, "project:2", linkedPath, [parent]);
  await insertWork(writeLane, "work:2", "project:2");
  await insertConversation(writeLane, "conv-main", { workId: "work:1" });
  await insertConversation(writeLane, "conv-linked", { workId: "work:2" });
  const laneKeys = [];
  class RecordingLanes extends GitLanes {
    run(key, operation) {
      laneKeys.push(key);
      return super.run(key, operation);
    }
  }
  const gateway = new GitWorktreeGateway(db, owlRoot, new RecordingLanes());

  const fromMain = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-main" });
  const fromLinked = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-linked" });

  for (const prepared of [fromMain, fromLinked]) {
    assert.equal(prepared.ok, true, prepared.message);
    assert.equal(prepared.kind, "worktree");
  }
  assert.equal(fromLinked.worktree_path, fromMain.worktree_path);
  assert.equal(fromLinked.branch, fromMain.branch);
  assert.ok(!fromMain.worktree_path.includes("another-name-checkout"));
  assert.equal(sharedWorktreeEntries(projectPath).length, 1);
  assert.equal(advisorBranches(projectPath).length, 1);
  assert.deepEqual([...new Set(laneKeys)], [await realpath(projectPath)]);
});

test("resolveAdvisorSessionDirectory creates no worktree and points outside the repository", async (t) => {
  const { projectPath, owlRoot, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-read", { workId: "work:1" });
  const before = git(projectPath, "worktree", "list", "--porcelain");

  const directory = await gateway.resolveAdvisorSessionDirectory({ conversation_id: "conv-read" });

  assert.equal(directory.kind, "repository");
  assert.equal(directory.cwd, await realpath(join(owlRoot, ".owl-workspaces", "advisor", "home")));
  assert.ok(relative(await realpath(projectPath), directory.cwd).startsWith(".."), "cwd is outside the repository");
  assert.equal(directory.repository_root, await realpath(projectPath));
  assert.equal(directory.base_branch, "main");
  assert.equal(git(projectPath, "worktree", "list", "--porcelain"), before);
  assert.deepEqual(advisorBranches(projectPath), []);
});

test("prepareAdvisorWorkspace fast-forwards a clean shared worktree to the latest base head", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-ff", { workId: "work:1" });
  const first = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-ff" });
  assert.equal(first.synced, true, first.message);
  await writeFile(join(projectPath, ".gitignore"), "ignored.log\n");
  git(projectPath, "add", ".gitignore");
  git(projectPath, "commit", "-m", "ignore logs");
  const second = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-ff" });
  assert.equal(second.synced, true, second.message);
  await writeFile(join(second.worktree_path, "ignored.log"), "keep me\n");

  const head = commitOnMain(projectPath, "newer base");
  const third = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-ff" });

  assert.equal(third.synced, true, third.message);
  assert.deepEqual(third.dirty_reasons, []);
  assert.equal(git(third.worktree_path, "rev-parse", "HEAD"), head);
  assert.equal(third.base_head, head);
  assert.equal(await readFile(join(third.worktree_path, "ignored.log"), "utf8"), "keep me\n");
});

test("prepareAdvisorWorkspace leaves uncommitted changes untouched and reports them", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-uncommitted", { workId: "work:1" });
  const first = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-uncommitted" });
  await writeFile(join(first.worktree_path, "draft.txt"), "uncommitted\n");
  const headBefore = git(first.worktree_path, "rev-parse", "HEAD");
  commitOnMain(projectPath, "newer base");

  const second = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-uncommitted" });

  assert.equal(second.ok, true, second.message);
  assert.equal(second.synced, false);
  assert.deepEqual(second.dirty_reasons, ["uncommitted_changes"]);
  assert.equal(git(first.worktree_path, "rev-parse", "HEAD"), headBefore);
  assert.equal(await readFile(join(first.worktree_path, "draft.txt"), "utf8"), "uncommitted\n");
});

test("prepareAdvisorWorkspace leaves unmerged commits untouched and reports them", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-unmerged-commit", { workId: "work:1" });
  const first = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-unmerged-commit" });
  await writeFile(join(first.worktree_path, "advisor-note.txt"), "advisor work\n");
  git(first.worktree_path, "add", "advisor-note.txt");
  git(first.worktree_path, "commit", "-m", "advisor commit");
  const headBefore = git(first.worktree_path, "rev-parse", "HEAD");
  commitOnMain(projectPath, "newer base");

  const second = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-unmerged-commit" });

  assert.equal(second.ok, true, second.message);
  assert.equal(second.synced, false);
  assert.deepEqual(second.dirty_reasons, ["unmerged_commits"]);
  assert.equal(git(first.worktree_path, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(first.worktree_path, "show", "HEAD:advisor-note.txt"), "advisor work");
});

test("inspectAdvisorWorkspace reports the shared worktree as dirty with its path", async (t) => {
  const { writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-inspect", { workId: "work:1" });
  assert.deepEqual(await gateway.inspectAdvisorWorkspace({ conversation_id: "conv-inspect" }), {
    ok: true, dirty: false, message: "No shared Advisor workspace.",
  });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-inspect" });
  assert.equal((await gateway.inspectAdvisorWorkspace({ conversation_id: "conv-inspect" })).dirty, false);
  await writeFile(join(prepared.worktree_path, "draft.txt"), "uncommitted\n");

  const inspection = await gateway.inspectAdvisorWorkspace({ conversation_id: "conv-inspect" });

  assert.equal(inspection.ok, true, inspection.message);
  assert.equal(inspection.dirty, true);
  assert.equal(inspection.worktree_path, prepared.worktree_path);
});

test("sweepAdvisorWorkspaces never removes the shared worktree, its branch or the home directory", async (t) => {
  const { projectPath, writeLane, gateway } = await fixture(t);
  await insertConversation(writeLane, "conv-keep", { workId: "work:1" });
  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-keep" });
  const directory = await gateway.resolveAdvisorSessionDirectory({ conversation_id: "conv-keep" });

  const result = await gateway.sweepAdvisorWorkspaces();

  assert.deepEqual(result, { removed_workspaces: [], removed_branches: [] });
  await access(prepared.worktree_path);
  await access(directory.cwd);
  assert.deepEqual(advisorBranches(projectPath), [prepared.branch]);
});

test("sweepAdvisorWorkspaces keeps a legacy branch that is not an ancestor of base", async (t) => {
  const fx = await fixture(t);
  const { projectPath, writeLane, gateway } = fx;
  await insertConversation(writeLane, "conv-legacy-ahead", { workId: "work:1" });
  const legacy = addLegacyAdvisorWorktree(fx, "conv-legacy-ahead");
  await writeFile(join(legacy.worktree_path, "advisor-note.txt"), "advisor work\n");
  git(legacy.worktree_path, "add", "advisor-note.txt");
  git(legacy.worktree_path, "commit", "-m", "advisor commit");
  git(projectPath, "worktree", "remove", "--force", legacy.worktree_path);

  const result = await gateway.sweepAdvisorWorkspaces();

  assert.deepEqual(result.removed_branches, []);
  assert.deepEqual(advisorBranches(projectPath), ["owl/advisor/conv-legacy-ahead"]);
});

test("prepareAdvisorWorkspace with project_id uses that Project's repository", async (t) => {
  const { parent, projectPath, writeLane, gateway } = await fixture(t);
  const otherPath = await createTestRepo(t, { prefix: "owl-advisor-other-repo-", files: { "OTHER.md": "other\n" } });
  await insertProject(writeLane, "project:other", otherPath, [parent, otherPath]);
  await insertConversation(writeLane, "conv-other", { workId: "work:1" });

  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-other", project_id: "project:other" });

  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.repository_root, await realpath(otherPath));
  assert.equal(git(prepared.worktree_path, "show", "HEAD:OTHER.md"), "other");
  assert.equal(sharedWorktreeEntries(otherPath).length, 1);
  assert.equal(sharedWorktreeEntries(projectPath).length, 0);
  const missing = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-other", project_id: "project:none" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, "project_not_found");
});

test("prepareAdvisorWorkspace uses a non-Git Project directory directly", async (t) => {
  const { parent, writeLane, gateway } = await fixture(t);
  const plainPath = join(parent, "plain-project");
  await mkdir(plainPath, { recursive: true });
  await insertProject(writeLane, "project:plain", plainPath, [parent]);
  await insertConversation(writeLane, "conv-plain", { workId: "work:1" });

  const prepared = await gateway.prepareAdvisorWorkspace({ conversation_id: "conv-plain", project_id: "project:plain" });

  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.kind, "direct");
  assert.equal(prepared.worktree_path, await realpath(plainPath));
  assert.equal(prepared.synced, true);
  assert.match(prepared.message, /not a Git repository/);
});
