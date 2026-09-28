import assert from "node:assert/strict";
import { test } from "node:test";
import { Core } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";
import { createUlid } from "../packages/db/dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: `test:${suffix}:${createUlid()}`, expected_version: expectedVersion, payload };
}

function fakeGit(merges = [], pushes = [], pushError = null) {
  const calls = [];
  const state = { workspaces: [], workBranchExists: true };
  return {
    calls,
    async abortIntegrationMerge(request) { calls.push(["abortIntegrationMerge", request.work_id]); return { ok: true, message: "No merge was in progress." }; },
    async mergeWorkIntoBase(request) {
      calls.push(["mergeWorkIntoBase", request.work_id]);
      return merges.shift() ?? {
        kind: "merged", ok: true, exit_code: 0, recorded: false, message: "merged", worktree_path: "/tmp/integration",
        base_branch: "main", work_branch: `owl/work/${request.work_id}/work`, old_base_commit: "a".repeat(40),
        new_base_commit: "b".repeat(40), merge_commit: "b".repeat(40), verification_commands_run: [],
      };
    },
    async deleteMergedWorkBranches(request) {
      calls.push(["deleteMergedWorkBranches", request.work_id]);
      const deleted = state.workBranchExists ? { [`owl/work/${request.work_id}/work`]: "c".repeat(40) } : {};
      state.workBranchExists = false;
      return { ok: true, message: "branches removed", deleted_branches: deleted };
    },
    async pushBaseBranch(request) {
      calls.push(["pushBaseBranch", request.work_id]);
      if (pushError) throw pushError;
      return (pushes.length > 1 ? pushes.shift() : pushes[0]) ?? { ok: true, exit_code: 0, recorded: false, kind: "skipped_disabled", message: "disabled" };
    },
    async removeWorktree() { return { ok: true, message: "removed" }; },
    async removeIntegrationWorktree() { return { ok: true, message: "removed" }; },
    async removeMergedIntegrationWorktree() { return { ok: true, message: "removed" }; },
    async removeTaskWorktreeAndBranch() { return { ok: true, message: "removed" }; },
    async discardTaskWorktree() { return { ok: true, message: "discarded" }; },
    async discardMergedWorktree() { return { ok: true, message: "discarded" }; },
    async listWorkspaces() { return state.workspaces; },
  };
}

async function openMergeCore(t, git, beforeStart) {
  const root = await mkdtemp(join(tmpdir(), "owl-auto-push-core-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const agentRunner = {
    runManagerPlan: async (request) => ({
      outcome: "success", report_valid: true,
      report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] } },
    }),
    runWorker: async () => ({ outcome: "failed", message: "unexpected worker call" }),
    runReviewer: async () => ({ outcome: "failed", message: "unexpected reviewer call" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, git, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 } });
  t.after(async () => { await core.stop({ force: true }); db.close(); await rm(root, { recursive: true, force: true }); });
  if (beforeStart) await beforeStart({ db, core, root });
  await core.start();
  return { db, core, root };
}

async function seedFinishedWork(core, db, withProject = false) {
  if (withProject) {
    await core.createProject(commandEnvelope({
      name: "Auto push test project", canonical_path: join(tmpdir(), `owl-project-${createUlid()}`),
      base_branch: "main", allowed_roots: [tmpdir()], verification_plan: [],
    }, "project"));
  }
  const projectId = withProject ? db.get("SELECT id FROM projects ORDER BY created_at DESC LIMIT 1").id : null;
  const created = await core.createWork(commandEnvelope({
    title: "Auto push test", summary: "Check push behavior.", size: "normal", project_id: projectId,
  }, "work"));
  const workId = created.data.work_id;
  const taskId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks
         (id, work_id, title, type, status, priority, context, acceptance,
          state_version, failure_count, same_error_count, review_round, worker_generation,
          created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'Done', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    const runId = createUlid();
    tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)", runId, workId, taskId, now, now);
    tx.run("INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1', 'success', ?, ?, 0, ?)", createUlid(), runId, JSON.stringify({ kind: "report", result: "success", work_done: "Done." }), "0".repeat(64), now);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  return { workId, taskId };
}

async function enableAutoPush(db, workId, enabled = true) {
  const projectId = db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id;
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE projects SET auto_push = ? WHERE id = ?", enabled ? 1 : 0, projectId);
    return null;
  });
  return projectId;
}

test("auto push runs after branch cleanup only when enabled and records work.pushed", async (t) => {
  const pushed = {
    ok: true, exit_code: 0, recorded: false, kind: "pushed", message: "Pushed.",
    remote: "origin", base_branch: "main", remote_ref: "refs/heads/main",
    previous_tracking_commit: "a".repeat(40), new_remote_commit: "b".repeat(40),
    up_to_date: false, hook_warnings: [],
  };
  const git = fakeGit([], [pushed]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  const projectId = await enableAutoPush(db, workId);
  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.deepEqual(git.calls.filter(([name]) => ["deleteMergedWorkBranches", "pushBaseBranch"].includes(name)).map(([name]) => name), ["deleteMergedWorkBranches", "pushBaseBranch"]);
  const event = db.get("SELECT idempotency_key, payload_json FROM events WHERE work_id = ? AND type = 'work.pushed'", workId);
  assert.ok(event);
  assert.equal(event.idempotency_key, `work-pushed:${workId}:${pushed.new_remote_commit}`);
  assert.deepEqual(JSON.parse(event.payload_json), {
    work_id: workId, project_id: projectId, remote: "origin", base_branch: "main",
    remote_branch: "main", remote_ref: "refs/heads/main",
    previous_tracking_commit: "a".repeat(40), new_remote_commit: "b".repeat(40),
    up_to_date: false, hook_warnings: [],
  });
});

test("auto push disabled, an unavailable optional method, or merge failure never pushes", async (t) => {
  const disabledGit = fakeGit();
  const disabled = await openMergeCore(t, disabledGit);
  const disabledWork = await seedFinishedWork(disabled.core, disabled.db, true);
  await disabled.core.tick(disabledWork.workId);
  assert.equal(disabledGit.calls.filter(([name]) => name === "pushBaseBranch").length, 0);

  const noMethodGit = fakeGit();
  delete noMethodGit.pushBaseBranch;
  const noMethod = await openMergeCore(t, noMethodGit);
  const noMethodWork = await seedFinishedWork(noMethod.core, noMethod.db, true);
  await enableAutoPush(noMethod.db, noMethodWork.workId);
  await noMethod.core.tick(noMethodWork.workId);
  assert.equal(noMethod.db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type LIKE 'work.push%'", noMethodWork.workId).n, 0);

  const failedMergeGit = fakeGit([{ kind: "conflict", ok: false, exit_code: 1, recorded: false, message: "conflict", conflicting_files: [], aborted: true, abort_message: "aborted" }]);
  const failedMerge = await openMergeCore(t, failedMergeGit);
  const failedWork = await seedFinishedWork(failedMerge.core, failedMerge.db, true);
  await enableAutoPush(failedMerge.db, failedWork.workId);
  await failedMerge.core.tick(failedWork.workId);
  assert.equal(failedMergeGit.calls.filter(([name]) => name === "pushBaseBranch").length, 0);
});

test("push failures and missing upstream keep Work completed and record reason-bearing idempotent alerts", async (t) => {
  const scenarios = [
    ["non_fast_forward", { failure: "non_fast_forward", hook_side: null }, "work_push_failed"],
    ["network", { failure: "network", hook_side: null }, "work_push_failed"],
    ["auth", { failure: "auth", hook_side: null }, "work_push_failed"],
    ["unknown", { failure: "unknown", hook_side: null }, "work_push_failed"],
    ["hook_local", { failure: "hook_rejected", hook_side: "local" }, "work_push_blocked_by_hook"],
    ["hook_remote", { failure: "hook_rejected", hook_side: "remote" }, "work_push_blocked_by_hook"],
  ];
  for (const [name, failure, kind] of scenarios) {
    const reason = name === "hook_local" ? "owl-pre-push: blocked: policy check" : name === "network" ? `${name} diagnostic ${"x".repeat(700)}` : `${name} diagnostic`;
    const result = {
      ok: false, exit_code: 1, recorded: false, kind: "failed", message: `git push failed (${failure.failure})`,
      ...failure, remote: "origin", base_branch: "main", remote_ref: "refs/heads/main",
      base_commit: "c".repeat(40), stderr_tail: reason,
    };
    const git = fakeGit([], [result]);
    const { db, core } = await openMergeCore(t, git);
    const { workId } = await seedFinishedWork(core, db, true);
    const projectId = await enableAutoPush(db, workId);
    await core.tick(workId);
    await core.pushCompletedWork(workId, projectId);
    assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed", name);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = ?", workId, kind).n, 1, name);
    const alert = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).payload_json);
    if (name !== "network") assert.match(alert.message, new RegExp(name === "hook_local" ? "owl-pre-push: blocked: policy check" : `${name} diagnostic`));
    assert.equal(alert.push_failure, failure.failure === "hook_rejected" ? undefined : failure.failure);
    assert.equal(alert.hook_side, failure.hook_side === "local" || failure.hook_side === "remote" ? failure.hook_side : undefined);
    assert.equal(alert.stderr_tail, reason);
    assert.equal(alert.message.endsWith(reason.slice(-500)), true);
  }

  const skipped = { ok: true, exit_code: 0, recorded: false, kind: "skipped_no_upstream", message: "No upstream.", base_branch: "main", base_commit: "d".repeat(40) };
  const git = fakeGit([], [skipped]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  const projectId = await enableAutoPush(db, workId);
  await core.tick(workId);
  const alert = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).payload_json);
  assert.equal(alert.kind, "work_push_skipped_no_upstream");
  assert.equal(alert.stderr_tail, undefined);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(git.calls.filter(([name]) => name === "pushBaseBranch").length, 1);
});

test("a push failure without a base commit stays idempotent when processed again", async (t) => {
  const failed = {
    ok: false, exit_code: 1, recorded: false, kind: "failed", failure: "network", hook_side: null,
    remote: "origin", base_branch: "main", remote_ref: "refs/heads/main", base_commit: null,
    stderr_tail: "connection refused", message: "Could not connect to origin.",
  };
  const git = fakeGit([], [failed]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  const projectId = await enableAutoPush(db, workId);

  await core.tick(workId);
  await core.pushCompletedWork(workId, projectId);

  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_push_failed'", workId).n, 1);
});

test("push failure alert includes the GitGateway message when stderr is empty", async (t) => {
  const reason = "Could not resolve Project base branch main: https://user:secret@example.invalid returned an invalid upstream.";
  const failed = {
    ok: false, exit_code: 1, recorded: false, kind: "failed", failure: "unknown", hook_side: null,
    remote: null, base_branch: "main", remote_ref: null, base_commit: "f".repeat(40),
    stderr_tail: "", message: reason,
  };
  const git = fakeGit([], [failed]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  await enableAutoPush(db, workId);

  await core.tick(workId);

  const alert = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).payload_json);
  assert.ok(alert.message.includes("Could not resolve Project base branch main: https://***@example.invalid returned an invalid upstream."));
  assert.doesNotMatch(alert.message, /secret/u);
});

test("a thrown push error becomes an unknown failure alert without undoing completion", async (t) => {
  const git = fakeGit([], [], new Error("https://user:secret@example.invalid push crashed"));
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  await enableAutoPush(db, workId);
  await core.tick(workId);
  const alert = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).payload_json);
  assert.equal(alert.kind, "work_push_failed");
  assert.equal(alert.push_failure, "unknown");
  assert.match(alert.message, /push crashed/);
  assert.doesNotMatch(alert.message, /secret/);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
});

test("push alerts use the Owner language", async (t) => {
  const result = {
    ok: false, exit_code: 1, recorded: false, kind: "failed", failure: "network", hook_side: null,
    remote: "origin", base_branch: "main", remote_ref: "refs/heads/main", base_commit: "e".repeat(40),
    stderr_tail: "connection refused", message: "git push failed (network)",
  };
  const git = fakeGit([], [result]);
  const { db, core } = await openMergeCore(t, git);
  await core.setLanguage("en");
  const { workId } = await seedFinishedWork(core, db, true);
  await enableAutoPush(db, workId);
  await core.tick(workId);
  const alert = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).payload_json);
  assert.match(alert.message, /^Could not push base branch main to origin\/main/u);
  assert.match(alert.remediation, /Check the connection/u);
});
