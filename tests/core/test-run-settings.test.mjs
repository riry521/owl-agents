import assert from "node:assert/strict";
import { test } from "node:test";

import { readTestRunSettings } from "../../packages/shared/dist/test-run-settings.js";
import { DEFAULT_TEST_POLICY } from "../../packages/shared/dist/test-policy.js";
import { spawnTestCommand, withDetachedWorktree } from "../../packages/core/dist/nightly-tests.js";
import { listTestFiles, recordTestRunInTransaction, runTestFiles, selectTests } from "../../packages/core/dist/test-runs.js";
import { command as envelope, createTestCore } from "../helpers/core.mjs";
import { createTestRepo, git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { access } from "node:fs/promises";
import { join } from "node:path";

const command = (payload, key) => envelope(payload, `test-run-settings:${key}`);
const pass = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const failing = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => assert.equal(1, 2));\n";

async function setup(t, projectPath = null) {
  const ctx = await createTestCore(t, { version: "test-run-settings" }, { prefix: "owl-test-run-settings-" });
  const created = await ctx.core.createProject(command({
    name: "P", canonical_path: projectPath ?? join(ctx.root, "p"), base_branch: "main", allowed_roots: [projectPath ?? ctx.root], verification_plan: [],
  }, "create"));
  return { ...ctx, projectId: created.data.id, created };
}

test("a Project saves test_run on create and update, reads it back, and clears it with null", async (t) => {
  const { core, db, projectId, created } = await setup(t);
  assert.equal(created.data.test_run, null);
  const settings = { file_argv: ["node", "--test", "{file}"], concurrency: 2, source_map: [{ from: "^a$", to: "b" }] };
  const updated = await core.updateProject(projectId, command({ test_run: settings }, "set"));
  assert.deepEqual(updated.data.test_run, settings);
  assert.deepEqual(JSON.parse(db.get("SELECT test_run_json FROM projects WHERE id = ?", projectId).test_run_json), settings);
  assert.deepEqual(core.listProjects().data[0].test_run, settings);
  await core.updateProject(projectId, command({ test_run: null }, "clear"));
  assert.equal(db.get("SELECT test_run_json FROM projects WHERE id = ?", projectId).test_run_json, null);

  const second = await core.createProject(command({
    name: "Q", canonical_path: "/tmp/owl-test-run-settings-q", base_branch: "main", allowed_roots: ["/tmp"], verification_plan: [], test_run: { prepare_argv: ["true"] },
  }, "create-with"));
  assert.deepEqual(second.data.test_run, { prepare_argv: ["true"] });
});

test("invalid test_run values are rejected on create and update", async (t) => {
  const { core, projectId } = await setup(t);
  const invalid = [
    { file_argv: ["node", "--test"] },
    { file_argv: ["node", "{file}", "{file}"] },
    { source_map: [{ from: "(", to: "x" }] },
    { concurrency: 1.5 },
    { file_timeout_seconds: 0 },
    { flaky_retries: "1" },
    { unknown_key: 1 },
    { prepare_argv: [""] },
    [],
  ];
  for (const [index, value] of invalid.entries()) {
    await assert.rejects(core.updateProject(projectId, command({ test_run: value }, `bad-${index}`)), (error) => error.code === "validation_error", JSON.stringify(value));
    await assert.rejects(core.createProject(command({
      name: `X${index}`, canonical_path: `/tmp/owl-test-run-settings-x${index}`, base_branch: "main", allowed_roots: ["/tmp"], verification_plan: [], test_run: value,
    }, `bad-create-${index}`)), (error) => error.code === "validation_error");
  }
});

test("real node --test files run through spawnTestCommand and their per-file results are stored", async (t) => {
  const repo = await createTestRepo(t, { files: { "tests/a.test.mjs": pass, "tests/b.test.mjs": failing } });
  const { db, core, projectId } = await setup(t);
  const settings = readTestRunSettings({ test_patterns: ["tests/**/*.test.mjs"], file_argv: ["node", "--test", "--test-reporter=tap", "{file}"], concurrency: 2, flaky_retries: 0 });
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const run = (argv, cwd, timeoutMs, limit) => spawnTestCommand(argv, cwd, env, timeoutMs, limit);
  const testFiles = await listTestFiles(repo, settings);
  const execution = await runTestFiles({ root: repo, files: testFiles, settings, run });
  assert.equal(execution.status, "completed");
  const selection = await selectTests({ scope: "work", root: repo, testFiles, changedFiles: [], previous: null, requiredTests: [], forceFull: "first_work_run", settings });
  await db.createWriteLane().transact((tx) => {
    recordTestRunInTransaction(tx, {
      project_id: projectId, work_id: null, task_id: null, agent_run_id: null, scope: "baseline", mode: "full",
      commit_sha: git(repo, "rev-parse", "HEAD"), base_commit: null, selection, started_at: new Date().toISOString(), execution, classified: new Map(),
    }, new Date().toISOString());
  });
  const rows = Object.fromEntries(db.all("SELECT file, status FROM test_run_files").map((row) => [row.file, row.status]));
  assert.deepEqual(rows, { "tests/a.test.mjs": "passed", "tests/b.test.mjs": "failed" });
});

test("spawnTestCommand keeps stdout and stderr apart, truncates, times out and reports a missing command", async () => {
  const env = { PATH: process.env.PATH ?? "" };
  const both = await spawnTestCommand([process.execPath, "-e", "process.stdout.write('o'.repeat(100)); process.stderr.write('err')"], process.cwd(), env, 10_000, 10);
  assert.equal(both.exit_code, 0);
  assert.equal(both.stdout, "o".repeat(10));
  assert.equal(both.stderr, "err");
  const slow = await spawnTestCommand([process.execPath, "-e", "setTimeout(() => {}, 60000)"], process.cwd(), env, 200, 1000);
  assert.equal(slow.timed_out, true);
  const missing = await spawnTestCommand(["owl-no-such-command"], process.cwd(), env, 1000, 1000);
  assert.equal(typeof missing.error, "string");
});

test("withDetachedWorktree checks the commit out, keeps it by default and removes it with cleanup", async (t) => {
  const repo = await createTestRepo(t);
  const commit = git(repo, "rev-parse", "HEAD");
  const base = await tempDir(t, "owl-detached-");
  const kept = join(base, "kept");
  assert.equal(await withDetachedWorktree({ repo, commit, path: kept }, async (path) => path), kept);
  await access(join(kept, "README.md"));
  const removed = join(base, "removed");
  await withDetachedWorktree({ repo, commit, path: removed, cleanup: true }, async () => undefined);
  await assert.rejects(access(removed));
});

test("deleting a Work removes its test_runs and test_run_files", async (t) => {
  const repo = await createTestRepo(t);
  const { core, db, projectId } = await setup(t, repo);
  const created = await core.createWork(command({ title: "W", summary: "", size: "small", project_id: projectId }, "work"));
  const workId = created.data.work_id;
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'completed', state_version = 1, completed_at = ?, updated_at = ? WHERE id = ?", now, now, workId);
  });
  await core.archiveWork(workId, envelope({}, "test-run-settings:archive", 1));
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO test_runs (id, project_id, work_id, scope, mode, commit_sha, status, started_at, finished_at) VALUES ('r1', ?, ?, 'work', 'full', 'abc', 'passed', ?, ?)`,
      projectId, workId, now, now,
    );
    tx.run("INSERT INTO test_run_files (run_id, file, status) VALUES ('r1', 'tests/a.test.mjs', 'passed')");
  });
  await core.deleteWork(workId, envelope({}, "test-run-settings:delete", 1));
  assert.equal(db.get("SELECT id FROM test_runs WHERE id = 'r1'"), undefined);
  assert.equal(db.get("SELECT run_id FROM test_run_files WHERE run_id = 'r1'"), undefined);
});

test("a Project saves test_policy, reads defaults when unset, rejects bad values, and keeps test detection on", async (t) => {
  const { core, db, projectId, created } = await setup(t);
  assert.deepEqual(created.data.test_policy, DEFAULT_TEST_POLICY);
  const policy = { reviewer_denied_commands: ["pnpm test"], check_commands: [["pnpm", "lint"]] };
  const updated = await core.updateProject(projectId, command({ test_policy: policy }, "policy-set"));
  assert.deepEqual(updated.data.test_policy, policy);
  assert.deepEqual(core.listProjects().data[0].test_policy, policy);
  assert.equal(db.get("SELECT test_run_json FROM projects WHERE id = ?", projectId).test_run_json, null);
  assert.equal(updated.data.test_run, null);
  const invalid = [{ unknown_key: 1 }, { quarantine_days: 3 },{ check_commands: [[]] }, { reviewer_denied_commands: [""] }, []];
  for (const [index, value] of invalid.entries()) {
    await assert.rejects(core.updateProject(projectId, command({ test_policy: value }, `policy-bad-${index}`)), (error) => error.code === "validation_error", JSON.stringify(value));
  }
  await core.updateProject(projectId, command({ test_policy: null }, "policy-clear"));
  assert.deepEqual(core.listProjects().data[0].test_policy, DEFAULT_TEST_POLICY);
});

test("a stored test_policy that an older version saved with a dropped key still reads, and the dropped key is not returned", async (t) => {
  const { core, db, projectId } = await setup(t);
  await db.createWriteLane().transact((tx) => tx.run("UPDATE projects SET test_policy_json = ? WHERE id = ?", JSON.stringify({ check_commands: [["pnpm", "lint"]], quarantine_days: 3 }), projectId));
  assert.deepEqual(core.listProjects().data[0].test_policy, { ...DEFAULT_TEST_POLICY, check_commands: [["pnpm", "lint"]] });
});

test("migrations 055 and 056 add test_policy_json and a test_quarantine table that follows the Project", async (t) => {
  const { core, db, projectId } = await setup(t);
  assert.ok(db.all("PRAGMA table_info(projects)").some((column) => column.name === "test_policy_json"));
  assert.deepEqual(db.all("PRAGMA table_info(test_quarantine)").filter((column) => column.pk > 0).map((column) => column.name).sort(), ["file", "project_id"]);
  await assert.rejects(db.createWriteLane().transact((tx) => tx.run("UPDATE projects SET test_policy_json = '[]' WHERE id = ?", projectId)));
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO test_quarantine (project_id, file, classified_by, failures_json, quarantined_at) VALUES (?, 'tests/a.test.mjs', 'baseline', '[]', '2026-10-01T00:00:00.000Z')", projectId);
  });
  assert.equal(db.all("SELECT file FROM test_quarantine WHERE project_id = ?", projectId).length, 1);
  await core.deleteProject(projectId, command({ confirmed_work_count: 0 }, "policy-delete"));
  assert.equal(db.all("SELECT file FROM test_quarantine WHERE project_id = ?", projectId).length, 0);
});

test("a Project's report_check_commands save through updateProject, survive a Core restart, and clear with null", async (t) => {
  const { core, db, root, projectId, created } = await setup(t);
  assert.deepEqual(created.data.report_check_commands, []);
  const updated = await core.updateProject(projectId, command({ report_check_commands: ["pnpm test:layout"] }, "checks-set"));
  assert.deepEqual(updated.data.report_check_commands, ["pnpm test:layout"]);
  for (const [index, value] of [[""], ["  "], [["pnpm"]], "pnpm test:layout", {}].entries()) {
    await assert.rejects(core.updateProject(projectId, command({ report_check_commands: value }, `checks-bad-${index}`)), (error) => error.code === "validation_error", JSON.stringify(value));
  }
  await core.stop();

  const { core: restarted } = await createTestCore(t, { db, owlRoot: root });
  assert.deepEqual(restarted.listProjects().data.find((project) => project.id === projectId).report_check_commands, ["pnpm test:layout"]);
  await restarted.updateProject(projectId, command({ report_check_commands: null }, "checks-clear"));
  assert.deepEqual(restarted.listProjects().data.find((project) => project.id === projectId).report_check_commands, []);
});
