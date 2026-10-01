import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}:${createUlid()}`,
    expected_version: expectedVersion,
    payload,
  };
}

function fakeGit(merges = []) {
  const calls = [];
  const state = {
    integrationRemoval: { ok: true, message: "worktree removed" },
    workspaces: [],
    workBranchExists: true,
  };
  return {
    calls,
    state,
    async abortIntegrationMerge(request) {
      calls.push(["abortIntegrationMerge", request.work_id]);
      return { ok: true, message: "No merge was in progress." };
    },
    async mergeWorkIntoBase(request) {
      calls.push(["mergeWorkIntoBase", request.work_id]);
      return merges.shift() ?? { kind: "merged", ok: true, message: "merged" };
    },
    async deleteMergedWorkBranches(request) {
      calls.push(["deleteMergedWorkBranches", request.work_id]);
      const deleted = state.workBranchExists ? { [`owl/work/${request.work_id}/work`]: "c".repeat(40) } : {};
      state.workBranchExists = false;
      return { ok: true, message: "branches removed", deleted_branches: deleted };
    },
    async removeIntegrationWorktree(request) {
      calls.push(["removeIntegrationWorktree", request.work_id]);
      return state.integrationRemoval;
    },
    async removeMergedIntegrationWorktree(request) {
      calls.push(["removeMergedIntegrationWorktree", request.work_id]);
      return state.integrationRemoval;
    },
    async listWorkspaces() { return state.workspaces; },
    async discardTaskWorktree() { return { ok: true, message: "discarded" }; },
    async discardMergedWorktree() { return { ok: true, message: "discarded" }; },
    async removeWorktree() { return { ok: true, message: "removed" }; },
  };
}

async function openMergeCore(t, git, beforeStart, { replanEvent = "task.replanned" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-work-merge-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const planRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => (planRequests.push(request), {
      outcome: "success",
      report_valid: true,
      report: {
        tasks: request.tasks ?? [],
        event: request.mode === "replan" ? replanEvent : null,
        verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] },
      },
    }),
    runWorker: async () => ({ outcome: "failed", message: "unexpected worker call" }),
    runReviewer: async () => ({ outcome: "failed", message: "unexpected reviewer call" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const createCore = () => new Core({
    db,
    git,
    agentRunner,
    version: "test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 },
  });
  let core = createCore();
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  if (beforeStart) await beforeStart({ db, core, root });
  await core.start();
  /** Stop Core and start a new one over the same database, running the startup pass again. */
  const restart = async () => {
    await core.stop({ force: true });
    core = createCore();
    await core.start();
    return core;
  };
  return { db, core, root, planRequests, restart };
}

async function seedFinishedWork(core, db, withProject = false) {
  if (withProject) {
    await core.createProject(commandEnvelope({
      name: "Merge test project",
      canonical_path: join(tmpdir(), `owl-project-${createUlid()}`),
      base_branch: "main",
      allowed_roots: [tmpdir()],
      verification_plan: [],
    }, "project"));
  }
  const project = !withProject
    ? null
    : db.get("SELECT id FROM projects ORDER BY created_at DESC LIMIT 1").id;
  const created = await core.createWork(commandEnvelope({
    title: "Merge test",
    summary: "Check Work completion merge behavior.",
    size: "normal",
    project_id: project,
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
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)`,
      runId, workId, taskId, now, now,
    );
    tx.run(
      `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
       VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
      createUlid(), runId, JSON.stringify({ kind: "report", result: "success", work_done: "Done." }), "0".repeat(64), now,
    );
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  return { workId, taskId };
}

const merged = {
  kind: "merged",
  ok: true,
  exit_code: 0,
  recorded: false,
  message: "Work branch merged into main.",
  worktree_path: "/tmp/integration",
  base_branch: "main",
  work_branch: "owl/work/test/work",
  old_base_commit: "a".repeat(40),
  new_base_commit: "b".repeat(40),
  merge_commit: "b".repeat(40),
  verification_commands_run: ["unit-tests"],
};

const conflict = {
  kind: "conflict", ok: false, exit_code: 1, recorded: false, message: "Merge conflict.",
  worktree_path: "/tmp/integration", base_branch: "main", work_branch: "owl/work/test/work",
  conflicting_files: ["src/app.ts", "src/lib.ts"], aborted: true, abort_message: "aborted",
};

async function answer(core, db, workId, optionKey) {
  const decision = db.get("SELECT id, options_json FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision);
  const label = JSON.parse(decision.options_json).find((option) => option.key === optionKey).label;
  await core.answerDecision(decision.id, commandEnvelope({ answer: label, option_key: optionKey, source_message_id: null }, optionKey));
}

test("a merged Project Work is completed, then its worktree and merged branches are removed", async (t) => {
  const git = fakeGit([{ ...merged }]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  const createdAt = "2020-01-02 03:04:05Z";
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET created_at = ? WHERE id = ?", createdAt, workId);
    for (const title of ["Superseded", "Cancelled"]) {
      tx.run(
        `INSERT INTO tasks
           (id, work_id, title, type, status, priority, context, acceptance,
            state_version, failure_count, same_error_count, review_round, worker_generation,
            created_at, updated_at, retry_no, manager_task_id)
         VALUES (?, ?, ?, 'code', 'cancelled', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T2')`,
        createUlid(), workId, title, now, now,
      );
    }
    return null;
  });
  const workBeforeCompletion = db.get("SELECT state_version, plan_revision FROM works WHERE id = ?", workId);

  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.deepEqual(git.calls.filter(([name]) => ["mergeWorkIntoBase", "removeMergedIntegrationWorktree", "deleteMergedWorkBranches"].includes(name)).map(([name]) => name), [
    "mergeWorkIntoBase",
    "removeMergedIntegrationWorktree",
    "deleteMergedWorkBranches",
  ]);
  const completed = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.completed'", workId).payload_json);
  assert.equal(completed.work_id, workId);
  assert.equal(completed.manager_final_verdict, "complete");
  assert.equal(completed.task_count, 1);
  assert.equal(completed.started_at, "2020-01-02T03:04:05.000Z");
  assert.equal(Number.isSafeInteger(completed.duration_ms), true);
  assert.ok(completed.duration_ms >= 0);
  assert.equal(completed.duration_ms, Math.round(Date.parse(completed.completed_at) - Date.parse(completed.started_at)));
  assert.equal(db.get("SELECT completed_at FROM works WHERE id = ?", workId).completed_at, completed.completed_at);
  assert.equal(
    db.get("SELECT idempotency_key FROM events WHERE work_id = ? AND type = 'work.completed'", workId).idempotency_key,
    `work-completed:${workId}:${workBeforeCompletion.state_version}:${workBeforeCompletion.plan_revision}`,
  );
  assert.deepEqual(completed.merge, {
    base_branch: "main",
    work_branch: "owl/work/test/work",
    old_base_commit: "a".repeat(40),
    new_base_commit: "b".repeat(40),
    merge_commit: "b".repeat(40),
    verification_commands_run: ["unit-tests"],
  });
  const deleted = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", workId).payload_json);
  assert.deepEqual(deleted.deleted_branches, { [`owl/work/${workId}/work`]: "c".repeat(40) });
});

test("a merged Work cleanup skip records one alert and keeps its branches", async (t) => {
  const git = fakeGit([{ ...merged }]);
  const { db, core, restart } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  git.state.integrationRemoval = { ok: false, message: "integration worktree is busy" };
  git.state.workspaces.push({ work_id: workId, task_id: null, path: `/workspaces/${workId}/__work__` });

  await core.tick(workId);
  await restart();

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(git.calls.filter(([name]) => name === "deleteMergedWorkBranches").length, 0);
  assert.equal(git.state.workBranchExists, true);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_merge_branch_cleanup_failed'", workId).n, 1);
  const alert = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).payload_json);
  assert.equal(alert.kind, "work_merge_branch_cleanup_failed");
  assert.ok(alert.message.includes("/workspaces/" + workId + "/__work__"));
  assert.match(alert.message, /integration worktree is busy/);
});

test("startup reports a merged Work worktree removal failure and keeps its branches", async (t) => {
  const git = fakeGit();
  git.state.integrationRemoval = { ok: false, message: "Git could not remove the integration worktree." };
  let workId;
  const { db, restart } = await openMergeCore(t, git, async ({ db, core }) => {
    ({ workId } = await seedFinishedWork(core, db, true));
    const now = new Date().toISOString();
    await db.createWriteLane().transact((tx) => {
      tx.run("UPDATE works SET state = 'completed' WHERE id = ?", workId);
      const sequence = db.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events").next;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, created_at)
         VALUES (?, ?, ?, 'work.completed', ?, ?, 'handled', ?)`,
        createUlid(), sequence, "test-completed:" + workId, workId,
        JSON.stringify({ work_id: workId, merge: { base_branch: "main" } }), now,
      );
      return null;
    });
    git.state.workspaces.push({ work_id: workId, task_id: null, path: "/workspaces/" + workId + "/__work__" });
  });
  await restart();

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(git.calls.filter(([name]) => name === "deleteMergedWorkBranches").length, 0);
  assert.equal(git.state.workBranchExists, true);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_merge_branch_cleanup_failed'", workId).n, 1);
  const alert = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).payload_json);
  assert.ok(alert.message.includes("/workspaces/" + workId + "/__work__"));
  assert.match(alert.message, /Git could not remove the integration worktree/);
});

test("startup retries branch cleanup only for completed Project Works with a recorded merge", async (t) => {
  const git = fakeGit();
  let workId;
  let unrecordedWorkId;
  let projectlessWorkId;
  const { db, core } = await openMergeCore(t, git, async ({ db, core }) => {
    ({ workId } = await seedFinishedWork(core, db, true));
    ({ workId: unrecordedWorkId } = await seedFinishedWork(core, db, true));
    ({ workId: projectlessWorkId } = await seedFinishedWork(core, db));
    const now = new Date().toISOString();
    await db.createWriteLane().transact((tx) => {
      for (const id of [workId, unrecordedWorkId, projectlessWorkId]) {
        tx.run("UPDATE works SET state = 'completed' WHERE id = ?", id);
      }
      const sequence = db.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events").next;
      const completedEvent = (id, offset, payload) => tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, created_at)
         VALUES (?, ?, ?, 'work.completed', ?, ?, 'handled', ?)`,
        createUlid(), sequence + offset, `test-completed:${id}`, id, JSON.stringify(payload), now,
      );
      completedEvent(workId, 0, { work_id: workId, merge: { ...merged } });
      completedEvent(unrecordedWorkId, 1, { work_id: unrecordedWorkId });
      return null;
    });
  });

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", projectlessWorkId).state, "completed");
  assert.equal(git.calls.filter(([name]) => name === "mergeWorkIntoBase").length, 0);
  assert.deepEqual(git.calls.filter(([name]) => name === "deleteMergedWorkBranches").map(([, id]) => id), [workId]);
  assert.equal(git.state.workBranchExists, false);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND payload_json LIKE '%work_merge_branch_cleanup_failed%'", workId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", workId).n, 1);
});

const mergeError = {
  kind: "error", ok: false, exit_code: 1, recorded: false, message: "The base checkout has uncommitted changes.",
  base_branch: "main", work_branch: "owl/work/test/work",
};

const autoAlerts = (db, workId) => db.all(
  "SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_merge_conflict_auto_resolve' ORDER BY sequence",
  workId,
).map((row) => JSON.parse(row.payload_json));

/** Tick until the Work opens a Decision; each automatic conflict round takes two ticks. */
async function tickUntilDecision(core, db, workId) {
  for (let i = 0; i < 10 && !db.get("SELECT id FROM decisions WHERE work_id = ? AND status = 'open'", workId); i += 1) {
    await core.tick(workId);
  }
  assert.ok(db.get("SELECT id FROM decisions WHERE work_id = ? AND status = 'open'", workId));
}

test("a merge conflict is handed to the Manager automatically, without a Decision", async (t) => {
  const git = fakeGit([{ ...conflict }, { ...merged }]);
  const { db, core, planRequests } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);

  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0);
  const alerts = autoAlerts(db, workId);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].conflicting_files, ["src/app.ts", "src/lib.ts"]);
  assert.equal(alerts[0].round, 1);
  assert.match(alerts[0].message, /src\/app\.ts/);
  const plansBefore = planRequests.length;

  await core.tick(workId);

  const replan = JSON.stringify(planRequests.slice(plansBefore));
  assert.match(replan, /merges the latest main into the Work/);
  assert.match(replan, /Conflicting files: src\/app\.ts, src\/lib\.ts/);
  assert.match(replan, /resolving the conflict automatically/);

  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(git.calls.filter(([name]) => name === "mergeWorkIntoBase").length, 2);
});

test("when the automatic replan cannot be applied the Owner is asked", async (t) => {
  const git = fakeGit([{ ...conflict }]);
  const { db, core } = await openMergeCore(t, git, undefined, { replanEvent: null });
  const { workId } = await seedFinishedWork(core, db, true);

  await core.tick(workId);
  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 1);
  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.match(decision.reason, /src\/app\.ts, src\/lib\.ts/);
  assert.doesNotMatch(JSON.stringify(decision), /Resolve the merge conflict automatically|Merging the Work into|Owner's answer|あなたの回答/);
});

test("a reopened Work gets automatic conflict resolution again", async (t) => {
  const queue = [{ ...conflict }, { ...conflict }, { ...merged }];
  const git = fakeGit(queue);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  for (let i = 0; i < 6 && db.get("SELECT state FROM works WHERE id = ?", workId).state !== "completed"; i += 1) await core.tick(workId);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(autoAlerts(db, workId).length, 2);

  queue.push({ ...conflict }, { ...merged });
  const version = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.reopenWork(workId, commandEnvelope({ reason: "one more change" }, "reopen", version));
  await core.tick(workId);
  await core.tick(workId);

  assert.equal(autoAlerts(db, workId).length, 3);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0);
});

test("the same conflict is not handed to the Manager twice while its replan is pending", async (t) => {
  const git = fakeGit([{ ...conflict }]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);

  await core.tick(workId);
  const result = await core.tryAutoResolveMergeConflict(workId, { ...conflict });

  assert.deepEqual(result, { handled: true });
  assert.equal(autoAlerts(db, workId).length, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0);
});

test("a conflict on a paused Work is left alone", async (t) => {
  const git = fakeGit([{ ...conflict }]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);
  await db.createWriteLane().transact((tx) => (tx.run("UPDATE works SET state = 'paused' WHERE id = ?", workId), null));

  const result = await core.tryAutoResolveMergeConflict(workId, { ...conflict });

  assert.deepEqual(result, { handled: true });
  assert.equal(autoAlerts(db, workId).length, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`).n, 0);
});

test("the third merge conflict opens the Decision and says automatic resolution was already tried", async (t) => {
  const git = fakeGit([{ ...conflict }, { ...conflict }, { ...conflict }]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);

  await tickUntilDecision(core, db, workId);

  assert.equal(autoAlerts(db, workId).length, 2);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  const decision = db.get("SELECT reason, options_json, recommended FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.match(decision.reason, /src\/app\.ts/);
  assert.match(decision.reason, /src\/lib\.ts/);
  assert.match(decision.reason, /自動解消を2回試しました/);
  assert.deepEqual(JSON.parse(decision.options_json).map((option) => option.key), ["resolve_conflict", "retry", "cancel"]);
  assert.equal(decision.recommended, "resolve_conflict");
  const alert = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence DESC LIMIT 1", workId);
  assert.deepEqual(JSON.parse(alert.payload_json).conflicting_files, ["src/app.ts", "src/lib.ts"]);
  assert.equal(JSON.parse(alert.payload_json).auto_resolve_attempts, 2);
});

test("a merge error still opens the Decision without trying automatic resolution", async (t) => {
  const git = fakeGit([{ ...mergeError }]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);

  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  const decision = db.get("SELECT options_json FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.deepEqual(JSON.parse(decision.options_json).map((option) => option.key), ["retry", "cancel"]);
  assert.equal(autoAlerts(db, workId).length, 0);
});

test("resolving a merge conflict from the Decision asks the Manager for a Task that merges the base, naming the conflicting files", async (t) => {
  const git = fakeGit([{ ...conflict }, { ...conflict }, { ...conflict }]);
  const { db, core, planRequests } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);

  await tickUntilDecision(core, db, workId);
  const plansBefore = planRequests.length;
  await answer(core, db, workId, "resolve_conflict");
  await core.tick(workId);

  const replan = JSON.stringify(planRequests.slice(plansBefore));
  assert.match(replan, /merges the latest main into the Work/);
  assert.match(replan, /Conflicting files: src\/app\.ts, src\/lib\.ts/);
  assert.match(replan, /the Owner asked you to resolve the conflict/);
});

test("a verification failure records the command and output tail in the Decision", async (t) => {
  const git = fakeGit([{
    kind: "verification_failed", ok: false, exit_code: 2, recorded: false, message: "Verification failed.",
    worktree_path: "/tmp/integration", base_branch: "main", work_branch: "owl/work/test/work",
    command_id: "unit-tests", command: ["pnpm", "test"], output_tail: "2 failing tests", stdout_tail: "", stderr_tail: "2 failing tests", timed_out: false,
  }]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);

  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  const decision = db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.match(decision.reason, /pnpm test/);
  assert.match(decision.reason, /2 failing tests/);
});

test("a Project-less Work skips merge and still saves outputs and removes its workspace", async (t) => {
  const git = fakeGit();
  const { db, core, root } = await openMergeCore(t, git);
  const { workId, taskId } = await seedFinishedWork(core, db);
  const taskWorkspace = join(root, ".owl-workspaces", workId, taskId);
  await mkdir(taskWorkspace, { recursive: true });
  await writeFile(join(taskWorkspace, "result.txt"), "saved output\n");

  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(git.calls.filter(([name]) => name === "mergeWorkIntoBase").length, 0);
  const completed = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.completed'", workId).payload_json);
  assert.equal(completed.work_id, workId);
  assert.equal(completed.manager_final_verdict, "complete");
  assert.equal(completed.task_count, 1);
  assert.equal(new Date(completed.started_at).toISOString(), completed.started_at);
  assert.equal(new Date(completed.completed_at).toISOString(), completed.completed_at);
  assert.equal(Number.isSafeInteger(completed.duration_ms), true);
  assert.ok(completed.duration_ms >= 0);
  assert.equal(completed.duration_ms, Math.max(0, Math.round(Date.parse(completed.completed_at) - Date.parse(completed.started_at))));
  assert.equal(Object.hasOwn(completed, "merge"), false);
  assert.equal(await readFile(join(root, "data", "outputs", workId, "result.txt"), "utf8"), "saved output\n");
  await assert.rejects(access(join(root, ".owl-workspaces", workId)));
});

test("retry after a merge failure reruns the final check and merge without a Manager replan", async (t) => {
  const git = fakeGit([{ ...mergeError }, { ...merged }]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);

  await core.tick(workId);
  await answer(core, db, workId, "retry");
  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(git.calls.filter(([name]) => name === "mergeWorkIntoBase").length, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`).n, 0);
});

test("retry follows the alert behind the answered Decision, not a later alert", async (t) => {
  const git = fakeGit([{ ...mergeError }, { ...merged }]);
  const { db, core } = await openMergeCore(t, git);
  const { workId } = await seedFinishedWork(core, db, true);

  await core.tick(workId);
  await db.createWriteLane().transact((tx) => {
    const sequence = db.get("SELECT MAX(sequence) + 1 AS next FROM events").next;
    tx.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, created_at)
       VALUES (?, ?, ?, 'system.alert', ?, ?, 'handled', ?)`,
      createUlid(), sequence, `test-later-alert:${workId}`, workId,
      JSON.stringify({ kind: "final_manager_incomplete", missing: ["unrelated"] }),
      new Date(Date.now() + 60_000).toISOString(),
    );
    return null;
  });
  await answer(core, db, workId, "retry");
  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(git.calls.filter(([name]) => name === "mergeWorkIntoBase").length, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`).n, 0);
});
