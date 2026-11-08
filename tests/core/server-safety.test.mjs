import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { chmodSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { OPENCODE_HARNESS_GAPS } from "../../packages/shared/dist/index.js";
import { loadOwlEnv, parseDotEnv } from "../../packages/shared/dist/env.js";
import { AppSettingsStore, scrubLegacySettings } from "../../apps/server/dist/app-settings-store.js";
import { createConfiguredCore } from "../../apps/server/dist/core.js";
import { IntegrationStore } from "../../apps/server/dist/integration-store.js";
import { connectorConfigStatus } from "../../apps/server/dist/secret-config.js";
import { isOwnerRequestAuthorized } from "../../apps/server/dist/http.js";
import { isExternalBind, isLoopbackBind, serverExposureError } from "../../apps/server/dist/config.js";
import { providerConfigurationError, providerSelection } from "../../apps/server/dist/provider-selection.js";
import { readProcessIdentity } from "../../packages/core/dist/process-identity.js";
import { SecretStore } from "../../packages/core/dist/secret-store.js";
import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { command } from "../helpers/core.mjs";
import { readFakeOpencodeLog, writeFakeOpencode } from "../helpers/fake-opencode.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { migrationsDir, repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const cliPath = join(repoRoot, "apps/server/dist/cli.js");

/** Runs body with the named process variables unset, restoring them afterwards. */
async function withoutEnv(names, body) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Every JSON file below dir, with its text. */
async function jsonFilesBelow(dir) {
  const found = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.json(\.migrated)?$/u.test(entry.name)) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    found.push({ path, text: await readFile(path, "utf8") });
  }
  return found;
}

// Smoke servers started with the real HOME must not use the real workspaces directory.
const SMOKE_WORKSPACES_DIR = join(tmpdir(), `owl-smoke-workspaces-${process.pid}`);

function envWith(overrides) {
  return { ...process.env, OWL_LANG: "en", OWL_WORKSPACES_DIR: SMOKE_WORKSPACES_DIR, ...overrides };
}

function request(remoteAddress, headers = {}) {
  return { headers, socket: { remoteAddress } };
}

async function freePort() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return null;
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.ok(port > 0);
  return port;
}

function waitForPath(path) {
  return waitFor(() => existsSync(path), { timeoutMs: 5_000, intervalMs: 50, message: path });
}

test(".env loads automatically without overriding explicit process values", async (t) => {
  const root = await tempDir(t, "owl-env-");
  await writeFile(join(root, ".env"), [
    "OWL_BIND=from-dotenv",
    "OWL_PORT=4123",
    "QUOTED=\"value # kept\"",
    "export EMPTY=",
  ].join("\n"));
  const env = { OWL_BIND: "from-process" };
  const result = loadOwlEnv({ projectRoot: root, env });
  assert.equal(env.OWL_BIND, "from-process");
  assert.equal(env.OWL_PORT, "4123");
  assert.equal(env.QUOTED, "value # kept");
  assert.equal(env.EMPTY, "");
  assert.deepEqual(result.loadedKeys.sort(), ["EMPTY", "OWL_PORT", "QUOTED"]);
  assert.deepEqual(parseDotEnv("A=one # comment\nB='two # value'"), { A: "one", B: "two # value" });
});

test("bind exposure policy fails closed and does not accept OWL_HOST", () => {
  assert.equal(isLoopbackBind("127.0.0.1"), true);
  assert.equal(isLoopbackBind("::1"), true);
  assert.equal(isExternalBind("0.0.0.0"), true);
  assert.match(serverExposureError("0.0.0.0"), /OWL_API_TOKEN/);
  assert.equal(serverExposureError("127.0.0.1"), null);
  const originalBind = process.env.OWL_BIND;
  const originalHost = process.env.OWL_HOST;
  delete process.env.OWL_BIND;
  process.env.OWL_HOST = "0.0.0.0";
  // The config module deliberately does not translate the deprecated name.
  assert.equal(process.env.OWL_BIND, undefined);
  if (originalBind === undefined) delete process.env.OWL_BIND; else process.env.OWL_BIND = originalBind;
  if (originalHost === undefined) delete process.env.OWL_HOST; else process.env.OWL_HOST = originalHost;
});

test("external requests require bearer token even with a UI cookie", () => {
  const remote = request("10.0.0.8", { cookie: "owl_ui_session=valid-looking", "x-csrf-token": "token" });
  assert.equal(isOwnerRequestAuthorized(remote, "token", true), false);
  assert.equal(isOwnerRequestAuthorized(remote, "token", false), false);
  assert.equal(isOwnerRequestAuthorized(request("10.0.0.8", { authorization: "Bearer token" }), "token", true), true);
  assert.equal(isOwnerRequestAuthorized(request("127.0.0.1", { cookie: "owl_ui_session=valid-looking" }), "token", true), true);
  assert.equal(isOwnerRequestAuthorized(request("10.0.0.8"), undefined, false), false);
});

test("Tailscale Serve requests count as local, but Funnel requests never do", () => {
  const serve = request("127.0.0.1", { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.2" });
  assert.equal(isOwnerRequestAuthorized(serve, undefined, false), true);
  const funnel = request("127.0.0.1", { "tailscale-funnel-request": "?1", "x-forwarded-for": "203.0.113.9" });
  assert.equal(isOwnerRequestAuthorized(funnel, undefined, false), false);
  assert.equal(isOwnerRequestAuthorized(funnel, "token", true), false);
  assert.equal(isOwnerRequestAuthorized({ ...funnel, headers: { ...funnel.headers, authorization: "Bearer token" } }, "token", false), true);
});

test("invalid stored provider selection is surfaced instead of silently switching to Claude", async (t) => {
  const root = await tempDir(t, "owl-invalid-provider-selection-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({
    custom_providers: {},
    provider_models: {},
  }));
  const keys = ["OWL_PROVIDER", "OWL_PROVIDER_ID", "OWL_DATA_DIR", "OWL_PROVIDER_ADAPTER", "OWL_CLAUDE_EXECUTABLE", "OWL_CODEX_EXECUTABLE", "OWL_PROVIDER_EXECUTABLE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.OWL_PROVIDER = "real";
    for (const key of keys.slice(1)) delete process.env[key];
    // Ignore machine-level provider/data settings loaded from .env so this
    // fixture exercises only the deliberately invalid settings file above.
    process.env.OWL_DATA_DIR = dataDir;
    // The provider is no longer read from app-settings.json (child-agent settings
    // carry their own allow-list), so the invalid selection comes from the env.
    process.env.OWL_PROVIDER_ID = "typo-provider";
    const selection = providerSelection(root);
    assert.equal(selection.harness, null);
    assert.match(providerConfigurationError(selection), /adapter設定を解決|adapter/u);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("malformed app settings are reported instead of field-by-field defaulting", async (t) => {
  const root = await tempDir(t, "owl-invalid-app-settings-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ hybrid_mode: "false" }));
  assert.throws(() => new AppSettingsStore(root, dataDir), /hybrid_mode must be a boolean/u);
});

test("legacy inline custom-provider keys migrate to .env without remaining in app-settings", async (t) => {
  const root = await tempDir(t, "owl-provider-key-migration-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const legacyKey = "legacy-provider-key-for-migration";
  const envName = "OWL_PROVIDER_ORCA_API_KEY";
  const previousEnv = process.env[envName];
  delete process.env[envName];
  try {
    await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({
      custom_providers: {
        orca: { displayName: "Orca", harnessId: "claude", apiKeySource: legacyKey },
      },
      provider_models: {},
    }));
    const settings = new AppSettingsStore(root, dataDir);
    assert.equal(settings.getCustomProviders().orca.apiKeySource, `env:${envName}`);
    assert.equal(process.env[envName], legacyKey);
    const stored = await readFile(join(dataDir, "app-settings.json"), "utf8");
    assert.match(stored, new RegExp(`apiKeySource\\": \\"env:${envName}\\"`));
    assert.doesNotMatch(stored, new RegExp(legacyKey));
    const envFile = await readFile(join(root, ".env"), "utf8");
    assert.match(envFile, new RegExp(`^${envName}=`, "mu"));
  } finally {
    if (previousEnv === undefined) delete process.env[envName];
    else process.env[envName] = previousEnv;
  }
});

test("legacy .owl-data migrates only missing settings and encrypted secrets", async (t) => {
  const root = await tempDir(t, "owl-data-");
  const dataDir = join(root, "runtime");
  const legacyDir = join(root, ".owl-data");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, "app-settings.json"), JSON.stringify({
    hybrid_mode: false,
    executor_config: { provider: "claude", model: "legacy-model", timeout_ms: 0 },
    custom_providers: {},
    provider_models: {},
    typesafe_api_key: "legacy-key",
  }));
  const passphrase = "test-passphrase-123";
  const vault = new SecretStore(legacyDir);
  vault.set("integration:slack", JSON.stringify({ bot_token: "xoxb-test", app_token: "xapp-test" }), passphrase);
  const previousTypesafeKey = process.env.OWL_TYPESAFE_API_KEY;
  delete process.env.OWL_TYPESAFE_API_KEY;
  t.after(() => {
    if (previousTypesafeKey === undefined) delete process.env.OWL_TYPESAFE_API_KEY;
    else process.env.OWL_TYPESAFE_API_KEY = previousTypesafeKey;
  });
  const settings = new AppSettingsStore(root, dataDir);
  assert.equal(settings.getTypesafeApiKey(), "legacy-key");
  assert.match(await readFile(join(dataDir, "app-settings.json"), "utf8"), /"typesafe_api_key": "env:OWL_TYPESAFE_API_KEY"/u);
  assert.equal(existsSync(join(dataDir, "app-settings.json")), true);
  const previousPassphrase = process.env.OWL_SECRET_PASSPHRASE;
  const connectorEnvKeys = [
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_SIGNING_SECRET",
    "SLACK_CHANNEL_ID",
    "SLACK_CONVERSATION_CHANNEL_ID",
    "SLACK_NOTIFICATION_CHANNEL_ID",
  ];
  const previousConnectorEnv = Object.fromEntries(connectorEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of connectorEnvKeys) delete process.env[key];
  process.env.OWL_SECRET_PASSPHRASE = passphrase;
  try {
    const integrations = new IntegrationStore(root, dataDir);
    assert.equal(integrations.getConfig("slack")?.bot_token, "xoxb-test");
  } finally {
    if (previousPassphrase === undefined) delete process.env.OWL_SECRET_PASSPHRASE;
    else process.env.OWL_SECRET_PASSPHRASE = previousPassphrase;
    for (const [key, value] of Object.entries(previousConnectorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(existsSync(join(legacyDir, "secrets.json")), true);
  assert.equal(existsSync(join(dataDir, "secrets.json")), true);

  await writeFile(join(legacyDir, "app-settings.json"), JSON.stringify({
    typesafe_api_key: "legacy-mutation-must-not-overwrite",
  }));
  const existingCanonical = new AppSettingsStore(root, dataDir);
  assert.equal(existingCanonical.getTypesafeApiKey(), "legacy-key");
});

const LEGACY_SECRET_ENV = ["OWL_PROVIDER_ORCA_API_KEY", "OWL_TYPESAFE_API_KEY"];

test("the legacy settings file is retired with its keys moved to .env and every other setting kept", async (t) => {
  const root = await tempDir(t, "owl-legacy-scrub-");
  const dataDir = join(root, "data");
  const legacyDir = join(root, ".owl-data");
  await mkdir(legacyDir, { recursive: true });
  const providerSecret = "sk-legacy-orca-provider-secret";
  const typesafeSecret = "legacy-typesafe-secret-value";
  const legacy = {
    hybrid_mode: true,
    executor_config: { provider: "claude", model: "legacy-model", timeout_ms: 0 },
    custom_providers: {
      orca: { displayName: "Orca", harnessId: "claude", backendUrl: "https://orca.test", apiKeySource: providerSecret },
    },
    provider_models: { orca: ["orca-large"] },
    typesafe_api_key: typesafeSecret,
    advisor_persona: "Keep answers short.",
  };
  await writeFile(join(legacyDir, "app-settings.json"), JSON.stringify(legacy), { mode: 0o600 });

  await withoutEnv(LEGACY_SECRET_ENV, async () => {
    const cleanup = scrubLegacySettings(root, dataDir);
    const retired = join(legacyDir, "app-settings.json.migrated");
    assert.deepEqual(cleanup, { file: retired, env_names: LEGACY_SECRET_ENV });
    assert.equal(existsSync(join(legacyDir, "app-settings.json")), false);
    assert.equal((await stat(retired)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(retired, "utf8")), {
      ...legacy,
      custom_providers: { orca: { ...legacy.custom_providers.orca, apiKeySource: "env:OWL_PROVIDER_ORCA_API_KEY" } },
      typesafe_api_key: "env:OWL_TYPESAFE_API_KEY",
    });
    const envFile = await readFile(join(root, ".env"), "utf8");
    assert.deepEqual(parseDotEnv(envFile), { OWL_PROVIDER_ORCA_API_KEY: providerSecret, OWL_TYPESAFE_API_KEY: typesafeSecret });

    // The data directory's copy was taken before the rewrite; loading it moves
    // its inline keys to references too.
    const settings = new AppSettingsStore(root, dataDir);
    assert.equal(settings.getTypesafeApiKey(), typesafeSecret);
    assert.equal(settings.getCustomProviders().orca.apiKeySource, "env:OWL_PROVIDER_ORCA_API_KEY");
    assert.equal(settings.getAdvisorPersona(), "Keep answers short.");
    assert.equal(settings.getHybridMode(), true);
    const files = await jsonFilesBelow(root);
    assert.ok(files.length >= 2);
    for (const { path, text } of files) {
      assert.doesNotMatch(text, new RegExp(`${providerSecret}|${typesafeSecret}`, "u"), path);
    }

    assert.equal(scrubLegacySettings(root, dataDir), null, "a second run finds nothing to do");
    assert.equal(await readFile(join(root, ".env"), "utf8"), envFile);
  });
});

test("retiring legacy settings keeps a key that .env already defines", async (t) => {
  const root = await tempDir(t, "owl-legacy-scrub-env-");
  const dataDir = join(root, "data");
  const legacyDir = join(root, ".owl-data");
  await mkdir(legacyDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ typesafe_api_key: "env:OWL_TYPESAFE_API_KEY" }));
  await writeFile(join(legacyDir, "app-settings.json"), JSON.stringify({ typesafe_api_key: "stale-legacy-value" }));
  await writeFile(join(root, ".env"), 'OWL_TYPESAFE_API_KEY="current-value"\n');
  await withoutEnv(LEGACY_SECRET_ENV, async () => {
    const cleanup = scrubLegacySettings(root, dataDir);
    assert.deepEqual(cleanup.env_names, []);
    assert.equal(await readFile(join(root, ".env"), "utf8"), 'OWL_TYPESAFE_API_KEY="current-value"\n');
    const retired = await readFile(cleanup.file, "utf8");
    assert.doesNotMatch(retired, /stale-legacy-value/u);
    assert.match(await readFile(join(dataDir, "app-settings.json"), "utf8"), /env:OWL_TYPESAFE_API_KEY/u);
  });
});

test("a legacy settings file that is not JSON is reported without its content", async (t) => {
  const root = await tempDir(t, "owl-legacy-scrub-corrupt-");
  const legacyDir = join(root, ".owl-data");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, "app-settings.json"), '{"typesafe_api_key": sk-unquoted-secret');
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data", "app-settings.json"), "{}");
  assert.throws(
    () => scrubLegacySettings(root, join(root, "data")),
    (error) => /not valid JSON/u.test(error.message) && !/sk-unquoted-secret/u.test(error.message),
  );
});

async function settingsApi(t, root) {
  const previous = { mode: process.env.OWL_CORE_MODE };
  process.env.OWL_CORE_MODE = "external";
  const db = createTestDatabase(root);
  const core = await createConfiguredCore({ db, agentRunner: {}, version: "settings-test", owlRoot: root, dataDir: join(root, "data") });
  const restore = async () => {
    await core.shutdown({ force: true, timeoutMs: 1000 }).catch(() => undefined);
    if (previous.mode === undefined) delete process.env.OWL_CORE_MODE;
    else process.env.OWL_CORE_MODE = previous.mode;
  };
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root }, { token: "settings-api-test-token" });
  if (api === null) {
    await restore();
    return null;
  }
  t.after(restore);
  let sequence = 0;
  return async (method, path, payload) => {
    sequence += 1;
    const response = await api.request(method, `/api/v1${path}`, payload === undefined ? undefined : command(payload, `settings-${sequence}`));
    return { status: response.status, body: await response.json() };
  };
}

test("the Typesafe API key is saved to .env and only a reference and a masked value leave the server", async (t) => {
  const root = await tempDir(t, "owl-typesafe-key-");
  await withoutEnv(["OWL_TYPESAFE_API_KEY"], async () => {
    const call = await settingsApi(t, root);
    if (call === null) return t.skip("localhost listen is unavailable");
    const key = "typesafe-secret-1234";
    const saved = await call("PUT", "/settings/typesafe", { typesafe_api_key: key });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.typesafe_api_key, `${"*".repeat(key.length - 4)}1234`);
    const shown = await call("GET", "/settings/typesafe");
    assert.equal(shown.body.data.typesafe_api_key, `${"*".repeat(key.length - 4)}1234`);
    assert.equal(parseDotEnv(await readFile(join(root, ".env"), "utf8")).OWL_TYPESAFE_API_KEY, key);
    const stored = await readFile(join(root, "data", "app-settings.json"), "utf8");
    assert.match(stored, /"typesafe_api_key": "env:OWL_TYPESAFE_API_KEY"/u);
    assert.doesNotMatch(stored, new RegExp(key, "u"));
    assert.equal(new AppSettingsStore(root, join(root, "data")).getTypesafeApiKey(), key);

    await call("PUT", "/settings/typesafe", { typesafe_api_key: "" });
    assert.equal((await call("GET", "/settings/typesafe")).body.data.typesafe_api_key, "");
    assert.equal(parseDotEnv(await readFile(join(root, ".env"), "utf8")).OWL_TYPESAFE_API_KEY, "");
    assert.match(await readFile(join(root, "data", "app-settings.json"), "utf8"), /"typesafe_api_key": ""/u);
  });
});

test("an inline Typesafe API key in the settings file is not accepted after load", async (t) => {
  const root = await tempDir(t, "owl-typesafe-inline-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ typesafe_api_key: "env:not a name" }));
  assert.throws(() => new AppSettingsStore(root, dataDir), /typesafe_api_key must be empty or use env:VARIABLE_NAME format/u);
});

test("a custom provider cannot be saved without a backend URL; a stored one without it fails its test", async (t) => {
  const root = await tempDir(t, "owl-provider-backend-");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data", "app-settings.json"), JSON.stringify({
    custom_providers: { orca: { displayName: "Orca", harnessId: "claude", apiKeySource: "env:OWL_PROVIDER_ORCA_API_KEY" } },
  }));
  const call = await settingsApi(t, root);
  if (call === null) return t.skip("localhost listen is unavailable");
  const created = await call("POST", "/settings/providers", { id: "kite", displayName: "Kite", harnessId: "codex" });
  assert.equal(created.status, 400);
  assert.equal(created.body.error.code, "validation_error");
  assert.match(created.body.error.message, /backendUrl/u);
  const updated = await call("PUT", "/settings/providers/orca", { displayName: "Orca", harnessId: "claude" });
  assert.equal(updated.status, 400);
  assert.equal(updated.body.error.code, "validation_error");

  const listed = await call("GET", "/settings/providers");
  assert.equal(listed.status, 200);
  const tested = await call("POST", "/settings/providers/orca/test");
  assert.equal(tested.body.data.ok, false);
  assert.match(tested.body.data.detail, /backendUrl/u);

  const fixed = await call("PUT", "/settings/providers/orca", { displayName: "Orca", harnessId: "claude", backendUrl: "https://orca.test" });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.data.backendUrl, "https://orca.test");
});

test("a custom provider can use the opencode harness, and unknown harnesses are still rejected", async (t) => {
  const root = await tempDir(t, "owl-provider-opencode-");
  await mkdir(join(root, "data"), { recursive: true });
  const call = await settingsApi(t, root);
  if (call === null) return t.skip("localhost listen is unavailable");
  const created = await call("POST", "/settings/providers", { id: "kite", displayName: "Kite", harnessId: "opencode", backendUrl: "https://kite.test" });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.harnessId, "opencode");
  const rejected = await call("POST", "/settings/providers", { id: "owl2", displayName: "Owl2", harnessId: "gemini", backendUrl: "https://owl2.test" });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "validation_error");
  const listed = await call("GET", "/settings/providers");
  assert.ok(listed.body.data.some((provider) => provider.id === "opencode" || provider.harnessId === "opencode"));
});

test("a run on a custom provider without a backend URL stops before the harness starts", async () => {
  let executed = false;
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    model: "claude-opus-5-5",
    providers: { orca: { adapter: "claude-cli/v1", api_key_env: "OWL_PROVIDER_ORCA_API_KEY" } },
    providerApiKeys: { OWL_PROVIDER_ORCA_API_KEY: "orca-key" },
    provider: { execute: async () => { executed = true; throw new Error("the harness must not start"); } },
  });
  await assert.rejects(
    () => runner.runManagerPlan({
      invocation_id: "manager-orca",
      work_id: "work-orca",
      task_id: null,
      attempt: 1,
      work: { id: "work-orca", title: "Plan", summary: "Plan the Work." },
      tasks: [],
      reports: [],
      notes: [],
      reason: "Plan it.",
      mode: "finalize",
      context: { mode: "finalize", work_id: "work-orca" },
      provider: "orca",
      model: "orca-large",
    }),
    { code: "provider_config_invalid", reason: "backend_url_missing:orca" },
  );
  assert.equal(executed, false);
});

test("connector tokens use .env and an unconfigured connector is a normal state", async (t) => {
  const root = await tempDir(t, "owl-connector-env-");
  const dataDir = join(root, "data");
  const envKeys = [
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_CHANNEL_ID",
    "SLACK_CONVERSATION_CHANNEL_ID",
    "SLACK_NOTIFICATION_CHANNEL_ID",
    "OWL_SECRET_PASSPHRASE",
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  try {
    const store = new IntegrationStore(root, dataDir);
    store.save_integration("slack", {
      bot_token: "xoxb-test-token",
      app_token: "xapp-test-token",
      channel_id: "C123",
      owner_user_ids: ["legacy-owner-must-be-ignored"],
    });
    assert.equal((await stat(join(root, ".env"))).mode & 0o777, 0o600);
    assert.match(await readFile(join(root, ".env"), "utf8"), /SLACK_BOT_TOKEN=/u);
    assert.doesNotMatch(await readFile(join(root, ".env"), "utf8"), /OWL_SECRET_PASSPHRASE=/u);

    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    loadOwlEnv({ projectRoot: root });
    const reloaded = new IntegrationStore(root, dataDir);
    assert.equal(reloaded.getConfig("slack")?.bot_token, "xoxb-test-token");
    assert.equal(reloaded.getConfig("slack")?.channel_id, "C123");
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C123");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C123");
    assert.equal(Object.hasOwn(reloaded.getConfig("slack") ?? {}, "owner_user_ids"), false);
    reloaded.save_integration("slack", {
      conversation_channel_id: "C-CONVERSATION",
      notification_channel_id: "C-NOTIFICATIONS",
    });
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-CONVERSATION");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-NOTIFICATIONS");
    assert.equal(Object.hasOwn(reloaded.getConfig("slack") ?? {}, "channel_id"), false);
    assert.throws(
      () => reloaded.save_integration("discord", { bot_token: "discord-test-token" }),
      /conversation_channel_id and notification_channel_id are required/u,
    );
    const noConnectorRoot = await tempDir(t, "owl-no-connector-");
    const noConnectorData = join(noConnectorRoot, "data");
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    assert.deepEqual(connectorConfigStatus(noConnectorRoot, noConnectorData), {
      configured: false,
      accessible: true,
      legacy: false,
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("stub doctor warns that no AI is used", async (t) => {
  const root = await tempDir(t, "owl-doctor-");
  const port = 65534;
  const result = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
    cwd: repoRoot,
    env: envWith({
      OWL_ROOT: root,
      OWL_DATA_DIR: join(root, "data"),
      OWL_PROVIDER: "stub",
      OWL_BIND: "127.0.0.1",
      OWL_PORT: String(port),
      OWL_TAILSCALE_SERVE: "",
      OWL_SECRET_PASSPHRASE: "",
    }),
    encoding: "utf8",
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "warning");
  const provider = payload.checks.find((check) => check.check_id === "provider");
  assert.equal(provider.status, "warn");
  assert.match(provider.remediation, /OWL_PROVIDER=real/);
  assert.equal(payload.checks.some((check) => check.check_id === "claude-cli"), false);
  assert.equal(payload.checks.find((check) => check.check_id === "sqlite").status, "warn");
  assert.equal(payload.checks.find((check) => check.check_id === "sqlite").message.startsWith("not_initialized"), true);
});

async function realDoctor(t, adapter, executables, prepare) {
  const root = await tempDir(t, "owl-provider-");
  const home = join(root, "home");
  await mkdir(home);
  await prepare?.(root);
  const result = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
    cwd: repoRoot,
    env: envWith({
      HOME: home,
      OWL_ROOT: root,
      OWL_DATA_DIR: join(root, "data"),
      OWL_PROVIDER: "real",
      OWL_PROVIDER_ADAPTER: adapter,
      OWL_BIND: "127.0.0.1",
      OWL_PORT: "65533",
      OWL_TAILSCALE_SERVE: "",
      OWL_SECRET_PASSPHRASE: "",
      ...executables,
    }),
    encoding: "utf8",
  });
  const payload = JSON.parse(result.stdout);
  return (id) => payload.checks.find((check) => check.check_id === id);
}

async function fakeCli(t, loggedIn) {
  const dir = await tempDir(t, "owl-fake-cli-");
  const path = join(dir, "fake-cli");
  await writeFile(path, `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit ${loggedIn ? 0 : 1}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("real doctor checks the selected Codex adapter and warns that Claude is missing", async (t) => {
  const codex = await fakeCli(t, true);
  const check = await realDoctor(t, "codex-cli/v1", {
    OWL_CODEX_EXECUTABLE: codex,
    OWL_CLAUDE_EXECUTABLE: "/definitely/not-installed/claude",
  });
  assert.equal(check("provider").status, "pass");
  assert.match(check("provider").message, /codex-cli\/v1/);
  assert.equal(check("claude-cli").status, "warn");
  assert.equal(check("codex-login").status, "pass");
});

test("real doctor warns with login instructions for logged-out CLIs and passes logged-in ones", async (t) => {
  const loggedIn = await fakeCli(t, true);
  const loggedOut = await fakeCli(t, false);
  const check = await realDoctor(t, "claude-cli/v1", {
    OWL_CLAUDE_EXECUTABLE: loggedOut,
    OWL_CODEX_EXECUTABLE: loggedIn,
  });
  assert.equal(check("claude-login").status, "warn");
  assert.match(check("claude-login").remediation, /claude auth login/);
  assert.equal(check("codex-login").status, "pass");
  const swapped = await realDoctor(t, "codex-cli/v1", {
    OWL_CLAUDE_EXECUTABLE: loggedIn,
    OWL_CODEX_EXECUTABLE: loggedOut,
  });
  assert.equal(swapped("claude-login").status, "pass");
  assert.equal(swapped("codex-login").status, "warn");
  assert.match(swapped("codex-login").remediation, /codex login/);
});

async function seedOpencodeRole(root, role, provider, model) {
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const Database = createRequire(join(repoRoot, "packages/db/package.json"))("better-sqlite3");
  const db = new Database(join(dataDir, "owl.sqlite"));
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('model_settings', ?)").run(JSON.stringify({ roles: [{ role, provider, model, effort: "high" }] }));
  db.close();
}

test("real doctor warns when opencode is missing or older than the minimum, with both versions", async (t) => {
  const missing = await realDoctor(t, "claude-cli/v1", { OWL_OPENCODE_EXECUTABLE: "/definitely/not-installed/opencode" });
  assert.equal(missing("opencode-cli").status, "warn");
  assert.equal(missing("opencode-cli").severity, "optional");
  assert.match(missing("opencode-cli").message, /not found/);
  assert.equal(missing("opencode-login").status, "warn");

  const dir = await tempDir(t, "owl-fake-opencode-");
  const executable = await writeFakeOpencode(dir);
  const old = await realDoctor(t, "claude-cli/v1", { OWL_OPENCODE_EXECUTABLE: executable, FAKE_OPENCODE_VERSION: "1.9.0" });
  assert.equal(old("opencode-cli").status, "warn");
  assert.match(old("opencode-cli").message, /1\.9\.0/);
  assert.match(old("opencode-cli").message, /2\.0\.0/);
  assert.equal(old("opencode-login").status, "warn");
  assert.match(old("opencode-login").message, /Skipped/);
});

test("real doctor passes opencode-cli and reads login state from one private serve", async (t) => {
  const dir = await tempDir(t, "owl-fake-opencode-");
  const executable = await writeFakeOpencode(dir);
  const logPath = join(dir, "log.jsonl");
  const ok = await realDoctor(t, "claude-cli/v1", { OWL_OPENCODE_EXECUTABLE: executable, FAKE_OPENCODE_LOG: logPath });
  assert.equal(ok("opencode-cli").status, "pass");
  assert.equal(ok("opencode-login").status, "pass");
  assert.equal(ok("opencode-harness-gaps").status, "pass");
  const starts = (await readFakeOpencodeLog(logPath)).filter((entry) => entry.type === "start");
  assert.equal(starts.length, 1);

  const loggedOut = await realDoctor(t, "claude-cli/v1", { OWL_OPENCODE_EXECUTABLE: executable, FAKE_OPENCODE_CONNECTIONS: "0" });
  assert.equal(loggedOut("opencode-cli").status, "pass");
  assert.equal(loggedOut("opencode-login").status, "warn");
});

test("real doctor lists the opencode harness gaps for a role that uses opencode, without config contents or the password", async (t) => {
  const dir = await tempDir(t, "owl-fake-opencode-");
  const executable = await writeFakeOpencode(dir);
  const logPath = join(dir, "log.jsonl");
  const check = await realDoctor(
    t,
    "claude-cli/v1",
    { OWL_OPENCODE_EXECUTABLE: executable, FAKE_OPENCODE_LOG: logPath, FAKE_OPENCODE_SAVED: JSON.stringify([{ id: "p1" }, { id: "p2" }]) },
    (root) => seedOpencodeRole(root, "worker", "opencode", "fake-provider/fake-model"),
  );
  const gaps = check("opencode-harness-gaps");
  assert.equal(gaps.status, "warn");
  assert.equal(gaps.severity, "optional");
  for (const gap of OPENCODE_HARNESS_GAPS) assert.ok(gaps.message.includes(gap.en), gap.key);
  assert.match(gaps.message, /Saved permissions: 2/);
  assert.match(gaps.message, /fake-config/);
  assert.equal(check("opencode-login").status, "pass");
  const [start] = (await readFakeOpencodeLog(logPath)).filter((entry) => entry.type === "start");
  assert.equal(start.env.password_present, true);
  assert.equal(JSON.stringify(gaps).includes("mcpServers"), false);
});

test("start rejects an external bind before listening when token is absent", async (t) => {
  const root = await tempDir(t, "owl-bind-");
  let error;
  try {
    execFileSync(process.execPath, [cliPath, "start", "--foreground", "--bind", "0.0.0.0", "--port", "41999"], {
      cwd: repoRoot,
      env: envWith({
        OWL_ROOT: root,
        OWL_DATA_DIR: join(root, "data"),
        OWL_PROVIDER: "stub",
        OWL_API_TOKEN: "",
        OWL_TAILSCALE_SERVE: "",
      }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    error = cause;
  }
  assert.ok(error);
  assert.match(String(error.stderr), /OWL_API_TOKEN/);
});

test("stub background smoke starts, answers health, and stops without Tailscale side effects", async (t) => {
  const port = await freePort();
  if (port === null) {
    t.skip("localhost listen is not permitted in this environment");
    return;
  }
  const root = await tempDir(t, "owl-smoke-");
  await cp(join(repoRoot, "contracts"), join(root, "contracts"), { recursive: true });
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await cp(join(repoRoot, "apps", "web", "out"), join(root, "apps", "web", "out"), { recursive: true });
  await mkdir(join(root, "packages", "db"), { recursive: true });
  await cp(migrationsDir, join(root, "packages", "db", "migrations"), { recursive: true });
  const dataDir = join(root, "runtime");
  const env = envWith({
    OWL_ROOT: root,
    OWL_DATA_DIR: dataDir,
    OWL_PROVIDER: "stub",
    OWL_BIND: "127.0.0.1",
    OWL_PORT: String(port),
    OWL_TAILSCALE_SERVE: "",
    OWL_SECRET_PASSPHRASE: "",
  });
  const start = execFileSync(process.execPath, [cliPath, "start"], { cwd: repoRoot, env, encoding: "utf8" });
  assert.match(start, /Owl started|\"command\":\"start\"/);
  const state = JSON.parse(await readFile(join(dataDir, "owl-server.json"), "utf8"));
  assert.equal(Number.isInteger(state.pid), true);
  assert.equal(state.port, port);
  const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.equal(health.status, 200);
  const stop = execFileSync(process.execPath, [cliPath, "stop"], { cwd: repoRoot, env, encoding: "utf8" });
  assert.match(stop, /Owl stopped|\"command\":\"stop\"/);
  assert.equal(existsSync(join(dataDir, "owl-server.json")), false);
  assert.equal(existsSync(join(dataDir, "owl-server.pid")), false);
});

test("owl stop also stops a server launched directly outside the owl start command", async (t) => {
  const port = await freePort();
  if (port === null) {
    t.skip("localhost listen is not permitted in this environment");
    return;
  }
  const root = await tempDir(t, "owl-direct-stop-");
  await cp(join(repoRoot, "contracts"), join(root, "contracts"), { recursive: true });
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await cp(join(repoRoot, "apps", "web", "out"), join(root, "apps", "web", "out"), { recursive: true });
  const dataDir = join(root, "runtime");
  const env = envWith({
    OWL_ROOT: root,
    OWL_DATA_DIR: dataDir,
    OWL_CORE_MODE: "standalone",
    OWL_PROVIDER: "stub",
    OWL_BIND: "127.0.0.1",
    OWL_PORT: String(port),
    OWL_TAILSCALE_SERVE: "",
  });
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "dist", "server.js"), "--bind", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitForPath(join(dataDir, "owl-server.json"));
  const state = JSON.parse(await readFile(join(dataDir, "owl-server.json"), "utf8"));
  assert.equal(state.pid, child.pid);
  const client = createConnection({ host: "127.0.0.1", port });
  client.on("error", () => {});
  t.after(() => client.destroy());
  await once(client, "connect");
  client.write("POST /api/v1/health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx");
  await new Promise((resolve) => setTimeout(resolve, 25));
  const exitPromise = once(child, "exit");
  const stop = execFileSync(process.execPath, [cliPath, "stop"], { cwd: repoRoot, env, encoding: "utf8", timeout: 5_000 });
  client.destroy();
  assert.match(stop, /Owl stopped|\"command\":\"stop\"/);
  const [exitCode] = await exitPromise;
  assert.equal(exitCode, 0);
  assert.equal(existsSync(join(dataDir, "owl-server.json")), false);
  assert.equal(existsSync(join(dataDir, "owl-server.pid")), false);
});

// --- single-instance lock and unresponsive-server recovery ---

const IGNORE_SIGNALS = `
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
console.log("ready");
setInterval(() => {}, 1000);
`;

/** A live process that ignores SIGTERM and SIGINT and listens on nothing. */
async function startStubbornProcess(t) {
  const child = spawn(process.execPath, ["-e", IGNORE_SIGNALS], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await once(child.stdout, "data");
  return child;
}

async function standaloneRoot(t, prefix) {
  const root = await tempDir(t, prefix);
  await cp(join(repoRoot, "contracts"), join(root, "contracts"), { recursive: true });
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await cp(join(repoRoot, "apps", "web", "out"), join(root, "apps", "web", "out"), { recursive: true });
  return { root, dataDir: join(root, "runtime") };
}

function standaloneEnv(root, dataDir, port) {
  return envWith({
    OWL_ROOT: root,
    OWL_DATA_DIR: dataDir,
    OWL_CORE_MODE: "standalone",
    OWL_PROVIDER: "stub",
    OWL_BIND: "127.0.0.1",
    OWL_PORT: String(port),
    OWL_TAILSCALE_SERVE: "",
    OWL_SHUTDOWN_TIMEOUT_MS: "1",
  });
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: repoRoot, env, encoding: "utf8", timeout: 60_000 });
}

async function writeServerState(dataDir, pid, port, identity) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "owl-server.pid"), String(pid));
  await writeFile(join(dataDir, "owl-server.json"), JSON.stringify({ pid, bind: "127.0.0.1", port, started_at: new Date().toISOString(), ...identity }));
}

function spawnStandaloneServer(t, root, dataDir, port) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "dist", "server.js"), "--bind", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: standaloneEnv(root, dataDir, port),
    stdio: ["ignore", "ignore", "ignore"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  return child;
}

test("owl status reports a live PID with a closed port, and stop --force kills it with SIGKILL", async (t) => {
  const port = await freePort();
  if (port === null) return t.skip("localhost listen is not permitted in this environment");
  const { root, dataDir } = await standaloneRoot(t, "owl-unresponsive-");
  const env = standaloneEnv(root, dataDir, port);
  const child = await startStubbornProcess(t);
  await writeServerState(dataDir, child.pid, port, readProcessIdentity(child.pid));

  const status = runCli(["status"], env);
  assert.notEqual(status.status, 0);
  assert.match(status.stdout, new RegExp(`unresponsive\\s+${child.pid}`));
  const json = runCli(["status", "--json"], env);
  assert.notEqual(json.status, 0);
  assert.deepEqual(JSON.parse(json.stdout).services, [{ name: "owl-core", state: "unresponsive", pid: child.pid }]);

  const exited = once(child, "exit");
  const stop = runCli(["stop", "--force", "--timeout", "1"], env);
  assert.equal(stop.status, 0, stop.stderr);
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  assert.equal(existsSync(join(dataDir, "owl-server.json")), false);
  assert.equal(existsSync(join(dataDir, "owl-server.pid")), false);
});

test("owl restart escalates to SIGKILL for an unresponsive server and starts a new one", async (t) => {
  const port = await freePort();
  if (port === null) return t.skip("localhost listen is not permitted in this environment");
  const { root, dataDir } = await standaloneRoot(t, "owl-restart-");
  const env = standaloneEnv(root, dataDir, port);
  const child = await startStubbornProcess(t);
  await writeServerState(dataDir, child.pid, port, readProcessIdentity(child.pid));

  const exited = once(child, "exit");
  const restart = runCli(["restart"], env);
  assert.equal(restart.status, 0, restart.stderr);
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  const state = JSON.parse(await readFile(join(dataDir, "owl-server.json"), "utf8"));
  assert.notEqual(state.pid, child.pid);
  t.after(() => {
    try { process.kill(state.pid, "SIGKILL"); } catch { /* already stopped */ }
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status, 200);
});

test("a second server on the same data directory is refused while the first keeps running", async (t) => {
  const first = await freePort();
  const second = await freePort();
  if (first === null || second === null) return t.skip("localhost listen is not permitted in this environment");
  const { root, dataDir } = await standaloneRoot(t, "owl-lock-");
  const one = spawnStandaloneServer(t, root, dataDir, first);
  await waitForPath(join(dataDir, "owl-server.pid"));

  const two = spawnStandaloneServer(t, root, dataDir, second);
  const [exitCode] = await once(two, "exit");
  assert.notEqual(exitCode, 0);
  await waitForPath(join(dataDir, "owl-server.json"));
  assert.equal(one.exitCode, null);
  assert.equal((await fetch(`http://127.0.0.1:${first}/api/v1/health`)).status, 200);
});

test("a server starts again after the previous one was killed with SIGKILL and left its files", async (t) => {
  const first = await freePort();
  const second = await freePort();
  if (first === null || second === null) return t.skip("localhost listen is not permitted in this environment");
  const { root, dataDir } = await standaloneRoot(t, "owl-sigkill-");
  const one = spawnStandaloneServer(t, root, dataDir, first);
  await waitForPath(join(dataDir, "owl-server.json"));
  const killed = once(one, "exit");
  one.kill("SIGKILL");
  await killed;
  assert.equal(existsSync(join(dataDir, "owl-server.pid")), true);
  assert.equal(existsSync(join(dataDir, "owl-server.json")), true);
  assert.equal(existsSync(join(dataDir, "owl-server.lock")), true);

  const two = spawnStandaloneServer(t, root, dataDir, second);
  await waitFor(() => {
    try { return JSON.parse(readFileSync(join(dataDir, "owl-server.json"), "utf8")).pid === two.pid; } catch { return false; }
  }, { timeoutMs: 10_000, intervalMs: 50, message: "second server state" });
  assert.equal((await fetch(`http://127.0.0.1:${second}/api/v1/health`)).status, 200);
});

test("stop --force and restart refuse to signal a PID whose recorded identity does not match", async (t) => {
  const port = await freePort();
  if (port === null) return t.skip("localhost listen is not permitted in this environment");
  const { root, dataDir } = await standaloneRoot(t, "owl-foreign-pid-");
  const env = standaloneEnv(root, dataDir, port);
  const child = await startStubbornProcess(t);
  const identity = readProcessIdentity(child.pid);
  await writeServerState(dataDir, child.pid, port, { ...identity, process_cmdline_sha256: "0".repeat(64) });

  for (const args of [["stop", "--force", "--timeout", "1"], ["restart"]]) {
    const result = runCli(args, env);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  }
  process.kill(child.pid, 0);
});

test("the server lock survives garbage collection of the caller's reference", async (t) => {
  const { dataDir } = await standaloneRoot(t, "owl-lock-gc-");
  await mkdir(dataDir, { recursive: true });
  const script = `
    import { acquireServerLock } from ${JSON.stringify(new URL("../../packages/db/dist/index.js", import.meta.url).href)};
    const path = process.argv[1];
    acquireServerLock(path);
    for (let i = 0; i < 5; i++) global.gc();
    process.stdout.write(acquireServerLock(path) === null ? "held" : "lost");
  `;
  const out = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script, join(dataDir, "gc.lock")], { encoding: "utf8" });
  assert.equal(out, "held");
});

// --- shutdown deadline and timestamped log ---

const DEADLINE_CHILD = `
import { createShutdownDeadline, timedStage } from ${JSON.stringify(pathToFileURL(join(repoRoot, "apps", "server", "dist", "shutdown-deadline.js")).href)};
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
const [mode, pidPath, markerPath, deadlineMs, graceMs] = process.argv.slice(1);
writeFileSync(pidPath, String(process.pid));
const deadline = createShutdownDeadline({
  deadlineMs: Number(deadlineMs),
  graceMs: Number(graceMs),
  run: () => timedStage("hang", () => {
    if (mode === "sync") for (;;) {}
    return new Promise(() => {});
  }),
  forceTerminate: () => appendFileSync(markerPath, "forced\\n"),
  cleanup: () => unlinkSync(pidPath),
  exit: (code) => process.exit(code),
  log: (line) => console.log(line),
});
process.on("SIGTERM", () => deadline.handleSignal("SIGTERM", false));
process.on("SIGINT", () => deadline.handleSignal("SIGINT", true));
setInterval(() => {}, 1000);
console.log("ready");
`;

async function spawnDeadlineChild(t, mode, deadlineMs, graceMs) {
  const dir = await tempDir(t, "owl-deadline-");
  const pidPath = join(dir, "child.pid");
  const markerPath = join(dir, "forced.txt");
  const child = spawn(process.execPath, ["--input-type=module", "-e", DEADLINE_CHILD, mode, pidPath, markerPath, String(deadlineMs), String(graceMs)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("ready"), { timeoutMs: 10_000, intervalMs: 20, message: "child ready" });
  return { child, pidPath, markerPath, output: () => output };
}

test("a shutdown stage that never resolves is cut at the deadline: children are force-terminated and the pid file is removed just before exit", async (t) => {
  const { child, pidPath, markerPath, output } = await spawnDeadlineChild(t, "promise", 400, 4_000);
  const exited = once(child, "close");
  const startedAt = Date.now();
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(existsSync(pidPath), true, "pid file stays during shutdown");
  const [code, signal] = await exited;
  assert.ok(Date.now() - startedAt < 4_000, "exits by the deadline, before the watchdog grace");
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.equal(existsSync(markerPath), true, "forceTerminateProcesses was called");
  assert.equal(existsSync(pidPath), false);
  assert.match(output(), /shutdown stage start: hang/);
  assert.match(output(), /shutdown aborted \(deadline 400ms exceeded\); unfinished stages: hang/);
});

test("a shutdown that blocks the event loop synchronously is killed by the watchdog thread within deadline plus grace", async (t) => {
  const { child } = await spawnDeadlineChild(t, "sync", 300, 500);
  const exited = once(child, "close");
  const startedAt = Date.now();
  child.kill("SIGTERM");
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  assert.ok(Date.now() - startedAt < 5_000);
});

test("SIGINT during a stuck SIGTERM shutdown force-terminates and exits without waiting for the deadline", async (t) => {
  const { child, pidPath, markerPath, output } = await spawnDeadlineChild(t, "promise", 60_000, 60_000);
  const exited = once(child, "close");
  child.kill("SIGTERM");
  await waitFor(() => output().includes("shutdown start"), { timeoutMs: 5_000, intervalMs: 20, message: "shutdown start" });
  assert.equal(existsSync(pidPath), true);
  child.kill("SIGINT");
  const [code] = await exited;
  assert.equal(code, 1);
  assert.equal(existsSync(markerPath), true);
  assert.equal(existsSync(pidPath), false);
  assert.match(output(), /SIGINT received during shutdown/);
});

test("the real server logs every line with a time and each shutdown stage on SIGTERM", async (t) => {
  const port = await freePort();
  if (port === null) return t.skip("localhost listen is not permitted in this environment");
  const { root, dataDir } = await standaloneRoot(t, "owl-shutdown-log-");
  const logPath = join(root, "server-output.log");
  await writeFile(logPath, "");
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "dist", "server.js"), "--bind", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: { ...standaloneEnv(root, dataDir, port), OWL_SHUTDOWN_TIMEOUT_MS: "20000" },
    stdio: ["ignore", fd, fd],
  });
  t.after(() => {
    closeSync(fd);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  // The result line comes after the signal handlers are registered.
  await waitFor(() => readFileSync(logPath, "utf8").includes('"command":"server"'), { timeoutMs: 10_000, intervalMs: 50, message: "server started" });
  const exited = once(child, "close");
  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0);
  const lines = readFileSync(logPath, "utf8").split("\n").filter((line) => line && !line.startsWith("{"));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, line);
  const text = lines.join("\n");
  for (const expected of ["received SIGTERM", "shutdown start", "stage start: core shutdown", "stage done: core shutdown", "stage done: runtime files", "shutdown complete"]) {
    assert.ok(text.includes(expected), expected + "\n" + text);
  }
});
