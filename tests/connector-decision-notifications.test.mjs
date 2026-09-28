import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SlackConnector,
  sendNotification as sendSlackNotification,
} from "../packages/connector-slack/dist/index.js";
import {
  DiscordConnector,
  sendNotification as sendDiscordNotification,
} from "../packages/connector-discord/dist/index.js";

const WORK_ID = "01ARZ3NDEKTSV4RRFFQ69WORK1";
const DECISION_ID = "01ARZ3NDEKTSV4RRFFQ6DECIS1";

function event(type, payload, extra = {}) {
  return {
    kind: "event",
    event_id: `event-${type}`,
    sequence: 1,
    cursor: "1",
    type,
    schema_version: "1.0.0",
    payload,
    ...extra,
  };
}

// Shape emitted by Core DecisionService.open(): the request payload plus decision_id.
function decisionOpened(overrides = {}) {
  return event("decision.opened", {
    work_id: WORK_ID,
    scope: "work",
    blocked_task_ids: [],
    reason: "DBマイグレーションを本番に適用してよいか判断が必要です",
    tried: "ステージングで適用し、テストが通ることを確認しました",
    current_state: "マイグレーション待ちで停止中",
    options: [],
    recommended: null,
    allow_free_text: true,
    issuer_role: "manager",
    decision_id: DECISION_ID,
    ...overrides,
  }, { work_id: WORK_ID });
}

function slackClient() {
  const posts = [];
  return { posts, client: { chat: { postMessage: async (message) => {
    posts.push(message);
    return { ok: true, ts: `1700000000.${String(posts.length).padStart(3, "0")}` };
  } } } };
}

function discordClient() {
  const sends = [];
  return {
    sends,
    client: {
      channels: {
        fetch: async (channelId) => ({
          isTextBased: () => true,
          send: async (message) => {
            sends.push({ channelId, message });
            return { id: `M${sends.length}` };
          },
        }),
      },
    },
  };
}

function embedData(send) {
  const embed = send.message.embeds[0];
  return typeof embed.toJSON === "function" ? embed.toJSON() : embed.data;
}

function slackConnector() {
  return new SlackConnector({
    botToken: "xoxb-decision-notification-test",
    appToken: "xapp-decision-notification-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
}

function discordConnector() {
  return new DiscordConnector({
    botToken: "discord-decision-notification-test",
    conversationChannelId: "D-CONVERSATION",
    notificationChannelId: "D-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
}

// --- Fix 1: decision.opened renders reason / tried / current_state ---------

test("Slack decision notification renders reason, tried and current_state from the real payload", async () => {
  const { posts, client } = slackClient();
  await sendSlackNotification(client, decisionOpened(), [{ channelId: "C-NOTIFICATIONS" }]);

  assert.equal(posts.length, 2);
  const main = posts[0];
  const mainBlocks = main.attachments[0].blocks;
  const mainBody = mainBlocks.find((block) => block.type === "section").text.text;
  assert.equal(main.attachments[0].color, "#F5A623");
  assert.equal(main.attachments[0].fallback, main.text);
  assert.match(mainBody, /❓ DBマイグレーションを本番に適用してよいか判断が必要です/u);
  assert.doesNotMatch(mainBody, /ステージング|マイグレーション待ち|回答 DECIS1/u);
  assert.match(mainBlocks.find((block) => block.type === "context").elements[0].text, /WORK1.*ID DECIS1/u);
  assert.equal(mainBlocks.some((block) => block.type === "actions"), false);

  assert.equal(posts[1].thread_ts, "1700000000.001");
  assert.match(posts[1].text, /ステージングで適用し、テストが通ることを確認しました/u);
  assert.match(posts[1].text, /マイグレーション待ちで停止中/u);
  assert.match(posts[1].text, /回答 DECIS1:/u);
});

test("Slack decision notification falls back to legacy question and omits absent sections", async () => {
  const { posts, client } = slackClient();
  await sendSlackNotification(client, decisionOpened({
    reason: undefined,
    tried: undefined,
    current_state: undefined,
    question: "どちらの案で進めますか",
    options: [{ key: "a", label: "A案" }, { key: "b", label: "B案" }],
    allow_free_text: false,
  }), [{ channelId: "C-NOTIFICATIONS" }]);

  const mainBody = posts[0].attachments[0].blocks.find((block) => block.type === "section").text.text;
  assert.match(mainBody, /❓ どちらの案で進めますか/u);
  assert.match(mainBody, /• A案\n• B案/u);
  assert.doesNotMatch(mainBody, /試したこと|現状|回答 DECIS1/u);
  assert.match(posts[1].text, /回答 DECIS1:/u, "answer guidance is in the thread detail");
  const actions = posts[0].attachments[0].blocks.find((block) => block.type === "actions");
  assert.equal(actions.elements.length, 2);
});

test("Discord decision notification renders reason, tried and current_state from the real payload", async () => {
  const { sends, client } = discordClient();
  await sendDiscordNotification(client, decisionOpened(), "D-NOTIFICATIONS");

  assert.equal(sends.length, 2);
  const data = embedData(sends[0]);
  assert.equal(data.title, "✋ 判断が必要です");
  assert.equal(data.description, "❓ DBマイグレーションを本番に適用してよいか判断が必要です");
  assert.doesNotMatch(data.description, /ステージングで適用|マイグレーション待ち|回答/u);
  assert.match(embedData(sends[1]).description, /ステージングで適用し、テストが通ることを確認しました/u);
  assert.match(embedData(sends[1]).description, /マイグレーション待ちで停止中/u);
  assert.match(embedData(sends[1]).description, /回答 DECIS1:/u);
  assert.equal(sends[1].message.reply.messageReference, "M1");
  assert.match(data.footer.text, /ID DECIS1/u);
  assert.equal(sends[0].message.components.length, 0, "no empty button row when there are no options");
});

test("Discord decision notification falls back to legacy question", async () => {
  const { sends, client } = discordClient();
  await sendDiscordNotification(client, decisionOpened({
    reason: undefined,
    tried: undefined,
    current_state: undefined,
    question: "どちらの案で進めますか",
    allow_free_text: false,
    options: [{ key: "a", label: "A案" }],
  }), "D-NOTIFICATIONS");
  assert.equal(sends.length, 2);
  const data = embedData(sends[0]);
  assert.match(data.description, /どちらの案で進めますか/u);
  assert.match(data.description, /• A案/u);
  assert.doesNotMatch(data.description, /回答 DECIS1/u);
  assert.match(embedData(sends[1]).description, /回答 DECIS1:/u);
  assert.equal(sends[1].message.reply.messageReference, "M1");
});

// --- Fix 3: failure notifications come from system.alert, not work.failed ---

const tickFailure = () => event("system.alert", {
  kind: "workflow_tick_failed",
  safe_reconcile_failed: true,
  driver_stopped: true,
  message: "CoreはWorkの自動駆動を停止しました。Workflowの処理に失敗しました。",
  remediation: "Coreログを確認し、必要ならDecisionを解決してからWorkを再開してください。",
  failure: "Workflowの処理に失敗しました。",
}, { work_id: WORK_ID });

test("Slack connector subscribes to events Core actually emits and notifies work-scoped system.alert failures", async () => {
  const connector = slackConnector();
  let subscribed = null;
  connector.core.subscribeEvents = async (types) => { subscribed = types; };
  connector.socket.on = () => connector.socket;
  connector.socket.start = async () => ({ ok: true });
  connector.socket.disconnect = async () => {};
  await connector.start();
  assert.ok(subscribed.includes("system.alert"));
  assert.ok(subscribed.includes("provider.paused"));
  assert.ok(subscribed.includes("provider.resumed"));
  assert.equal(subscribed.includes("work.failed"), false, "Core never emits work.failed");

  const posts = [];
  connector.web = { chat: { postMessage: async (message) => posts.push(message) } };
  await connector.handleCoreEvent(tickFailure());
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-NOTIFICATIONS");
  assert.match(posts[0].text, /問題が発生/u);
  const blocks = posts[0].attachments[0].blocks;
  assert.match(blocks.find((block) => block.type === "section").text.text, /自動駆動を停止しました/u);
  assert.match(blocks.find((block) => block.type === "section" && block.text.text.includes("対処")).text.text, /Coreログを確認/u, "remediation is shown");
  assert.match(blocks.find((block) => block.type === "context").elements[0].text, /WORK1/u, "work id from the event frame is shown");
  await connector.stop();
});

test("Discord connector subscribes to events Core actually emits and notifies work-scoped system.alert failures", async () => {
  const connector = discordConnector();
  let subscribed = null;
  connector.core.subscribeEvents = async (types) => { subscribed = types; };
  connector.client.login = async () => "ok";
  connector.client.destroy = async () => {};
  await connector.start();
  assert.ok(subscribed.includes("system.alert"));
  assert.equal(subscribed.includes("work.failed"), false, "Core never emits work.failed");

  const { sends, client } = discordClient();
  connector.client.channels.fetch = client.channels.fetch;
  await connector.handleCoreEvent(tickFailure());
  assert.equal(sends.length, 1);
  const data = embedData(sends[0]);
  assert.equal(data.title, "🚨 問題が発生");
  assert.equal(data.color, 0xf44336);
  assert.match(data.description, /自動駆動を停止しました/u);
  assert.equal(data.fields[0].name, "対処");
  assert.match(data.fields[0].value, /Coreログを確認/u);
  assert.match(data.footer.text, /WORK1/u);
  await connector.stop();
});

test("system.alert without a message (internal bookkeeping) is still not notified", async () => {
  const { posts, client } = slackClient();
  const connector = slackConnector();
  connector.web = client;
  await connector.handleCoreEvent(event("system.alert", { kind: "work_created", schema_version: "1.0.0" }, { work_id: WORK_ID }));
  assert.equal(posts.length, 0);
});

// --- decision.resolved / decision.cancelled follow-up notifications --------

function decisionResolved(overrides = {}) {
  return event("decision.resolved", {
    decision_id: DECISION_ID,
    work_id: WORK_ID,
    answer: "B案で進めます",
    ...overrides,
  }, { work_id: WORK_ID });
}

function decisionCancelled(overrides = {}) {
  return event("decision.cancelled", {
    decision_id: DECISION_ID,
    work_id: WORK_ID,
    reason: "work_cancelled",
    ...overrides,
  }, { work_id: WORK_ID });
}

test("Slack posts a follow-up for decision.resolved with the answer text", async () => {
  const { posts, client } = slackClient();
  await sendSlackNotification(client, decisionResolved(), [{ channelId: "C-NOTIFICATIONS" }]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /解決しました/u);
  const blocks = posts[0].attachments[0].blocks;
  assert.match(blocks.find((block) => block.type === "section").text.text, /B案で進めます/u);
  assert.match(blocks.find((block) => block.type === "context").elements[0].text, /WORK1.*DECIS1/u);
});

test("Slack posts a follow-up for decision.cancelled naming the reason", async () => {
  const { posts, client } = slackClient();
  await sendSlackNotification(client, decisionCancelled(), [{ channelId: "C-NOTIFICATIONS" }]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /取り消されました/u);
  assert.match(posts[0].attachments[0].blocks.find((block) => block.type === "section").text.text, /Workが中止されたため/u);

  const { posts: posts2, client: client2 } = slackClient();
  await sendSlackNotification(client2, decisionCancelled({ reason: "task_superseded" }), [{ channelId: "C-NOTIFICATIONS" }]);
  assert.match(posts2[0].attachments[0].blocks.find((block) => block.type === "section").text.text, /対象のTaskが置き換えられたため/u);
});

test("Discord posts a follow-up for decision.resolved and decision.cancelled", async () => {
  const { sends, client } = discordClient();
  await sendDiscordNotification(client, decisionResolved(), "D-NOTIFICATIONS");
  await sendDiscordNotification(client, decisionCancelled(), "D-NOTIFICATIONS");
  assert.equal(sends.length, 2);

  const resolved = embedData(sends[0]);
  assert.equal(resolved.title, "☑️ 解決しました");
  assert.equal(resolved.fields[0].name, "回答");
  assert.match(resolved.fields[0].value, /B案で進めます/u);
  assert.match(resolved.footer.text, /ID DECIS1/u);

  const cancelled = embedData(sends[1]);
  assert.equal(cancelled.title, "🚫 取り消されました");
  assert.equal(cancelled.fields[0].name, "理由");
  assert.match(cancelled.fields[0].value, /Workが中止されたため/u);
});

test("Slack and Discord connectors subscribe to decision.resolved and decision.cancelled", async () => {
  const slack = slackConnector();
  let slackTypes = null;
  slack.core.subscribeEvents = async (types) => { slackTypes = types; };
  slack.socket.on = () => slack.socket;
  slack.socket.start = async () => ({ ok: true });
  slack.socket.disconnect = async () => {};
  await slack.start();
  assert.ok(slackTypes.includes("decision.resolved"));
  assert.ok(slackTypes.includes("decision.cancelled"));
  await slack.stop();

  const discord = discordConnector();
  let discordTypes = null;
  discord.core.subscribeEvents = async (types) => { discordTypes = types; };
  discord.client.login = async () => "ok";
  discord.client.destroy = async () => {};
  await discord.start();
  assert.ok(discordTypes.includes("decision.resolved"));
  assert.ok(discordTypes.includes("decision.cancelled"));
  assert.ok(discordTypes.includes("provider.paused"));
  assert.ok(discordTypes.includes("provider.resumed"));
  await discord.stop();
});

// --- decision.resolved / decision.cancelled edit the original notice in place ---

test("Slack: a resolved Decision edits its original notification instead of posting a new one", async () => {
  const connector = slackConnector();
  const posts = [];
  const updates = [];
  connector.web = {
    chat: {
      postMessage: async (message) => { posts.push(message); return { ok: true, ts: "9.1" }; },
      update: async (args) => { updates.push(args); return { ok: true }; },
    },
  };

  await connector.handleCoreEvent(decisionOpened());
  assert.equal(posts.length, 2, "the opened Decision also gets its thread detail");
  assert.deepEqual(connector.core.decisionMessage(DECISION_ID), {
    channel_id: "C-NOTIFICATIONS",
    message_ref: "9.1",
    posted_at: connector.core.decisionMessage(DECISION_ID).posted_at,
  });

  await connector.handleCoreEvent(decisionResolved());
  assert.equal(posts.length, 2, "no new message is posted for the resolved event");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].channel, "C-NOTIFICATIONS");
  assert.equal(updates[0].ts, "9.1");
  assert.match(updates[0].text, /解決しました/u);
  assert.match(updates[0].text, /B案で進めます/u);
  assert.equal(updates[0].attachments[0].color, "#4CAF50");
  assert.equal(updates[0].attachments[0].blocks.some((block) => block.type === "actions"), false);
  assert.equal(connector.core.decisionMessage(DECISION_ID), null, "the mapping is forgotten once the Decision closes");
});

test("Discord: a cancelled Decision edits its original notification instead of sending a new one", async () => {
  const connector = discordConnector();
  const sends = [];
  const edits = [];
  connector.client.channels.fetch = async (channelId) => ({
    isTextBased: () => true,
    send: async (message) => { sends.push({ channelId, message }); return { id: "M1" }; },
    messages: { fetch: async (id) => ({ edit: async (options) => { edits.push({ id, options }); } }) },
  });

  await connector.handleCoreEvent(decisionOpened());
  assert.equal(sends.length, 2, "the main card and its decision detail are posted");
  assert.deepEqual(connector.core.decisionMessage(DECISION_ID), {
    channel_id: "D-NOTIFICATIONS",
    message_ref: "M1",
    posted_at: connector.core.decisionMessage(DECISION_ID).posted_at,
  });

  await connector.handleCoreEvent(decisionCancelled());
  assert.equal(sends.length, 2, "no new message is sent for the cancelled event");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].id, "M1");
  const edited = edits[0].options.embeds[0];
  const data = typeof edited.toJSON === "function" ? edited.toJSON() : edited.data;
  assert.equal(data.title, "🚫 取り消されました");
  assert.deepEqual(edits[0].options.components, []);
  assert.equal(connector.core.decisionMessage(DECISION_ID), null);
});

// --- Fix 5: work.completed payload has no title ------------------------------

test("work.completed without title falls back to the work id instead of a duplicated generic label", async () => {
  const completed = event("work.completed", { work_id: WORK_ID, manager_final_verdict: "complete" }, { work_id: WORK_ID });

  const { posts, client } = slackClient();
  await sendSlackNotification(client, completed, [{ channelId: "C-NOTIFICATIONS" }]);
  assert.equal(posts[0].text, "✅ 完了しました: Work 9WORK1");

  const discord = discordClient();
  await sendDiscordNotification(discord.client, completed, "D-NOTIFICATIONS");
  assert.equal(embedData(discord.sends[0]).title, "✅ 完了しました");
  assert.equal(embedData(discord.sends[0]).description, "Work 9WORK1");
});

// --- work.paused / work.reopened notifications --------------------------------

function workPaused(overrides = {}) {
  return event("work.paused", { work_id: WORK_ID, reason: "レビュー待ちのため", ...overrides }, { work_id: WORK_ID });
}

function workReopened(overrides = {}) {
  return event("work.reopened", { work_id: WORK_ID, reason: "追加対応が必要なため", ...overrides }, { work_id: WORK_ID });
}

test("Slack notifies work.paused and work.reopened, including the reason given", async () => {
  const { posts, client } = slackClient();
  await sendSlackNotification(client, workPaused(), [{ channelId: "C-NOTIFICATIONS" }]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /⏸️ 一時停止しました: Work 9WORK1/u);
  assert.match(posts[0].attachments[0].blocks.find((block) => block.type === "section" && block.text.text.includes("理由")).text.text, /レビュー待ちのため/u);

  const { posts: posts2, client: client2 } = slackClient();
  await sendSlackNotification(client2, workReopened(), [{ channelId: "C-NOTIFICATIONS" }]);
  assert.equal(posts2.length, 1);
  assert.match(posts2[0].text, /🔄 再オープンしました: Work 9WORK1/u);
  assert.match(posts2[0].attachments[0].blocks.find((block) => block.type === "section" && block.text.text.includes("理由")).text.text, /追加対応が必要なため/u);
});

test("Slack notifies work.paused without a reason line when none was given", async () => {
  const { posts, client } = slackClient();
  await sendSlackNotification(client, workPaused({ reason: "" }), [{ channelId: "C-NOTIFICATIONS" }]);
  assert.equal(posts[0].text, "⏸️ 一時停止しました: Work 9WORK1");
});

test("Discord notifies work.paused and work.reopened, including the reason given", async () => {
  const { sends, client } = discordClient();
  await sendDiscordNotification(client, workPaused(), "D-NOTIFICATIONS");
  await sendDiscordNotification(client, workReopened(), "D-NOTIFICATIONS");
  assert.equal(sends.length, 2);

  const paused = embedData(sends[0]);
  assert.equal(paused.title, "⏸️ 一時停止しました");
  assert.equal(paused.description, "Work 9WORK1");
  assert.match(paused.fields[0].value, /レビュー待ちのため/u);

  const reopened = embedData(sends[1]);
  assert.equal(reopened.title, "🔄 再オープンしました");
  assert.equal(reopened.description, "Work 9WORK1");
  assert.match(reopened.fields[0].value, /追加対応が必要なため/u);
});

test("Slack and Discord connectors subscribe to work.paused and work.reopened, and route them to the notification channel", async () => {
  const slack = slackConnector();
  let slackTypes = null;
  slack.core.subscribeEvents = async (types) => { slackTypes = types; };
  slack.socket.on = () => slack.socket;
  slack.socket.start = async () => ({ ok: true });
  slack.socket.disconnect = async () => {};
  await slack.start();
  assert.ok(slackTypes.includes("work.paused"));
  assert.ok(slackTypes.includes("work.reopened"));

  const posts = [];
  slack.web = { chat: { postMessage: async (message) => posts.push(message) } };
  await slack.handleCoreEvent(workPaused());
  await slack.handleCoreEvent(workReopened());
  assert.equal(posts.length, 2);
  assert.equal(posts[0].channel, "C-NOTIFICATIONS");
  assert.equal(posts[1].channel, "C-NOTIFICATIONS");
  await slack.stop();

  const discord = discordConnector();
  let discordTypes = null;
  discord.core.subscribeEvents = async (types) => { discordTypes = types; };
  discord.client.login = async () => "ok";
  discord.client.destroy = async () => {};
  await discord.start();
  assert.ok(discordTypes.includes("work.paused"));
  assert.ok(discordTypes.includes("work.reopened"));
  assert.ok(discordTypes.includes("provider.paused"));
  assert.ok(discordTypes.includes("provider.resumed"));

  const { sends, client: fetchClient } = discordClient();
  discord.client.channels.fetch = fetchClient.channels.fetch;
  await discord.handleCoreEvent(workPaused());
  await discord.handleCoreEvent(workReopened());
  assert.equal(sends.length, 2);
  await discord.stop();
});
