import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

/** A temporary repository whose Work branch adds `state.txt`; the required test command reads it. */
async function fixture(t, requiredTestArgv) {
  const parent = await tempDir(t, "owl-required-test-gate-");
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const db = {
    get(sql) {
      if (sql.includes("SELECT project_id FROM works")) return { project_id: "project-1" };
      if (sql.includes("SELECT state, state_version FROM works")) return { state: "running", state_version: 1, title: null };
      if (sql.includes("SELECT title FROM works")) return { title: null };
      if (sql.includes("FROM projects")) {
        return {
          canonical_path: project,
          base_branch: "main",
          allowed_roots_json: JSON.stringify([parent]),
          verification_plan_json: "[]",
          required_test_argv_json: requiredTestArgv === null ? null : JSON.stringify(requiredTestArgv),
        };
      }
      return undefined;
    },
  };
  return { parent, project, gateway: new GitWorktreeGateway(db, join(parent, "owl")) };
}

async function addWorkChange(gateway, content) {
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, "state.txt"), content);
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
}

// The command is a failing/passing test run in the integration worktree: it exits 3 unless state.txt says "ok".
const REQUIRED = ["node", "-e", "const s = require('fs').readFileSync('state.txt', 'utf8'); if (s.trim() !== 'ok') { console.error('required test failed: ' + s.trim()); process.exit(3); }"];

test("a failing required test command stops the merge, leaves base untouched and reports why", async (t) => {
  const { project, gateway } = await fixture(t, REQUIRED);
  await addWorkChange(gateway, "broken\n");
  const oldBase = git(project, "rev-parse", "refs/heads/main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(result.kind, "verification_failed");
  assert.equal(result.command_id, "required_tests");
  assert.deepEqual(result.command, REQUIRED);
  assert.equal(result.exit_code, 3);
  assert.match(result.output_tail, /required test failed: broken/);
  assert.match(result.message, /exit 3/);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldBase);
});

test("a passing required test command still merges the Work", async (t) => {
  const { project, gateway } = await fixture(t, REQUIRED);
  await addWorkChange(gateway, "ok\n");
  const oldBase = git(project, "rev-parse", "refs/heads/main");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(result.kind, "merged");
  assert.deepEqual(result.verification_commands_run, ["required_tests"]);
  assert.notEqual(git(project, "rev-parse", "refs/heads/main"), oldBase);
});

test("without a required test command the merge runs no extra command", async (t) => {
  const { project, gateway } = await fixture(t, null);
  await addWorkChange(gateway, "broken\n");

  const result = await gateway.mergeWorkIntoBase({ work_id: "W" });
  assert.equal(result.kind, "merged");
  assert.deepEqual(result.verification_commands_run, []);
  assert.equal(git(project, "show", "refs/heads/main:state.txt"), "broken");
});

test("required_test_command is set, changed and cleared through the Project update and survives a restart", async (t) => {
  const coreOptions = { git: {}, dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 } };
  const first = await createTestCore(t, coreOptions, { prefix: "owl-required-test-core-" });
  const { root, db } = first;
  const envelope = (payload) => command(payload, `test:${createUlid()}`);
  let { core } = first;
  const created = await core.createProject(envelope({
    name: "P", canonical_path: join(root, "repo"), base_branch: "main", allowed_roots: [root], verification_plan: [],
  }));
  const id = created.data.id;
  assert.equal(created.data.required_test_command, null);

  const updated = await core.updateProject(id, envelope({ required_test_command: ["pnpm", "test:gate"] }));
  assert.deepEqual(updated.data.required_test_command, ["pnpm", "test:gate"]);
  await core.stop({ force: true });
  ({ core } = await createTestCore(t, { ...coreOptions, db, owlRoot: root }));
  assert.deepEqual(core.listProjects().data.find((p) => p.id === id).required_test_command, ["pnpm", "test:gate"]);

  await core.updateProject(id, envelope({ required_test_command: [] }));
  assert.equal(core.listProjects().data.find((p) => p.id === id).required_test_command, null);
});
