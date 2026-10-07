import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DEFAULT_CHILD_RUN_SETTINGS } from "../../../packages/shared/dist/child-runs.js";
import { Core } from "../../../packages/core/dist/index.js";
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
  assert.equal(migrated.default_provider, "codex");
  assert.equal(migrated.default_model, "gpt-5.6-luna");
  assert.equal(migrated.default_effort, "xhigh");
  assert.equal(migrated.timeout_minutes, 11);
  assert.deepEqual(migrated.allowed_models, [
    { provider: "codex", model: "gpt-5.6-luna" },
    ...DEFAULT_CHILD_RUN_SETTINGS.allowed_models.filter(({ provider, model }) => provider !== "codex" || model !== "gpt-5.6-luna"),
  ]);
  assert.deepEqual(migrated.allowed_efforts, ["low", "medium", "high", "xhigh"]);
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
    default_effort: null,
    timeout_minutes: 25,
  });

  await core.start();
  assert.deepEqual(core.getChildRunSettings(), saved);
});
