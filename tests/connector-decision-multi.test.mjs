import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyIntent,
  createDecisionButtonId,
  decisionShortId,
  isTransientDeliveryError,
  retryTransient,
} from "../packages/plugin-sdk/dist/shared/index.js";
import {
  SlackConnector,
  sendNotification as sendSlackNotification,
} from "../packages/connector-slack/dist/index.js";
import {
  DiscordConnector,
  sendNotification as sendDiscordNotification,
} from "../packages/connector-discord/dist/index.js";

const WORK_ID = "01ARZ3NDEKTSV4RRFFQ69WORK1";
// Core's default options for its own Decisions.
const DEFAULT_OPTIONS = [{ key: "retry", label: "再試行" }, { key: "cancel", label: "キャンセル" }];
const first = { id: "01ARZ3NDEKTSV4RRFFQ6AAAAA1", options: DEFAULT_OPTIONS, allow_free_text: true, reason: "Agentが報告なしで終了しました" };
const second = { id: "01ARZ3NDEKTSV4RRFFQ6BBBBB2", options: DEFAULT_OPTIONS, allow_free_text: true, reason: "Providerの応答が不正です" };
const buttonsOnly = { id: "01ARZ3NDEKTSV4RRFFQ6CCCCC3", options: DEFAULT_OPTIONS, allow_free_text: false };
const open = [first, second];

const noSleep = { baseDelayMs: 0 };

function decisionOpened(decision, extra = {}) {
  return {
    kind: "event",
    event_id: `event-${decision.id}`,
    sequence: 42,
    cursor: "42",
    type: "decision.opened",
    schema_version: "1.0.0",
    work_id: WORK_ID,
    payload: {
      work_id: WORK_ID,
      scope: "task",
      reason: decision.reason ?? "判断してください",
      options: decision.options,
      recommended: null,
      allow_free_text: decision.allow_free_text,
      decision_id: decision.id,
      ...extra,
    },
  };
}

function slackConnector() {
  return new SlackConnector({
    botToken: "xoxb-multi-decision-test",
    appToken: "xapp-multi-decision-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
}

function discordConnector() {
  return new DiscordConnector({
    botToken: "discord-multi-decision-test",
    conversationChannelId: "D-CONVERSATION",
    notificationChannelId: "D-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
}

function answerPayload(request) {
  return JSON.parse(JSON.stringify(request.init.body)).payload;
}

// --- Router: several open Decisions -----------------------------------------

test("回答 <short-id>: routes free text to the named Decision while several are open", () => {
  assert.equal(decisionShortId(second.id), "BBBBB2");
  for (const text of ["回答 BBBBB2: 別のProviderで再実行して", "回答 bbbbb2：別のProviderで再実行して", "answer BBBBB2: 別のProviderで再実行して"]) {
    assert.deepEqual(classifyIntent({ text }, open), {
      kind: "decision_answer",
      decisionId: second.id,
      answer: "別のProviderで再実行して",
      optionKey: null,
      optionLabel: null,
    }, text);
  }
});

test("回答 <short-id>: matches that Decision's option key/label and answers with the option label", () => {
  assert.deepEqual(classifyIntent({ text: "回答 AAAAA1: 再試行" }, open), {
    kind: "decision_answer", decisionId: first.id, answer: "再試行", optionKey: "retry", optionLabel: "再試行",
  });
  assert.deepEqual(classifyIntent({ text: "回答 CCCCC3: cancel" }, [...open, buttonsOnly]), {
    kind: "decision_answer", decisionId: buttonsOnly.id, answer: "キャンセル", optionKey: "cancel", optionLabel: "キャンセル",
  });
});

test("an ambiguous or unknown answer gets a clarification listing the open ids instead of reaching the Advisor", () => {
  const ambiguous = classifyIntent({ text: "回答: 再実行して" }, open);
  assert.equal(ambiguous.kind, "decision_clarification");
  assert.match(ambiguous.text, /AAAAA1: Agentが報告なしで終了しました/u);
  assert.match(ambiguous.text, /BBBBB2: Providerの応答が不正です/u);

  const unknown = classifyIntent({ text: "回答 ZZZZZ9: 再実行して" }, open);
  assert.equal(unknown.kind, "decision_clarification");
  assert.match(unknown.text, /ZZZZZ9/u);
  assert.match(unknown.text, /AAAAA1/u);

  // A bare label with no explicit answer prefix is ordinary conversation, even
  // though it happens to match an option shared by every open Decision.
  const bare = classifyIntent({ text: "再試行" }, open);
  assert.equal(bare.kind, "conversation");

  const freeTextNotAllowed = classifyIntent({ text: "回答 CCCCC3: 何か別のこと" }, [buttonsOnly]);
  assert.equal(freeTextNotAllowed.kind, "decision_clarification");
  assert.match(freeTextNotAllowed.text, /再試行 \/ キャンセル/u);

  const none = classifyIntent({ text: "回答: 進めて" }, []);
  assert.equal(none.kind, "decision_clarification");
});

test("a plain 回答: still answers the single open Decision, and ordinary chat is untouched", () => {
  assert.deepEqual(classifyIntent({ text: "回答: 進めて" }, [first]), {
    kind: "decision_answer", decisionId: first.id, answer: "進めて", optionKey: null, optionLabel: null,
  });
  assert.equal(classifyIntent({ text: "ありがとう" }, open).kind, "conversation");
  assert.equal(classifyIntent({ text: "ありがとう" }, []).kind, "conversation");
});

test("a reply to a Decision notification answers that Decision, prefix optional", () => {
  assert.deepEqual(classifyIntent({ text: "別のProviderで", replyToDecisionId: second.id }, open), {
    kind: "decision_answer", decisionId: second.id, answer: "別のProviderで", optionKey: null, optionLabel: null,
  });
  assert.deepEqual(classifyIntent({ text: "回答: キャンセル", replyToDecisionId: first.id }, open), {
    kind: "decision_answer", decisionId: first.id, answer: "キャンセル", optionKey: "cancel", optionLabel: "キャンセル",
  });
  const resolved = classifyIntent({ text: "進めて", replyToDecisionId: "01ARZ3NDEKTSV4RRFFQ6GONE00" }, open);
  assert.equal(resolved.kind, "decision_clarification");
});

// --- Slack: thread replies, clarification replies, default-option buttons ---

test("Slack: a reply in a Decision notification thread answers that Decision", async () => {
  const connector = slackConnector();
  const handlers = {};
  connector.socket.on = (name, handler) => { handlers[name] = handler; return connector.socket; };
  connector.socket.start = async () => ({ ok: true });
  connector.socket.disconnect = async () => {};
  connector.core.subscribeEvents = async () => {};
  await connector.start();

  const posts = [];
  let nextTs = 100;
  connector.web = { chat: { postMessage: async (message) => {
    posts.push(message);
    return { ok: true, ts: message.thread_ts ?? `1700000000.${nextTs++}` };
  } } };
  await connector.handleCoreEvent(decisionOpened(first));
  await connector.handleCoreEvent(decisionOpened(second));
  assert.equal(posts.length, 4, "each Decision has one main card and one thread detail");
  assert.match(posts[2].attachments[0].blocks.find((block) => block.type === "context").elements[0].text, /ID BBBBB2/u);

  connector.fetchPendingDecisions = async () => open;
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  connector.core.language = async () => "ja";

  await handlers.message({
    ack: async () => {},
    event: { user: "U1", channel: "C-NOTIFICATIONS", ts: "1700000001.000", thread_ts: "1700000000.101", text: "別のProviderで再実行して" },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, `/decisions/${second.id}/answer`);
  assert.deepEqual(answerPayload(requests[0]), {
    answer: "別のProviderで再実行して", option_key: null, source: "slack", source_message_id: "1700000001.000",
  });
  const ack = posts.at(-1);
  assert.equal(ack.channel, "C-NOTIFICATIONS");
  assert.equal(ack.thread_ts, "1700000000.101");

  // Unrelated notification-channel messages are still ignored.
  await handlers.message({
    ack: async () => {},
    event: { user: "U1", channel: "C-NOTIFICATIONS", ts: "1700000002.000", thread_ts: "1699999999.000", text: "hello" },
  });
  assert.equal(requests.length, 1);
  await connector.stop();
});

test("Slack: an ambiguous 回答: gets an id list reply instead of going to the Advisor", async () => {
  const connector = slackConnector();
  connector.fetchPendingDecisions = async () => open;
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  connector.core.language = async () => "ja";
  const posts = [];
  connector.web = { chat: { postMessage: async (message) => { posts.push(message); return { ok: true }; } } };

  await connector.handleMessage({ user: "U1", channel: "C-CONVERSATION", ts: "1700000003.000", text: "回答: 進めて" });
  assert.equal(requests.length, 0, "nothing is sent to Core (no Decision answer, no Advisor message)");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /AAAAA1/u);
  assert.match(posts[0].text, /BBBBB2/u);

  await connector.handleMessage({ user: "U1", channel: "C-CONVERSATION", ts: "1700000004.000", text: "回答 AAAAA1: 進めて" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, `/decisions/${first.id}/answer`);
});

test("Slack: Core default {key,label} options render as buttons and a click answers with the option label", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (message) => { posts.push(message); return { ok: true, ts: "1.1" }; } } };
  await sendSlackNotification(client, decisionOpened(first), [{ channelId: "C-NOTIFICATIONS" }]);
  const actions = posts[0].attachments[0].blocks.find((block) => block.type === "actions");
  assert.deepEqual(actions.elements.map((element) => [element.text.text, element.value]), [["再試行", "retry"], ["キャンセル", "cancel"]]);
  assert.deepEqual(actions.elements.map((element) => element.action_id), [
    createDecisionButtonId(first.id, 0),
    createDecisionButtonId(first.id, 1),
  ]);

  const connector = slackConnector();
  connector.fetchPendingDecisions = async () => open;
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  connector.core.language = async () => "ja";
  connector.web = { chat: { postMessage: async () => ({ ok: true }) } };
  await connector.handleInteraction({
    type: "block_actions",
    actions: [{ action_id: actions.elements[1].action_id, value: "cancel" }],
    channel: { id: "C-NOTIFICATIONS" },
    message: { ts: "1.1" },
  });
  assert.equal(requests[0].path, `/decisions/${first.id}/answer`);
  assert.deepEqual(answerPayload(requests[0]), { answer: "キャンセル", option_key: "cancel", source: "slack", source_message_id: "1.1" });
});

// --- Discord -------------------------------------------------------------------

test("Discord: a reply to a Decision notification answers that Decision; default options render as buttons", async () => {
  const connector = discordConnector();
  const sends = [];
  let nextId = 1;
  connector.client.channels.fetch = async (channelId) => ({
    isTextBased: () => true,
    send: async (message) => { sends.push({ channelId, message }); return { id: `M${nextId++}` }; },
  });
  await connector.handleCoreEvent(decisionOpened(first));
  await connector.handleCoreEvent(decisionOpened(second));
  assert.equal(sends.length, 4);
  const buttons = sends[0].message.components[0].toJSON().components;
  assert.deepEqual(buttons.map((button) => button.label), ["再試行", "キャンセル"]);
  assert.equal(buttons[0].custom_id, createDecisionButtonId(first.id, 0));

  connector.fetchPendingDecisions = async () => open;
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  connector.core.language = async () => "ja";
  const replies = [];
  const reply = {
    id: "R1",
    author: { id: "U1", bot: false },
    content: "キャンセル",
    channelId: "D-NOTIFICATIONS",
    reference: { messageId: "M3" },
    attachments: new Map(),
    channel: { isDMBased: () => false, isTextBased: () => true, send: async (message) => replies.push(message) },
  };
  let handler;
  connector.client.on = (name, fn) => { if (name === "messageCreate") handler = fn; return connector.client; };
  connector.core.subscribeEvents = async () => {};
  connector.client.login = async () => "ok";
  connector.client.destroy = async () => {};
  await connector.start();
  handler(reply);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, `/decisions/${second.id}/answer`);
  assert.deepEqual(answerPayload(requests[0]), { answer: "キャンセル", option_key: "cancel", source: "discord", source_message_id: "R1" });
  assert.match(replies[0].content, /BBBBB2/u);

  // A notification-channel message that does not reply to a Decision is ignored.
  handler({ ...reply, id: "R2", reference: undefined });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  await connector.stop();
});

// --- Notification delivery retry ---------------------------------------------

test("retryTransient retries transient failures with backoff and stops on permanent ones", async () => {
  const delays = [];
  let calls = 0;
  const result = await retryTransient(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return "ok";
  }, { baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result, "ok");
  assert.deepEqual(delays, [10, 20]);

  calls = 0;
  await assert.rejects(retryTransient(async () => {
    calls += 1;
    throw Object.assign(new Error("An API error occurred: channel_not_found"), { code: "slack_webapi_platform_error", data: { error: "channel_not_found" } });
  }, noSleep), (error) => error.attempts === 1);
  assert.equal(calls, 1);

  assert.equal(isTransientDeliveryError({ status: 503 }), true);
  assert.equal(isTransientDeliveryError({ status: 404 }), false);
  assert.equal(isTransientDeliveryError({ code: "slack_webapi_platform_error", data: { error: "internal_error" } }), true);
});

test("Slack notification retries a transient post failure, then reports the final failure with the event sequence", async () => {
  let calls = 0;
  const flaky = { chat: { postMessage: async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("request failed"), { code: "slack_webapi_request_error" });
    return { ok: true, ts: "2.2" };
  } } };
  const posted = [];
  await sendSlackNotification(flaky, decisionOpened(first), [{ channelId: "C-NOTIFICATIONS" }], {
    retry: noSleep,
    onPosted: (ref) => posted.push(ref),
  });
  assert.equal(calls, 3, "two main post attempts are followed by one detail post");
  assert.deepEqual(posted, [{ channelId: "C-NOTIFICATIONS", ts: "2.2" }]);

  const connector = slackConnector();
  const posts = [];
  connector.web = { chat: { postMessage: async (message) => {
    if (message.channel === "C-NOTIFICATIONS") {
      throw Object.assign(new Error("An API error occurred: internal_error"), { code: "slack_webapi_platform_error", data: { error: "internal_error" } });
    }
    posts.push(message);
    return { ok: true };
  } } };
  const errors = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  console.warn = () => {};
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => originalSetTimeout(fn, 0);
  try {
    await connector.handleCoreEvent(decisionOpened(second));
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.ok(errors.some((line) => /event #42 \(decision\.opened.*failed after 3 attempt/u.test(line)), errors.join("\n"));
  assert.equal(posts.length, 1, "the final failure is posted to the conversation channel");
  assert.equal(posts[0].channel, "C-CONVERSATION");
  assert.match(posts[0].text, /イベント #42 decision\.opened, Decision BBBBB2/u);
});

test("Discord notification retries a transient send failure", async () => {
  let calls = 0;
  const posted = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    send: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("Service Unavailable"), { status: 503 });
      return { id: "M9" };
    },
  }) } };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await sendDiscordNotification(client, decisionOpened(first), "D-NOTIFICATIONS", {
      retry: noSleep,
      onPosted: (ref) => posted.push(ref),
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls, 4);
  assert.deepEqual(posted, [{ channelId: "D-NOTIFICATIONS", messageId: "M9" }]);
});
