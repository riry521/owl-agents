import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter as pathDelimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function fixture(t, { autoPush = 1 } = {}) {
  const root = await tempDir(t, "owl-git-push-");
  const remote = join(root, "remote.git");
  const project = join(root, "project");
  await mkdir(project);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "initial\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  git(project, "remote", "add", "origin", remote);
  git(project, "push", "--porcelain", "-u", "origin", "main");
  const db = {
    get(sql) {
      if (sql.includes("FROM works")) return { project_id: "P1" };
      if (sql.includes("FROM projects")) return {
        canonical_path: project,
        base_branch: "main",
        allowed_roots_json: JSON.stringify([root]),
        auto_push: autoPush,
      };
      return undefined;
    },
  };
  return { root, remote, project, gateway: new GitWorktreeGateway(db, join(root, "owl")) };
}

async function createGitArgvWrapper(root) {
  const wrapperDirectory = join(root, "git-wrapper");
  const argvLog = join(root, "git-argv.jsonl");
  await mkdir(wrapperDirectory);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = join(wrapperDirectory, "git");
  await writeFile(wrapper, [
    "#!/usr/bin/env node",
    'const { spawnSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    'fs.appendFileSync(process.env.OWL_TEST_GIT_ARGV_LOG, JSON.stringify(args) + String.fromCharCode(10));',
    'const result = spawnSync(process.env.OWL_TEST_GIT_REAL_BIN, args, { stdio: "inherit" });',
    "if (result.error) { console.error(result.error); process.exit(127); }",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  return { wrapperDirectory, argvLog, realGit };
}

async function withGitArgvCapture(wrapper, run) {
  const originalPath = process.env.PATH;
  const originalLog = process.env.OWL_TEST_GIT_ARGV_LOG;
  const originalGit = process.env.OWL_TEST_GIT_REAL_BIN;
  process.env.PATH = `${wrapper.wrapperDirectory}${pathDelimiter}${originalPath ?? ""}`;
  process.env.OWL_TEST_GIT_ARGV_LOG = wrapper.argvLog;
  process.env.OWL_TEST_GIT_REAL_BIN = wrapper.realGit;
  try {
    const result = await run();
    const entries = (await readFile(wrapper.argvLog, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { result, entries };
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.OWL_TEST_GIT_ARGV_LOG;
    else process.env.OWL_TEST_GIT_ARGV_LOG = originalLog;
    if (originalGit === undefined) delete process.env.OWL_TEST_GIT_REAL_BIN;
    else process.env.OWL_TEST_GIT_REAL_BIN = originalGit;
  }
}

function assertPushArgvHasNoForce(entries) {
  const pushes = entries.filter((argv) => argv.includes("push"));
  assert.ok(pushes.length > 0, "GitWorktreeGateway did not invoke git push");
  for (const argv of pushes) {
    assert.equal(
      argv.some((arg) => ["--force", "-f", "--force-with-lease"].includes(arg) || arg.startsWith("+")),
      false,
      `git push argv contains a force option or forced refspec: ${JSON.stringify(argv)}`,
    );
  }
}

test("base branch push skips when disabled or when the branch has no upstream", async (t) => {
  const disabled = await fixture(t, { autoPush: 0 });
  assert.equal((await disabled.gateway.pushBaseBranch({ work_id: "W1" })).kind, "skipped_disabled");
  const noUpstream = await fixture(t);
  git(noUpstream.project, "branch", "--unset-upstream");
  assert.equal((await noUpstream.gateway.pushBaseBranch({ work_id: "W2" })).kind, "skipped_no_upstream");
});

test("base branch push updates only its upstream and reports the previous tracking commit", async (t) => {
  const { project, remote, gateway } = await fixture(t);
  const previous = git(project, "rev-parse", "refs/remotes/origin/main");
  await writeFile(join(project, "feature.txt"), "feature\n");
  git(project, "add", "feature.txt");
  git(project, "commit", "-m", "feature");
  const localTip = git(project, "rev-parse", "refs/heads/main");
  const result = await gateway.pushBaseBranch({ work_id: "W3" });
  assert.equal(result.kind, "pushed", result.message);
  assert.equal(result.previous_tracking_commit, previous);
  assert.equal(result.new_remote_commit, localTip);
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), localTip);
  assert.equal((await gateway.pushBaseBranch({ work_id: "W3" })).up_to_date, true);
});

test("base branch push passes no force options or forced refspecs to git on success and rejection", async (t) => {
  const { root, project, remote, gateway } = await fixture(t);
  const wrapper = await createGitArgvWrapper(root);
  await writeFile(join(project, "feature.txt"), "feature\n");
  git(project, "add", "feature.txt");
  git(project, "commit", "-m", "feature");

  const success = await withGitArgvCapture(wrapper, () => gateway.pushBaseBranch({ work_id: "W-argv-success" }));
  assert.equal(success.result.kind, "pushed", success.result.message);
  assertPushArgvHasNoForce(success.entries);

  const other = join(root, "other");
  git(root, "clone", remote, other);
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.invalid");
  await writeFile(join(other, "remote.txt"), "remote\n");
  git(other, "add", "remote.txt");
  git(other, "commit", "-m", "remote advance");
  git(other, "push", "origin", "main");
  const remoteBefore = git(remote, "rev-parse", "refs/heads/main");
  await writeFile(join(project, "local.txt"), "local\n");
  git(project, "add", "local.txt");
  git(project, "commit", "-m", "local advance");

  await writeFile(wrapper.argvLog, "");
  const rejected = await withGitArgvCapture(wrapper, () => gateway.pushBaseBranch({ work_id: "W-argv-rejected" }));
  assert.equal(rejected.result.kind, "failed");
  assert.equal(rejected.result.failure, "non_fast_forward");
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), remoteBefore);
  assertPushArgvHasNoForce(rejected.entries);
});

test("a remote advance rejects the push without changing the remote ref", async (t) => {
  const { root, project, remote, gateway } = await fixture(t);
  const other = join(root, "other");
  git(root, "clone", remote, other);
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.invalid");
  await writeFile(join(other, "remote.txt"), "remote\n");
  git(other, "add", "remote.txt");
  git(other, "commit", "-m", "remote advance");
  git(other, "push", "origin", "main");
  const remoteBefore = git(remote, "rev-parse", "refs/heads/main");
  await writeFile(join(project, "local.txt"), "local\n");
  git(project, "add", "local.txt");
  git(project, "commit", "-m", "local advance");
  const result = await gateway.pushBaseBranch({ work_id: "W4" });
  assert.equal(result.kind, "failed");
  assert.equal(result.failure, "non_fast_forward");
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), remoteBefore);
});

test("local pre-push rejection is classified and credential URLs are redacted from message and stderr", async (t) => {
  const { project, gateway } = await fixture(t);
  const hook = join(project, ".git", "hooks", "pre-push");
  await writeFile(hook, "#!/bin/sh\nprintf '%s\\n' 'owl-pre-push: blocked: policy check' 'https://user:secret@example.invalid/repo.git' >&2\nexit 1\n");
  await chmod(hook, 0o755);
  const result = await gateway.pushBaseBranch({ work_id: "W5" });
  assert.equal(result.kind, "failed");
  assert.equal(result.failure, "hook_rejected");
  assert.equal(result.hook_side, "local");
  assert.match(result.message, /owl-pre-push: blocked: policy check/);
  assert.match(result.stderr_tail, /https:\/\/\*\*\*@example\.invalid/);
  assert.doesNotMatch(result.stderr_tail, /secret/);
  assert.doesNotMatch(result.message, /secret/);
});
