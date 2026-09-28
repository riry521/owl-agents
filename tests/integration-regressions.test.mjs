import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { IntegrationStore } from "../apps/server/dist/integration-store.js";
import { createOwlHttpServer, validateIntegrationPayload } from "../apps/server/dist/http.js";
import { createCore as createServerCore } from "../apps/server/dist/core.js";
import { Core, DecisionService } from "../packages/core/dist/index.js";
import { resolveAdvisorWorkingDirectory } from "../packages/core/dist/advisor-working-directory.js";
import { runExecutor as runCoreExecutor, runExecutorsParallel as runCoreExecutorsParallel } from "../packages/core/dist/executor.js";
import { SecretStore } from "../packages/core/dist/secret-store.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { parseAdvisorResponse as parseSharedAdvisorResponse } from "../packages/shared/dist/index.js";
import {
  createDecisionButtonId,
  parseDecisionButtonId,
  resolveDecisionButtonTarget,
} from "../packages/plugin-sdk/dist/shared/index.js";
import { CoreClient } from "../packages/plugin-sdk/dist/index.js";
import { AdvisorSessionDriver, classifyProviderFailure, createAgentRunner } from "../packages/agent-runtime/dist/index.js";
import {
  SlackConnector as FullSlackConnector,
  isSlackBlockActionsPayload,
  resolveSlackAdvisorChannel,
  sendNotification as sendSlackNotification,
} from "../packages/connector-slack/dist/index.js";
import {
  DiscordConnector as FullDiscordConnector,
  resolveDiscordAdvisorChannel,
  sendNotification as sendDiscordNotification,
} from "../packages/connector-discord/dist/index.js";
import { SlackConnector as StandaloneSlackConnector } from "../apps/connectors/dist/slack-connector.js";
import { DiscordConnector as StandaloneDiscordConnector } from "../apps/connectors/dist/discord-connector.js";
import { createConnectorLifecycle, resolveConnectorAccountId } from "../apps/connectors/dist/cli.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function resetEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function commandEnvelope(payload, suffix) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}`,
    expected_version: 0,
    payload,
  };
}

function coreEvent(sequence, type = "system.alert") {
  return {
    kind: "event",
    event_id: createUlid(),
    sequence,
    cursor: String(sequence),
    type,
    schema_version: "1.0.0",
    payload: { sequence },
  };
}

function requestStub(onRequest) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = (milliseconds, handler) => {
      request.timeoutMs = milliseconds;
      request.timeoutHandler = handler;
    };
    request.write = (body) => {
      request.body = `${request.body ?? ""}${body}`;
    };
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    request.end = () => {
      try {
        const result = onRequest(url, options, request);
        queueMicrotask(() => {
          const res = new EventEmitter();
          res.statusCode = result.status ?? 200;
          res.destroy = () => {};
          callback(res);
          res.emit("data", Buffer.from(JSON.stringify(result.body)));
          res.emit("end");
        });
      } catch (error) {
        queueMicrotask(() => request.emit("error", error));
      }
    };
    return request;
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("CoreClient baselines first polling history and selects HTTP or HTTPS by URL", async () => {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const pages = [
    { body: { data: { events: [coreEvent(1)], cursor: "1", has_more: true } } },
    { body: { data: { events: [coreEvent(2)], cursor: "2", has_more: false } } },
    { body: { data: { events: [coreEvent(3)], cursor: "3", has_more: false } } },
  ];
  let pollTick;
  const httpCalls = [];
  const httpsCalls = [];

  http.request = requestStub((url, options, request) => {
    const page = pages.shift();
    httpCalls.push({ url: String(url), options, request });
    assert.ok(page, `unexpected HTTP request: ${String(url)}`);
    return page;
  });
  https.request = requestStub((url, options, request) => {
    httpsCalls.push({ url: String(url), options, request });
    return { body: { data: { secure: true } } };
  });
  globalThis.setInterval = (callback) => {
    pollTick = callback;
    return { unref() {} };
  };
  globalThis.clearInterval = () => {};

  try {
    const client = new CoreClient({ core_api_base: "http://core.example/api/v1", plugin_name: "regression" });
    const received = [];
    await client.subscribeEvents([], (event) => received.push(event));
    await flushMicrotasks();
    assert.deepEqual(received, []);
    assert.deepEqual(httpCalls.map((call) => new URL(call.url).searchParams.get("after")), ["0", "1"]);

    await pollTick();
    assert.deepEqual(received.map((event) => event.sequence), [3]);
    assert.equal(new URL(httpCalls.at(-1).url).searchParams.get("after"), "2");
    assert.equal(httpCalls[0].request.timeoutMs, 30_000);
    client.close();

    const secureClient = new CoreClient({
      core_api_base: "https://core.example/api/v1",
      plugin_name: "regression",
      api_token: "token-must-not-be-logged",
    });
    const secureResult = await secureClient.request("/secure", {
      method: "POST",
      body: { payload: "value" },
      headers: { "X-Regression": "yes" },
    });
    assert.deepEqual(secureResult, { secure: true });
    assert.equal(httpsCalls.length, 1);
    assert.equal(httpsCalls[0].options.headers.Authorization, "Bearer token-must-not-be-logged");
    assert.equal(httpsCalls[0].options.headers["X-Regression"], "yes");
    assert.equal(httpsCalls[0].options.headers["Content-Type"], "application/json");
    assert.equal(httpsCalls[0].request.body, JSON.stringify({ payload: "value" }));
    assert.equal(httpsCalls[0].request.timeoutMs, 30_000);
  } finally {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("CoreClient requestPage preserves pagination metadata while request keeps its unwrap contract", async () => {
  const originalHttpRequest = http.request;
  const calls = [];
  http.request = requestStub((url) => {
    calls.push(String(url));
    if (new URL(url).pathname.endsWith("/decisions")) {
      return { body: { request_id: "request-page", data: [{ id: "decision-1" }], cursor: "50", has_more: true } };
    }
    return { body: { request_id: "request-plain", data: [{ id: "decision-2" }] } };
  });

  try {
    const client = new CoreClient({ core_api_base: "http://core.example/api/v1", plugin_name: "regression" });
    assert.deepEqual(
      await client.requestPage("/decisions?status=open&limit=50"),
      { data: [{ id: "decision-1" }], cursor: "50", has_more: true },
    );
    assert.deepEqual(await client.request("/plain"), [{ id: "decision-2" }]);
    assert.deepEqual(calls, [
      "http://core.example/api/v1/decisions?status=open&limit=50",
      "http://core.example/api/v1/plain",
    ]);
  } finally {
    http.request = originalHttpRequest;
  }
});

test("integration channel precedence preserves split settings and migrates legacy channels", async () => {
  const envKeys = [
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_SIGNING_SECRET",
    "SLACK_CHANNEL_ID",
    "SLACK_CONVERSATION_CHANNEL_ID",
    "SLACK_NOTIFICATION_CHANNEL_ID",
    "DISCORD_BOT_TOKEN",
    "DISCORD_CHANNEL_ID",
    "DISCORD_CONVERSATION_CHANNEL_ID",
    "DISCORD_NOTIFICATION_CHANNEL_ID",
    "OWL_SECRET_PASSPHRASE",
  ];
  const previous = restoreEnvironment(envKeys);
  for (const key of envKeys) delete process.env[key];

  try {
    const root = await mkdtemp(join(tmpdir(), "owl-precedence-"));
    const dataDir = join(root, "data");
    process.env.SLACK_BOT_TOKEN = "xoxb-precedence-test";
    process.env.SLACK_APP_TOKEN = "xapp-precedence-test";
    const initial = new IntegrationStore(root, dataDir);
    initial.save_integration("slack", {
      bot_token: process.env.SLACK_BOT_TOKEN,
      app_token: process.env.SLACK_APP_TOKEN,
      conversation_channel_id: "C-PERSISTED-CONVERSATION",
      notification_channel_id: "C-PERSISTED-NOTIFICATION",
    });

    let reloaded = new IntegrationStore(root, dataDir);
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-PERSISTED-CONVERSATION");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-PERSISTED-NOTIFICATION");

    process.env.SLACK_CONVERSATION_CHANNEL_ID = "C-ENV-CONVERSATION";
    reloaded = new IntegrationStore(root, dataDir);
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-ENV-CONVERSATION");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-ENV-CONVERSATION");
    const metadataAfterRoleOverride = JSON.parse(await readFile(join(dataDir, "integrations-meta.json"), "utf8"));
    assert.equal(metadataAfterRoleOverride[0].conversation_channel_id, "C-PERSISTED-CONVERSATION");
    assert.equal(metadataAfterRoleOverride[0].notification_channel_id, "C-PERSISTED-NOTIFICATION");
    reloaded.save_integration("slack", { account_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-ENV-CONVERSATION");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-ENV-CONVERSATION");
    const metadataAfterPartialSaveDuringOverride = JSON.parse(await readFile(join(dataDir, "integrations-meta.json"), "utf8"));
    assert.equal(metadataAfterPartialSaveDuringOverride[0].conversation_channel_id, "C-PERSISTED-CONVERSATION");
    assert.equal(metadataAfterPartialSaveDuringOverride[0].notification_channel_id, "C-PERSISTED-NOTIFICATION");

    delete process.env.SLACK_CONVERSATION_CHANNEL_ID;
    process.env.SLACK_CHANNEL_ID = "C-LEGACY";
    process.env.SLACK_NOTIFICATION_CHANNEL_ID = "C-ROLE-NOTIFICATION";
    reloaded = new IntegrationStore(root, dataDir);
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-LEGACY");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-ROLE-NOTIFICATION");

    process.env.SLACK_CONVERSATION_CHANNEL_ID = "C-ROLE-CONVERSATION";
    reloaded = new IntegrationStore(root, dataDir);
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-ROLE-CONVERSATION");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-ROLE-NOTIFICATION");

    delete process.env.SLACK_CONVERSATION_CHANNEL_ID;
    delete process.env.SLACK_CHANNEL_ID;
    process.env.SLACK_NOTIFICATION_CHANNEL_ID = "C-ROLE-NOTIFICATION-ONLY";
    reloaded = new IntegrationStore(root, dataDir);
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-ROLE-NOTIFICATION-ONLY");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-ROLE-NOTIFICATION-ONLY");

    delete process.env.SLACK_NOTIFICATION_CHANNEL_ID;
    process.env.SLACK_CHANNEL_ID = "C-LEGACY-ONLY";
    reloaded = new IntegrationStore(root, dataDir);
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-LEGACY-ONLY");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-LEGACY-ONLY");
    assert.equal(reloaded.getConfig("slack")?.channel_id, "C-LEGACY-ONLY");

    delete process.env.SLACK_CHANNEL_ID;
    reloaded = new IntegrationStore(root, dataDir);
    reloaded.save_integration("slack", { conversation_channel_id: "C-UPDATED-CONVERSATION" });
    assert.equal(reloaded.getConfig("slack")?.conversation_channel_id, "C-UPDATED-CONVERSATION");
    assert.equal(reloaded.getConfig("slack")?.notification_channel_id, "C-PERSISTED-NOTIFICATION");
    assert.equal(reloaded.getConfig("slack")?.bot_token, "xoxb-precedence-test");

    const envOnlyRoot = await mkdtemp(join(tmpdir(), "owl-env-channel-only-"));
    process.env.SLACK_CONVERSATION_CHANNEL_ID = "C-ENV-ONLY";
    const envOnlyStore = new IntegrationStore(envOnlyRoot, join(envOnlyRoot, "data"));
    assert.equal(envOnlyStore.getConfig("slack")?.conversation_channel_id, "C-ENV-ONLY");
    assert.equal(envOnlyStore.getConfig("slack")?.notification_channel_id, "C-ENV-ONLY");
    const envOnlyMeta = JSON.parse(await readFile(join(envOnlyRoot, "data", "integrations-meta.json"), "utf8"));
    assert.equal(envOnlyMeta[0].has_conversation_channel_id, false);
    assert.equal(envOnlyMeta[0].has_notification_channel_id, false);
    delete process.env.SLACK_CONVERSATION_CHANNEL_ID;

    const discordRoot = await mkdtemp(join(tmpdir(), "owl-legacy-channel-"));
    const discordStore = new IntegrationStore(discordRoot, join(discordRoot, "data"));
    const discordStatus = discordStore.save_integration("discord", {
      bot_token: "discord-test-token",
      conversation_channel_id: "D-CONVERSATION-ONLY",
    });
    assert.equal(discordStatus.conversation_channel_id, "D-CONVERSATION-ONLY");
    assert.equal(discordStatus.notification_channel_id, "D-CONVERSATION-ONLY");

    const legacyRoot = await mkdtemp(join(tmpdir(), "owl-legacy-migration-"));
    const legacyData = join(legacyRoot, "data");
    const legacyPassphrase = "legacy-test-passphrase";
    const legacyVault = new SecretStore(legacyData);
    legacyVault.set("integration:slack", JSON.stringify({
      bot_token: "xoxb-migrated-test",
      app_token: "xapp-migrated-test",
      channel_id: "C-MIGRATED-LEGACY",
    }), legacyPassphrase);
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_CHANNEL_ID;
    process.env.OWL_SECRET_PASSPHRASE = legacyPassphrase;
    const migrated = new IntegrationStore(legacyRoot, legacyData);
    assert.equal(migrated.getConfig("slack")?.conversation_channel_id, "C-MIGRATED-LEGACY");
    assert.equal(migrated.getConfig("slack")?.notification_channel_id, "C-MIGRATED-LEGACY");
    assert.equal(migrated.getConfig("slack")?.channel_id, "C-MIGRATED-LEGACY");
  } finally {
    resetEnvironment(previous);
  }
});

test("integration HTTP validation returns client errors and accepts secret-omitting partial updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-integration-api-"));
  const previousToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "integration-api-test-token";
  let configured = false;
  const saves = [];
  const core = {
    ready: true,
    getIntegrations: async () => [{
      provider: "slack",
      configured,
      conversation_channel_id: configured ? "C-CONVERSATION" : null,
      notification_channel_id: configured ? "C-NOTIFICATION" : null,
      last_tested_at: null,
      last_test_ok: null,
    }],
    saveIntegration: async (provider, config) => {
      saves.push({ provider, config });
      return {
        data: {
          provider,
          configured: true,
          conversation_channel_id: config.conversation_channel_id ?? "C-CONVERSATION",
          notification_channel_id: config.notification_channel_id ?? "C-NOTIFICATION",
          last_tested_at: null,
          last_test_ok: null,
        },
        version: 0,
      };
    },
  };
  const http = createOwlHttpServer({
    core,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  let listening = false;

  try {
    try {
      await http.listen();
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("この実行環境ではlocalhost listenが禁止されています");
        return;
      }
      throw error;
    }
    listening = true;
    const address = http.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer integration-api-test-token",
    };

    const invalid = await fetch(`http://127.0.0.1:${port}/api/v1/settings/integrations/slack`, {
      method: "PUT",
      headers,
      body: JSON.stringify(commandEnvelope({ bot_token: "xoxb-incomplete" }, "invalid")),
    });
    assert.equal(invalid.status, 400);
    assert.equal(saves.length, 0);

    configured = true;
    const partial = await fetch(`http://127.0.0.1:${port}/api/v1/settings/integrations/slack`, {
      method: "PUT",
      headers,
      body: JSON.stringify(commandEnvelope({ conversation_channel_id: "C-UPDATED" }, "partial")),
    });
    assert.equal(partial.status, 200);
    assert.deepEqual(saves[0], {
      provider: "slack",
      config: { conversation_channel_id: "C-UPDATED" },
    });

    const ownerIdPayload = await fetch(`http://127.0.0.1:${port}/api/v1/settings/integrations/slack`, {
      method: "PUT",
      headers,
      body: JSON.stringify(commandEnvelope({ owner_user_ids: ["must-not-be-supported"] }, "owner-id")),
    });
    assert.equal(ownerIdPayload.status, 400);
  } finally {
    if (listening) await http.close();
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
  }
});

test("integration payload validator covers new-config completeness and configured partial updates", () => {
  assert.throws(
    () => validateIntegrationPayload({ bot_token: "xoxb-incomplete" }, "slack", false),
    (error) => error?.status === 400 && error?.code === "validation_error",
  );
  assert.deepEqual(
    validateIntegrationPayload({ conversation_channel_id: " C-UPDATED " }, "slack", true),
    { conversation_channel_id: "C-UPDATED" },
  );
  assert.throws(
    () => validateIntegrationPayload({ owner_user_ids: ["unsupported"] }, "discord", true),
    (error) => error?.status === 400 && error?.code === "validation_error",
  );
});

test("integration connection tests validate Slack Socket Mode and both channels, plus Discord send access", async () => {
  const envKeys = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "DISCORD_BOT_TOKEN"];
  const previous = restoreEnvironment(envKeys);
  for (const key of envKeys) delete process.env[key];

  try {
    const slackCalls = [];
    const slackFetch = async (input, init = {}) => {
      const url = String(input);
      slackCalls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body, signal: init.signal });
      if (url.endsWith("/auth.test")) return response({ ok: true, team: "test-team" });
      if (url.endsWith("/apps.connections.open")) return response({ ok: true, url: "wss://socket-mode.example" });
      if (url.includes("/conversations.info?")) {
        const channel = new URL(url).searchParams.get("channel");
        return response({ ok: true, channel: { id: channel, is_archived: false, is_member: true } });
      }
      if (url.endsWith("/chat.postMessage")) return response({ ok: true, ts: "123.456" });
      return response({ ok: false, error: "unexpected_test_url" }, 404);
    };
    const slackRoot = await mkdtemp(join(tmpdir(), "owl-slack-test-"));
    const slackStore = new IntegrationStore(slackRoot, join(slackRoot, "data"), { fetch: slackFetch });
    slackStore.save_integration("slack", {
      bot_token: "xoxb-no-log-test",
      app_token: "xapp-no-log-test",
      conversation_channel_id: "C-SLACK-CONVERSATION",
      notification_channel_id: "C-SLACK-NOTIFICATION",
    });
    const slackResult = await slackStore.test("slack");
    assert.equal(slackResult.ok, true);
    assert.match(slackResult.detail, /Socket Mode/iu);
    assert.equal(slackCalls.filter((call) => call.url.endsWith("/auth.test")).length, 1);
    assert.equal(slackCalls.filter((call) => call.url.endsWith("/apps.connections.open")).length, 1);
    assert.equal(slackCalls.filter((call) => call.url.includes("/conversations.info?")).length, 2);
    assert.equal(slackCalls.filter((call) => call.url.endsWith("/chat.postMessage")).length, 2);
    assert.ok(slackCalls.every((call) => call.signal instanceof AbortSignal));
    assert.equal(slackStore.list().find((item) => item.provider === "slack")?.configured, true);

    const discordCalls = [];
    const discordFetch = async (input, init = {}) => {
      const url = String(input);
      discordCalls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body, signal: init.signal });
      if (url.endsWith("/users/@me")) return response({ id: "bot-id", username: "owl-test" });
      if (url.endsWith("/messages")) return response({ id: "message-id" });
      const channelId = url.split("/").pop();
      return response({ id: channelId, type: 0 });
    };
    const discordRoot = await mkdtemp(join(tmpdir(), "owl-discord-test-"));
    const discordStore = new IntegrationStore(discordRoot, join(discordRoot, "data"), { fetch: discordFetch });
    discordStore.save_integration("discord", {
      bot_token: "discord-no-log-test",
      conversation_channel_id: "D-DISCORD-CONVERSATION",
      notification_channel_id: "D-DISCORD-NOTIFICATION",
    });
    const discordResult = await discordStore.test("discord");
    assert.equal(discordResult.ok, true);
    assert.equal(discordCalls.filter((call) => call.url.endsWith("/users/@me")).length, 1);
    assert.equal(discordCalls.filter((call) => call.method === "GET" && call.url.includes("/channels/")).length, 2);
    assert.equal(discordCalls.filter((call) => call.method === "POST" && call.url.endsWith("/messages")).length, 2);
    assert.ok(discordCalls.every((call) => call.signal instanceof AbortSignal));
  } finally {
    resetEnvironment(previous);
  }
});

test("integration connection test timeouts become safe failed results", async () => {
  const previous = restoreEnvironment(["DISCORD_BOT_TOKEN", "DISCORD_CONVERSATION_CHANNEL_ID", "DISCORD_NOTIFICATION_CHANNEL_ID"]);
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_CONVERSATION_CHANNEL_ID;
  delete process.env.DISCORD_NOTIFICATION_CHANNEL_ID;
  let observedSignal;
  const hangingFetch = async (_input, init = {}) => new Promise((_resolve, reject) => {
    observedSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
  });
  try {
    const root = await mkdtemp(join(tmpdir(), "owl-integration-timeout-"));
    const store = new IntegrationStore(root, join(root, "data"), { fetch: hangingFetch, requestTimeoutMs: 10 });
    store.save_integration("discord", {
      bot_token: "discord-timeout-secret",
      conversation_channel_id: "D-TIMEOUT",
    });

    const result = await store.test("discord");
    assert.equal(result.ok, false);
    assert.ok(observedSignal instanceof AbortSignal);
    assert.doesNotMatch(result.detail, /discord-timeout-secret/iu);
  } finally {
    resetEnvironment(previous);
  }
});

test("Advisor action fences are parsed out and malformed fences preserve the reply text", () => {
  const valid = parseSharedAdvisorResponse([
    "調べた結果です。",
    "```owl-actions",
    JSON.stringify([{ type: "work", description: "修正をWorkに登録する" }]),
    "```",
    "続けて確認できます。",
  ].join("\n"));
  assert.deepEqual(valid, {
    reply: "調べた結果です。\n\n続けて確認できます。",
    suggested_actions: [{ type: "work", description: "修正をWorkに登録する" }],
  });

  const warnings = [];
  const malformed = parseSharedAdvisorResponse(
    "本文はここです。\n```owl-actions\n[broken JSON without a closing fence",
    (reason) => warnings.push(reason),
  );
  assert.deepEqual(malformed, { reply: "本文はここです。", suggested_actions: [] });
  assert.deepEqual(warnings, ["unclosed_fence"]);
});

test("persistent Advisor actions create and start a Work through Core", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-actions-runtime-"));
  const projectRoot = join(root, "registered-project");
  await mkdir(projectRoot, { recursive: true });
  const projectGit = (...args) => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  projectGit("init", "--initial-branch=main");
  await writeFile(join(projectRoot, "README.md"), "Advisor worktree fixture\n");
  projectGit("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "README.md");
  projectGit("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const now = new Date().toISOString();
  const ownerId = "owner:advisor-actions";
  const conversationId = "conversation:advisor-actions";
  const slackAccountId = "account:advisor-actions-slack";
  const webAccountId = "account:advisor-actions-web";
  const sourceMessageId = "source:advisor-actions";
  const responseText = [
    "設定を確認しました。",
    "```owl-actions",
    JSON.stringify([{
      type: "create_work",
      description: "依存関係の修正をWorkに登録して着手する",
      payload: {
        title: "依存関係の修正",
        summary: "依存関係を確認し、必要な修正を行う。既存のテストを実行して結果を報告する。",
        size: "small",
        project_id: null,
      },
    }]),
    "```",
  ].join("\n");
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", ownerId, "Owner", now, now);
    transaction.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, '[]', '[]', ?, ?)`,
      "project:advisor-actions",
      ownerId,
      "Advisor project",
      projectRoot,
      JSON.stringify([root]),
      now,
      now,
    );
    transaction.run(
      `INSERT INTO works
         (id, owner_id, project_id, title, summary, size, state, state_version, plan_revision,
          rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'small', 'ready', 0, 0, '{"schema_version":"1.0.0","rules":[]}', '[]', ?, ?)`,
      "work:advisor-actions",
      ownerId,
      "project:advisor-actions",
      "Advisor cwd test",
      now,
      now,
    );
    transaction.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'slack', ?, ?)", slackAccountId, ownerId, "slack-advisor-actions", now);
    transaction.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", webAccountId, ownerId, "web-advisor-actions", now);
    transaction.run("INSERT INTO conversations (id, owner_id, work_id, channel, thread_ref, dm_ref, is_active, created_at, updated_at) VALUES (?, ?, ?, 'slack', ?, ?, 1, ?, ?)", conversationId, ownerId, "work:advisor-actions", "1712345678.000100", "C-ADVISOR-ACTIONS", now, now);
    transaction.run("INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at) VALUES (?, ?, 'slack', ?, ?, ?, '[]', ?, ?)", "message:advisor-actions-user", conversationId, slackAccountId, sourceMessageId, "設定を調べて", now, now);
  });

  let sentTurnId = null;
  let sentTurnText = null;
  let sessionRequest = null;
  let workerRequest = null;
  let coreStarted = false;
  const providerClient = {
    createSession: async (request) => {
      sessionRequest = request;
      return {
        provider_session_id: "advisor-actions-provider-session",
        pid: process.pid,
        send: async (turn) => {
          sentTurnId = turn.turn_id;
          sentTurnText = typeof turn?.text === "string" ? turn.text : JSON.stringify(turn);
          await writeFile(join(sessionRequest.cwd, "advisor-change.txt"), "kept in the Advisor worktree\n");
        },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "session.ready", provider_session_id: "advisor-actions-provider-session", pid: process.pid };
            assert.ok(sentTurnId, "the provider should receive the turn before events are consumed");
            yield { type: "turn.completed", turn_id: sentTurnId, reply: responseText, usage: null };
          },
        }),
        stop: async () => {},
      };
    },
  };
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("small Advisor-created Work should skip Manager planning"); },
    runWorker: async (request) => {
      workerRequest = request;
      return {
        outcome: "failed",
        failure_class: "transient",
        error_key: "test_advisor_action_dispatch",
        retry_allowed: false,
        message: "Test stops after verifying Work dispatch.",
      };
    },
    runReviewer: async () => { throw new Error("Reviewer should not run in this dispatch test."); },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, providerClient, dispatcher: { tick_interval_ms: 25 } });
  try {
    await core.start();
    coreStarted = true;
    await core.advisorRespond(conversationId, "message:advisor-actions-user", {
      channel: "slack",
      channel_id: "C-ADVISOR-ACTIONS",
      ref: "1712345678.000100",
    });
    assert.equal(sessionRequest.cwd, realpathSync(join(root, ".owl-workspaces", "advisor", "conversation_advisor-actions")));
    assert.match(sessionRequest.system_prompt, /must become an Owl Work that you dispatch/u);
    assert.match(sessionRequest.system_prompt, /every concrete request to perform work.*regardless of size/u);
    assert.match(sessionRequest.system_prompt, /'これやっといて' is a normal Work request/u);
    assert.match(sessionRequest.system_prompt, /Only bypass Work when the operator explicitly asks you to do the work directly/u);
    assert.match(sessionRequest.system_prompt, /For that explicit exception, do the work in your Advisor workspace and do not create a Work/u);
    assert.match(sessionRequest.system_prompt, /Before returning create_work, compare the full request and conversation context against the complete current Project catalog/u);
    assert.equal(execFileSync("git", ["-C", sessionRequest.cwd, "branch", "--show-current"], { encoding: "utf8" }).trim(), "owl/advisor/conversation_advisor-actions");
    assert.equal(await readFile(join(sessionRequest.cwd, "README.md"), "utf8"), "Advisor worktree fixture\n");

    const deadline = Date.now() + 5_000;
    let reply = undefined;
    while (Date.now() < deadline && (!reply || !workerRequest)) {
      reply = db.get("SELECT body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%' ORDER BY created_at DESC LIMIT 1", conversationId);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(reply, "the Advisor response should be persisted");
    assert.ok(workerRequest, "the Advisor-created small Work should be sent to the Worker");
    assert.match(sentTurnText, /always search this complete, current Project catalog/u);
    assert.match(sentTurnText, /project:advisor-actions/u);
    assert.match(sentTurnText, /registered-project/u);
    assert.match(sentTurnText, /Use null only after checking every entry/u);
    assert.match(reply.body, /^設定を確認しました。/u);
    assert.match(reply.body, /未コミット、またはベースブランチ未統合の変更があります/u);
    assert.ok(reply.body.includes(sessionRequest.cwd));
    assert.match(reply.body, /Work「依存関係の修正」を起票し、Workerへ渡しました（ID: [0-9A-HJKMNP-TV-Z]{26}）。/u);
    assert.doesNotMatch(reply.body, /```owl-actions/u);
    assert.equal(workerRequest.context.task.title, "依存関係の修正");
    assert.match(workerRequest.context.task.acceptance, /既存のテストを実行/u);
    const createdWork = db.get("SELECT id, project_id, size, state FROM works WHERE title = ? ORDER BY created_at DESC LIMIT 1", "依存関係の修正");
    assert.ok(createdWork, "Core should persist the Work");
    assert.equal(createdWork.project_id, "project:advisor-actions", "a linked project should be inherited when the action leaves it unset");
    assert.equal(createdWork.size, "small");
    assert.notEqual(createdWork.state, "memo", "Core should start the Work automatically");
    assert.equal(await readFile(join(sessionRequest.cwd, "advisor-change.txt"), "utf8"), "kept in the Advisor worktree\n");
    assert.equal(projectGit("status", "--porcelain=v1"), "", "the user's registered checkout remains unchanged");
    const reusedWorkspace = await core.gitGateway().prepareAdvisorWorkspace({ conversation_id: conversationId });
    assert.equal(reusedWorkspace.ok, true);
    assert.equal(reusedWorkspace.worktree_path, sessionRequest.cwd);
    assert.equal(await readFile(join(sessionRequest.cwd, "advisor-change.txt"), "utf8"), "kept in the Advisor worktree\n");
    await core.restartAdvisorSession(ownerId);
    assert.equal(await readFile(join(sessionRequest.cwd, "advisor-change.txt"), "utf8"), "kept in the Advisor worktree\n");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%'", conversationId).count, 1);

    const event = core.listEventsAfter(null, 100).find((candidate) => candidate.type === "advisor.responded");
    assert.deepEqual(event?.payload.suggested_actions, []);
  } finally {
    if (coreStarted) await core.stop({ force: true });
    db.close();
  }
});

test("Advisor base-directory resolver uses the Owl root when no Project is linked", () => {
  assert.equal(
    resolveAdvisorWorkingDirectory({ get: () => undefined }, repoRoot, "conversation-without-project"),
    resolve(repoRoot),
  );
});

test("Slack Advisor responses are posted as regular channel messages on a fresh connector instance", async () => {
  const event = {
    kind: "event",
    event_id: createUlid(),
    sequence: 1,
    cursor: "1",
    type: "advisor.responded",
    schema_version: "1.0.0",
    payload: {
      conversation_id: "slack:C-CONVERSATION:thread",
      message_id: createUlid(),
      reply: "返信を受け取りました。",
      suggested_actions: [{ type: "work", description: "この変更をWorkに登録する" }],
      origin: { channel: "slack", channel_id: "C-CONVERSATION", ref: "1712345678.000100" },
    },
  };
  assert.equal(resolveSlackAdvisorChannel(event, "C-CONVERSATION", new Map()), "C-CONVERSATION");

  const connector = new FullSlackConnector({
    botToken: "xoxb-fresh-connector-test",
    appToken: "xapp-fresh-connector-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATION",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const posts = [];
  connector.web = { chat: { postMessage: async (message) => posts.push(message) } };
  await connector.handleCoreEvent(event);
  assert.deepEqual(posts, [{
    channel: "C-CONVERSATION",
    // A reply posts back into the thread it came from (origin.ref).
    thread_ts: "1712345678.000100",
    text: "返信を受け取りました。\n\n次のアクション案:\n• work: この変更をWorkに登録する",
  }]);
  assert.doesNotMatch(posts[0].text, /```owl-actions/u);

  const noThreadEvent = {
    ...event,
    payload: {
      ...event.payload,
      origin: { channel: "slack", channel_id: "C-CONVERSATION" },
    },
  };
  assert.equal(resolveSlackAdvisorChannel(noThreadEvent, "C-CONVERSATION"), "C-CONVERSATION");
  await connector.handleCoreEvent(noThreadEvent);
  assert.equal(posts[1].channel, "C-CONVERSATION");
  assert.equal(posts[1].text, "返信を受け取りました。\n\n次のアクション案:\n• work: この変更をWorkに登録する");
  assert.equal(Object.hasOwn(posts[1], "thread_ts"), false);
});

test("Discord Advisor responses are posted as regular channel messages", async () => {
  const connector = new FullDiscordConnector({
    botToken: "discord-native-message-test",
    conversationChannelId: "D-CONVERSATION",
    notificationChannelId: "D-NOTIFICATION",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const sent = [];
  connector.client.channels.fetch = async (channelId) => ({
    id: channelId,
    isTextBased: () => true,
    send: async (message) => sent.push(message),
  });
  await connector.handleCoreEvent({
    kind: "event",
    event_id: createUlid(),
    sequence: 1,
    cursor: "1",
    type: "advisor.responded",
    schema_version: "1.0.0",
    payload: {
      conversation_id: "discord:D-CONVERSATION",
      message_id: createUlid(),
      reply: "返信を受け取りました。",
      origin: { channel: "discord", channel_id: "D-CONVERSATION", ref: "source-message-id" },
    },
  });
  assert.deepEqual(sent, [{ content: "返信を受け取りました。" }]);
});

test("Discord Advisor responses render suggested_actions, matching Slack", async () => {
  const connector = new FullDiscordConnector({
    botToken: "discord-suggested-actions-test",
    conversationChannelId: "D-CONVERSATION",
    notificationChannelId: "D-NOTIFICATION",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const sent = [];
  connector.client.channels.fetch = async (channelId) => ({
    id: channelId,
    isTextBased: () => true,
    send: async (message) => sent.push(message),
  });
  await connector.handleCoreEvent({
    kind: "event",
    event_id: createUlid(),
    sequence: 1,
    cursor: "1",
    type: "advisor.responded",
    schema_version: "1.0.0",
    payload: {
      conversation_id: "discord:D-CONVERSATION",
      message_id: createUlid(),
      reply: "返信を受け取りました。",
      suggested_actions: [{ type: "work", description: "この変更をWorkに登録する" }],
      origin: { channel: "discord", channel_id: "D-CONVERSATION", ref: "source-message-id" },
    },
  });
  assert.deepEqual(sent, [{
    content: "返信を受け取りました。\n\n次のアクション案:\n• work: この変更をWorkに登録する",
  }]);
});

test("integration channel lists reach every configured conversation and notification channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-multi-channel-"));
  const store = new IntegrationStore(root, join(root, "data"));
  const status = store.save_integration("slack", {
    bot_token: "xoxb-multi-channel-test",
    app_token: "xapp-multi-channel-test",
    conversation_channel_id: " C-SLACK-CONVERSATION-1, C-SLACK-CONVERSATION-2\nC-SLACK-CONVERSATION-1 ",
    notification_channel_id: "C-SLACK-NOTIFICATION-1\nC-SLACK-NOTIFICATION-2",
  });
  assert.equal(status.conversation_channel_id, "C-SLACK-CONVERSATION-1,C-SLACK-CONVERSATION-2");
  assert.equal(status.notification_channel_id, "C-SLACK-NOTIFICATION-1,C-SLACK-NOTIFICATION-2");
  assert.equal(
    store.getConfig("slack")?.conversation_channel_id,
    "C-SLACK-CONVERSATION-1,C-SLACK-CONVERSATION-2",
  );

  const event = {
    kind: "event",
    event_id: createUlid(),
    sequence: 1,
    cursor: "1",
    type: "work.completed",
    schema_version: "1.0.0",
    payload: { title: "複数チャンネルテスト" },
  };
  const slackPosts = [];
  await sendSlackNotification(
    { chat: { postMessage: async (message) => slackPosts.push(message) } },
    event,
    [{ channelId: "C-SLACK-NOTIFICATION-1" }, { channelId: "C-SLACK-NOTIFICATION-2" }],
  );
  assert.deepEqual(slackPosts.map((message) => message.channel), [
    "C-SLACK-NOTIFICATION-1",
    "C-SLACK-NOTIFICATION-2",
  ]);

  const discordPosts = [];
  const discordClient = {
    channels: {
      fetch: async (channelId) => ({
        isTextBased: () => true,
        send: async (message) => discordPosts.push({ channelId, message }),
      }),
    },
  };
  await sendDiscordNotification(discordClient, event, "D-NOTIFICATION-1, D-NOTIFICATION-2\nD-NOTIFICATION-1");
  assert.deepEqual(discordPosts.map((post) => post.channelId), ["D-NOTIFICATION-1", "D-NOTIFICATION-2"]);

  const slackAdvisorEvent = {
    ...event,
    type: "advisor.responded",
    payload: {
      origin: { channel: "slack", channel_id: "C-SLACK-CONVERSATION-2", ref: "1712345678.000200" },
      reply: "返信",
    },
  };
  const discordAdvisorEvent = {
    ...event,
    type: "advisor.responded",
    payload: {
      origin: { channel: "discord", channel_id: "D-CONVERSATION-2" },
      reply: "返信",
    },
  };
  assert.equal(resolveSlackAdvisorChannel(slackAdvisorEvent, ["C-SLACK-CONVERSATION-1", "C-SLACK-CONVERSATION-2"]), "C-SLACK-CONVERSATION-2");
  assert.equal(resolveSlackAdvisorChannel(slackAdvisorEvent, "C-SLACK-CONVERSATION-1"), null);
  assert.equal(resolveDiscordAdvisorChannel(discordAdvisorEvent, "D-CONVERSATION-1,D-CONVERSATION-2"), "D-CONVERSATION-2");
  assert.equal(resolveDiscordAdvisorChannel(discordAdvisorEvent, ["D-CONVERSATION-1"]), null);
});

test("Claude Advisor session sends the first turn before the stream init frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-driver-"));
  const executable = join(root, "fake-claude");
  await writeFile(executable, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (!buffer.includes("\\n")) return;
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
  buffer = "";
});
`, "utf8");
  await chmod(executable, 0o755);

  const driver = await AdvisorSessionDriver.create({
    adapter: "claude",
    role: "advisor",
    model: "claude-opus-5",
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    system_prompt: "test",
  }, executable);
  assert.equal(driver.provider_session_id, "");
  await driver.send({ turn_id: "turn-1", text: "hello" });

  const events = [];
  for await (const event of driver.events()) {
    events.push(event);
    if (event.type === "turn.completed") break;
  }
  assert.deepEqual(events.map((event) => event.type), ["session.ready", "turn.delta", "turn.completed"]);
  assert.equal(driver.provider_session_id, "fake-session");
  await driver.stop("test", 1000);
});

test("Advisor session surfaces Claude API errors and settles the turn without leaking credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-api-error-"));
  const executable = join(root, "fake-claude");
  await writeFile(executable, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (!buffer.includes("\\n")) return;
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "system", subtype: "api_error", error: { status: 401, message: "authentication_error: access token has been revoked; secret-token-should-not-display" } }) + "\\n");
  buffer = "";
});
`, "utf8");
  await chmod(executable, 0o755);

  const driver = await AdvisorSessionDriver.create({
    adapter: "claude",
    role: "advisor",
    model: "claude-opus-5",
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    system_prompt: "test",
  }, executable);
  await driver.send({ turn_id: "turn-api-error", text: "hello" });

  const events = [];
  for await (const event of driver.events()) {
    events.push(event);
    if (event.type === "turn.failed") break;
  }
  const failure = events.find((event) => event.type === "turn.failed");
  assert.equal(failure?.turn_id, "turn-api-error");
  assert.match(failure?.error ?? "", /認証に失敗/);
  assert.doesNotMatch(failure?.error ?? "", /secret-token-should-not-display/);
  assert.equal(events.some((event) => event.type === "turn.completed"), false);
  await driver.stop("test", 1000);
});

test("Manager, Worker, and Reviewer surface provider failures without raw harness output", async () => {
  const secret = "provider-secret-must-not-display";
  const failureProvider = {
    execute: async (request) => ({
      adapter: request.adapter,
      stdout: "",
      stderr: `authentication_error: access token has been revoked ${secret}`,
      exit_code: 1,
      signal: null,
    }),
  };
  const runner = createAgentRunner({ provider: failureProvider });
  const report = {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: "worker-report",
    result: "success",
    work_done: "done",
    changes: [],
    verification: { passed: true, method: "Checked the result." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
  const [manager, worker, reviewer] = await Promise.all([
    runner.runManagerPlan({ invocation_id: "manager-run", work_id: "work-1", task_id: null, attempt: 1, context: { mode: "plan" } }),
    runner.runWorker({ invocation_id: "worker-run", work_id: "work-1", task_id: "task-1", attempt: 1, context: {} }),
    runner.runReviewer({ invocation_id: "reviewer-run", work_id: "work-1", task_id: "task-1", attempt: 1, review_round: 1, context: { report } }),
  ]);
  for (const result of [manager, worker, reviewer]) {
    assert.equal(result.outcome, "failed");
    assert.match(result.message, /認証に失敗/);
    assert.doesNotMatch(result.message, /provider-secret-must-not-display/);
  }

  const malformedRunner = createAgentRunner({
    provider: {
      execute: async (request) => ({
        adapter: request.adapter,
        stdout: `not-a-report ${secret}`,
        stderr: "",
        exit_code: 0,
        signal: null,
      }),
    },
  });
  const malformed = await malformedRunner.runWorker({
    invocation_id: "malformed-worker-run",
    work_id: "work-1",
    task_id: "task-1",
    attempt: 1,
    context: {},
  });
  assert.equal(malformed.outcome, "failed");
  assert.match(malformed.message, /レポート契約|出力形式/);
  assert.doesNotMatch(malformed.message, /provider-secret-must-not-display/);
});

test("Core role handoffs map work, task, report, rules, and workspace once", async () => {
  const requests = [];
  const workerReport = {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: "worker-handoff",
    result: "success",
    work_done: "worker-report-marker",
    changes: [],
    verification: { passed: true, method: "Checked the result." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
  const runner = createAgentRunner({
    provider: {
      execute: async (request) => {
        requests.push(request);
        const body = request.role === "manager"
          ? { tasks: [] }
          : request.role === "worker"
            ? workerReport
            : { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
        return { adapter: request.adapter, stdout: JSON.stringify(body), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const task = {
    id: "task-handoff",
    work_id: "work-handoff",
    title: "task-title-marker",
    status: "running",
    type: "code",
    state_version: 2,
    updated_at: "2026-09-24T00:00:00.000Z",
    parent_task_id: null,
    acceptance: "task-acceptance-marker",
    review_round: 1,
    failure_count: 0,
    worker_generation: 1,
    depends_on: [],
  };
  const report = { ...workerReport, invocation_id: "worker-handoff" };
  await runner.runManagerPlan({
    invocation_id: "manager-handoff",
    work_id: "work-handoff",
    task_id: null,
    attempt: 1,
    reason: "manager-reason-marker",
    context: {
      mode: "replan",
      work: { id: "work-handoff", title: "work-title-marker", summary: "work-summary-marker" },
      failed_task_ids: [task.id],
      failed_tasks: [task],
      reason: "manager-reason-marker",
      question: "manager-question-marker",
      rules: "manager-rule-marker",
    },
  });
  await runner.runWorker({
    invocation_id: "worker-handoff",
    work_id: "work-handoff",
    task_id: task.id,
    attempt: 1,
    context: { task, task_id: task.id, work_id: "work-handoff", worktree: "/tmp/worker-worktree-marker", hybrid_mode: false, rules: "worker-rule-marker" },
  });
  await runner.runReviewer({
    invocation_id: "reviewer-handoff",
    work_id: "work-handoff",
    task_id: task.id,
    attempt: 1,
    review_round: 1,
    context: { task, report, worktree: "/tmp/reviewer-worktree-marker", rules: "reviewer-rule-marker" },
  });

  const managerPrompt = requests.find((request) => request.role === "manager").prompt;
  const workerRequest = requests.find((request) => request.role === "worker");
  const reviewerRequest = requests.find((request) => request.role === "reviewer");
  assert.match(managerPrompt, /work-title-marker/u);
  assert.match(managerPrompt, /manager-question-marker/u);
  assert.equal(managerPrompt.split("manager-reason-marker").length - 1, 1);
  assert.equal(managerPrompt.split("manager-rule-marker").length - 1, 1);
  assert.doesNotMatch(managerPrompt, /Manager plan for work-handoff/u);
  assert.equal(workerRequest.prompt.split("task-title-marker").length - 1, 1);
  assert.equal(workerRequest.prompt.split("worker-rule-marker").length - 1, 1);
  assert.doesNotMatch(workerRequest.prompt, /worker-worktree-marker|hybrid_mode/u);
  assert.equal(workerRequest.cwd, "/tmp/worker-worktree-marker");
  assert.equal(reviewerRequest.prompt.split("task-acceptance-marker").length - 1, 1);
  assert.equal(reviewerRequest.prompt.split("worker-report-marker").length - 1, 1);
  assert.equal(reviewerRequest.prompt.split("reviewer-rule-marker").length - 1, 1);
  assert.doesNotMatch(reviewerRequest.prompt, /reviewer-worktree-marker/u);
  assert.equal(reviewerRequest.cwd, "/tmp/reviewer-worktree-marker");
});

test("final Manager honors its role-specific provider, model, and invocation id", async () => {
  const requests = [];
  const runner = createAgentRunner({
    adapter: "codex",
    model: "gpt-6-luna",
    providers: { anthropic: { adapter: "claude-cli/v1" } },
    provider: {
      execute: async (request) => {
        requests.push(request);
        return {
          adapter: request.adapter,
          stdout: JSON.stringify({
            type: "result",
            result: JSON.stringify({
              verdict: {
                verdict: "complete",
                summary: "The Work is complete.",
                missing: [],
                lessons: [],
              },
            }),
          }),
          stderr: "",
          exit_code: 0,
          signal: null,
        };
      },
    },
  });

  const result = await runner.runManagerPlan({
    invocation_id: "manager-final-run",
    work_id: "work-final",
    task_id: null,
    attempt: 1,
    work: { id: "work-final", title: "Finish the Work", summary: "Check the Task reports." },
    tasks: [],
    reports: [{ work_done: "The final report was kept concise." }],
    notes: [],
    reason: "All Tasks completed.",
    mode: "finalize",
    context: { mode: "finalize", work_id: "work-final" },
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
  });

  assert.equal(result.verdict.verdict, "complete");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].invocation_id, "manager-final-run");
  assert.equal(requests[0].workspace_id, "work-final");
  assert.equal(requests[0].adapter, "claude-cli/v1");
  assert.equal(requests[0].model, "claude-opus-5-5");
  assert.equal(requests[0].effort, "high");
  assert.match(requests[0].prompt, /The final report was kept concise/u);
});

test("Hybrid plans use provider-enforced JSON Schema and get one contract-repair attempt", async () => {
  for (const adapter of ["claude-cli/v1", "codex"]) {
    const root = await mkdtemp(join(tmpdir(), `owl-hybrid-schema-${adapter.replaceAll("/", "-")}-`));
    const executable = join(root, adapter.startsWith("codex") ? "codex" : "claude");
    const capturePath = join(root, "provider-calls.jsonl");
    const counterPath = join(root, "provider-call-count");
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const capturePath = ${JSON.stringify(capturePath)};`,
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const args = process.argv.slice(2);',
      'let prompt = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { prompt += chunk; });',
      'process.stdin.on("end", () => {',
      'const schemaFlag = args.includes("--json-schema") ? "--json-schema" : args.includes("--output-schema") ? "--output-schema" : null;',
      'const schemaArgument = schemaFlag ? args[args.indexOf(schemaFlag) + 1] : null;',
      'const schema = schemaFlag === "--json-schema" ? JSON.parse(schemaArgument) : schemaFlag === "--output-schema" ? JSON.parse(fs.readFileSync(schemaArgument, "utf8")) : null;',
      'const callCount = (fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0) + 1;',
      'fs.writeFileSync(counterPath, String(callCount));',
      'fs.appendFileSync(capturePath, JSON.stringify({ args, schemaFlag, schemaArgument, schema, prompt }) + "\\n");',
      'const plan = JSON.stringify({ subtasks: [{ subtask_id: "s1", title: "Implement the change", instruction: "Inspect and implement the requested change.", write_paths: ["src/change.ts"] }] });',
      'const message = callCount === 1 ? "Plan follows:\\n```json\\n" + plan + "\\n```" : plan;',
      'const response = args[0] === "exec" ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }) + "\\n" : JSON.stringify({ type: "result", result: message });',
      'process.stdout.write(response);',
      '});',
      "",
    ].join("\n");
    await writeFile(executable, script, "utf8");
    await chmod(executable, 0o755);

    const runner = createAgentRunner({
      adapter,
      cwd: root,
      executablePath: executable,
      model: "test-model",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const processEvents = [];
    runner.setProcessObserver((invocationId, event) => processEvents.push({ invocationId, ...event }));
    const result = await runner.runWorker({
      invocation_id: `hybrid-plan-${adapter}`,
      work_id: "work-hybrid-plan",
      task_id: "task-hybrid-plan",
      attempt: 1,
      context: { hybrid_mode: true, hybrid_phase: "plan" },
    });

    assert.equal(result.outcome, "success", `${adapter} should recover from one malformed plan`);
    assert.deepEqual(result.report?.subtasks, [{ subtask_id: "s1", title: "Implement the change", instruction: "Inspect and implement the requested change.", write_paths: ["src/change.ts"] }]);
    const calls = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 2, `${adapter} should make one bounded repair call`);
    assert.equal(calls[0].schemaFlag, adapter.startsWith("codex") ? "--output-schema" : "--json-schema");
    for (const call of calls) {
      assert.deepEqual(call.schema.required, ["subtasks"]);
      assert.equal(call.schema.additionalProperties, false);
      assert.deepEqual(call.schema.properties.subtasks.items.required, ["subtask_id", "title", "instruction", "write_paths"]);
      assert.equal(call.schema.properties.subtasks.items.additionalProperties, false);
    }
    assert.match(calls[1].prompt, /previous Hybrid Mode planning response did not satisfy Owl's machine-validated output contract/u);
    assert.equal(calls[0].args.includes(calls[0].prompt), false, "the full prompt must not be passed in argv");
    if (adapter.startsWith("codex")) assert.equal(calls[0].args.at(-1), "-");
    assert.deepEqual(processEvents.map((event) => event.type), ["spawned", "exited", "spawned", "exited"]);
    assert.ok(processEvents.every((event) => event.pid > 0));
    assert.equal(processEvents[0].invocationId, `hybrid-plan-${adapter}`);
    assert.equal(processEvents[1].pid, processEvents[0].pid);
    assert.equal(processEvents[2].invocationId, `hybrid-plan-${adapter}`);
    assert.equal(processEvents[3].pid, processEvents[2].pid);
    if (adapter.startsWith("codex")) {
      await assert.rejects(readFile(calls[0].schemaArgument, "utf8"));
      await assert.rejects(readFile(calls[1].schemaArgument, "utf8"));
    }
  }
});

test("Hybrid verdict sends large Executor results over stdin", async () => {
  for (const adapter of ["claude-cli/v1", "codex"]) {
    const root = await mkdtemp(join(tmpdir(), `owl-hybrid-large-verdict-${adapter.replaceAll("/", "-")}-`));
    const executable = join(root, adapter.startsWith("codex") ? "codex" : "claude");
    const capturePath = join(root, "capture.json");
    const invocationId = `hybrid-verdict-${adapter}`;
    const report = {
      kind: "report",
      schema_version: "1.0.0",
      invocation_id: invocationId,
      result: "success",
      work_done: "Reviewed all Executor results.",
      changes: [],
      verification: { passed: true, method: "Checked the result." },
      remaining_issues: [],
      next_action: "none",
      needs_replanning: false,
      question_for_manager: null,
      verdict: "ok",
      retry_subtasks: [],
    };
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const capturePath = ${JSON.stringify(capturePath)};`,
      'const args = process.argv.slice(2);',
      'let prompt = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { prompt += chunk; });',
      'process.stdin.on("end", () => {',
      'fs.writeFileSync(capturePath, JSON.stringify({ args, prompt_bytes: Buffer.byteLength(prompt), includes_executor_marker: prompt.includes("executor-marker-"), executor_marker_occurrences: (prompt.match(/executor-marker-/g) || []).length }));',
      `const message = ${JSON.stringify(JSON.stringify(report))};`,
      'const response = args[0] === "exec" ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }) + "\\n" : JSON.stringify({ type: "result", result: message });',
      'process.stdout.write(response);',
      '});',
      "",
    ].join("\n");
    await writeFile(executable, script, "utf8");
    await chmod(executable, 0o755);

    const runner = createAgentRunner({
      adapter,
      cwd: root,
      executablePath: executable,
      model: "test-model",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const result = await runner.runWorker({
      invocation_id: invocationId,
      work_id: "work-hybrid-large-verdict",
      task_id: "task-hybrid-large-verdict",
      attempt: 1,
      context: {
        hybrid_mode: true,
        hybrid_phase: "verdict",
        executor_results: [{
          subtask_id: "s1",
          success: true,
          output: `executor-marker-${"x".repeat(1_100_000)}`,
          exit_code: 0,
          duration_ms: 1,
        }],
      },
    });

    assert.equal(result.outcome, "success", `${adapter} must process a verdict above ARG_MAX`);
    assert.equal(result.report?.verdict, "ok");
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.ok(captured.prompt_bytes > 1_048_576);
    assert.equal(captured.includes_executor_marker, true);
    assert.equal(captured.executor_marker_occurrences, 1, "Executor output must cross the Worker handoff only once");
    assert.equal(captured.args.includes(`executor-marker-${"x".repeat(1_100_000)}`), false);
    if (adapter.startsWith("codex")) assert.equal(captured.args.at(-1), "-");
  }
});

test("Provider reports command-line size errors as oversized input instead of bad configuration", () => {
  const failure = classifyProviderFailure("claude-cli/v1", {
    exit_code: null,
    signal: null,
    error_code: "E2BIG",
    error: new Error("spawn E2BIG"),
    stderr: "The configured provider could not complete the request. Check the locked executable, credentials, and provider logs before retrying.",
  });
  assert.equal(failure.error_key, "provider_failed:argument_list_too_long");
  assert.match(failure.message, /入力がOSのコマンドサイズ上限を超え/u);
  assert.doesNotMatch(failure.message, /実行設定が不正/u);
});

test("Core clears an AgentRun PID when a provider phase exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-agent-pid-lifecycle-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  let processObserver = null;
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
    setProcessObserver: (observer) => { processObserver = observer; },
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
  try {
    const created = await core.createWork(commandEnvelope({
      title: "Agent PID lifecycle test",
      summary: "Verify process tracking for multi-phase AgentRuns.",
      size: "small",
      project_id: null,
    }, "agent-pid-lifecycle-create"));
    const taskId = createUlid();
    const agentRunId = createUlid();
    const now = new Date().toISOString();
    await db.createWriteLane().transact((transaction) => {
      transaction.run(
        `INSERT INTO tasks
           (id, work_id, title, type, status, priority, context, acceptance,
            state_version, failure_count, same_error_count, review_round, worker_generation,
            created_at, updated_at, retry_no)
         VALUES (?, ?, ?, 'code', 'running', 'normal', '{}', ?, 0, 0, 0, 0, 1, ?, ?, 0)`,
        taskId,
        created.data.work_id,
        "Track the current child process",
        "An exited child PID is no longer active.",
        now,
        now,
      );
      transaction.run(
        `INSERT INTO agent_runs
           (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
         VALUES (?, ?, ?, 'worker', 'anthropic', 'test-model', 'running', ?, ?)`,
        agentRunId,
        created.data.work_id,
        taskId,
        now,
        now,
      );
    });

    assert.ok(processObserver, "Core should subscribe to provider process lifecycle events");
    await processObserver(agentRunId, { type: "spawned", pid: process.pid });
    assert.equal(db.get("SELECT pid FROM agent_runs WHERE id = ?", agentRunId).pid, process.pid);
    await processObserver(agentRunId, { type: "exited", pid: process.pid });
    const agent = db.get("SELECT pid, process_start_time, process_cmdline_sha256 FROM agent_runs WHERE id = ?", agentRunId);
    assert.equal(agent.pid, null);
    assert.equal(agent.process_start_time, null);
    assert.equal(agent.process_cmdline_sha256, null);
  } finally {
    db.close();
  }
});

test("Hybrid Executor surfaces provider failures without raw harness output", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-core-executor-error-"));
  const executable = join(root, "claude");
  const secret = "executor-secret-must-not-display";
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "process.stdout.write(" + JSON.stringify(secret) + ");",
    'process.stderr.write("authentication_error: invalid api key");',
    "process.exit(1);",
    "",
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    const result = await runCoreExecutor(
      {
        subtask_id: "executor-subtask",
        instruction: "run",
        workspace_dir: root,
        task: { title: "Executor Task", acceptance: "It works.", context: "", rules: null, owner_guidance: [] },
      },
      {
        provider: "claude",
        model: "test-model",
        effort: "high",
        timeout_ms: 1000,
      },
    );
    assert.equal(result.success, false);
    assert.match(result.output, /認証に失敗/);
    assert.doesNotMatch(result.output, /executor-secret-must-not-display/);
    assert.doesNotMatch(result.output, /authentication_error/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Hybrid Executors run disjoint write scopes concurrently and overlapping scopes in a later wave", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-core-executor-parallel-waves-"));
  const executable = join(root, "claude");
  const logPath = join(root, "executor-order.log");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const logPath = " + JSON.stringify(logPath) + ";",
    "const id = process.env.OWL_AGENT_RUN_ID;",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  fs.appendFileSync(logPath, `start:${id}\\n`);",
    "  setTimeout(() => {",
    "    fs.appendFileSync(logPath, `end:${id}\\n`);",
    "    process.stdout.write(JSON.stringify({ type: 'result', result: `finished ${id}` }));",
    "  }, 200);",
    "});",
    "",
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    const task = (subtask_id, write_paths) => ({
      subtask_id,
      instruction: `work on ${subtask_id}`,
      write_paths,
      workspace_dir: root,
      task: { title: "Executor Task", acceptance: "It works.", context: "", rules: null, owner_guidance: [] },
    });
    const results = await runCoreExecutorsParallel([
      task("subtask-a", ["src/a.ts"]),
      task("subtask-b", ["src/b.ts"]),
      task("subtask-a-followup", ["src/a.ts"]),
    ], { provider: "claude", model: "test-model", effort: "high", timeout_ms: 2_000 }, 0);
    assert.deepEqual(results.map((result) => result.success), [true, true, true]);
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    const firstEnd = Math.min(events.indexOf("end:subtask-a"), events.indexOf("end:subtask-b"));
    assert.ok(events.indexOf("start:subtask-a") < firstEnd);
    assert.ok(events.indexOf("start:subtask-b") < firstEnd, "both disjoint Executors should start before either one finishes");
    assert.ok(events.indexOf("start:subtask-a-followup") > events.indexOf("end:subtask-a"), "same-path followup should start after its conflicting wave completes");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Slack Socket Mode dispatches interactive block_actions envelopes and acknowledges them", async () => {
  const connector = new FullSlackConnector({
    botToken: "xoxb-interactive-test",
    appToken: "xapp-interactive-test",
    conversationChannelId: "C-INTERACTIVE-CONVERSATION",
    notificationChannelId: "C-INTERACTIVE-NOTIFICATION",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const handlers = new Map();
  const interactions = [];
  const socket = connector.socket;
  socket.on = (event, handler) => {
    handlers.set(event, handler);
    return socket;
  };
  socket.start = async () => ({ ok: true });
  socket.disconnect = async () => {};
  connector.core.subscribeEvents = async () => {};
  connector.handleInteraction = async (body) => interactions.push(body);

  await connector.start();
  assert.ok(handlers.has("interactive"));
  assert.equal(handlers.has("interactive_message"), false);
  assert.equal(isSlackBlockActionsPayload({ type: "block_actions", actions: [] }), true);
  assert.equal(isSlackBlockActionsPayload({ type: "view_submission", actions: [] }), false);

  let acks = 0;
  const interactive = handlers.get("interactive");
  const unsupported = { type: "view_submission", actions: [{ action_id: "ignored", value: "ignored" }] };
  const blockActions = { type: "block_actions", actions: [{ action_id: "owl.d1.a.0", value: "ignored" }] };
  await interactive({ body: unsupported, ack: async () => { acks += 1; } });
  await interactive({ body: blockActions, ack: async () => { acks += 1; } });
  assert.equal(acks, 2);
  assert.deepEqual(interactions, [blockActions]);
  await connector.stop();
});

test("Discord decision buttons defer before Core I/O and edit the deferred reply", async () => {
  const decisionId = "01ARZ3NDEKTSV4RRFFQ6_DISCORD";
  const connector = new FullDiscordConnector({
    botToken: "discord-button-ack-test",
    conversationChannelId: "D-BUTTON-CONVERSATION",
    notificationChannelId: "D-BUTTON-NOTIFICATION",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const calls = [];
  connector.fetchPendingDecisions = async (throwOnError) => {
    calls.push(["pending", throwOnError]);
    return [{ id: decisionId, options: [{ key: "approve_now", label: "承認" }] }];
  };
  connector.core.request = async (path) => {
    calls.push(["core", path]);
    return {};
  };
  connector.core.language = async () => "ja";
  const interaction = {
    isButton: () => true,
    channelId: "D-BUTTON-NOTIFICATION",
    customId: createDecisionButtonId(decisionId, 0),
    message: { id: "discord-message-1" },
    deferred: false,
    replied: false,
    deferReply: async (options) => {
      calls.push(["defer", options]);
      interaction.deferred = true;
    },
    editReply: async (payload) => calls.push(["edit", payload]),
    reply: async (payload) => calls.push(["reply", payload]),
  };

  await connector.handleButtonInteraction(interaction);
  assert.deepEqual(calls.map(([kind]) => kind), ["defer", "pending", "core", "edit"]);
  assert.deepEqual(calls[0][1], { ephemeral: true });
  assert.equal(calls[3][1].content, "✓ 「承認」で回答しました。");
  assert.equal(calls.some(([kind]) => kind === "reply"), false);

  const staleCalls = [];
  connector.fetchPendingDecisions = async () => {
    staleCalls.push("pending");
    return [];
  };
  const staleInteraction = {
    ...interaction,
    deferred: false,
    replied: false,
    deferReply: async () => staleCalls.push("defer"),
    editReply: async (payload) => staleCalls.push(["edit", payload]),
    reply: async () => staleCalls.push("reply"),
  };
  await connector.handleButtonInteraction(staleInteraction);
  assert.deepEqual(staleCalls.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["defer", "pending", "edit"]);
  assert.match(staleCalls[2][1].content, /解決済み|見つかりません/u);

  const failureCalls = [];
  connector.fetchPendingDecisions = async () => {
    failureCalls.push("pending");
    return [{ id: decisionId, options: [{ key: "approve_now", label: "承認" }] }];
  };
  connector.core.request = async () => {
    failureCalls.push("core");
    throw new Error("simulated core failure");
  };
  const failureInteraction = {
    ...interaction,
    deferred: false,
    replied: false,
    deferReply: async () => {
      failureCalls.push("defer");
      failureInteraction.deferred = true;
    },
    editReply: async (payload) => failureCalls.push(["edit", payload]),
    reply: async (payload) => failureCalls.push(["reply", payload]),
  };
  await connector.handleButtonInteraction(failureInteraction);
  assert.deepEqual(failureCalls.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["defer", "pending", "core", "edit"]);
  assert.match(failureCalls[3][1].content, /処理に失敗/u);
  assert.equal(failureCalls.some((entry) => Array.isArray(entry) && entry[0] === "reply"), false);
});

test("decision button IDs round-trip underscore options and reject malformed or stale targets", () => {
  const decisions = [{
    id: "01ARZ3NDEKTSV4RRFFQ6_DECISION",
    options: [
      { key: "needs_more_info_v2", label: "追加情報" },
      { key: "approve_now", label: "承認" },
    ],
  }];
  const buttonId = createDecisionButtonId(decisions[0].id, 0);
  assert.ok(buttonId);
  assert.equal(buttonId.includes("needs_more_info_v2"), false);
  assert.ok(buttonId.length <= 100);
  const parsed = parseDecisionButtonId(buttonId);
  assert.deepEqual(parsed, { decisionId: decisions[0].id, optionIndex: 0 });
  assert.deepEqual(resolveDecisionButtonTarget(decisions, parsed), {
    decisionId: decisions[0].id,
    optionKey: "needs_more_info_v2",
    label: "追加情報",
    stateVersion: 0,
  });
  assert.equal(parseDecisionButtonId("owl.d1.a.0"), null);
  assert.equal(parseDecisionButtonId("owl.d1.%%% .0"), null);
  assert.equal(parseDecisionButtonId("owl.d1.a.00"), null);
  assert.equal(resolveDecisionButtonTarget(decisions, { decisionId: decisions[0].id, optionIndex: 8 }), null);
  assert.equal(resolveDecisionButtonTarget(decisions, { decisionId: "missing", optionIndex: 0 }), null);
  assert.equal(createDecisionButtonId("x".repeat(129), 0), null);
});

test("core Decision resolution rejects an option outside stored options", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-decision-core-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const workId = "work-decision-option-test";
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      "INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      "owner:default",
      "Test owner",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    transaction.run(
      `INSERT INTO works
         (id, owner_id, title, summary, size, state, state_version, plan_revision,
          rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'small', 'running', 0, 0, ?, ?, ?, ?)`,
      workId,
      "owner:default",
      "Decision test",
      "Decision test",
      JSON.stringify({ schema_version: "1.0.0", rules: [] }),
      JSON.stringify([]),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  });

  try {
    const service = new DecisionService(db);
    const opened = await service.open({
      request_id: createUlid(),
      idempotency_key: "decision-open-test",
      expected_version: 0,
      payload: {
        work_id: workId,
        scope: "work",
        blocked_task_ids: [],
        reason: "Need an owner choice",
        question: "Which information should the Worker gather?",
        tried: "Tested both options",
        current_state: "judgement_waiting",
        options: [{ key: "needs_more_info_v2", label: "追加情報", description: "Gather more information first." }],
        recommended: null,
        allow_free_text: false,
        issuer_role: "manager",
      },
    });
    const openedEvent = db.get("SELECT id, sequence, type, work_id, payload_json FROM events WHERE type = 'decision.opened' ORDER BY sequence DESC LIMIT 1");
    assert.ok(openedEvent);
    assert.equal(JSON.parse(openedEvent.payload_json).decision_id, opened.data.decision_id);

    const notification = new FullSlackConnector({
      botToken: "xoxb-decision-notification-test",
      appToken: "xapp-decision-notification-test",
      conversationChannelId: "C-DECISION-CONVERSATION",
      notificationChannelId: "C-DECISION-NOTIFICATION",
      coreApiBase: "http://127.0.0.1:1/api/v1",
      accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    const posts = [];
    notification.web = { chat: { postMessage: async (message) => posts.push(message) } };
    await notification.handleCoreEvent({
      kind: "event",
      event_id: openedEvent.id,
      sequence: openedEvent.sequence,
      cursor: String(openedEvent.sequence),
      type: openedEvent.type,
      schema_version: "1.0.0",
      work_id: openedEvent.work_id,
      payload: JSON.parse(openedEvent.payload_json),
    });
    const decisionBlocks = [
      ...(posts[0]?.blocks ?? []),
      ...(posts[0]?.attachments ?? []).flatMap((attachment) => attachment.blocks ?? []),
    ];
    const decisionButton = decisionBlocks.find((block) => block.type === "actions")?.elements?.[0];
    assert.equal(parseDecisionButtonId(decisionButton.action_id)?.decisionId, opened.data.decision_id);

    await assert.rejects(
      () => service.resolve({
        request_id: createUlid(),
        idempotency_key: "decision-resolve-free-text",
        expected_version: 0,
        payload: {
          decision_id: opened.data.decision_id,
          answer: "arbitrary free text",
          option_key: null,
          source_message_id: null,
          source: "slack",
        },
      }),
      (error) => error?.code === "validation_error" && /free-text/u.test(error.message),
    );
    await assert.rejects(
      () => service.resolve({
        request_id: createUlid(),
        idempotency_key: "decision-resolve-invalid",
        expected_version: 0,
        payload: {
          decision_id: opened.data.decision_id,
          answer: "not stored",
          option_key: "not_stored_option",
          source_message_id: null,
          source: "slack",
        },
      }),
      (error) => error?.code === "validation_error",
    );
    const resolved = await service.resolve({
      request_id: createUlid(),
      idempotency_key: "decision-resolve-valid",
      expected_version: 0,
      payload: {
        decision_id: opened.data.decision_id,
        answer: "追加情報",
        option_key: "needs_more_info_v2",
        source_message_id: null,
        source: "slack",
      },
    });
    assert.equal(resolved.data.status, "resolved");
  } finally {
    db.close();
  }
});

test("MemoryCore rejects free-text answers when the saved Decision disallows them", async () => {
  const core = createServerCore({ version: "test", db: null, agentRunner: {} });
  const decision = {
    id: "01ARZ3NDEKTSV4RRFFQ6_MEMORY",
    work_id: "01ARZ3NDEKTSV4RRFFQ6_WORK",
    scope: "work",
    status: "open",
    reason: "Need an owner choice",
    options: [{ key: "approve_now", label: "承認" }],
    recommended: null,
    allow_free_text: false,
    blocked_task_ids: [],
    state_version: 0,
  };
  core.decisions.set(decision.id, decision);
  await assert.rejects(
    () => core.answerDecision(decision.id, {
      answer: "arbitrary free text",
      option_key: null,
      source_message_id: null,
    }, commandEnvelope({}, "memory-free-text")),
    (error) => error?.status === 400 && error?.code === "validation_error" && /自由記述/u.test(error.message),
  );
  assert.equal(decision.status, "open");
  assert.equal(decision.state_version, 0);
});

test("standalone connector CLI requires provider-owned account IDs for --all", () => {
  const keys = [
    "OWL_CONNECTOR_ACCOUNT_ID",
    "OWL_SLACK_CONNECTOR_ACCOUNT_ID",
    "OWL_DISCORD_CONNECTOR_ACCOUNT_ID",
  ];
  const previous = restoreEnvironment(keys);
  try {
    process.env.OWL_CONNECTOR_ACCOUNT_ID = "shared-account";
    delete process.env.OWL_SLACK_CONNECTOR_ACCOUNT_ID;
    delete process.env.OWL_DISCORD_CONNECTOR_ACCOUNT_ID;
    assert.throws(
      () => resolveConnectorAccountId("slack", true),
      /--all requires OWL_SLACK_CONNECTOR_ACCOUNT_ID and OWL_DISCORD_CONNECTOR_ACCOUNT_ID/u,
    );

    process.env.OWL_SLACK_CONNECTOR_ACCOUNT_ID = "slack-account";
    process.env.OWL_DISCORD_CONNECTOR_ACCOUNT_ID = "discord-account";
    assert.equal(resolveConnectorAccountId("slack", true), "slack-account");
    assert.equal(resolveConnectorAccountId("discord", true), "discord-account");

    delete process.env.OWL_SLACK_CONNECTOR_ACCOUNT_ID;
    assert.equal(resolveConnectorAccountId("slack", false), "shared-account");
  } finally {
    resetEnvironment(previous);
  }
});

test("standalone connector startup stops every connector once and preserves the startup error", async () => {
  const events = [];
  const startupError = new Error("discord startup failed");
  const lifecycle = createConnectorLifecycle([
    {
      name: "slack",
      start: async () => { events.push("slack:start"); },
      stop: async () => { events.push("slack:stop"); },
    },
    {
      name: "discord",
      start: async () => {
        events.push("discord:start");
        throw startupError;
      },
      stop: async () => {
        events.push("discord:stop");
        throw new Error("discord cleanup failed");
      },
    },
  ]);

  await assert.rejects(
    () => lifecycle.start(),
    (error) => error === startupError,
  );
  assert.deepEqual(events, ["slack:start", "discord:start", "slack:stop", "discord:stop"]);

  await lifecycle.stop();
  assert.deepEqual(events, ["slack:start", "discord:start", "slack:stop", "discord:stop"]);
});

test("Slack and Discord pending Decision pagination reaches the 51st button target", async () => {
  const decisions = Array.from({ length: 51 }, (_, index) => ({
    id: `decision-${index}`,
    options: [{ key: `option-${index}`, label: `Option ${index}` }],
    allow_free_text: false,
  }));

  const installPages = (connector, pages, paths) => {
    connector.core.requestPage = async (path) => {
      paths.push(path);
      const page = pages.shift();
      assert.ok(page, `unexpected page request: ${path}`);
      return page;
    };
  };
  const expectedPaths = [
    "/decisions?status=open&limit=50",
    "/decisions?status=open&limit=50&cursor=50",
  ];

  const slack = new FullSlackConnector({
    botToken: "xoxb-pagination-test",
    appToken: "xapp-pagination-test",
    conversationChannelId: "C-PAGINATION",
    notificationChannelId: "C-PAGINATION-NOTIFY",
    coreApiBase: "http://127.0.0.1:3787/api/v1",
    accountId: "slack-pagination-account",
  });
  const slackPaths = [];
  installPages(slack, [
    { data: decisions.slice(0, 50), cursor: "50", has_more: true },
    { data: decisions.slice(50), cursor: null, has_more: false },
  ], slackPaths);
  const slackPending = await slack.fetchPendingDecisions();
  assert.equal(slackPending.length, 51);
  assert.deepEqual(slackPaths, expectedPaths);

  const discord = new FullDiscordConnector({
    botToken: "discord-pagination-test",
    conversationChannelId: "D-PAGINATION",
    notificationChannelId: "D-PAGINATION-NOTIFY",
    coreApiBase: "http://127.0.0.1:3787/api/v1",
    accountId: "discord-pagination-account",
  });
  const discordPaths = [];
  installPages(discord, [
    { data: decisions.slice(0, 50), cursor: "50", has_more: true },
    { data: decisions.slice(50), cursor: null, has_more: false },
  ], discordPaths);
  const discordPending = await discord.fetchPendingDecisions(true);
  assert.equal(discordPending.length, 51);
  assert.deepEqual(discordPaths, expectedPaths);

  for (const pending of [slackPending, discordPending]) {
    const targetId = createDecisionButtonId("decision-50", 0);
    const target = parseDecisionButtonId(targetId);
    assert.ok(target);
    assert.deepEqual(resolveDecisionButtonTarget(pending, target), {
      decisionId: "decision-50",
      optionKey: "option-50",
      label: "Option 50",
      stateVersion: 0,
    });
  }
});

test("standalone connector adapters reuse full notification and interaction implementations", async () => {
  const config = {
    owlApiBase: "http://127.0.0.1:3787/api/v1",
    slackBotToken: "xoxb-standalone-test",
    slackAppToken: "xapp-standalone-test",
    conversationChannelId: "C-STANDALONE-CONVERSATION",
    notificationChannelId: "C-STANDALONE-NOTIFICATION",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  };
  const standaloneSlack = new StandaloneSlackConnector(config);
  assert.ok(standaloneSlack.delegate instanceof FullSlackConnector);
  assert.equal(standaloneSlack.delegate.config.notificationChannelId, "C-STANDALONE-NOTIFICATION");

  const notificationPosts = [];
  standaloneSlack.delegate.web = { chat: { postMessage: async (message) => notificationPosts.push(message) } };
  await standaloneSlack.delegate.handleCoreEvent({
    kind: "event",
    event_id: createUlid(),
    sequence: 1,
    cursor: "1",
    type: "work.completed",
    schema_version: "1.0.0",
    payload: { title: "Standalone work" },
  });
  assert.equal(notificationPosts[0]?.channel, "C-STANDALONE-NOTIFICATION");

  const decisionId = "01ARZ3NDEKTSV4RRFFQ6_STANDALONE";
  const requests = [];
  standaloneSlack.delegate.fetchPendingDecisions = async () => [{
    id: decisionId,
    options: [{ key: "needs_more_info_v2", label: "追加情報" }],
  }];
  standaloneSlack.delegate.core.request = async (path, init) => {
    requests.push({ path, init });
    return {};
  };
  await standaloneSlack.delegate.handleInteraction({
    actions: [{ action_id: createDecisionButtonId(decisionId, 0), value: "ignored-by-handler" }],
    channel: { id: "C-STANDALONE-NOTIFICATION" },
    message: { ts: "1712345678.000100" },
  });
  assert.equal(requests[0]?.path, `/decisions/${decisionId}/answer`);
  assert.equal(requests[0].init.body.payload.option_key, "needs_more_info_v2");

  const standaloneDiscord = new StandaloneDiscordConnector({
    owlApiBase: config.owlApiBase,
    discordBotToken: "discord-standalone-test",
    conversationChannelId: "D-STANDALONE-CONVERSATION",
    notificationChannelId: "D-STANDALONE-NOTIFICATION",
    accountId: config.accountId,
  });
  assert.ok(standaloneDiscord.delegate instanceof FullDiscordConnector);
  assert.equal(standaloneDiscord.delegate.config.notificationChannelId, "D-STANDALONE-NOTIFICATION");
});

test("clearing an Advisor conversation removes messages referenced by turns and receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-clear-"));
  const db = openDatabase(join(root, "owl.db"));
  try {
    db.migrate(join(repoRoot, "packages/db/migrations"));
    const now = new Date().toISOString();
    const conversationId = "conversation:clear-test";
    const messageId = "message:clear-test";
    await db.createWriteLane().transact((transaction) => {
      transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
      transaction.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", "account:clear-test", "owner:default", "web-default", now);
      transaction.run("INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)", conversationId, "owner:default", now, now);
      transaction.run("INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at) VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)", messageId, conversationId, "account:clear-test", "source:clear-test", "test message", now, now);
      transaction.run("INSERT INTO advisor_sessions (id, status, conversation_id, last_activity_at, created_at, updated_at) VALUES (?, 'ended', ?, ?, ?, ?)", "session:clear-test", conversationId, now, now, now);
      transaction.run("INSERT INTO advisor_turns (id, session_id, conversation_id, user_message_id, status, origin_channel, queued_at) VALUES (?, ?, ?, ?, 'failed', 'web', ?)", "turn:clear-test", "session:clear-test", conversationId, messageId, now);
      transaction.run("INSERT INTO inbound_receipts (id, provider, account_id, external_message_id, request_id, idempotency_key, request_hash, ack_id, message_id, status, created_at) VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)", "receipt:clear-test", "account:clear-test", "external:clear-test", "request:clear-test", "idempotency:clear-test", "a".repeat(64), "ack:clear-test", messageId, now);
    });

    const core = new Core({ db, agentRunner: {}, version: "test", owlRoot: root });
    assert.deepEqual(await core.clearConversation(conversationId), { cleared: true });
    assert.deepEqual(core.listMessages(conversationId).data, []);
    assert.equal(db.get("SELECT id FROM advisor_turns WHERE conversation_id = ?", conversationId), undefined);
    assert.equal(db.get("SELECT message_id FROM inbound_receipts WHERE id = ?", "receipt:clear-test").message_id, null);
  } finally {
    db.close();
  }
});

test("small Work skips initial Manager planning and dispatches one focused Task to the Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-direct-worker-work-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  let managerCalls = 0;
  let workerRequest = null;
  const agentRunner = {
    runManagerPlan: async () => {
      managerCalls += 1;
      throw new Error("Manager should not plan a small Work.");
    },
    runWorker: async (request) => {
      workerRequest = request;
      return {
        outcome: "failed",
        failure_class: "transient",
        error_key: "test_direct_worker_dispatch",
        retry_allowed: true,
        message: "Test stops after verifying dispatch.",
      };
    },
    runReviewer: async () => { throw new Error("Reviewer should not run for a failed Worker attempt."); },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  try {
    await core.start();
    const created = await core.createWork(commandEnvelope({
      title: "Fix the typo",
      summary: "Correct the typo in the button label.",
      size: "small",
      project_id: null,
    }, "direct-worker-create"));
    await core.startWork(created.data.work_id, {
      ...commandEnvelope({ mode: "small" }, "direct-worker-start"),
      expected_version: created.version,
    });

    const deadline = Date.now() + 5_000;
    while (!workerRequest && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(workerRequest, "the Worker should receive the Work");
    assert.equal(managerCalls, 0);
    assert.equal(workerRequest.context.task.title, "Fix the typo");
    assert.equal(workerRequest.context.task.type, "code");
    assert.equal(workerRequest.context.task.acceptance, "Correct the typo in the button label.");
    const tasks = db.all("SELECT title, type FROM tasks WHERE work_id = ?", created.data.work_id);
    assert.deepEqual(tasks, [{ title: "Fix the typo", type: "code" }]);
  } finally {
    await core.stop({ force: true });
    db.close();
  }
});

test("Core strips Hybrid-only control fields before passing a Worker report to the Reviewer", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-hybrid-review-report-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  let reviewerRequest = null;
  const workerReport = {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: "hybrid-worker-run",
    result: "success",
    work_done: "Completed the subtask.",
    changes: [],
    verification: { passed: true, method: "Checked the result." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
    verdict: "ok",
    retry_subtasks: [],
  };
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "The Work is complete.", missing: [], lessons: [] } } }
      : { outcome: "failed", message: "Unexpected Manager planning request." },
    runWorker: async () => ({ outcome: "success", report_valid: true, report: workerReport }),
    runReviewer: async (request) => {
      reviewerRequest = request;
      return { outcome: "failed", failure_class: "transient", error_key: "test_stops_after_reviewer_input" };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  try {
    await core.start();
    const created = await core.createWork(commandEnvelope({
      title: "Review Hybrid report contract",
      summary: "Pass only the base report envelope to the Reviewer.",
      size: "small",
      project_id: null,
    }, "hybrid-review-create"));
    await core.startWork(created.data.work_id, {
      ...commandEnvelope({ mode: "small" }, "hybrid-review-start"),
      expected_version: created.version,
    });

    const deadline = Date.now() + 5_000;
    while (!reviewerRequest && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(reviewerRequest, "Core should dispatch the successful code Task for review");
    assert.equal(reviewerRequest.context.report.verdict, undefined);
    assert.equal(reviewerRequest.context.report.retry_subtasks, undefined);
    assert.equal(reviewerRequest.context.report.work_done, "Completed the subtask.");
    assert.equal(reviewerRequest.context.report.invocation_id, "hybrid-worker-run");
  } finally {
    await core.stop({ force: true });
    db.close();
  }
});

test("Core preserves valid Reviewer findings and sends them to the next Worker attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-review-feedback-handoff-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const workerRequests = [];
  const managerRequests = [];
  let reviewCount = 0;
  const finding = {
    severity: "major",
    file: "src/target.ts",
    line: 17,
    problem: "review-finding-handoff-marker is not handled.",
    reason: "It must be handled before completion.",
    fix: "Handle review-finding-handoff-marker.",
  };
  const agentRunner = {
    runManagerPlan: async (request) => {
      managerRequests.push(request);
      return request.mode === "finalize"
        ? { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "The Work is complete.", missing: [], lessons: [] } } }
        : { outcome: "failed", message: "Unexpected Manager planning request." };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      return {
        outcome: "success",
        report_valid: true,
        report: {
          kind: "report",
          schema_version: "1.0.0",
          invocation_id: request.invocation_id,
          result: "success",
          work_done: `Worker attempt ${workerRequests.length} completed.`,
          changes: [],
          verification: { passed: true, method: "Checked the result." },
          remaining_issues: [],
          next_action: "none",
          needs_replanning: false,
          question_for_manager: null,
          verdict: "ok",
          retry_subtasks: [],
        },
      };
    },
    runReviewer: async () => {
      reviewCount += 1;
      const review = reviewCount === 1
        ? { verdict: "fix_required", summary: "One required correction remains.", findings: [finding], tests: { ran: true, command: "pnpm test", passed: 3, failed: 1 } }
        : { verdict: "pass", summary: "The correction passed review.", findings: [], tests: { ran: true, command: "pnpm test", passed: 4, failed: 0 } };
      return {
        // A valid non-pass review is represented as failed at the runtime
        // boundary. Core must inspect its typed review before treating it as
        // an invocation failure.
        outcome: review.verdict === "pass" ? "success" : "failed",
        report_valid: true,
        report: review,
        review,
      };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  try {
    await core.start();
    const created = await core.createWork(commandEnvelope({
      title: "Exercise the review retry handoff",
      summary: "Use the Reviewer finding on the next Worker attempt.",
      size: "small",
      project_id: null,
    }, "review-feedback-create"));
    await core.startWork(created.data.work_id, {
      ...commandEnvelope({ mode: "small" }, "review-feedback-start"),
      expected_version: created.version,
    });

    const deadline = Date.now() + 5_000;
    while (workerRequests.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(workerRequests.length, 2, "a valid fix_required verdict should schedule a Worker retry");
    const retryContext = workerRequests[1].context;
    assert.equal(retryContext.reviewer_findings?.[0]?.problem, finding.problem);
    assert.equal(retryContext.previous_report?.work_done, "Worker attempt 1 completed.");
    const storedReview = db.get("SELECT verdict, findings_json FROM reviews WHERE task_id = ? AND verdict = 'fix_required' ORDER BY round DESC LIMIT 1", workerRequests[0].task_id);
    assert.equal(storedReview.verdict, "fix_required");
    assert.deepEqual(JSON.parse(storedReview.findings_json), [finding]);

    const finalManagerDeadline = Date.now() + 5_000;
    while (!managerRequests.some((request) => request.mode === "finalize") && Date.now() < finalManagerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const finalRequest = managerRequests.find((request) => request.mode === "finalize");
    assert.ok(finalRequest, "Core should send the completed Work to Manager finalization");
    assert.equal(finalRequest.reports[0].verdict, undefined, "Hybrid routing fields must not leak into the Manager's Worker report");
    assert.equal(finalRequest.reports[0].retry_subtasks, undefined);
  } finally {
    await core.stop({ force: true });
    db.close();
  }
});

test("Manager review choices survive planning and control Reviewer dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-manager-review-choice-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const workerRequests = [];
  const reviewerRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? {
          outcome: "success",
          report_valid: true,
          report: {
            tasks: [
              { id: "T-code", title: "Skip optional code review", type: "code", acceptance: "Complete the code task.", depends_on: [], replaces: [], review: false },
              { id: "T-research", title: "Require research review", type: "research", acceptance: "Complete the research task.", depends_on: [], replaces: [], review: true, notes: "manager-note-handoff-marker" },
            ],
            event: "work.planned",
          },
        }
      : {
          outcome: "success",
          report_valid: true,
          report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "The Work is complete.", missing: [], lessons: [] } },
        },
    runWorker: async (request) => {
      workerRequests.push(request);
      return {
        outcome: "success",
        report_valid: true,
        report: {
          kind: "report",
          schema_version: "1.0.0",
          invocation_id: request.invocation_id,
          result: "success",
          work_done: `${request.context.task.title} completed.`,
          changes: [],
          verification: { passed: true, method: "Checked the result." },
          remaining_issues: [],
          next_action: "none",
          needs_replanning: false,
          question_for_manager: null,
        },
      };
    },
    runReviewer: async (request) => {
      reviewerRequests.push(request);
      const review = { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  try {
    await core.start();
    const created = await core.createWork(commandEnvelope({
      title: "Check Manager review options",
      summary: "Review dispatch should follow the Manager's per-task choice.",
      size: "normal",
      project_id: null,
    }, "manager-review-choice-create"));
    await core.startWork(created.data.work_id, {
      ...commandEnvelope({ mode: "normal" }, "manager-review-choice-start"),
      expected_version: created.version,
    });

    const deadline = Date.now() + 5_000;
    while ((workerRequests.length < 2 || reviewerRequests.length < 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(workerRequests.length, 2);
    assert.equal(reviewerRequests.length, 1);
    assert.equal(workerRequests.find((request) => request.context.task.type === "research").context.task.review, true);
    assert.match(workerRequests.find((request) => request.context.task.type === "research").context.task.context, /manager-note-handoff-marker/u);
    assert.equal(workerRequests.find((request) => request.context.task.type === "code").context.task.review, false);
    assert.equal(reviewerRequests[0].context.task.type, "research");
    assert.equal(db.get("SELECT review_override FROM tasks WHERE work_id = ? AND type = 'research'", created.data.work_id).review_override, "true");
    assert.equal(db.get("SELECT review_override FROM tasks WHERE work_id = ? AND type = 'code'", created.data.work_id).review_override, "false");
  } finally {
    await core.stop({ force: true });
    db.close();
  }
});

test("advisor turn migration persists a channel-id column for restart recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-migration-"));
  const db = openDatabase(join(root, "owl.db"));
  try {
    const beforeSix = join(root, "migrations-before-six");
    await mkdir(beforeSix, { recursive: true });
    for (const filename of [
      "001_initial.sql",
      "002_advisor_persistent_session.sql",
      "003_conversation_triage.sql",
      "004_runtime_recovery.sql",
      "005_artifact_storage.sql",
    ]) {
      await copyFile(join(repoRoot, "packages/db/migrations", filename), join(beforeSix, filename));
    }
    db.migrate(beforeSix);

    const now = new Date().toISOString();
    const ownerId = "owner:migration-test";
    const accountId = "account:migration-test";
    const conversationId = "conversation:migration-test";
    const messageId = "message:migration-test";
    const sessionId = "session:migration-test";
    await db.createWriteLane().transact((transaction) => {
      transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", ownerId, "Migration owner", now, now);
      transaction.run(
        "INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'slack', ?, ?)",
        accountId,
        ownerId,
        "slack:account",
        now,
      );
      transaction.run(
        `INSERT INTO conversations
           (id, owner_id, channel, thread_ref, dm_ref, is_active, created_at, updated_at)
         VALUES (?, ?, 'slack', ?, ?, 0, ?, ?)`,
        conversationId,
        ownerId,
        "1712345678.000100",
        "C-MIGRATION-ORIGIN",
        now,
        now,
      );
      transaction.run(
        `INSERT INTO messages
           (id, conversation_id, provider, account_id, source_message_id, body,
            attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'slack', ?, ?, ?, '[]', ?, ?)`,
        messageId,
        conversationId,
        accountId,
        "slack:source",
        "queued question",
        now,
        now,
      );
      transaction.run(
        `INSERT INTO advisor_sessions (id, status, conversation_id, last_activity_at, created_at, updated_at)
         VALUES (?, 'suspended', ?, ?, ?, ?)`,
        sessionId,
        conversationId,
        now,
        now,
        now,
      );
      transaction.run(
        `INSERT INTO advisor_turns
           (id, session_id, conversation_id, user_message_id, status, origin_channel, origin_ref, queued_at)
         VALUES (?, ?, ?, ?, 'queued', 'slack', ?, ?)`,
        "turn:migration-test",
        sessionId,
        conversationId,
        messageId,
        "1712345678.000100",
        now,
      );
    });

    const result = db.migrate(join(repoRoot, "packages/db/migrations"));
    assert.ok(result.applied.includes("006"));
    const columns = db.all("PRAGMA table_info(advisor_turns)");
    assert.ok(columns.some((column) => column.name === "origin_channel_id"));
    assert.equal(
      db.get("SELECT origin_channel_id FROM advisor_turns WHERE id = ?", "turn:migration-test").origin_channel_id,
      "C-MIGRATION-ORIGIN",
    );

    const recoveredEvent = {
      payload: {
        origin: { channel: "slack", channel_id: "C-MIGRATION-ORIGIN", ref: "1712345678.000100" },
      },
    };
    assert.equal(resolveSlackAdvisorChannel(recoveredEvent, "C-MIGRATION-ORIGIN"), "C-MIGRATION-ORIGIN");
    assert.equal(resolveSlackAdvisorChannel(recoveredEvent, "C-CONFIGURED-CONVERSATION"), null);
  } finally {
    db.close();
  }
});
