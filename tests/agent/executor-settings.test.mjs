import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createChildRunScheduler } from "../../packages/core/dist/child-run-scheduler.js";
import {
  AgentTimeoutSettingError,
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  DEFAULT_AGENT_WALL_TIMEOUT_MS,
  DEFAULT_CHILD_RUN_SETTINGS,
  DEFAULT_ROLE_SESSION_CONTEXT_LIMIT,
  agentIdleTimeoutMs,
  agentWallTimeoutMs,
  roleSessionContextLimit,
} from "../../packages/shared/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

async function openCore(t) {
  const { db, root } = await openTestDatabase(t, { prefix: "owl-child-settings-" });
  const makeCore = async () => (await createTestCore(t, { db, version: "test", owlRoot: root })).core;
  return { db, root, makeCore };
}

test("child settings derive from legacy executor_config without saving the migration", async (t) => {
  const { db, makeCore } = await openCore(t);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Test Owner', ?, ?)", now, now);
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('executor_config', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", effort: "xhigh", timeout_ms: 600_001 }), now,
    );
  });
  const core = await makeCore();

  const settings = core.getChildRunSettings();
  assert.equal(settings.default_provider, "codex");
  assert.equal(settings.default_model, "gpt-5.6-luna");
  assert.equal(settings.default_effort, "xhigh");
  assert.deepEqual(settings.allowed_models, [
    { provider: "codex", model: "gpt-5.6-luna" },
    { provider: "claude", model: "claude-sonnet-5" },
    { provider: "claude", model: "claude-sonnet-5-5" },
  ]);
  assert.deepEqual(settings.defaults_by_parent_harness, DEFAULT_CHILD_RUN_SETTINGS.defaults_by_parent_harness);
  assert.deepEqual(settings.allowed_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(settings.timeout_minutes, 11);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM settings WHERE key = 'child_run_settings'").count, 0);
});

test("child settings validate, normalize legacy provider names and persist across Core restart", async (t) => {
  const { db, makeCore } = await openCore(t);
  const core = await makeCore();
  const settings = {
    ...DEFAULT_CHILD_RUN_SETTINGS,
    defaults_by_parent_harness: {
      claude: { provider: "codex", model: "gpt-5.6-luna", effort: "low" },
      codex: { provider: "claude", model: "claude-sonnet-5-5", effort: "high" },
    },
    default_provider: "openai",
    default_model: "gpt-5.6-luna",
    allowed_models: [
      { provider: "openai", model: "gpt-5.6-luna" },
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ],
    default_effort: "high",
    timeout_minutes: 35,
  };
  const saved = await core.setChildRunSettings(settings);
  assert.equal(saved.default_provider, "codex");
  assert.deepEqual(saved.allowed_models, [
    { provider: "codex", model: "gpt-5.6-luna" },
    { provider: "claude", model: "claude-sonnet-5" },
    { provider: "claude", model: "claude-sonnet-5-5" },
  ]);
  assert.deepEqual(saved.defaults_by_parent_harness, settings.defaults_by_parent_harness);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'settings.child_runs_updated'").count, 1);

  await assert.rejects(
    () => core.setChildRunSettings({ ...settings, default_model: "not-a-model" }),
    (error) => error?.code === "validation_error",
  );
  await core.stop();
  const restarted = await makeCore();
  assert.deepEqual(restarted.getChildRunSettings(), saved);
});

test("saved child settings without per-parent defaults are completed when read", async (t) => {
  const { db, makeCore } = await openCore(t);
  const now = new Date().toISOString();
  const legacy = {
    default_provider: DEFAULT_CHILD_RUN_SETTINGS.default_provider,
    default_model: DEFAULT_CHILD_RUN_SETTINGS.default_model,
    default_effort: DEFAULT_CHILD_RUN_SETTINGS.default_effort,
  };
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Test Owner', ?, ?)", now, now);
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('child_run_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify(legacy), now,
    );
  });
  const core = await makeCore();
  assert.deepEqual(core.getChildRunSettings().defaults_by_parent_harness, DEFAULT_CHILD_RUN_SETTINGS.defaults_by_parent_harness);
});

test("legacy executor PUT updates both parent defaults and dispatch uses the saved values", async (t) => {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-executor-settings-api-" });
  const token = randomUUID();
  const scheduler = createChildRunScheduler({
    db,
    writeLane: db.createWriteLane(),
    executorRuntime: () => ({}),
    providerPauseController: { isPaused: () => true },
    settings: () => core.getChildRunSettings(),
    onParentActivity() {},
  });
  t.after(() => scheduler.stop());
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir: root }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  const request = (path, { method = "GET", body } = {}) => api.request(method, `/api/v1${path}`, body);

  await core.setChildRunSettings({
    ...core.getChildRunSettings(),
    defaults_by_parent_harness: {
      claude: { provider: "claude", model: "claude-sonnet-5-5", effort: "high" },
      codex: { provider: "codex", model: "gpt-5.6-luna", effort: "medium" },
    },
  });
  const oldDefaults = { provider: "openai", model: "gpt-5.6-luna", effort: "low" };
  const update = await request("/settings/executor", {
    method: "PUT",
    body: { request_id: randomUUID(), idempotency_key: randomUUID(), expected_version: 0, payload: { ...oldDefaults, timeout_ms: 35 * 60_000 } },
  });
  assert.equal(update.status, 200);
  const updated = (await update.json()).data;
  const resolvedDefaults = {
    claude: { provider: "codex", model: "gpt-5.6-luna", effort: "low" },
    codex: { provider: "codex", model: "gpt-5.6-luna", effort: "low" },
  };
  assert.deepEqual(updated.defaults_by_parent_harness, resolvedDefaults);
  assert.ok(updated.allowed_models.some((item) => item.provider === "codex" && item.model === "gpt-5.6-luna"));
  assert.ok(updated.allowed_efforts.includes("low"));
  assert.equal(updated.provider, "codex");
  assert.equal(updated.model, "gpt-5.6-luna");
  assert.equal(updated.effort, "low");
  assert.equal(updated.timeout_ms, 35 * 60_000);
  const invalidUpdate = await request("/settings/executor", {
    method: "PUT",
    body: { request_id: randomUUID(), idempotency_key: randomUUID(), expected_version: 0, payload: { ...oldDefaults, effort: "invalid", timeout_ms: 35 * 60_000 } },
  });
  assert.equal(invalidUpdate.status, 400);
  assert.equal((await invalidUpdate.json()).error.code, "validation_error");

  const childSettings = (await (await request("/settings/child-runs")).json()).data;
  assert.deepEqual(childSettings.defaults_by_parent_harness, resolvedDefaults);
  assert.deepEqual(childSettings.allowed_models, updated.allowed_models);
  assert.deepEqual(childSettings.allowed_efforts, updated.allowed_efforts);
  const legacyGet = (await (await request("/settings/executor")).json()).data;
  assert.deepEqual(legacyGet.defaults_by_parent_harness, resolvedDefaults);
  assert.deepEqual(legacyGet.allowed_models, updated.allowed_models);
  assert.deepEqual(legacyGet.allowed_efforts, updated.allowed_efforts);

  const now = new Date().toISOString();
  const ids = { work: createUlid(), task: createUlid(), claude: createUlid(), codex: createUlid() };
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Dispatch defaults', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      ids.work, now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Dispatch defaults', 'code', 'running', 'normal', '', '', ?, ?)`,
      ids.task, ids.work, now, now,
    );
    for (const harness of ["claude", "codex"]) {
      tx.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, effort, status, created_at, updated_at)
         VALUES (?, ?, ?, 'worker', ?, 'parent-model', NULL, 'running', ?, ?)`,
        ids[harness], ids.work, ids.task, harness, now, now,
      );
    }
  });
  for (const harness of ["claude", "codex"]) {
    scheduler.registerParent({
      agent_run_id: ids[harness], work_id: ids.work, task_id: ids.task, harness,
      workspace_dir: root, worktree: root, task: { title: "Dispatch defaults", acceptance: "", context: "", rules: "", owner_guidance: [] },
    });
    const dispatched = await scheduler.dispatch(ids[harness], {
      title: `child from ${harness}`, instruction: "Check the configured defaults", write_paths: [`children/${harness}`],
    }, `legacy-defaults-${harness}`);
    assert.deepEqual(
      { provider: dispatched.provider, model: dispatched.model, effort: dispatched.effort },
      { provider: "codex", model: "gpt-5.6-luna", effort: "low" },
    );
  }
});

test("role timeouts and context limit fall back to the common value, then to today's defaults", () => {
  assert.equal(agentWallTimeoutMs({}, "worker"), DEFAULT_AGENT_WALL_TIMEOUT_MS);
  assert.equal(agentIdleTimeoutMs({}, "worker"), DEFAULT_AGENT_IDLE_TIMEOUT_MS);
  assert.equal(roleSessionContextLimit({}, "worker"), 80_000);
  assert.equal(DEFAULT_ROLE_SESSION_CONTEXT_LIMIT, 80_000);

  const env = {
    OWL_PROVIDER_TIMEOUT_MS: "1000",
    OWL_PROVIDER_TIMEOUT_MS_WORKER: "2000",
    OWL_PROVIDER_IDLE_TIMEOUT_MS_WORKER: String(2 * 60 * 60 * 1000),
    OWL_ROLE_SESSION_CONTEXT_LIMIT: "5000",
    OWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER: "9000",
  };
  assert.equal(agentWallTimeoutMs(env, "worker"), 2000);
  assert.equal(agentWallTimeoutMs(env, "reviewer"), 1000);
  assert.equal(agentWallTimeoutMs(env), 1000);
  assert.equal(agentIdleTimeoutMs(env, "worker"), 2 * 60 * 60 * 1000);
  assert.equal(agentIdleTimeoutMs(env, "reviewer"), DEFAULT_AGENT_IDLE_TIMEOUT_MS);
  assert.equal(roleSessionContextLimit(env, "worker"), 9000);
  assert.equal(roleSessionContextLimit(env, "reviewer"), 5000);
});

test("an invalid role-specific setting names its own key", () => {
  assert.throws(
    () => agentWallTimeoutMs({ OWL_PROVIDER_TIMEOUT_MS_WORKER: "soon" }, "worker"),
    (error) => error instanceof AgentTimeoutSettingError && error.setting === "OWL_PROVIDER_TIMEOUT_MS_WORKER",
  );
  assert.throws(
    () => agentIdleTimeoutMs({ OWL_PROVIDER_IDLE_TIMEOUT_MS_WORKER: "60000" }, "worker"),
    (error) => error instanceof AgentTimeoutSettingError && error.setting === "OWL_PROVIDER_IDLE_TIMEOUT_MS_WORKER",
  );
  assert.throws(
    () => roleSessionContextLimit({ OWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER: "0" }, "worker"),
    (error) => error instanceof AgentTimeoutSettingError && error.setting === "OWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER",
  );
});
