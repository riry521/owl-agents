import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../packages/core/dist/git-gateway.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixture(verificationPlan = []) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-merge-work-")));
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const work = { state: "running", state_version: 1, title: null };
  const db = {
    get(sql) {
      if (sql.includes("SELECT project_id FROM works")) return { project_id: "project-1" };
      if (sql.includes("SELECT state, state_version FROM works")) return { ...work };
      if (sql.includes("SELECT title FROM works")) return { title: work.title };
      if (sql.includes("FROM projects")) {
        return {
          canonical_path: project,
          base_branch: "main",
          allowed_roots_json: JSON.stringify([parent]),
          verification_plan_json: JSON.stringify(verificationPlan),
        };
      }
      return undefined;
    },
  };
  const owlRoot = join(parent, "owl");
  return { parent, project, owlRoot, work, gateway: new GitWorktreeGateway(db, owlRoot) };
}

async function addWorkChange(gateway, workId = "W") {
  const task = await gateway.prepareWorktree({ work_id: workId, task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, "feature.txt"), "Work feature\n");
  const integrated = await gateway.integrateTask({ work_id: workId, task_id: "T1", worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
  return `owl/work/${workId}/work`;
}

function assertNoMergeHead(worktreePath) {
  assert.throws(() => git(worktreePath, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
}

/**
 * The base gained exactly one commit on top of the old base: the Work's
 * content, by the repository's author, with no Owl branch or commit in it.
 */
function assertMergeCommitOnBase(project, result, oldBase, workBranch) {
  assert.equal(result.merge_commit, result.new_base_commit);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), result.merge_commit);
  assert.equal(git(project, "rev-list", "--parents", "-n", "1", result.merge_commit), `${result.merge_commit} ${oldBase}`);
  assert.equal(git(project, "rev-parse", `${result.merge_commit}^{tree}`), git(project, "merge-tree", "--write-tree", oldBase, `refs/heads/${workBranch}`));
  assert.equal(git(project, "log", "--format=%an <%ae>|%cn <%ce>", "-1", result.merge_commit), "Test <test@example.invalid>|Test <test@example.invalid>");
  assert.doesNotMatch(git(project, "log", "--format=%B", "-1", result.merge_commit), /owl|\bW\b/iu);
  assert.equal(git(project, "rev-list", "--count", `${oldBase}..main`), "1");
}

function assertIntegrationOnWorkBranch(owlRoot, workId = "W") {
  const integration = join(owlRoot, ".owl-workspaces", workId, "__work__");
  assert.equal(git(integration, "branch", "--show-current"), `owl/work/${workId}/work`);
  assert.equal(git(integration, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"), "");
}

test("mergeWorkIntoBase verifies the Work branch and advances an unchecked-out base", async () => {
  const { project, owlRoot, gateway } = await fixture();
  const workBranch = await addWorkChange(gateway);
  await writeFile(join(project, "base-only.txt"), "latest base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "advance base");
  const oldBase = git(project, "rev-parse", "refs/heads/main");
  git(project, "checkout", "-b", "owner-checkout");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(result.kind, "merged", result.message);
  assert.equal(result.old_base_commit, oldBase);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), result.new_base_commit);
  assert.equal(git(project, "show", "main:base-only.txt"), "latest base");
  assert.equal(git(project, "show", `${workBranch}:feature.txt`), "Work feature");
  assertMergeCommitOnBase(project, result, oldBase, workBranch);
  assert.deepEqual(result.verification_commands_run, []);
  assert.equal(git(project, "branch", "--show-current"), "owner-checkout");
  assertNoMergeHead(join(owlRoot, ".owl-workspaces", "W", "__work__"));
  assertIntegrationOnWorkBranch(owlRoot);
});

test("mergeWorkIntoBase aborts conflicts and leaves the base ref untouched", async () => {
  const { project, owlRoot, gateway } = await fixture();
  const task = await gateway.prepareWorktree({ work_id: "W2", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, "README.md"), "Work version\n");
  const integrated = await gateway.integrateTask({ work_id: "W2", task_id: "T1", worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
  await writeFile(join(project, "README.md"), "Base version\n");
  git(project, "add", "README.md");
  git(project, "commit", "-m", "conflicting base edit");
  const oldBase = git(project, "rev-parse", "refs/heads/main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W2" });
  assert.equal(result.kind, "conflict");
  assert.deepEqual(result.conflicting_files, ["README.md"]);
  assert.equal(result.aborted, true, result.abort_message);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldBase);
  assertNoMergeHead(project);
  assertNoMergeHead(join(owlRoot, ".owl-workspaces", "W2", "__work__"));
  assertIntegrationOnWorkBranch(owlRoot, "W2");
});

test("verification failure reports its command and output and leaves the base ref untouched", async () => {
  const plan = [{
    command_id: "fail-check",
    argv: ["node", "-e", "for (let i = 0; i < 100; i++) console.log(i === 0 ? 'stdout beginning' : i === 99 ? 'stdout ending' : 'stdout line ' + i); console.error('stderr ending'); process.exit(7)"],
    cwd: ".",
    env_allowlist: [],
    timeout_seconds: 20,
    stdout_limit: 128,
    stderr_limit: 8_192,
    expected_exit_codes: [0],
    executor: "core",
  }];
  const { project, owlRoot, gateway } = await fixture(plan);
  await addWorkChange(gateway);
  const oldBase = git(project, "rev-parse", "refs/heads/main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(result.kind, "verification_failed");
  assert.equal(result.command_id, "fail-check");
  assert.deepEqual(result.command, plan[0].argv);
  assert.equal(result.exit_code, 7);
  assert.match(result.output_tail, /stdout ending/);
  assert.doesNotMatch(result.output_tail, /stdout beginning/);
  assert.match(result.output_tail, /stderr ending/);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldBase);
  assertNoMergeHead(project);
  assertNoMergeHead(join(owlRoot, ".owl-workspaces", "W", "__work__"));
  assertIntegrationOnWorkBranch(owlRoot);
});

test("mergeWorkIntoBase advances the base when it is checked out in canonical", async () => {
  const { project, gateway } = await fixture();
  const workBranch = await addWorkChange(gateway);
  const oldBase = git(project, "rev-parse", "refs/heads/main");
  await writeFile(join(project, "notes.txt"), "owner notes\n");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(result.kind, "merged", result.message);
  assert.equal(git(project, "branch", "--show-current"), "main");
  assert.equal(git(project, "rev-parse", "HEAD"), result.new_base_commit);
  assert.notEqual(result.new_base_commit, oldBase);
  assert.equal(git(project, "show", "HEAD:feature.txt"), "Work feature");
  assert.equal(await readFile(join(project, "feature.txt"), "utf8"), "Work feature\n");
  assert.equal(await readFile(join(project, "notes.txt"), "utf8"), "owner notes\n");
  assertMergeCommitOnBase(project, result, oldBase, workBranch);
});

test("mergeWorkIntoBase fast-forwards the base in the linked worktree that has it checked out", async () => {
  const { parent, project, owlRoot, gateway } = await fixture();
  const workBranch = await addWorkChange(gateway);
  const oldBase = git(project, "rev-parse", "refs/heads/main");
  git(project, "checkout", "-b", "owner-checkout");
  const linked = join(parent, "main-checkout");
  git(project, "worktree", "add", linked, "main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(result.kind, "merged", result.message);
  assertMergeCommitOnBase(project, result, oldBase, workBranch);
  assert.equal(git(linked, "rev-parse", "HEAD"), result.merge_commit);
  assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.equal(await readFile(join(linked, "feature.txt"), "utf8"), "Work feature\n");
  assert.equal(git(project, "branch", "--show-current"), "owner-checkout");
  assertIntegrationOnWorkBranch(owlRoot);
});

for (const [label, change] of [
  ["paused", (work) => { work.state = "paused"; work.state_version += 1; }],
  ["cancelled", (work) => { work.state = "cancelled"; work.state_version += 1; }],
  ["paused and resumed", (work) => { work.state_version += 2; }],
]) {
  test(`mergeWorkIntoBase leaves the base unchanged when the Work is ${label} during verification`, async () => {
    const plan = [{
      command_id: "check",
      argv: ["node", "-e", "require('fs').writeFileSync('build-output.txt', 'x')"],
      cwd: ".",
      env_allowlist: [],
      timeout_seconds: 20,
      stdout_limit: 1_024,
      stderr_limit: 1_024,
      expected_exit_codes: [0],
      executor: "core",
    }];
    const { project, owlRoot, work, gateway } = await fixture(plan);
    await addWorkChange(gateway);
    const oldBase = git(project, "rev-parse", "refs/heads/main");
    const runCommand = gateway.runProjectVerificationCommand.bind(gateway);
    gateway.runProjectVerificationCommand = async (...args) => {
      const result = await runCommand(...args);
      change(work);
      return result;
    };

    const result = await gateway.mergeWorkIntoBase({ work_id: "W", expected_state_version: 1 });

    assert.equal(result.kind, "interrupted", result.message);
    assert.equal(git(project, "rev-parse", "refs/heads/main"), oldBase);
    assert.equal(git(project, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assertIntegrationOnWorkBranch(owlRoot);
  });
}

test("mergeWorkIntoBase records the verification commands it ran and cleans their output", async () => {
  const plan = [{
    command_id: "build",
    argv: ["node", "-e", "require('fs').writeFileSync('build-output.txt', 'x')"],
    cwd: ".",
    env_allowlist: [],
    timeout_seconds: 20,
    stdout_limit: 1_024,
    stderr_limit: 1_024,
    expected_exit_codes: [0],
    executor: "core",
  }];
  const { project, owlRoot, gateway } = await fixture(plan);
  const workBranch = await addWorkChange(gateway);
  const oldBase = git(project, "rev-parse", "refs/heads/main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W", expected_state_version: 1 });

  assert.equal(result.kind, "merged", result.message);
  assert.deepEqual(result.verification_commands_run, ["build"]);
  assertMergeCommitOnBase(project, result, oldBase, workBranch);
  assert.throws(() => git(project, "cat-file", "-e", "main:build-output.txt"));
  assertIntegrationOnWorkBranch(owlRoot);
});

test("mergeWorkIntoBase detects a checked-out base moving between validation and fast-forward", async () => {
  const { project, owlRoot, gateway } = await fixture();
  const oldBase = git(project, "rev-parse", "refs/heads/main");
  await addWorkChange(gateway);
  const statusBefore = git(project, "status", "--porcelain=v1", "--untracked-files=all");
  const workCommit = git(project, "rev-parse", "refs/heads/owl/work/W/work");

  const originalGit = gateway.git.bind(gateway);
  let movedDuringMerge = false;
  let concurrentBase;
  gateway.git = async (cwd, args) => {
    if (!movedDuringMerge && cwd === project && args[0] === "merge" && args[1] === "--ff-only") {
      await writeFile(join(project, "concurrent.txt"), "concurrent base change\n");
      git(project, "add", "concurrent.txt");
      git(project, "commit", "-m", "concurrent base advance");
      concurrentBase = git(project, "rev-parse", "refs/heads/main");
      movedDuringMerge = true;
    }
    return originalGit(cwd, args);
  };

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });

  assert.equal(movedDuringMerge, true);
  assert.equal(result.kind, "base_moved");
  assert.equal(result.expected_base_commit, oldBase);
  assert.equal(result.actual_base_commit, concurrentBase);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), concurrentBase);
  assert.notEqual(concurrentBase, workCommit);
  assert.throws(() => git(project, "merge-base", "--is-ancestor", concurrentBase, workCommit));
  assert.equal(git(project, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assertNoMergeHead(project);
  assertNoMergeHead(join(owlRoot, ".owl-workspaces", "W", "__work__"));
});

test("mergeWorkIntoBase preserves canonical uncommitted changes when fast-forward is refused", async () => {
  const { project, owlRoot, gateway } = await fixture();
  await addWorkChange(gateway);
  await writeFile(join(project, "feature.txt"), "owner local change\n");
  const oldBase = git(project, "rev-parse", "refs/heads/main");
  const statusBefore = git(project, "status", "--porcelain=v1", "--untracked-files=all");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });

  assert.ok(result.kind === "error" || result.kind === "base_moved", result.message);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldBase);
  assert.equal(git(project, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assert.equal(await readFile(join(project, "feature.txt"), "utf8"), "owner local change\n");
  assertNoMergeHead(project);
  assertNoMergeHead(join(owlRoot, ".owl-workspaces", "W", "__work__"));
});

test("mergeWorkIntoBase lands the Work as one commit titled by the Work and counts it merged afterwards", async () => {
  const { project, work, gateway } = await fixture();
  work.title = "Show model names in the activity log\nwith more detail below";
  const workBranch = await addWorkChange(gateway);
  const oldBase = git(project, "rev-parse", "refs/heads/main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(result.kind, "merged", result.message);
  assertMergeCommitOnBase(project, result, oldBase, workBranch);
  assert.equal(git(project, "log", "--format=%B", "-1", result.merge_commit), "Show model names in the activity log");

  // The base moves on; the squashed Work still counts as merged.
  git(project, "checkout", "main");
  await writeFile(join(project, "later.txt"), "later\n");
  git(project, "add", "later.txt");
  git(project, "commit", "-m", "later change");
  assert.equal(await gateway.workHasUnmergedChanges({ work_id: "W" }), false);
  const again = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(again.kind, "merged", again.message);
  assert.equal(again.merge_commit, null);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), again.old_base_commit);
});
