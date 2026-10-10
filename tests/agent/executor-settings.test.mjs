import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { AppSettingsStore } from "../../apps/server/dist/app-settings-store.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
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
    { provider: "claude", model: "claude-sonnet-5-5" },
    { provider: "claude", model: "claude-haiku-5-5" },
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

test("token relay and researcher settings have defaults and partial saved values are merged with them", async (t) => {
  assert.deepEqual(DEFAULT_CHILD_RUN_SETTINGS.token_relay, {
    models: [{ provider: "claude", model: "claude-haiku-5-5" }],
    handoff_tokens: 70_000, kill_tokens: 95_000, max_relays: 5, report_threshold_tokens: 100_000,
  });
  assert.equal(DEFAULT_CHILD_RUN_SETTINGS.research_subagent.claude.model, "claude-haiku-5-5");
  assert.equal(DEFAULT_CHILD_RUN_SETTINGS.research_subagent.codex.model, "gpt-6-luna");
  assert.ok(DEFAULT_CHILD_RUN_SETTINGS.research_subagent.claude.max_turns >= 2);

  const { db, makeCore } = await openCore(t);
  const now = new Date().toISOString();
  const { token_relay: _relay, research_subagent: _research, ...withoutNewKeys } = DEFAULT_CHILD_RUN_SETTINGS;
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Test Owner', ?, ?)", now, now);
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('child_run_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify(withoutNewKeys), now,
    );
  });
  const core = await makeCore();
  assert.deepEqual(core.getChildRunSettings().token_relay, DEFAULT_CHILD_RUN_SETTINGS.token_relay);
  assert.deepEqual(core.getChildRunSettings().research_subagent, DEFAULT_CHILD_RUN_SETTINGS.research_subagent);

  const saved = await core.setChildRunSettings({
    ...DEFAULT_CHILD_RUN_SETTINGS,
    token_relay: { kill_tokens: 120_000 },
    research_subagent: { claude: { max_turns: 20 } },
  });
  assert.deepEqual(saved.token_relay, { ...DEFAULT_CHILD_RUN_SETTINGS.token_relay, kill_tokens: 120_000 });
  assert.deepEqual(saved.research_subagent, {
    ...DEFAULT_CHILD_RUN_SETTINGS.research_subagent,
    claude: { ...DEFAULT_CHILD_RUN_SETTINGS.research_subagent.claude, max_turns: 20 },
  });
});

test("invalid token relay and researcher settings are rejected with the offending field", async (t) => {
  const { makeCore } = await openCore(t);
  const core = await makeCore();
  const relay = DEFAULT_CHILD_RUN_SETTINGS.token_relay;
  const research = DEFAULT_CHILD_RUN_SETTINGS.research_subagent;
  const cases = [
    [{ token_relay: "on" }, "token_relay"],
    [{ token_relay: { ...relay, handoff_tokens: 999 } }, "token_relay.handoff_tokens"],
    [{ token_relay: { ...relay, kill_tokens: 1_000_001 } }, "token_relay.kill_tokens"],
    [{ token_relay: { ...relay, handoff_tokens: 95_000, kill_tokens: 95_000 } }, "token_relay.handoff_tokens"],
    [{ token_relay: { ...relay, max_relays: 21 } }, "token_relay.max_relays"],
    [{ token_relay: { ...relay, max_relays: 1.5 } }, "token_relay.max_relays"],
    [{ token_relay: { ...relay, report_threshold_tokens: 10_000_001 } }, "token_relay.report_threshold_tokens"],
    [{ token_relay: { ...relay, models: [{ provider: "codex", model: "gpt-6-luna" }] } }, "token_relay.models"],
    [{ token_relay: { ...relay, models: [relay.models[0], relay.models[0]] } }, "token_relay.models"],
    [{ token_relay: { ...relay, models: ["claude-haiku-5-5"] } }, "token_relay.models"],
    [{ research_subagent: [] }, "research_subagent"],
    [{ research_subagent: { ...research, claude: { model: "", max_turns: 12 } } }, "research_subagent.claude.model"],
    [{ research_subagent: { ...research, claude: { model: "haiku\"} --x", max_turns: 12 } } }, "research_subagent.claude.model"],
    [{ research_subagent: { ...research, codex: { model: "not-a-codex-model", max_turns: 12 } } }, "research_subagent.codex.model"],
    [{ research_subagent: { ...research, codex: { ...research.codex, max_turns: 1 } } }, "research_subagent.codex.max_turns"],
    [{ research_subagent: { ...research, answer_max_chars: 8_001 } }, "research_subagent.answer_max_chars"],
    [{ research_subagent: { ...research, answer_max_chars: null } }, "research_subagent.answer_max_chars"],
  ];
  for (const [patch, field] of cases) {
    await assert.rejects(
      () => core.setChildRunSettings({ ...DEFAULT_CHILD_RUN_SETTINGS, ...patch }),
      (error) => error?.code === "validation_error" && error?.details?.field === field,
      `${JSON.stringify(patch)} should be rejected on ${field}`,
    );
  }
  assert.deepEqual(core.getChildRunSettings(), DEFAULT_CHILD_RUN_SETTINGS);
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

test("server routes answer 400 for malformed path escapes and inherited-property provider names", async (t) => {
  const { root, core, db } = await createTestCore(t, {}, { prefix: "owl-route-hardening-api-" });
  const token = randomUUID();
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const api = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  const envelope = (payload) => ({ request_id: randomUUID(), idempotency_key: randomUUID(), expected_version: 0, payload });

  for (const route of ["/settings/providers/%E0%A4%A", "/knowledge/%E0%A4%A"]) {
    assert.equal((await api.request("GET", `/api/v1${route}`)).status, 400, route);
  }
  assert.equal((await api.request("GET", "/api/v1/settings/providers/constructor")).status, 404);
  // A non-string body must not be saved as an empty entry body.
  assert.equal((await api.request("PUT", "/api/v1/knowledge/global/a.md", { body: null })).status, 400);
  const before = (await (await api.request("GET", "/api/v1/settings/executor")).json()).data;
  const update = await api.request("PUT", "/api/v1/settings/executor", envelope({ provider: "constructor", model: "m", timeout_ms: 60_000 }));
  assert.equal(update.status, 400);
  assert.deepEqual((await (await api.request("GET", "/api/v1/settings/executor")).json()).data, before);

  assert.equal((await api.request("PUT", "/api/v1/knowledge/global/a.md", { tags: "x" })).status, 400);

  // A domain error code named like an inherited property is not an HTTP status.
  const inheritedCode = () => { throw Object.assign(new Error("boom"), { code: "constructor" }); };
  core.setChildRunSettings = inheritedCode;
  core.resumePrerequisiteWait = inheritedCode;
  const childRuns = await api.request("PUT", "/api/v1/settings/executor", envelope({ provider: "claude", model: "m", timeout_ms: 60_000 }));
  assert.equal(childRuns.status, 500);
  assert.notEqual((await childRuns.json()).error?.code, "constructor");
  const resumed = await api.request("POST", `/api/v1/tasks/${"0".repeat(26)}/prerequisite/resume`, envelope({}));
  assert.equal(resumed.status, 500);
  assert.notEqual((await resumed.json()).error?.code, "constructor");

  // A saved provider-models entry named like an inherited property must not make the next start fail.
  const saved = await api.request("PUT", "/api/v1/settings/provider-models/constructor", envelope({ models: ["m1"] }));
  assert.equal(saved.status, 200);
  assert.deepEqual(new AppSettingsStore(root, dataDir).getProviderModels().constructor, ["m1"]);
});
