import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { NoopGitGateway, createProviderPauseStore, createTaskPlanInTransaction, createWorkInTransaction } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

// Core's verification and fake harnesses spawn node/git through PATH; keep them reachable when the runner starts with an empty environment.
process.env.PATH ||= `${dirname(process.execPath)}:/usr/bin:/bin`;
process.env.HOME ||= "/tmp";

const NOW = "2030-01-02T03:04:05.000Z";

// Cores made by makeCore for a database, so the cleanup can stop them before the database is closed.
const coresByDatabase = new WeakMap();

// The cleanup hook is registered before the temporary directory so it runs first:
// release gates, stop every Core, close the database, then the directory is removed.
async function dbInTemp(t, beforeStop = () => {}) {
  let db;
  t.after(async () => {
    await beforeStop();
    for (const core of (coresByDatabase.get(db) ?? []).reverse()) await core.stop({ force: true });
    db?.close();
  });
  const root = await tempDir(t, "owl-provider-pause-reviewer-recovery-");
  db = createTestDatabase(root);
  coresByDatabase.set(db, []);
  return { root, db };
}

// Not helpers/wait.mjs waitFor: these tests mock Date and setTimeout, so a deadline/timer based poll would never advance. Polls by event-loop turns instead.
async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 20000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function reviewerAgentRunner({ thrown = false } = {}) {
  let reviewerAttempts = 0;
  return {
    get reviewerAttempts() { return reviewerAttempts; },
    runner: {
      runWorker: async (request) => (await writeValidFile(request), {
        outcome: "success", report_valid: true,
        report: { result: "success", verification: { passed: true } },
        skill_feedback: null,
      }),
      runReviewer: async () => {
        reviewerAttempts += 1;
        if (reviewerAttempts === 1 && thrown) {
          throw Object.assign(new Error("limit"), { failure_class: "rate_limited", rate_limit: { resets_at: NOW, source: "event" }, outcome: "failed_after_side_effect", retry_allowed: false });
        }
        return reviewerAttempts === 1
          ? {
              outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
              rate_limit: { resets_at: NOW, source: "event" }, message: "limit", skill_feedback: null,
            }
          : {
              outcome: "success", report_valid: true, report: { result: "success" },
              review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null,
            };
      },
      runManagerPlan: async () => ({ outcome: "failed", skill_feedback: null }),
      runAdvisor: async () => ({ reply: "" }),
    },
  };
}

async function makeCore(t, db, root, agentRunner) {
  const { core } = await createTestCore(t, {
    db,
    agentRunner,
    version: "provider-pause-reviewer-recovery-test",
    owlRoot: root,
    git: Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) }),
    dispatcher: { tick_interval_ms: 60_000 },
    now: () => new Date().toISOString(),
  });
  coresByDatabase.get(db).push(core);
  return core;
}

async function seedReviewTask(db) {
  return db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Review recovery", summary: "Retry a paused Reviewer", size: "normal", project_id: null });
    const [task] = createTaskPlanInTransaction(tx, work.id, [
      { id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] },
    ]);
    tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "worker", provider: "openai", model: "gpt-5.6-terra" },
        { role: "reviewer", provider: "anthropic", model: "claude-sonnet-5" },
      ] }), NOW);
    return { workId: work.id, taskId: task.id };
  });
}

async function seedTwoReviewTasks(db) {
  return db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Two paused Reviews", summary: "Retry both Reviewers", size: "normal", project_id: null });
    const tasks = createTaskPlanInTransaction(tx, work.id, [
      { id: "REVIEW_ONE", title: "Review one", type: "code", acceptance: "Pass", depends_on: [] },
      { id: "REVIEW_TWO", title: "Review two", type: "code", acceptance: "Pass", depends_on: [] },
    ]);
    for (const task of tasks) tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "worker", provider: "openai", model: "gpt-5.6-terra" },
        { role: "reviewer", provider: "anthropic", model: "claude-sonnet-5" },
      ] }), NOW);
    return { workId: work.id, taskIds: tasks.map((task) => task.id) };
  });
}

async function writeValidFile(request) {
  await writeFile(join(request.context.worktree, `${request.task_id}.mjs`), "export const x = 1;\n");
}

test("a thrown Reviewer rate limit pauses the Provider without a Decision and retries after resume", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db } = await dbInTemp(t);
  const { workId, taskId } = await seedReviewTask(db);
  const agent = reviewerAgentRunner({ thrown: true });
  const core = await makeCore(t, db, root, agent.runner);
  await core.start();
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
  await core.tick(workId);
  await core.workflow.drainPipelines();
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'reviewer.rate_limited'").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'decision.opened'").count, 0);
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  assert.equal(createProviderPauseStore(db).list().find((pause) => pause.provider === "anthropic")?.state, "paused");

  t.mock.timers.tick(30_000);
  await waitUntil(() => agent.reviewerAttempts === 2 && db.get("SELECT status FROM tasks WHERE id = ?", taskId).status === "completed", "Reviewer retry after provider resume");
});

test("Core restart preserves a rate-limited Reviewer wait and retries it when the provider resumes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db } = await dbInTemp(t);
  const { workId, taskId } = await seedReviewTask(db);
  const agent = reviewerAgentRunner();
  const firstCore = await makeCore(t, db, root, agent.runner);
  await firstCore.start();
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
  await firstCore.tick(workId);
  await firstCore.workflow.drainPipelines();
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "verifying");
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  assert.equal(db.get("SELECT status FROM agent_runs WHERE role = 'reviewer' AND task_id = ?", taskId).status, "exited");
  assert.equal(createProviderPauseStore(db).list().find((pause) => pause.provider === "anthropic")?.state, "paused");
  assert.ok(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `paused-reviewer-wait:${taskId}`));

  await firstCore.stop({ force: true });
  const restartedCore = await makeCore(t, db, root, agent.runner);
  await restartedCore.start();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "verifying");

  t.mock.timers.tick(30_000);
  await waitUntil(() => agent.reviewerAttempts === 2 && db.get("SELECT status FROM tasks WHERE id = ?", taskId).status === "completed", "Reviewer retry after provider resume");
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE role = 'reviewer' AND task_id = ?", taskId).count, 2);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = ?", `paused-reviewer-wait:${taskId}`).count, 0);
});

test("Core restart retries a rate-limited Reviewer when another call already resumed its provider", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db } = await dbInTemp(t);
  const { workId, taskId } = await seedReviewTask(db);
  const agent = reviewerAgentRunner();
  const firstCore = await makeCore(t, db, root, agent.runner);
  await firstCore.start();
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
  await firstCore.tick(workId);
  await firstCore.workflow.drainPipelines();
  assert.ok(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `paused-reviewer-wait:${taskId}`));

  const pauseStore = createProviderPauseStore(db, () => NOW);
  await pauseStore.resume("anthropic");
  assert.equal((await pauseStore.noteProviderSucceeded("anthropic", NOW))?.state, "active");
  assert.equal(pauseStore.list().length, 0);
  await firstCore.stop({ force: true });

  const restartedCore = await makeCore(t, db, root, agent.runner);
  await restartedCore.start();
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  assert.notEqual(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "review_fix_waiting");
  await waitUntil(() => agent.reviewerAttempts === 2 && db.get("SELECT status FROM tasks WHERE id = ?", taskId).status === "completed", "Reviewer retry after another call resumed the provider");

  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE role = 'reviewer' AND task_id = ?", taskId).count, 2);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = ?", `paused-reviewer-wait:${taskId}`).count, 0);
});

test("restart preserves every Reviewer wait for one paused Provider, including Tasks with no Reviewer run", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db } = await dbInTemp(t, () => {
    releaseSecondWorker();
    releaseResumedReviewers();
  });
  const { workId, taskIds } = await seedTwoReviewTasks(db);
  let releaseSecondWorker;
  let secondWorkerStarted;
  const secondStarted = new Promise((resolvePromise) => { secondWorkerStarted = resolvePromise; });
  const secondWorkerGate = new Promise((resolvePromise) => { releaseSecondWorker = resolvePromise; });
  let releaseResumedReviewers;
  const resumedReviewersGate = new Promise((resolvePromise) => { releaseResumedReviewers = resolvePromise; });
  let reviewerAttempts = 0;
  const runner = {
    runWorker: async (request) => {
      if (request.task_id === taskIds[1]) {
        secondWorkerStarted();
        await secondWorkerGate;
      }
      await writeValidFile(request);
      return {
        outcome: "success", report_valid: true,
        report: { result: "success", verification: { passed: true } },
        skill_feedback: null,
      };
    },
    runReviewer: async () => {
      reviewerAttempts += 1;
      if (reviewerAttempts === 1) {
        return {
            outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
            rate_limit: { resets_at: NOW, source: "event" }, message: "limit", skill_feedback: null,
        };
      }
      await resumedReviewersGate;
      return {
        outcome: "success", report_valid: true, report: { result: "success" },
        review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null,
      };
    },
    runManagerPlan: async () => ({ outcome: "failed", skill_feedback: null }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const firstCore = await makeCore(t, db, root, runner);
  await firstCore.start();
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
  await firstCore.tick(workId);
  await secondStarted;
  await waitUntil(() => createProviderPauseStore(db).list().some((pause) => pause.provider === "anthropic"), "first Reviewer rate limit");
  releaseSecondWorker();
  await firstCore.workflow.drainPipelines();

  assert.deepEqual(taskIds.map((taskId) => db.get("SELECT status FROM tasks WHERE id = ?", taskId).status), ["verifying", "verifying"]);
  assert.deepEqual(taskIds.map((taskId) => db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count), [0, 0]);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key LIKE 'paused-reviewer-wait:%'").count, 2);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE role = 'reviewer' AND task_id = ?", taskIds[0]).count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE role = 'reviewer' AND task_id = ?", taskIds[1]).count, 0);

  await firstCore.stop({ force: true });
  const restartedCore = await makeCore(t, db, root, runner);
  await restartedCore.start();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(taskIds.map((taskId) => db.get("SELECT status FROM tasks WHERE id = ?", taskId).status), ["verifying", "verifying"]);
  assert.deepEqual(taskIds.map((taskId) => db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count), [0, 0]);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key LIKE 'paused-reviewer-wait:%'").count, 2);

  t.mock.timers.tick(30_000);
  await waitUntil(() => reviewerAttempts === 3, "both Reviewers to restart");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key LIKE 'paused-reviewer-wait:%'").count, 0);
  releaseResumedReviewers();
  await waitUntil(() => taskIds.every((taskId) => db.get("SELECT status FROM tasks WHERE id = ?", taskId).status === "completed"), "both Reviewers after Provider resume");
  assert.deepEqual(taskIds.map((taskId) => db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count), [0, 0]);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key LIKE 'paused-reviewer-wait:%'").count, 0);
});

test("startup counts an ordinary orphaned Reviewer while its Provider is paused for another Task", async (t) => {
  const { root, db } = await dbInTemp(t);
  const { taskId, otherTaskId } = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Reviewer crash", summary: "Count a real crash", size: "normal", project_id: null });
    const [task, otherTask] = createTaskPlanInTransaction(tx, work.id, [
      { id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] },
      { id: "OTHER", title: "Other task", type: "code", acceptance: "Pass", depends_on: [] },
    ]);
    const timestamp = new Date().toISOString();
    tx.run("UPDATE tasks SET status = 'verifying', review_override = 'true' WHERE id = ?", task.id);
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'reviewer', 'anthropic', 'claude-sonnet-5', 'exited', ?, ?)`,
      createUlid(), work.id, task.id, timestamp, timestamp,
    );
    return { taskId: task.id, otherTaskId: otherTask.id };
  });
  await createProviderPauseStore(db).recordRateLimit({ provider: "anthropic", resets_at: NOW, role: "worker", task_id: otherTaskId });
  const core = await makeCore(t, db, root, reviewerAgentRunner().runner);

  await core.start();

  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 1);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "review_fix_waiting");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM provider_pauses WHERE state <> 'active'").count, 1);
});
