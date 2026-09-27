import assert from "node:assert/strict";
import { test } from "node:test";

import { ConnectorManager } from "../apps/server/dist/connector-manager.js";
import { SlackConnector } from "../packages/connector-slack/dist/index.js";
import { DiscordConnector } from "../packages/connector-discord/dist/index.js";

function fakeStore(config = {}) {
  return {
    list: () => [{ provider: "slack", configured: true }],
    getConfig: () => config,
  };
}

test("startConnector calls stop() when start() throws, and never registers the connector", async () => {
  const manager = new ConnectorManager("/tmp/owl-root-fake", fakeStore(), 4000);
  const calls = [];
  manager.createConnector = async () => ({
    start: async () => { throw new Error("boom"); },
    stop: async () => { calls.push("stop"); },
  });

  await assert.rejects(manager.startConnector("slack"), /boom/);
  assert.deepEqual(calls, ["stop"], "stop() must run after a failed start()");

  // The failed connector was never added to the map: a later stopConnector()
  // call finds nothing to stop (no-op, no second stop() call, no throw).
  await manager.stopConnector("slack");
  assert.deepEqual(calls, ["stop"]);
});

test("startConnector still surfaces the start() error even when the cleanup stop() also fails", async () => {
  const manager = new ConnectorManager("/tmp/owl-root-fake", fakeStore(), 4000);
  manager.createConnector = async () => ({
    start: async () => { throw new Error("start failed"); },
    stop: async () => { throw new Error("stop also failed"); },
  });

  await assert.rejects(manager.startConnector("slack"), /start failed/);
});

test("a successful start() registers the connector so a later stopConnector() reaches it", async () => {
  const manager = new ConnectorManager("/tmp/owl-root-fake", fakeStore(), 4000);
  let started = false;
  let stopped = false;
  manager.createConnector = async () => ({
    start: async () => { started = true; },
    stop: async () => { stopped = true; },
  });

  await manager.startConnector("slack");
  assert.equal(started, true);
  await manager.stopConnector("slack");
  assert.equal(stopped, true);
});

// --- Connectors connect to the platform before subscribing to Core, and self-clean-up
// on failure ------------------------------------------------------------------------

function slackConnector() {
  return new SlackConnector({
    botToken: "xoxb-start-order-test",
    appToken: "xapp-start-order-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
}

function discordConnector() {
  return new DiscordConnector({
    botToken: "discord-start-order-test",
    conversationChannelId: "D-CONVERSATION",
    notificationChannelId: "D-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
}

test("Slack: a Socket Mode connect failure never reaches subscribeEvents, and a later stop() is still safe", async () => {
  const connector = slackConnector();
  connector.socket.on = () => connector.socket;
  connector.socket.start = async () => { throw new Error("bad token"); };
  connector.socket.disconnect = async () => {};
  let subscribed = false;
  connector.core.subscribeEvents = async () => { subscribed = true; };

  await assert.rejects(connector.start(), /bad token/);
  assert.equal(subscribed, false, "subscribeEvents must not run when connecting to Slack itself failed");

  // ConnectorManager always calls stop() after a failed start(); it must not throw.
  await connector.stop();
});

test("Slack: a subscribeEvents failure after connecting disconnects Slack again and is safe to stop() twice", async () => {
  const connector = slackConnector();
  connector.socket.on = () => connector.socket;
  connector.socket.start = async () => ({ ok: true });
  let disconnected = 0;
  connector.socket.disconnect = async () => { disconnected += 1; };
  connector.core.subscribeEvents = async () => { throw new Error("subscribe failed"); };

  await assert.rejects(connector.start(), /subscribe failed/);
  assert.equal(disconnected, 1, "Slack must be disconnected again when subscribing to Core fails");

  // ConnectorManager calls stop() again on the same connector; it must be a no-op.
  await connector.stop();
  assert.equal(disconnected, 1, "a second stop() must not disconnect Slack again");
});

test("Discord: a Gateway login failure never reaches subscribeEvents, and a later stop() is still safe", async () => {
  const connector = discordConnector();
  connector.client.on = () => connector.client;
  connector.client.login = async () => { throw new Error("bad token"); };
  connector.client.destroy = async () => {};
  let subscribed = false;
  connector.core.subscribeEvents = async () => { subscribed = true; };

  await assert.rejects(connector.start(), /bad token/);
  assert.equal(subscribed, false, "subscribeEvents must not run when logging into Discord itself failed");

  await connector.stop();
});

test("Discord: a subscribeEvents failure after connecting destroys the Gateway client again and is safe to stop() twice", async () => {
  const connector = discordConnector();
  connector.client.on = () => connector.client;
  connector.client.login = async () => "ok";
  let destroyed = 0;
  connector.client.destroy = async () => { destroyed += 1; };
  connector.core.subscribeEvents = async () => { throw new Error("subscribe failed"); };

  await assert.rejects(connector.start(), /subscribe failed/);
  assert.equal(destroyed, 1, "the Gateway client must be destroyed again when subscribing to Core fails");

  await connector.stop();
  assert.equal(destroyed, 1, "a second stop() must not destroy the client again");
});
