import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DEFAULT_CHILD_RUN_SETTINGS } from "../../../packages/shared/dist/child-runs.js";
import { Core } from "../../../packages/core/dist/index.js";
import { AppSettingsStore } from "../dist/app-settings-store.js";
import { ExternalCoreAdapter } from "../dist/core.js";
import { createOwlHttpServer } from "../dist/http.js";
import { openDatabase } from "../../../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function setup(t, legacyExecutorConfig) {
  const root = await mkdtemp(join(tmpdir(), "owl-app-settings-migration-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ executor_config: legacyExecutorConfig }));
  const dbPath = join(dataDir, "owl.db");
  let db = openDatabase(dbPath);
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const cores = [];
  const makeCore = () => {
    const core = new Core({ db, agentRunner: {}, version: "test", owlRoot: root, dataDir });
    cores.push(core);
    return core;
  };
  t.after(async () => {
    for (const core of cores) await core.stop().catch(() => {});
    try { db.close(); } catch { /* already closed during restart */ }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    dataDir,
    db,
    makeCore,
    reopenDb() {
      db = openDatabase(dbPath);
      return db;
    },
    hasChildSettings() {
      return db.get("SELECT 1 AS present FROM settings WHERE key = 'child_run_settings'") !== undefined;
    },
  };
}

test("legacy app-settings executor config migrates through Core and survives a restart", async (t) => {
  const env = await setup(t, { provider: "openai", model: "gpt-5.6-luna", effort: "xhigh", timeout_ms: 600_001 });
  const first = env.makeCore();

  await first.start();
  const migrated = first.getChildRunSettings();
  assert.equal(migrated.executor_harness, "codex");
  assert.deepEqual(migrated.executor_by_harness, {
    ...DEFAULT_CHILD_RUN_SETTINGS.executor_by_harness,
    codex: { model: "gpt-5.6-luna", effort: "xhigh" },
  });
  assert.equal(migrated.timeout_minutes, 11);
  assert.equal(env.hasChildSettings(), true);

  await first.stop();
  env.db.close();
  env.reopenDb();
  const restarted = env.makeCore();
  await restarted.start();
  assert.deepEqual(restarted.getChildRunSettings(), migrated);
});

test("saved child settings take precedence over app-settings executor_config", async (t) => {
  const env = await setup(t, { provider: "openai", model: "gpt-5.6-luna", effort: "high", timeout_ms: 1_800_000 });
  const core = env.makeCore();
  const saved = await core.setChildRunSettings({
    ...DEFAULT_CHILD_RUN_SETTINGS,
    executor_by_harness: {
      ...DEFAULT_CHILD_RUN_SETTINGS.executor_by_harness,
      codex: { ...DEFAULT_CHILD_RUN_SETTINGS.executor_by_harness.codex, effort: null },
    },
    timeout_minutes: 25,
  });

  await core.start();
  assert.deepEqual(core.getChildRunSettings(), saved);
});

test("default anthropic models are the latest generation and stored legacy models still load", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-app-settings-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const fresh = new AppSettingsStore(root, dataDir).getProviderModels();
  assert.deepEqual(fresh.anthropic, ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ provider_models: { anthropic: ["claude-opus-4-8", "claude-haiku-4-5"] } }));
  const stored = new AppSettingsStore(root, dataDir).getProviderModels().anthropic;
  for (const model of ["claude-opus-4-8", "claude-haiku-4-5", "claude-fable-5-1"]) assert.ok(stored.includes(model));
});

test("an HTTP server starts and serves the settings view and provider models with legacy models stored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-app-settings-http-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ provider_models: { anthropic: ["claude-opus-4-8", "claude-sonnet-5"] } }));
  const db = openDatabase(join(dataDir, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner: {}, version: "test", owlRoot: root, dataDir });
  const adapter = new ExternalCoreAdapter(core, db, root, dataDir);
  const prior = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "legacy-models-token";
  const http = createOwlHttpServer({ core: adapter, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root });
  t.after(async () => {
    await http.close().catch(() => {});
    if (prior === undefined) delete process.env.OWL_API_TOKEN; else process.env.OWL_API_TOKEN = prior;
    await core.stop({ force: true }).catch(() => {});
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  try { await http.listen(); } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("listen not permitted"); return; }
    throw error;
  }
  const origin = `http://127.0.0.1:${http.server.address().port}/api/v1/settings`;
  const headers = { authorization: "Bearer legacy-models-token" };
  const models = await fetch(`${origin}/provider-models`, { headers });
  assert.equal(models.status, 200);
  const anthropic = (await models.json()).data.anthropic;
  for (const model of ["claude-opus-4-8", "claude-sonnet-5", "claude-fable-5-1"]) assert.ok(anthropic.includes(model));
  assert.equal((await fetch(`${origin}/view`, { headers })).status, 200);
});
