import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { AdvisorSessionManager, AdvisorSessionRuntime, createTaskPlanInTransaction, createWorkInTransaction, createProviderPauseController, createProviderPauseStore, NoopGitGateway, WorkflowEngine } from "../../packages/core/dist/index.js";
import { createAgentRunner, toolNamesInLine } from "../../packages/agent-runtime/dist/index.js"; // helpers-exempt: the real runner decides the failure class under test
import { autoRecoveryUsed } from "../../packages/core/dist/auto-recovery.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_ROLE_MODELS } from "../../packages/shared/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { criteriaFor, necessityFor, withNecessity } from "../helpers/necessity.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

// Core's verification and fake harnesses spawn node/git through PATH; keep them reachable when the runner starts with an empty environment.
process.env.PATH ||= `${dirname(process.execPath)}:/usr/bin:/bin`;
process.env.HOME ||= "/tmp";
const NOW = "2030-01-02T03:04:05.000Z";

function fakeClock(initial = NOW) {
  let current = Date.parse(initial);
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => new Date(current).toISOString(),
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: current + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      current += milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= current).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          if (!timers.delete(id)) continue;
          timer.callback();
        }
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
      }
    },
  };
}

// onCleanup registers the test's own teardown (stop engines, close the database).
// It is registered before the temporary directory so it runs first and the directory is removed last.
async function dbInTemp(t) {
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const root = await tempDir(t, "owl-provider-pause-engine-");
  const db = createTestDatabase(root);
  return { root, db, onCleanup: (cleanup) => cleanups.push(cleanup) };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

// For tests with mocked setTimeout: yield to the event loop until the predicate holds.
async function flushUntil(predicate, label) {
  for (let i = 0; i < 500 && !predicate(); i += 1) await flush();
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
}

// Core polls the knowledge storage on the mocked setTimeout but probes it with real file I/O.
// One large tick would fire the 5 s probe timeout before the real probe finishes and mark the
// storage unavailable; its later recovery then races the test's teardown. Step below that timeout
// and let each started probe finish, as real time would.
async function tickMockedClock(t, core, milliseconds) {
  for (let left = milliseconds; left > 0; left -= 1_000) {
    t.mock.timers.tick(Math.min(1_000, left));
    await core.checkKnowledgeStorage();
  }
}

const waitUntil = (predicate, message) => waitFor(predicate, { timeoutMs: 5_000, intervalMs: 10, message });

function unsetDefaultRoleModels(t, ...roles) {
  const saved = new Map(roles.map((role) => [role, DEFAULT_ROLE_MODELS[role]]));
  // Exercise the resolver's undefined-model branch without storing role-specific settings.
  for (const role of roles) delete DEFAULT_ROLE_MODELS[role];
  t.after(() => {
    for (const [role, model] of saved) DEFAULT_ROLE_MODELS[role] = model;
  });
}

function mutablePausedProviders() {
  const paused = new Set();
  return {
    paused,
    controller: {
      isPaused: (provider) => paused.has(provider === "claude" ? "anthropic" : provider === "codex" ? "openai" : provider),
      noteProviderSucceeded: async () => {},
    },
  };
}

async function writeValidFile(request) {
  await writeFile(join(request.context.worktree, "a.mjs"), "export const x = 1;\n");
}

test("a Task without a role model uses the default Provider in both launch pause checks", async (t) => {
  unsetDefaultRoleModels(t, "worker");
  const { root, db, onCleanup } = await dbInTemp(t);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Default provider pause", summary: "Wait for Anthropic", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    createTaskPlanInTransaction(tx, work.id, [{ id: "WORK", title: "Implement", type: "doc", acceptance: "Change", depends_on: [] }]);
    return work.id;
  });
  const providerState = mutablePausedProviders();
  let prepareCount = 0;
  let workerAttempts = 0;
  let workerProvider;
  const workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async (request) => {
        workerAttempts += 1;
        workerProvider = request.provider;
        return { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null };
      },
    },
    git: Object.assign(new NoopGitGateway(), {
      prepareWorktree: async () => {
        prepareCount += 1;
        if (prepareCount === 1) providerState.paused.add("anthropic");
        return { ok: true, worktree_path: root };
      },
    }),
    owlRoot: root,
    dataDir: root,
    providerPauseController: providerState.controller,
  });
  onCleanup(async () => { await workflow.stop(); db.close(); });
  workflow.start();
  await workflow.resolveDependencies(workId);
  const taskId = db.get("SELECT id FROM tasks WHERE manager_task_id = 'WORK'").id;

  assert.deepEqual(await workflow.launchReady(workId), [], "the transaction rechecks after Anthropic pauses during worktree preparation");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = ?", taskId).count, 0);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");
  assert.deepEqual(await workflow.launchReady(workId), [], "a pre-paused default Provider is skipped before preparing the worktree");
  assert.equal(prepareCount, 1);

  providerState.paused.clear();
  providerState.paused.add("openai");
  assert.deepEqual(await workflow.launchReady(workId), [taskId], "a different paused Provider does not block the Anthropic default");
  await workflow.drainPipelines();
  assert.equal(workerAttempts, 1);
  assert.equal(workerProvider, "anthropic", "the fallback Provider is passed to the Worker");
  assert.equal(db.get("SELECT provider FROM agent_runs WHERE task_id = ?", taskId).provider, "anthropic");
});

test("a Reviewer without a role model is withheld while the default Provider is paused", async (t) => {
  unsetDefaultRoleModels(t, "reviewer");
  const { root, db, onCleanup } = await dbInTemp(t);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Default reviewer provider", summary: "Wait for Anthropic", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] }]);
    tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    return work.id;
  });
  const providerState = mutablePausedProviders();
  providerState.paused.add("anthropic");
  let workerAttempts = 0;
  let reviewerAttempts = 0;
  const workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async (request) => {
        await writeValidFile(request);
        workerAttempts += 1;
        return { outcome: "success", report_valid: true, report: { result: "success", verification: { passed: true } }, skill_feedback: null };
      },
      runReviewer: async () => {
        reviewerAttempts += 1;
        return { outcome: "success", report_valid: true, report: { result: "success" }, review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null };
      },
    },
    git: Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) }),
    owlRoot: root,
    dataDir: root,
    providerPauseController: providerState.controller,
  });
  onCleanup(async () => { await workflow.stop(); db.close(); });
  workflow.start();
  await workflow.resolveDependencies(workId);
  const launched = await workflow.launchReady(workId);
  assert.equal(launched.length, 1);
  await workflow.drainPipelines();

  const taskId = db.get("SELECT id FROM tasks WHERE manager_task_id = 'REVIEW'").id;
  assert.equal(workerAttempts, 1, "the OpenAI backed Worker can run while Anthropic is paused");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "verifying");
  assert.equal(reviewerAttempts, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = ? AND role = 'reviewer'", taskId).count, 0);
});

test("rate-limited Task keeps its counters and worktree while another provider runs; resume retries it", async (t) => {
  const { root, db, onCleanup } = await dbInTemp(t);
  const clock = fakeClock();
  const store = createProviderPauseStore(db, clock.now);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Provider pause", summary: "Continue with other providers", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    createTaskPlanInTransaction(tx, work.id, [
      { id: "DESIGN", title: "Design", type: "design", acceptance: "Document", depends_on: [] },
      { id: "WORK", title: "Implement", type: "doc", acceptance: "Change", depends_on: [] },
    ]);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "designer", provider: "anthropic", model: "claude-test" },
        { role: "worker", provider: "openai", model: "codex-test" },
      ] }), clock.now());
    return work.id;
  });

  let workflow;
  let designerAttempts = 0;
  let workerAttempts = 0;
  const replans = [];
  const events = [];
  const controller = createProviderPauseController({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    emitEvent: async (event) => events.push(event.type),
    onResume: async () => { await workflow.launchReady(workId); },
  });
  workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runDesigner: async () => {
        designerAttempts += 1;
        // A role-shaped runner throws its limit error, here marked as a failure after a side effect.
        if (designerAttempts === 1) throw Object.assign(new Error("limit"), { failure_class: "rate_limited", rate_limit: { resets_at: "2030-01-02T03:04:35.000Z", source: "event" }, outcome: "failed_after_side_effect", retry_allowed: false });
        return { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null };
      },
      runWorker: async () => {
        workerAttempts += 1;
        return { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null };
      },
    },
    git: Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) }),
    owlRoot: root,
    dataDir: root,
    providerPauseController: controller,
    onManagerReplanNeeded: async (input) => replans.push(input),
  });
  onCleanup(async () => { controller.stop(); await workflow.stop(); db.close(); });
  workflow.start();
  controller.start();
  await workflow.resolveDependencies(workId);
  const launched = await workflow.launchReady(workId);
  assert.deepEqual(launched.sort(), [
    db.get("SELECT id FROM tasks WHERE manager_task_id = 'DESIGN'").id,
    db.get("SELECT id FROM tasks WHERE manager_task_id = 'WORK'").id,
  ].sort());
  await workflow.drainPipelines();

  const design = db.get("SELECT status, retry_no, failure_count, same_error_count, worktree_state FROM tasks WHERE manager_task_id = 'DESIGN'");
  assert.equal(design.status, "ready");
  assert.equal(design.retry_no, 0);
  assert.equal(design.failure_count, 0);
  assert.equal(design.same_error_count, 0);
  assert.equal(design.worktree_state, "active");
  assert.equal(db.get("SELECT status FROM tasks WHERE manager_task_id = 'WORK'").status, "ready");
  assert.equal(workerAttempts, 1, "the OpenAI backed Task ran while Anthropic was paused");
  assert.deepEqual(replans, []);
  assert.equal(controller.isPaused("claude"), true);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'task.rate_limited'").count, 1);

  await workflow.launchReady(workId);
  assert.equal(designerAttempts, 1, "a second Anthropic Task attempt is withheld during its pause");
  await clock.advance(120_000);
  await flush();
  await workflow.drainPipelines();
  assert.equal(designerAttempts, 2, "the Task is retried when the provider timer resumes");
  const retried = db.get("SELECT status, retry_no, failure_count, same_error_count FROM tasks WHERE manager_task_id = 'DESIGN'");
  assert.equal(retried.status, "ready");
  assert.equal(retried.retry_no, 1, "only the later transient failure increments retry_no");
  assert.equal(retried.failure_count, 0);
  assert.equal(retried.same_error_count, 0);
  assert.deepEqual(events, ["provider.paused", "provider.resumed"]);
  assert.deepEqual(replans, []);
});

test("a Worker that hit the usage limit after a side-effect tool call is requeued and pauses the provider", async (t) => {
  const { root, db, onCleanup } = await dbInTemp(t);
  const clock = fakeClock();
  const store = createProviderPauseStore(db, clock.now);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Side effect limit", summary: "Limit after Bash", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    createTaskPlanInTransaction(tx, work.id, [{ id: "WORK", title: "Implement", type: "doc", acceptance: "Change", depends_on: [] }]);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [{ role: "worker", provider: "openai", model: "codex-test" }] }), clock.now());
    return work.id;
  });
  const started = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "curl -X POST https://example.com" } });
  const limit = JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again at 9:00 PM." });
  const runner = createAgentRunner({
    adapter: "codex-cli/v1",
    outputLogDir: null,
    provider: { toolNamesInLine, execute: async (request) => ({ adapter: request.adapter, stdout: `${started}\n${limit}\n`, stderr: "", exit_code: 1, signal: null, format: "provider-json" }) },
  });
  const controller = createProviderPauseController({ store, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const workflow = new WorkflowEngine({
    db,
    agentRunner: { runWorker: (request) => runner.runWorker(request) },
    git: Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) }),
    owlRoot: root,
    dataDir: root,
    providerPauseController: controller,
  });
  onCleanup(async () => { controller.stop(); await workflow.stop(); db.close(); });
  workflow.start();
  controller.start();
  await workflow.resolveDependencies(workId);
  await workflow.launchReady(workId);
  await workflow.drainPipelines();

  assert.equal(db.get("SELECT status FROM tasks WHERE manager_task_id = 'WORK'").status, "ready");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'task.rate_limited'").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type IN ('decision.opened', 'task.failure.classified')").count, 0);
  assert.equal(db.get("SELECT state FROM provider_pauses WHERE provider = 'openai'").state, "paused");
});

for (const role of ["worker", "reviewer"]) {
  test(`a ${role} that keeps hitting a temporary rate limit fails as transient without pausing the provider`, async (t) => {
    const { root, db, onCleanup } = await dbInTemp(t);
    const clock = fakeClock();
    const store = createProviderPauseStore(db, clock.now);
    const workId = await db.createWriteLane().transact((tx) => {
      const work = createWorkInTransaction(tx, { title: "Temporary limit", summary: "429 only", size: "normal", project_id: null });
      tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
      const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "TASK", title: "Do it", type: "code", acceptance: "Pass", depends_on: [] }]);
      if (role === "reviewer") tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
      tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
        JSON.stringify({ version: 1, roles: [
          { role: "worker", provider: "anthropic", model: "claude-test" },
          { role: "reviewer", provider: "anthropic", model: "claude-test" },
        ] }), clock.now());
      return work.id;
    });
    let calls = 0;
    const runner = createAgentRunner({
      adapter: "claude-cli/v1",
      outputLogDir: null,
      env: { OWL_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "0" },
      provider: { toolNamesInLine, execute: async (request) => (calls += 1, { adapter: request.adapter, stdout: "", stderr: "API Error: 429 Too Many Requests", exit_code: 1, signal: null, format: "provider-json" }) },
    });
    const controller = createProviderPauseController({ store, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    const workflow = new WorkflowEngine({
      db,
      agentRunner: {
        runWorker: role === "worker"
          ? (request) => runner.runWorker(request)
          : async (request) => (await writeValidFile(request), { outcome: "success", report_valid: true, report: { kind: "report", schema_version: "1.1.0", invocation_id: request.invocation_id, result: "success", work_done: "Done.", delegation: { decomposition: "Small.", delegated: [], own_subagents_used: false, retained: [] }, changes: [], verification: { status: "passed", method: "Checked.", acceptance: [{ criterion_id: "AC1", criterion: "Pass", status: "passed", evidence: "Looked." }], checks: [], integration_check: null }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null }, skill_feedback: null }),
        runReviewer: (request) => runner.runReviewer(request),
      },
      git: Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) }),
      owlRoot: root,
      dataDir: root,
      providerPauseController: controller,
    });
    onCleanup(async () => { controller.stop(); await workflow.stop(); db.close(); });
    workflow.start();
    controller.start();
    await workflow.resolveDependencies(workId);
    await workflow.launchReady(workId);
    await workflow.drainPipelines();

    assert.ok(calls >= 3, "the runner retried the temporary limit before failing");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM provider_pauses").count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'task.rate_limited'").count, 0);
    const classified = db.all("SELECT payload_json FROM events WHERE type = 'task.failure.classified'").map((row) => JSON.parse(row.payload_json));
    assert.ok(classified.some((payload) => payload.failure_class === "transient"), "the failure is classified as transient");
    assert.ok(classified.every((payload) => !String(payload.reason ?? "").includes("利用上限")));
    if (role === "reviewer") {
      const failed = db.all("SELECT payload_json FROM events WHERE type = 'review.failed'").map((row) => JSON.parse(row.payload_json).error);
      assert.equal(failed.length, 1);
      assert.ok(!failed[0].includes("利用上限"));
    }
  });
}

test("a rate-limited Reviewer resumes without consuming Reviewer failures", async (t) => {
  const { root, db, onCleanup } = await dbInTemp(t);
  const clock = fakeClock();
  const store = createProviderPauseStore(db, clock.now);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Review pause", summary: "Retry review", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] }]);
    tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "worker", provider: "openai", model: "codex-test" },
        { role: "reviewer", provider: "anthropic", model: "claude-test" },
      ] }), clock.now());
    return work.id;
  });
  let workflow;
  let reviewerAttempts = 0;
  const controller = createProviderPauseController({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onResume: async (provider) => workflow.resumeProvider(provider),
  });
  workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async (request) => (await writeValidFile(request), {
        outcome: "success", report_valid: true,
        report: { result: "success", verification: { passed: true } },
        skill_feedback: null,
      }),
      runReviewer: async () => {
        reviewerAttempts += 1;
        if (reviewerAttempts === 1) return {
          outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
          rate_limit: { resets_at: NOW, source: "event" }, message: "limit", skill_feedback: null,
        };
        return {
          outcome: "success", report_valid: true, report: { result: "success" },
          review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null,
        };
      },
    },
    git: Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) }),
    owlRoot: root,
    dataDir: root,
    providerPauseController: controller,
  });
  onCleanup(async () => { controller.stop(); await workflow.stop(); db.close(); });
  workflow.start();
  controller.start();
  await workflow.resolveDependencies(workId);
  await workflow.launchReady(workId);
  await workflow.drainPipelines();

  const taskId = db.get("SELECT id FROM tasks WHERE manager_task_id = 'REVIEW'").id;
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "verifying");
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'review.failed'").count, 0);
  assert.equal(db.get("SELECT status FROM agent_runs WHERE role = 'reviewer'").status, "exited");

  await clock.advance(90_000);
  for (let i = 0; i < 30 && db.get("SELECT status FROM tasks WHERE id = ?", taskId).status !== "completed"; i += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.equal(reviewerAttempts, 2);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "completed");
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
});

test("an Advisor rate limit replies with the reset time, pauses the provider and never resends the turn", async (t) => {
  const { root, db, onCleanup } = await dbInTemp(t);
  const clock = fakeClock();
  const ownerId = createUlid();
  const accountId = createUlid();
  const conversationId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", ownerId, clock.now(), clock.now());
    tx.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", accountId, ownerId, `web:${ownerId}`, clock.now());
    tx.run("INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)", conversationId, ownerId, clock.now(), clock.now());
  });
  const messageId = createUlid();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
     VALUES (?, ?, 'web', ?, ?, 'question', '[]', ?, ?)`,
    messageId, conversationId, accountId, `web-user:${messageId}`, clock.now(), clock.now(),
  ));
  const sent = [];
  const queued = [];
  const waiters = [];
  let providerPauseController;
  let runtime;
  const providerSession = {
    pid: 901,
    provider_session_id: "advisor-provider-session",
    exited: false,
    async send(turn) {
      sent.push(turn);
      setImmediate(() => {
        const event = sent.length === 1
          ? { type: "turn.failed", turn_id: turn.turn_id, error: "limit", rate_limit: { resets_at: "2030-01-02T03:04:10.000Z", source: "event" } }
          : { type: "turn.completed", turn_id: turn.turn_id, reply: "recovered reply", usage: null };
        const waiter = waiters.shift();
        if (waiter) waiter({ value: event, done: false });
        else queued.push(event);
      });
    },
    events() {
      return { [Symbol.asyncIterator]() { return { next() {
        const event = queued.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        return new Promise((resolveNext) => waiters.push(resolveNext));
      } }; } };
    },
    async stop() {},
  };
  const errors = [];
  const replies = [];
  runtime = new AdvisorSessionRuntime({
    db,
    sessionManager: new AdvisorSessionManager(db),
    memorySaver: {},
    providerClient: { createSession: async () => providerSession },
    owlRoot: root,
    git: { resolveAdvisorSessionDirectory: async () => ({ kind: "direct", cwd: root }) },
    getAdvisorSettings: () => ({ providerId: "anthropic", harnessId: "claude", model: "claude-test", systemPrompt: "Advisor" }),
    resolveAttachmentPaths: () => ({ paths: [], notes: [] }),
    isProviderPaused: (provider) => providerPauseController.isPaused(provider),
    onProviderRateLimited: async (provider, rateLimit) => providerPauseController.recordRateLimit({ provider, resets_at: rateLimit.resets_at, role: "advisor" }),
    onProviderSucceeded: async (provider, startedAt) => providerPauseController.noteProviderSucceeded(provider, startedAt),
    onReply: async (_conversationId, reply) => { replies.push(reply); return null; },
    onError: async (_conversationId, error) => errors.push(error),
  });
  providerPauseController = createProviderPauseController({
    store: createProviderPauseStore(db, clock.now),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onResume: async (provider) => runtime.resumeProvider(provider),
  });
  onCleanup(async () => {
    providerPauseController.stop();
    await runtime.stop();
    db.close();
  });
  providerPauseController.start();
  const session = await runtime.ensureSession(ownerId, conversationId);
  const turnId = await runtime.enqueueTurn(session.id, conversationId, messageId, { turn_id: "", text: "question", origin: { channel: "web" } });
  await waitUntil(() => replies.length === 1 && providerPauseController.isPaused("anthropic"), "Advisor rate-limit reply");
  assert.equal(db.get("SELECT status FROM advisor_turns WHERE id = ?", turnId).status, "failed");
  assert.match(replies[0], /ごろ解除/u);
  assert.deepEqual(errors, []);
  assert.equal(sent.length, 1);

  await clock.advance(120_000);
  await flush();
  assert.equal(providerPauseController.isPaused("anthropic"), false);
  assert.equal(sent.length, 1, "the rate-limited request must not be resent after the provider resumes");
  assert.equal(replies.length, 1);
  assert.deepEqual(errors, []);
});

test("a Manager replan rate limit is requeued and retried after persisted pause recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db, onCleanup } = await dbInTemp(t);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Replan pause", summary: "Retry the Manager", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "FAILED", title: "Failed", type: "doc", acceptance: "Retry", depends_on: [] }]);
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", task.id);
    tx.run(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, ?, 202, ?, ?)`,
      `manager-trigger:${task.id}`, "0".repeat(64), JSON.stringify({ status: "queued" }), NOW, "2031-01-02T03:04:05.000Z",
    );
    return work.id;
  });
  let managerCalls = 0;
  const agentRunner = {
    runManagerPlan: async () => {
      managerCalls += 1;
      if (managerCalls === 1) return {
        outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
        rate_limit: { resets_at: NOW, source: "event" }, message: "limit", skill_feedback: null,
      };
      return {
        outcome: "success", report_valid: true, skill_feedback: null,
        report: { result: "success", event: "task.replanned", tasks: [
          { id: "REPLACEMENT", title: "Replacement", type: "doc", acceptance: "Continue", depends_on: [], required_sections: [], required_tests: [], replaces: ["FAILED"] },
        ] },
      };
    },
    runWorker: async (request) => (await writeValidFile(request), { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null }),
    runReviewer: async () => ({ outcome: "failed", skill_feedback: null }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { core } = await createTestCore(t, { db, agentRunner: withNecessity(agentRunner), version: "provider-pause-replan-test", owlRoot: root, dispatcher: { tick_interval_ms: 60_000 }, now: () => new Date().toISOString() });
  onCleanup(async () => { await core.stop({ force: true }); await flush(); db.close(); });
  await core.start();
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ?", workId).id;

  await core.tick(workId);
  assert.equal(managerCalls, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "failed");
  assert.equal(db.get("SELECT status FROM agent_runs WHERE role = 'manager' ORDER BY created_at DESC LIMIT 1").status, "exited");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'manager.failed'").count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE status = 'open'").count, 0);
  assert.equal(JSON.parse(db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `manager-trigger:${taskId}`).response_json).status, "queued");

  await tickMockedClock(t, core, 90_000);
  await flushUntil(() => db.get("SELECT status FROM tasks WHERE manager_task_id = 'REPLACEMENT'")?.status === "waiting", "requeued replan");
  assert.equal(managerCalls, 2, "the Work driver retries the queued replan when provider.resumed fires");
  assert.equal(db.get("SELECT status FROM tasks WHERE manager_task_id = 'REPLACEMENT'").status, "waiting");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "cancelled");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'provider.paused'").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'provider.resumed'").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE status = 'open'").count, 0);
});

test("an initial Manager plan rate limit leaves the Work running and retries after resume", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db, onCleanup } = await dbInTemp(t);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Initial plan pause", summary: "Plan after resume", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    return work.id;
  });
  let managerCalls = 0;
  const { core } = await createTestCore(t, {
    db,
    agentRunner: {
      runManagerPlan: async () => {
        managerCalls += 1;
        if (managerCalls === 1) return {
          outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
          rate_limit: { resets_at: NOW, source: "event" }, message: "limit", skill_feedback: null,
        };
        return {
          outcome: "success", report_valid: true, skill_feedback: null,
          report: { result: "success", event: "work.planned", tasks: [
            { id: "INITIAL", title: "First Task", type: "doc", acceptance: "Complete", depends_on: [], required_sections: [], required_tests: [], replaces: [], necessity: necessityFor(), acceptance_criteria: criteriaFor("Complete") },
          ] },
        };
      },
      runWorker: async (request) => (await writeValidFile(request), { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null }),
      runReviewer: async () => ({ outcome: "failed", skill_feedback: null }),
      runAdvisor: async () => ({ reply: "" }),
    },
    version: "provider-pause-initial-plan-test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 60_000 },
    now: () => new Date().toISOString(),
  });
  onCleanup(async () => { await core.stop({ force: true }); await flush(); db.close(); });
  await core.start();

  await core.tick(workId);
  assert.equal(managerCalls, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId).count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE status = 'open'").count, 0);

  await tickMockedClock(t, core, 90_000);
  await flushUntil(() => db.get("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId).count === 1, "resumed Manager plan");
  assert.equal(managerCalls, 2);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId).count, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'manager.failed'").count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE status = 'open'").count, 0);
});

test("five Manager 429s open no Decision: each is recorded as an uncounted wait and the used count stays 0", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db, onCleanup } = await dbInTemp(t);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Repeated 429", summary: "Wait without a Decision", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    return work.id;
  });
  let managerCalls = 0;
  const { core } = await createTestCore(t, {
    db,
    agentRunner: {
      runManagerPlan: async () => {
        managerCalls += 1;
        return {
          outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
          rate_limit: { resets_at: new Date().toISOString(), source: "event" }, message: "limit", skill_feedback: null,
        };
      },
      runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null }),
      runReviewer: async () => ({ outcome: "failed", skill_feedback: null }),
      runAdvisor: async () => ({ reply: "" }),
    },
    version: "provider-pause-429-count-test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 60_000 },
    now: () => new Date().toISOString(),
  });
  onCleanup(async () => { await core.stop({ force: true }); await flush(); db.close(); });
  await core.start();

  await core.tick(workId);
  // Each resume makes the Work driver ask the Manager again, which answers 429 again.
  while (managerCalls < 5) {
    const before = managerCalls;
    // The resume timer is armed once the pause is recorded; advance the clock only after that.
    await flushUntil(() => db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'provider.paused'").count >= before && db.get("SELECT COUNT(*) AS count FROM events WHERE work_id = ? AND type = 'recovery.started'", workId).count === before, `pause ${before}`);
    await tickMockedClock(t, core, 90_000);
    await flushUntil(() => managerCalls > before, `Manager call ${before + 1}`);
  }
  await flush();

  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE work_id = ?", workId).count, 0);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  const records = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'recovery.started' ORDER BY sequence", workId).map((row) => JSON.parse(row.payload_json));
  assert.ok(managerCalls >= 5);
  assert.equal(records.length, managerCalls, "every 429 is recorded once");
  assert.ok(records.every((record) => record.counted === false && record.kind === "provider_transient" && record.action === "wait_rate_limit"));
  assert.equal(autoRecoveryUsed(db, "provider_transient", { kind: "work", id: workId }), 0);
});
