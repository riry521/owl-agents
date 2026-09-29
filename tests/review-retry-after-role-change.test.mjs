import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { Core, createTaskPlanInTransaction, createWorkInTransaction, NoopGitGateway, WorkflowEngine } from "../packages/core/dist/index.js";
import { recoverOrphanedState } from "../packages/core/dist/startup-recovery.js";
import { readPausedReviewerWait } from "../packages/core/dist/provider-pause-reviewer-wait.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const migrations = join(resolve(process.cwd()), "packages/db/migrations");
const NOW = "2030-01-02T03:04:05.000Z";

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function setReviewerRole(db, provider, model) {
  await db.createWriteLane().transact((tx) => {
    tx.run("DELETE FROM settings WHERE key = 'model_settings'");
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "worker", provider: "anthropic", model: "claude-test" },
        { role: "reviewer", provider, model },
      ] }),
      NOW,
    );
  });
}

// Leaves one Task in `verifying` whose Reviewer launch was withheld because openai is paused.
async function harness(t, { pausedProviders = ["openai"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-review-retry-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(migrations);
  const paused = new Set(pausedProviders);
  const launches = [];
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Review retry", summary: "Retry review", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] }]);
    tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    return work.id;
  });
  await setReviewerRole(db, "openai", "codex-test");
  const workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async () => ({
        outcome: "success", report_valid: true,
        report: { result: "success", verification: { passed: true } },
        skill_feedback: null,
      }),
      runReviewer: async () => {
        launches.push(db.get("SELECT provider FROM agent_runs WHERE role = 'reviewer' ORDER BY created_at DESC LIMIT 1").provider);
        return {
          outcome: "success", report_valid: true, report: { result: "success" },
          review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null,
        };
      },
    },
    git: new NoopGitGateway(),
    owlRoot: root,
    dataDir: root,
    providerPauseController: {
      isPaused: (provider) => paused.has(provider),
      noteProviderSucceeded: async () => {},
    },
  });
  t.after(async () => { await workflow.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  workflow.start();
  await workflow.resolveDependencies(workId);
  await workflow.launchReady(workId);
  await workflow.drainPipelines();
  const taskId = db.get("SELECT id FROM tasks WHERE manager_task_id = 'REVIEW'").id;
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "verifying");
  assert.equal(readPausedReviewerWait(db, taskId)?.provider, "openai");
  assert.deepEqual(launches, []);
  return { db, workflow, paused, launches, taskId };
}

async function assertCompletedWith(ctx, provider) {
  await waitUntil(() => ctx.db.get("SELECT status FROM tasks WHERE id = ?", ctx.taskId).status === "completed", "task completion");
  assert.deepEqual(ctx.launches, [provider]);
  assert.equal(readPausedReviewerWait(ctx.db, ctx.taskId), undefined);
}

test("switching the Reviewer role to an unpaused provider launches the waiting Review", async (t) => {
  const ctx = await harness(t);
  await setReviewerRole(ctx.db, "orca", "orca-test");
  ctx.paused.delete("openai");
  ctx.workflow.resumeProvider("openai");
  ctx.workflow.retryWaitingReviews();
  await assertCompletedWith(ctx, "orca");
});

test("Core.updateModelSettings launches the waiting Review when the Reviewer role moves to an unpaused provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-review-retry-core-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(migrations);
  const launches = [];
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Review retry", summary: "Retry review", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] }]);
    tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    tx.run(
      `INSERT INTO provider_pauses (provider, state, paused_at, resume_at, resume_source, created_at, updated_at)
       VALUES ('openai', 'paused', ?, '2099-01-01T00:00:00.000Z', 'reported', ?, ?)`,
      NOW, NOW, NOW,
    );
    return work.id;
  });
  await setReviewerRole(db, "openai", "codex-test");
  const core = new Core({
    db,
    version: "test",
    owlRoot: root,
    dataDir: root,
    git: new NoopGitGateway(),
    agentRunner: {
      runWorker: async () => ({
        outcome: "success", report_valid: true,
        report: { result: "success", verification: { passed: true } },
        skill_feedback: null,
      }),
      runReviewer: async () => {
        launches.push(db.get("SELECT provider FROM agent_runs WHERE role = 'reviewer' ORDER BY created_at DESC LIMIT 1").provider);
        return {
          outcome: "success", report_valid: true, report: { result: "success" },
          review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null,
        };
      },
    },
  });
  t.after(async () => { await core.stop?.(); db.close(); await rm(root, { recursive: true, force: true }); });
  await core.start();
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ?", workId).id;
  await waitUntil(() => readPausedReviewerWait(db, taskId)?.provider === "openai", "parked Review");
  assert.deepEqual(launches, []);

  const current = core.getModelSettings();
  await core.updateModelSettings({
    request_id: createUlid(),
    idempotency_key: "test:reviewer-role-switch",
    expected_version: current.version,
    payload: { roles: current.roles.map((role) => (
      role.role === "reviewer" ? { ...role, provider: "anthropic", model: "claude-test" } : role
    )).map((role) => ({ ...role, effort: role.effort ?? "high" })) },
  });
  await waitUntil(() => db.get("SELECT status FROM tasks WHERE id = ?", taskId).status === "completed", "task completion");
  assert.deepEqual(launches, ["anthropic"]);
});

test("the waiting Review stays parked when the new Reviewer provider is also paused", async (t) => {
  const ctx = await harness(t);
  ctx.paused.add("orca");
  await setReviewerRole(ctx.db, "orca", "orca-test");
  ctx.workflow.retryWaitingReviews();
  ctx.workflow.resumeProvider("openai");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.deepEqual(ctx.launches, []);
  assert.equal(ctx.db.get("SELECT status FROM tasks WHERE id = ?", ctx.taskId).status, "verifying");
  assert.equal(readPausedReviewerWait(ctx.db, ctx.taskId)?.provider, "openai");
});

test("resuming the old provider after a role switch launches the Review with the current provider", async (t) => {
  const ctx = await harness(t);
  await setReviewerRole(ctx.db, "orca", "orca-test");
  ctx.paused.delete("openai");
  ctx.workflow.resumeProvider("openai");
  await assertCompletedWith(ctx, "orca");
});

test("resuming an unrelated provider does not launch a Review waiting on another one", async (t) => {
  const ctx = await harness(t);
  await setReviewerRole(ctx.db, "orca", "orca-test");
  ctx.workflow.resumeProvider("anthropic");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.deepEqual(ctx.launches, []);
});

test("startup recovery flags a Review waiting on a paused provider so a moved Reviewer role can run it", async (t) => {
  const ctx = await harness(t);
  await ctx.db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO provider_pauses (provider, state, paused_at, resume_at, resume_source, created_at, updated_at)
       VALUES ('openai', 'paused', ?, '2099-01-01T00:00:00.000Z', 'reported', ?, ?)`,
      NOW, NOW, NOW,
    );
  });
  await setReviewerRole(ctx.db, "orca", "orca-test");
  const recovery = await recoverOrphanedState(ctx.db);
  assert.deepEqual(recovery.reviewerProvidersToResume, []);
  ctx.workflow.retryWaitingReviews();
  await assertCompletedWith(ctx, "orca");
});
