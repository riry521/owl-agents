import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { resolveRoleModel } from "../packages/core/dist/workflow-engine.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";
import {
  codexKnownModels,
  mergeOfficialModels,
  parseAnthropicModels,
  readCodexModelCatalog,
  refreshCodexModelCatalog,
} from "../apps/server/dist/model-catalog.js";
import { CODEX_BUILTIN_MODELS, DEFAULT_HARNESS_MODELS } from "../packages/shared/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Designer model lookup uses the shared default when settings are absent or omit Designer", () => {
  const noSettings = { get: () => undefined };
  assert.deepEqual(resolveRoleModel(noSettings, "designer"), { provider: "anthropic", model: "claude-fable-5-1", effort: "high" });

  const oldSettings = { get: () => ({ value_json: JSON.stringify({ roles: [
    { role: "manager", provider: "anthropic", model: "manager-model", effort: "high" },
    { role: "worker", provider: "openai", model: "worker-model", effort: "high" },
  ] }) }) };
  assert.deepEqual(resolveRoleModel(oldSettings, "designer"), { provider: "anthropic", model: "claude-fable-5-1", effort: "high" });

  const explicitSettings = { get: () => ({ value_json: JSON.stringify({ roles: [
    { role: "designer", provider: "custom-provider", model: "design-model", effort: "medium" },
  ] }) }) };
  assert.deepEqual(resolveRoleModel(explicitSettings, "designer"), { provider: "custom-provider", model: "design-model", effort: "medium" });
});

test("stored model settings without another role's entry still fail", () => {
  const withoutWorker = { get: () => ({ value_json: JSON.stringify({ roles: [
    { role: "manager", provider: "anthropic", model: "manager-model", effort: "high" },
  ] }) }) };
  assert.throws(() => resolveRoleModel(withoutWorker, "worker"), /missing a valid worker provider\/model/);
  assert.throws(() => resolveRoleModel(withoutWorker, "reviewer"), /missing a valid reviewer provider\/model/);
  const invalidDesigner = { get: () => ({ value_json: JSON.stringify({ roles: [{ role: "designer", provider: "anthropic", model: "" }] }) }) };
  assert.throws(() => resolveRoleModel(invalidDesigner, "designer"), /missing a valid designer provider\/model/);
});

async function withCodexHome(cache, run) {
  const codexHome = await mkdtemp(join(tmpdir(), "owl-codex-home-"));
  try {
    if (cache !== null) await writeFile(join(codexHome, "models_cache.json"), typeof cache === "string" ? cache : JSON.stringify(cache));
    return await run({ CODEX_HOME: codexHome });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function withCore(options, run) {
  const root = await mkdtemp(join(tmpdir(), "owl-model-settings-"));
  const db = openDatabase(join(root, "owl.db"));
  try {
    db.migrate(join(repoRoot, "packages/db/migrations"));
    return await run(new Core({ db, agentRunner: {}, version: "test", owlRoot: root, ...options }), db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

function updateRoles(core, change) {
  const current = core.getModelSettings();
  return core.updateModelSettings({
    request_id: createUlid(),
    idempotency_key: `test:${createUlid()}`,
    expected_version: current.version,
    payload: {
      roles: current.roles.map(({ role, provider, model, effort }) => ({ role, provider, model, effort, ...(change[role] ?? {}) })),
    },
  });
}

test("Anthropic catalog reads only current Claude API IDs", () => {
  const markdown = [
    "| Feature | Fable | Opus | Sonnet | Haiku |",
    "| Claude API ID | `claude-fable-5-1` | `claude-opus-5-5` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` |",
    "Legacy models: `claude-opus-4-8`",
  ].join("\n");
  assert.deepEqual(parseAnthropicModels(markdown), [
    "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001",
  ]);
});

const CODEX_CACHE = {
  fetched_at: "2026-01-01T00:00:00Z",
  models: [
    { slug: "gpt-7-nova", visibility: "list" },
    { slug: "gpt-5.6-terra", visibility: "list" },
    { slug: "codex-internal-review", visibility: "hide" },
    { visibility: "list" },
  ],
};

test("the Codex model catalog is read from CODEX_HOME/models_cache.json", async () => {
  await withCodexHome(CODEX_CACHE, async (env) => {
    assert.deepEqual(readCodexModelCatalog(env), [
      { slug: "gpt-7-nova", listed: true },
      { slug: "gpt-5.6-terra", listed: true },
      { slug: "codex-internal-review", listed: false },
    ]);
    const known = codexKnownModels(env);
    for (const model of ["gpt-7-nova", "codex-internal-review", ...CODEX_BUILTIN_MODELS]) assert.ok(known.has(model), model);
  });
});

test("the OpenAI selector lists the Codex catalog's visible models ahead of the saved list", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  t.mock.method(console, "warn", () => {});
  await withCodexHome(CODEX_CACHE, async (env) => {
    const merged = await mergeOfficialModels({ anthropic: ["claude-sonnet-5"], openai: ["gpt-6-luna", "gpt-5.6-terra"] }, env);
    assert.deepEqual(merged.openai, ["gpt-7-nova", "gpt-5.6-terra", "gpt-6-luna"]);
    assert.deepEqual(merged.anthropic, ["claude-sonnet-5"]);
  });
});

test("without a readable Codex catalog the built-in model list is used", async () => {
  for (const cache of [null, "not json", { models: "none" }]) {
    await withCodexHome(cache, async (env) => {
      assert.equal(readCodexModelCatalog(env), null);
      assert.deepEqual([...codexKnownModels(env)].sort(), [...CODEX_BUILTIN_MODELS].sort());
    });
  }
  for (const model of ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-terra"]) assert.ok(CODEX_BUILTIN_MODELS.includes(model), model);
});

test("default role and Executor models are real harness models", async () => {
  await withCore({}, async (core) => {
    const worker = core.getModelSettings().roles.find(({ role }) => role === "worker");
    assert.equal(worker.provider, "openai");
    assert.equal(worker.model, DEFAULT_HARNESS_MODELS.codex);
    assert.ok(CODEX_BUILTIN_MODELS.includes(DEFAULT_HARNESS_MODELS.codex));
    const curator = core.getModelSettings().roles.find(({ role }) => role === "curator");
    assert.equal(curator.provider, "anthropic");
    assert.equal(curator.model, "claude-haiku-4-5-20251001");
    assert.equal(curator.effort, "low");
    assert.equal((await core.getExecutorConfig()).model, DEFAULT_HARNESS_MODELS.claude);
  });
});

test("a stored setting without a librarian role uses the stored advisor model for it", async () => {
  await withCore({}, async (core, db) => {
    const now = new Date().toISOString();
    const roles = ["advisor", "manager", "designer", "worker", "reviewer"].map((role) => ({
      role,
      provider: "anthropic",
      model: role === "advisor" ? "claude-sonnet-5" : "claude-opus-5",
      effort: "medium",
      catalog_version: "1.0.0",
    }));
    await db.createWriteLane().transact((tx) => {
      tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
      tx.run(
        "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
        JSON.stringify({ schema_version: "1.0.0", version: 1, roles }),
        now,
      );
    });
    const settings = core.getModelSettings().roles;
    const librarian = settings.find(({ role }) => role === "librarian");
    assert.equal(librarian.model, "claude-sonnet-5");
    assert.equal(librarian.effort, "medium");
    assert.equal(settings.find(({ role }) => role === "curator").model, "claude-haiku-4-5-20251001");
  });
});

test("model settings reject Codex models the harness does not know", async () => {
  await withCore({}, async (core) => {
    await assert.rejects(() => updateRoles(core, { worker: { model: "luna" } }), (error) => {
      assert.equal(error?.code, "validation_error");
      assert.match(error.message, /gpt-5\.6-terra/);
      return true;
    });
    const accepted = await updateRoles(core, { worker: { model: "gpt-6-luna" } });
    assert.equal(accepted.data.roles.find(({ role }) => role === "worker").model, "gpt-6-luna");
    await assert.rejects(
      () => core.setExecutorConfig({ provider: "openai", model: "luna", effort: "high", timeout_ms: 0 }),
      (error) => error?.code === "validation_error",
    );
    assert.equal((await core.setExecutorConfig({ provider: "codex", model: "gpt-6-luna", effort: "high", timeout_ms: 0 })).model, "gpt-6-luna");
  });
});

test("custom providers and Claude models are not checked against the Codex list", async () => {
  await withCore({}, async (core) => {
    const updated = await updateRoles(core, {
      worker: { provider: "orca", model: "orca-large" },
      manager: { provider: "anthropic", model: "opus" },
    });
    assert.equal(updated.data.roles.find(({ role }) => role === "worker").model, "orca-large");
    assert.equal(updated.data.roles.find(({ role }) => role === "manager").model, "opus");
  });
});

test("Core warns at startup about saved models its harness no longer offers, without changing them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-model-warn-"));
  const dbPath = join(root, "owl.db");
  // Every other role keeps its own default Claude model untouched by this
  // test, so the permissive list must still cover them for the save to pass.
  const defaultClaudeModels = [DEFAULT_HARNESS_MODELS.claude, "claude-opus-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"];
  const permissiveKnownModels = (harness) =>
    harness === "codex"
      ? new Set(["retired-worker-model", ...CODEX_BUILTIN_MODELS])
      : new Set(["retired-executor-model", ...defaultClaudeModels]);
  // The next start checks the saved values against a catalog that no longer
  // offers either one (Claude is checked here too, to exercise the Executor's model).
  const strictKnownModels = (harness) =>
    harness === "codex" ? new Set(CODEX_BUILTIN_MODELS) : new Set(defaultClaudeModels);
  try {
    {
      // Save models while both the worker's Codex model and the Executor's
      // (here Claude-harness) model are still accepted.
      const db = openDatabase(dbPath);
      db.migrate(join(repoRoot, "packages/db/migrations"));
      const core = new Core({ db, agentRunner: {}, version: "test", owlRoot: root, dataDir: root, knownModels: permissiveKnownModels });
      await updateRoles(core, { worker: { provider: "openai", model: "retired-worker-model" } });
      await core.setExecutorConfig({ provider: "anthropic", model: "retired-executor-model", effort: "high", timeout_ms: 0 });
      db.close();
    }

    const db = openDatabase(dbPath);
    const core = new Core({ db, agentRunner: {}, version: "test", owlRoot: root, dataDir: root, knownModels: strictKnownModels });
    const warnMock = t.mock.method(console, "warn");
    await core.start();
    await core.stop({ force: true }).catch(() => {});
    db.close();

    const lines = warnMock.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(lines.some((line) => /worker/.test(line) && /retired-worker-model/.test(line)), `expected a worker warning, got: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((line) => /executor/.test(line) && /retired-executor-model/.test(line)), `expected an executor warning, got: ${JSON.stringify(lines)}`);

    const dbAfter = openDatabase(dbPath);
    const worker = new Core({ db: dbAfter, agentRunner: {}, version: "test", owlRoot: root, dataDir: root }).getModelSettings()
      .roles.find(({ role }) => role === "worker");
    assert.equal(worker.model, "retired-worker-model", "the saved value must be left untouched");
    dbAfter.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Core does not warn at startup when saved models are known or unchecked", async (t) => {
  await withCore({}, async (core) => {
    const warnMock = t.mock.method(console, "warn");
    await core.start();
    await core.stop({ force: true }).catch(() => {});
    const lines = warnMock.mock.calls.map((call) => String(call.arguments[0]));
    assert.deepEqual(lines.filter((line) => /is no longer offered/u.test(line)), []);
  });
});

test("an injected model list replaces the built-in one", async () => {
  const knownModels = (harness) => harness === "codex" ? new Set(["gpt-7-nova"]) : new Set(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  await withCore({ knownModels }, async (core) => {
    await assert.rejects(() => updateRoles(core, { worker: { model: "gpt-5.6-terra" }, manager: { model: "claude-sonnet-5" } }), (error) => error?.code === "validation_error");
    await assert.rejects(() => updateRoles(core, { worker: { model: "gpt-7-nova" }, manager: { model: "claude-opus-5" } }), (error) => error?.code === "validation_error");
    const updated = await updateRoles(core, {
      worker: { model: "gpt-7-nova" },
      manager: { model: "claude-sonnet-5" },
      reviewer: { model: "claude-sonnet-5" },
      advisor: { model: "claude-sonnet-5" },
      designer: { model: "claude-sonnet-5" },
      lead_designer: { model: "claude-sonnet-5" },
      librarian: { model: "claude-sonnet-5" },
    });
    assert.equal(updated.data.roles.find(({ role }) => role === "worker").model, "gpt-7-nova");
  });
});

async function withFakeCodex(script, run) {
  const dir = await mkdtemp(join(tmpdir(), "owl-fake-codex-"));
  try {
    const executable = join(dir, "codex");
    await writeFile(executable, `#!${process.execPath}\n${script}`);
    await chmod(executable, 0o755);
    return await run({ dir, executable });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FAKE_APP_SERVER = `
const fs = require("node:fs");
const path = require("node:path");
const hang = process.env.FAKE_HANG === "1";
fs.writeFileSync(path.join(process.env.FAKE_DIR, "pid"), String(process.pid));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (hang) continue;
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    if (message.method === "model/list") {
      fs.writeFileSync(path.join(process.env.FAKE_DIR, "params.json"), JSON.stringify(message.params));
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-sol", visibility: "list" }] }));
      const data = [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", hidden: false }, { id: "gpt-reserve", model: "gpt-reserve", hidden: true }];
      process.stdout.write(JSON.stringify({ id: message.id, result: { data } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`;

test("refreshing the Codex catalog keeps the model/list answer even when the local cache lags", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  await withCodexHome(null, async (home) => withFakeCodex(FAKE_APP_SERVER, async ({ dir, executable }) => {
    const env = { ...process.env, ...home, FAKE_DIR: dir };
    assert.equal(readCodexModelCatalog(env), null);
    assert.equal(await refreshCodexModelCatalog({ executable, env }), true);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "params.json"), "utf8")), { includeHidden: true });
    assert.deepEqual(readCodexModelCatalog(env), [{ slug: "gpt-6-sol", listed: true }]);
    const known = codexKnownModels(env);
    for (const slug of ["gpt-6.1-sol", "gpt-reserve", "gpt-6-sol"]) assert.ok(known.has(slug), slug);
  }));
});

test("a hung Codex app-server is killed once the refresh times out", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  await withCodexHome(null, async (home) => withFakeCodex(FAKE_APP_SERVER, async ({ dir, executable }) => {
    const env = { ...process.env, ...home, FAKE_DIR: dir, FAKE_HANG: "1" };
    assert.equal(await refreshCodexModelCatalog({ executable, env, timeoutMs: 500 }), false);
    assert.equal(warn.mock.callCount(), 1);
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }));
});

test("a missing Codex executable resolves false without throwing", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  assert.equal(await refreshCodexModelCatalog({ executable: join(tmpdir(), "owl-no-such-codex") }), false);
});
