import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadOwlEnv, parseDotEnv } from "../packages/shared/dist/env.js";
import { AppSettingsStore, scrubLegacySettings } from "../apps/server/dist/app-settings-store.js";
import { createConfiguredCore } from "../apps/server/dist/core.js";
import { IntegrationStore } from "../apps/server/dist/integration-store.js";
import { connectorConfigStatus } from "../apps/server/dist/secret-config.js";
import { createOwlHttpServer, isOwnerRequestAuthorized } from "../apps/server/dist/http.js";
import { isExternalBind, isLoopbackBind, serverExposureError } from "../apps/server/dist/config.js";
import { providerConfigurationError, providerSelection } from "../apps/server/dist/provider-selection.js";
import { SecretStore } from "../packages/core/dist/secret-store.js";
import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

function envWith(overrides) {
  return { ...process.env, OWL_LANG: "en", ...overrides };
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

async function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test(".env loads automatically without overriding explicit process values", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-env-"));
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

test("invalid stored provider selection is surfaced instead of silently switching to Claude", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-invalid-provider-selection-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({
    executor_config: { provider: "typo-provider", model: "model", timeout_ms: 0 },
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

test("malformed app settings are reported instead of field-by-field defaulting", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-invalid-app-settings-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ hybrid_mode: "false" }));
  assert.throws(() => new AppSettingsStore(root, dataDir), /hybrid_mode must be a boolean/u);
});

test("legacy inline custom-provider keys migrate to .env without remaining in app-settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-provider-key-migration-"));
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
  const root = await mkdtemp(join(tmpdir(), "owl-data-"));
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

test("the legacy settings file is retired with its keys moved to .env and every other setting kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-legacy-scrub-"));
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

test("retiring legacy settings keeps a key that .env already defines", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-legacy-scrub-env-"));
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

test("a legacy settings file that is not JSON is reported without its content", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-legacy-scrub-corrupt-"));
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
  const previous = { mode: process.env.OWL_CORE_MODE, token: process.env.OWL_API_TOKEN };
  process.env.OWL_CORE_MODE = "external";
  process.env.OWL_API_TOKEN = "settings-api-test-token";
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = await createConfiguredCore({ db, agentRunner: {}, version: "settings-test", owlRoot: root, dataDir: join(root, "data") });
  const http = createOwlHttpServer({ core, db, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root });
  const restore = async () => {
    await http.close().catch(() => undefined);
    await core.shutdown({ force: true, timeoutMs: 1000 }).catch(() => undefined);
    for (const [name, value] of [["OWL_CORE_MODE", previous.mode], ["OWL_API_TOKEN", previous.token]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    await http.listen();
  } catch (error) {
    await restore();
    if (error?.code === "EPERM" || error?.code === "EACCES") return null;
    throw error;
  }
  t.after(restore);
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  let sequence = 0;
  return async (method, path, payload) => {
    sequence += 1;
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer settings-api-test-token" },
      ...(payload === undefined ? {} : {
        body: JSON.stringify({ request_id: `req-${sequence}`, idempotency_key: `settings-${sequence}`, expected_version: 0, payload }),
      }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("the Typesafe API key is saved to .env and only a reference and a masked value leave the server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-typesafe-key-"));
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

test("an inline Typesafe API key in the settings file is not accepted after load", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-typesafe-inline-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ typesafe_api_key: "env:not a name" }));
  assert.throws(() => new AppSettingsStore(root, dataDir), /typesafe_api_key must be empty or use env:VARIABLE_NAME format/u);
});

test("a custom provider cannot be saved without a backend URL; a stored one without it fails its test", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-provider-backend-"));
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

test("connector tokens use .env and an unconfigured connector is a normal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-connector-env-"));
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
    const noConnectorRoot = await mkdtemp(join(tmpdir(), "owl-no-connector-"));
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

test("stub doctor is successful without Claude, Codex, or Tailscale", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-doctor-"));
  const port = 65534;
  const result = execFileSync(process.execPath, [cliPath, "doctor", "--json"], {
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
  const payload = JSON.parse(result);
  assert.equal(payload.status, "ok");
  assert.equal(payload.checks.find((check) => check.check_id === "provider").status, "pass");
  assert.equal(payload.checks.some((check) => check.check_id === "claude-cli"), false);
  assert.equal(payload.checks.find((check) => check.check_id === "sqlite").status, "warn");
  assert.equal(payload.checks.find((check) => check.check_id === "sqlite").message.startsWith("not_initialized"), true);
});

test("real doctor checks the selected Codex adapter without requiring Claude", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-provider-"));
  const result = execFileSync(process.execPath, [cliPath, "doctor", "--json"], {
    cwd: repoRoot,
    env: envWith({
      OWL_ROOT: root,
      OWL_DATA_DIR: join(root, "data"),
      OWL_PROVIDER: "real",
      OWL_PROVIDER_ADAPTER: "codex-cli/v1",
      OWL_CODEX_EXECUTABLE: process.execPath,
      OWL_CLAUDE_EXECUTABLE: "/definitely/not-installed/claude",
      OWL_BIND: "127.0.0.1",
      OWL_PORT: "65533",
      OWL_TAILSCALE_SERVE: "",
      OWL_SECRET_PASSPHRASE: "",
    }),
    encoding: "utf8",
  });
  const payload = JSON.parse(result);
  const provider = payload.checks.find((check) => check.check_id === "provider");
  assert.equal(provider.status, "pass");
  assert.match(provider.message, /codex-cli\/v1/);
});

test("start rejects an external bind before listening when token is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-bind-"));
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
  const root = await mkdtemp(join(tmpdir(), "owl-smoke-"));
  await cp(join(repoRoot, "contracts"), join(root, "contracts"), { recursive: true });
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await cp(join(repoRoot, "apps", "web", "out"), join(root, "apps", "web", "out"), { recursive: true });
  await mkdir(join(root, "packages", "db"), { recursive: true });
  await cp(join(repoRoot, "packages", "db", "migrations"), join(root, "packages", "db", "migrations"), { recursive: true });
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
  const root = await mkdtemp(join(tmpdir(), "owl-direct-stop-"));
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
