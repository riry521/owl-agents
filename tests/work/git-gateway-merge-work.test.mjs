import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function fixture(t, verificationPlan = []) {
  const parent = await tempDir(t, "owl-merge-work-");
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

async function addWorkChange(gateway, workId = "W", file = "feature.txt") {
  const task = await gateway.prepareWorktree({ work_id: workId, task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, file), "Work feature\n");
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

test("mergeWorkIntoBase verifies the Work branch and advances an unchecked-out base", async (t) => {
  const { project, owlRoot, gateway } = await fixture(t);
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

test("mergeWorkIntoBase aborts conflicts and leaves the base ref untouched", async (t) => {
  const { project, owlRoot, gateway } = await fixture(t);
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

test("verification failure reports its command and output and leaves the base ref untouched", async (t) => {
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
  const { project, owlRoot, gateway } = await fixture(t, plan);
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

test("mergeWorkIntoBase advances the base when it is checked out in canonical", async (t) => {
  const { project, gateway } = await fixture(t);
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

test("mergeWorkIntoBase fast-forwards the base in the linked worktree that has it checked out", async (t) => {
  const { parent, project, owlRoot, gateway } = await fixture(t);
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
  test(`mergeWorkIntoBase leaves the base unchanged when the Work is ${label} during verification`, async (t) => {
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
    const { project, owlRoot, work, gateway } = await fixture(t, plan);
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

test("mergeWorkIntoBase records the verification commands it ran and cleans their output", async (t) => {
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
  const { project, owlRoot, gateway } = await fixture(t, plan);
  const workBranch = await addWorkChange(gateway);
  const oldBase = git(project, "rev-parse", "refs/heads/main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W", expected_state_version: 1 });

  assert.equal(result.kind, "merged", result.message);
  assert.deepEqual(result.verification_commands_run, ["build"]);
  assertMergeCommitOnBase(project, result, oldBase, workBranch);
  assert.throws(() => git(project, "cat-file", "-e", "main:build-output.txt"));
  assertIntegrationOnWorkBranch(owlRoot);
});

test("mergeWorkIntoBase detects a checked-out base moving between validation and fast-forward", async (t) => {
  const { project, owlRoot, gateway } = await fixture(t);
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

test("mergeWorkIntoBase runs one merge at a time per Project, so the second verifies on the first's base", async (t) => {
  const plan = [{
    command_id: "build", argv: ["node", "-e", "setTimeout(() => {}, 300)"], cwd: ".", env_allowlist: [], timeout_seconds: 20,
    stdout_limit: 1_024, stderr_limit: 1_024, expected_exit_codes: [0], executor: "core",
  }];
  const { project, gateway } = await fixture(t, plan);
  await addWorkChange(gateway, "W1", "one.txt");
  await addWorkChange(gateway, "W2", "two.txt");
  const spans = [];
  const original = gateway.runWorkVerification.bind(gateway);
  gateway.runWorkVerification = async (workId, ...rest) => {
    const span = { workId, start: Date.now() };
    spans.push(span);
    try { return await original(workId, ...rest); } finally { span.end = Date.now(); }
  };

  const results = await Promise.all(["W1", "W2"].map((work_id) => gateway.mergeWorkIntoBase({ work_id })));

  assert.deepEqual(results.map((r) => r.kind), ["merged", "merged"], results.map((r) => r.message).join("; "));
  assert.equal(spans.length, 2);
  assert.ok(spans[0].end <= spans[1].start, "verification spans must not overlap");
  for (const file of ["one.txt", "two.txt"]) assert.equal(git(project, "show", `main:${file}`), "Work feature");
});

test("mergeWorkIntoBase merges past uncommitted changes that do not overlap the merge",async (t) => {
  const { project, gateway } = await fixture(t);
  await addWorkChange(gateway);
  await writeFile(join(project, "README.md"), "owner edit\n");
  await writeFile(join(project, "scratch.txt"), "untracked\n");
  const oldBase = git(project, "rev-parse", "refs/heads/main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });

  assert.equal(result.kind, "merged", result.message);
  assert.notEqual(git(project, "rev-parse", "refs/heads/main"), oldBase);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), result.merge_commit);
  assert.equal(await readFile(join(project, "README.md"), "utf8"), "owner edit\n");
  assert.equal(await readFile(join(project, "scratch.txt"), "utf8"), "untracked\n");
});

test("mergeWorkIntoBase refuses uncommitted changes that overlap the merge, naming every file", async (t) => {
  const { project, owlRoot, gateway } = await fixture(t);
  await addWorkChange(gateway);
  await writeFile(join(project, "feature.txt"), "owner local change\n");
  const oldBase = git(project, "rev-parse", "refs/heads/main");
  const statusBefore = git(project, "status", "--porcelain=v1", "--untracked-files=all");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });

  assert.equal(result.kind, "error", result.message);
  assert.match(result.message, /feature\.txt/);
  assert.deepEqual(result.overlap_files, ["feature.txt"]);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldBase);
  assert.equal(git(project, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assert.equal(await readFile(join(project, "feature.txt"), "utf8"), "owner local change\n");
  assertNoMergeHead(project);
  assertNoMergeHead(join(owlRoot, ".owl-workspaces", "W", "__work__"));
});

test("mergeWorkIntoBase lands the Work as one commit titled by the Work and counts it merged afterwards", async (t) => {
  const { project, work, gateway } = await fixture(t);
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

// ---- Core activity reports: merge verification, base merge and the wait for the Git lane ----

function recordActivity(gateway) {
  const log = [];
  let next = 0;
  gateway.onCoreActivity((workId, kind) => {
    const id = `${kind}-${next++}`;
    log.push({ phase: "started", kind, id, workId });
    return { command() {}, output() {}, end: async (outcome) => { log.push({ phase: "completed", kind, id, outcome }); } };
  });
  return log;
}

const endedAs = (log, kind) => log.filter((entry) => entry.kind === kind).map(({ phase, outcome, id }) => [phase, outcome, id.split("-")[0]]);

test("mergeWorkIntoBase reports its verification and base merge, and a failed verification ends without a base merge", async (t) => {
  const passing = await fixture(t, [{
    command_id: "ok", argv: ["node", "-e", "console.log('hi')"], cwd: ".", env_allowlist: [], timeout_seconds: 20,
    stdout_limit: 128, stderr_limit: 128, expected_exit_codes: [0], executor: "core",
  }]);
  const log = recordActivity(passing.gateway);
  await addWorkChange(passing.gateway);
  const merged = await passing.gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(merged.kind, "merged", merged.message);
  assert.deepEqual(endedAs(log, "merge_verification"), [["started", undefined, "merge_verification"], ["completed", "passed", "merge_verification"]]);
  assert.deepEqual(endedAs(log, "base_merge"), [["started", undefined, "base_merge"], ["completed", "passed", "base_merge"]]);
  assert.deepEqual(log.filter((entry) => entry.kind === "merge_verification").map((entry) => entry.id), ["merge_verification-0", "merge_verification-0"]);
  assert.equal(log.some((entry) => entry.kind === "git_lane_wait"), false, "nothing waited on the lane");

  const failing = await fixture(t, [{
    command_id: "bad", argv: ["node", "-e", "process.exit(3)"], cwd: ".", env_allowlist: [], timeout_seconds: 20,
    stdout_limit: 128, stderr_limit: 128, expected_exit_codes: [0], executor: "core",
  }]);
  const failLog = recordActivity(failing.gateway);
  await addWorkChange(failing.gateway);
  assert.equal((await failing.gateway.mergeWorkIntoBase({ work_id: "W" })).kind, "verification_failed");
  assert.deepEqual(endedAs(failLog, "merge_verification").map(([phase, outcome]) => [phase, outcome]), [["started", undefined], ["completed", "failed"]]);
  assert.equal(failLog.some((entry) => entry.kind === "base_merge"), false);
});

test("a Work step that has to wait for the Git lane reports git_lane_wait until its operation starts", async (t) => {
  const { gateway } = await fixture(t);
  await addWorkChange(gateway);
  const log = recordActivity(gateway);
  await Promise.all([gateway.mergeWorkIntoBase({ work_id: "W" }), gateway.mergeWorkIntoBase({ work_id: "W" })]);
  const waits = log.filter((entry) => entry.kind === "git_lane_wait");
  assert.ok(waits.length >= 2 && waits.length % 2 === 0, "each wait has a start and an end");
  for (const started of waits.filter((entry) => entry.phase === "started")) {
    const end = waits.find((entry) => entry.phase === "completed" && entry.id === started.id);
    assert.equal(end?.outcome, "done");
  }
});

const DIRTY_PLAN = [{
  command_id: "dirty", argv: ["node", "-e", "require('fs').writeFileSync('build-output.txt','x')"], cwd: ".", env_allowlist: [], timeout_seconds: 60,
  stdout_limit: 10_000, stderr_limit: 10_000, expected_exit_codes: [0], executor: "core",
}];

test("a failed restore after verification is an error and the dirty worktree is never merged", async (t) => {
  const { project, gateway } = await fixture(t, DIRTY_PLAN);
  await addWorkChange(gateway);
  const oldBase = git(project, "rev-parse", "refs/heads/main");
  t.mock.method(console, "error", () => undefined);
  const restore = gateway.restoreIntegrationWorktreeNow.bind(gateway);
  let calls = 0;
  gateway.restoreIntegrationWorktreeNow = async (...args) => (++calls === 1 ? restore(...args) : { ok: false, exit_code: 1, recorded: false, message: "restore broke" });

  const verified = await gateway.verifyWorkBranch({ work_id: "W" });
  assert.equal(verified.status, "error");
  assert.match(verified.message, /restore broke/u);
  assert.equal(console.error.mock.callCount(), 1);

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.notEqual(result.kind, "merged");
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldBase);
});

test("withWorkCheckout throws on merge-base or restore failures and diffPaths logs its failure", async (t) => {
  const { gateway } = await fixture(t);
  await addWorkChange(gateway);
  t.mock.method(console, "error", () => undefined);
  t.mock.method(console, "warn", () => undefined);

  const restore = gateway.restoreIntegrationWorktreeNow.bind(gateway);
  let calls = 0;
  gateway.restoreIntegrationWorktreeNow = async (...args) => (++calls === 1 ? restore(...args) : { ok: false, exit_code: 1, recorded: false, message: "restore broke" });
  await assert.rejects(gateway.withWorkCheckout({ work_id: "W" }, async () => "done"), /restore broke/u);
  gateway.restoreIntegrationWorktreeNow = restore;

  const git_ = gateway.git.bind(gateway);
  gateway.git = async (cwd, args) => (args[0] === "merge-base" ? { ok: false, exit_code: 1, recorded: false, message: "no merge base" } : git_(cwd, args));
  await assert.rejects(gateway.withWorkCheckout({ work_id: "W" }, async () => "done"), /no merge base/u);
  gateway.git = git_;

  await assert.rejects(gateway.diffPaths({ work_id: "W", from: "nope", to: "HEAD" }), /git diff nope\.\.HEAD failed/u);
  assert.match(String(console.warn.mock.calls[0].arguments[1]), /git diff nope\.\.HEAD failed/u);

  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T9" });
  gateway.git = async (cwd, args) => (args[0] === "merge-base" ? { ok: false, exit_code: 1, recorded: false, message: "no merge base" } : git_(cwd, args));
  await assert.rejects(gateway.projectBaseCommit({ work_id: "W", task_id: "T9", worktree_path: task.worktree_path }), /no merge base/u);
  assert.match(String(console.warn.mock.calls[1].arguments[1]), /no merge base/u);
});
