import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../../packages/core/dist/index.js";
import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { git } from "../helpers/git.mjs";

// Exits 3 unless state.txt says "ok".
const REQUIRED = ["node", "-e", "const s = require('fs').readFileSync('state.txt', 'utf8'); if (s.trim() !== 'ok') { console.error('required test failed: ' + s.trim()); process.exit(3); }"];

/** Real temp DB + real temp git repo + real gateway + real Core; the Project's required_test_command comes from the DB. */
async function coreFixture(t, requiredTestCommand) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-required-test-e2e-"))); // helpers-exempt: the gateway needs the db before the Core exists, so cleanup order (Core, db, root) is kept by hand below
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const db = createTestDatabase(parent);
  const gateway = new GitWorktreeGateway(db, join(parent, "owl"));
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] } } }),
    runWorker: async () => ({ outcome: "failed", message: "unexpected" }),
    runReviewer: async () => ({ outcome: "failed", message: "unexpected" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, git: gateway, agentRunner, version: "test", owlRoot: parent, dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 } }); // helpers-exempt: needs the gateway built on the same db
  t.after(async () => { await core.stop({ force: true }); db.close(); await rm(parent, { recursive: true, force: true }); });
  const envelope = (payload) => command(payload, `test:${createUlid()}`);
  const created = await core.createProject(envelope({
    name: "P", canonical_path: project, base_branch: "main", allowed_roots: [parent], verification_plan: [], required_test_command: typeof requiredTestCommand === "function" ? requiredTestCommand(project) : requiredTestCommand,
  }));
  const work = await core.createWork(envelope({ title: "W", summary: "s", size: "normal", project_id: created.data.id }));
  const workId = work.data.work_id;
  const taskId = createUlid();
  const now = new Date().toISOString();
  const prepared = await gateway.prepareWorktree({ work_id: workId, task_id: taskId });
  assert.equal(prepared.ok, true, prepared.message);
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id, worktree_path)
       VALUES (?, ?, 'Done', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1', ?)`,
      taskId, workId, now, now, prepared.worktree_path,
    );
    tx.run("INSERT INTO artifacts (id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, version_no, created_at) VALUES (?, ?, ?, 'state.txt', 'generated', 1, ?, 1, 'text/plain', 1, ?)", createUlid(), workId, taskId, "a".repeat(64), now);
    const runId = createUlid();
    tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)", runId, workId, taskId, now, now);
    tx.run("INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1', 'success', ?, ?, 0, ?)", createUlid(), runId, JSON.stringify({ kind: "report", result: "success", work_done: "Done." }), "0".repeat(64), now);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  await writeFile(join(prepared.worktree_path, "state.txt"), "");
  return { core, db, project, gateway, workId, taskId, worktree: prepared.worktree_path };
}

async function commitTaskState(f, content) {
  await writeFile(join(f.worktree, "state.txt"), content);
  const integrated = await f.gateway.integrateTask({ work_id: f.workId, task_id: f.taskId, worktree_path: f.worktree });
  assert.equal(integrated.merged, true, integrated.message);
}

test("Core with a failing required test keeps base, and the Decision and event say why", async (t) => {
  // Passes on the first run (the integration check), which also moves base to a different tree, so the merge gate re-runs and fails.
  const marker = join(tmpdir(), `owl-required-test-marker-${createUlid()}`);
  t.after(() => rm(marker, { force: true }));
  const failOnSecondRun = (project) => ["node", "-e", `const fs = require('fs'); if (fs.existsSync(${JSON.stringify(marker)})) { console.error('required test failed: broken'); process.exit(3); } fs.writeFileSync(${JSON.stringify(marker)}, ''); const cp = require('child_process'); fs.writeFileSync(${JSON.stringify(join(project, "moved.txt"))}, 'x'); cp.execFileSync('git', ['-C', ${JSON.stringify(project)}, 'add', 'moved.txt']); cp.execFileSync('git', ['-C', ${JSON.stringify(project)}, 'commit', '-m', 'base moved']);`];
  const f = await coreFixture(t, failOnSecondRun);
  await commitTaskState(f, "broken\n");
  await f.core.start();
  await f.core.tick(f.workId);

  assert.equal(git(f.project, "log", "-1", "--format=%s", "refs/heads/main"), "base moved");
  assert.notEqual(f.db.get("SELECT state FROM works WHERE id = ?", f.workId).state, "completed");
  const text = JSON.stringify(await f.core.listDecisions({ status: "open", limit: 50, cursor: null }));
  assert.match(text, /required test failed: broken/);
  const alerts = f.db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", f.workId).map((row) => JSON.parse(row.payload_json));
  const alert = alerts.find((a) => a.output_tail !== undefined);
  assert.ok(alert, JSON.stringify(alerts));
  assert.equal(alert.command_id, "required_tests");
  assert.deepEqual(alert.command, failOnSecondRun(f.project));
  assert.match(alert.output_tail, /required test failed: broken/);
  assert.match(JSON.stringify(alert), /exit 3/);
});

test("Core with a passing required test merges and advances base", async (t) => {
  const f = await coreFixture(t, REQUIRED);
  await commitTaskState(f, "ok\n");
  const oldBase = git(f.project, "rev-parse", "refs/heads/main");
  await f.core.start();
  await f.core.tick(f.workId);

  assert.equal(f.db.get("SELECT state FROM works WHERE id = ?", f.workId).state, "completed");
  assert.notEqual(git(f.project, "rev-parse", "refs/heads/main"), oldBase);
  assert.equal(git(f.project, "show", "refs/heads/main:state.txt"), "ok");
});

test("Core without a required test command merges a Work that would fail it", async (t) => {
  const f = await coreFixture(t, []);
  await commitTaskState(f, "broken\n");
  await f.core.start();
  await f.core.tick(f.workId);

  assert.equal(f.db.get("SELECT state FROM works WHERE id = ?", f.workId).state, "completed");
  assert.equal(git(f.project, "show", "refs/heads/main:state.txt"), "broken");
});
