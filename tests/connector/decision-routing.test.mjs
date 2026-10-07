import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyIntent, createDecisionButtonId } from "../../packages/plugin-sdk/dist/shared/index.js";
import { CoreRequestError } from "../../packages/plugin-sdk/dist/index.js";
import { SlackConnector } from "../../packages/connector-slack/dist/index.js";
import { DiscordConnector } from "../../packages/connector-discord/dist/index.js";

const DECISION_ID = "01ARZ3NDEKTSV4RRFFQ6DECIS1";
const freeTextDecision = { id: DECISION_ID, options: [], allow_free_text: true };
const optionDecision = {
  id: "01ARZ3NDEKTSV4RRFFQ6DECIS2",
  options: [{ key: "approve", label: "承認" }, { key: "reject", label: "却下" }],
  allow_free_text: true,
};

// --- Fix 2: free-text answers must be explicit -------------------------------

test("ordinary short messages are NOT hijacked as the answer to the single open free-text Decision", () => {
  for (const text of ["ありがとう", "了解、あとでやる", "READMEも更新しておいて", "明日の予定は"]) {
    const intent = classifyIntent({ text }, [freeTextDecision]);
    assert.equal(intent.kind, "conversation", `"${text}" should reach the Advisor`);
    assert.equal(intent.text, text);
  }
});

test("an explicit answer prefix routes free text to the single open Decision and strips the prefix", () => {
  const cases = [
    ["回答: 本番に適用してOK", "本番に適用してOK"],
    ["回答：本番に適用してOK", "本番に適用してOK"],
    ["answer: go ahead", "go ahead"],
    ["Answer:go ahead", "go ahead"],
  ];
  for (const [text, answer] of cases) {
    const intent = classifyIntent({ text }, [freeTextDecision]);
    assert.deepEqual(intent, { kind: "decision_answer", decisionId: DECISION_ID, answer, optionKey: null, optionLabel: null }, text);
  }
});

test("an explicit answer prefix still matches option keys/labels exactly", () => {
  const intent = classifyIntent({ text: "回答: 承認" }, [optionDecision]);
  assert.deepEqual(intent, { kind: "decision_answer", decisionId: optionDecision.id, answer: "承認", optionKey: "approve", optionLabel: "承認" });
});

test("a bare option label with no explicit answer prefix reaches the Advisor as ordinary conversation", () => {
  const intent = classifyIntent({ text: "承認" }, [optionDecision]);
  assert.equal(intent.kind, "conversation");
  assert.equal(intent.text, "承認");
});

test("prefixed free text is not routed when the target Decision is ambiguous or free text is not allowed", () => {
  // Several open and no id: ask which one instead of silently reaching the Advisor.
  const ambiguous = classifyIntent({ text: "回答: 進めて" }, [freeTextDecision, { ...optionDecision }]);
  assert.equal(ambiguous.kind, "decision_clarification");
  assert.match(ambiguous.text, /DECIS1/u);
  assert.match(ambiguous.text, /DECIS2/u);
  assert.match(ambiguous.text, /回答 <ID>: 内容/u);
  const closed = classifyIntent({ text: "回答: 進めて" }, [{ ...freeTextDecision, allow_free_text: false }]);
  assert.equal(closed.kind, "decision_clarification");
});

test("an empty explicit answer is not submitted", () => {
  const intent = classifyIntent({ text: "回答:   " }, [freeTextDecision]);
  assert.notEqual(intent.kind, "decision_answer");
});

// --- Fix 4: button answers always send source_message_id ---------------------

test("Slack button answer sends source_message_id: null when the payload has no message", async () => {
  const connector = new SlackConnector({
    botToken: "xoxb-button-source-test",
    appToken: "xapp-button-source-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  connector.fetchPendingDecisions = async () => [optionDecision];
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  connector.core.language = async () => "ja";
  connector.web = { chat: { postMessage: async () => ({ ok: true }) } };

  await connector.handleInteraction({
    type: "block_actions",
    actions: [{ action_id: createDecisionButtonId(optionDecision.id, 0), value: "approve" }],
    user: { id: "U1" },
    channel: { id: "C-NOTIFICATIONS" },
  });

  assert.equal(requests.length, 1);
  const payload = JSON.parse(JSON.stringify(requests[0].init.body)).payload;
  assert.ok(Object.hasOwn(payload, "source_message_id"), "source_message_id must survive JSON serialization");
  assert.equal(payload.source_message_id, null);
  assert.equal(payload.option_key, "approve");
});

test("Discord button answer sends source_message_id: null when the interaction message is missing", async () => {
  const connector = new DiscordConnector({
    botToken: "discord-button-source-test",
    conversationChannelId: "D-CONVERSATION",
    notificationChannelId: "D-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  connector.fetchPendingDecisions = async () => [optionDecision];
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  connector.core.language = async () => "ja";
  const interaction = {
    isButton: () => true,
    channelId: "D-NOTIFICATIONS",
    customId: createDecisionButtonId(optionDecision.id, 1),
    message: undefined,
    deferred: false,
    replied: false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async () => {},
    reply: async () => {},
  };
  await connector.handleButtonInteraction(interaction);
  assert.equal(requests.length, 1);
  const payload = JSON.parse(JSON.stringify(requests[0].init.body)).payload;
  assert.ok(Object.hasOwn(payload, "source_message_id"));
  assert.equal(payload.source_message_id, null);
  assert.equal(payload.option_key, "reject");
});

// --- Button and text-answer submissions use a deterministic idempotency key,
// and a settled Decision is reported as "already answered" instead of an error. ----

test("Slack: clicking the same button twice reuses the same idempotency_key and expected_version", async () => {
  const versionedDecision = { ...optionDecision, state_version: 3 };
  const connector = new SlackConnector({
    botToken: "xoxb-idem-test",
    appToken: "xapp-idem-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  connector.fetchPendingDecisions = async () => [versionedDecision];
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  connector.core.language = async () => "ja";
  connector.web = { chat: { postMessage: async () => ({ ok: true }) } };

  const interaction = {
    type: "block_actions",
    actions: [{ action_id: createDecisionButtonId(versionedDecision.id, 0), value: "approve" }],
    user: { id: "U1" },
    channel: { id: "C-NOTIFICATIONS" },
    message: { ts: "1700000005.000" },
  };
  await connector.handleInteraction(interaction);
  await connector.handleInteraction(interaction);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.body.idempotency_key, requests[1].init.body.idempotency_key);
  assert.equal(requests[0].init.body.expected_version, 3);
  assert.equal(requests[1].init.body.expected_version, 3);
});

test("Slack: a button click on an already-settled Decision replies 'already answered' instead of an error", async () => {
  const connector = new SlackConnector({
    botToken: "xoxb-settled-test",
    appToken: "xapp-settled-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  connector.fetchPendingDecisions = async () => [optionDecision];
  connector.core.request = async () => {
    throw new CoreRequestError(409, "decision_already_resolved", "already resolved");
  };
  connector.core.language = async () => "ja";
  const posts = [];
  connector.web = { chat: { postMessage: async (message) => { posts.push(message); return { ok: true }; } } };

  await connector.handleInteraction({
    type: "block_actions",
    actions: [{ action_id: createDecisionButtonId(optionDecision.id, 0), value: "approve" }],
    user: { id: "U1" },
    channel: { id: "C-NOTIFICATIONS" },
  });

  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /承認/u);
  assert.match(posts[0].text, /回答済み/u);
});

test("Discord: replying twice with the same message id reuses the same idempotency_key", async () => {
  const versionedDecision = { ...optionDecision, state_version: 7 };
  const connector = new DiscordConnector({
    botToken: "discord-idem-test",
    conversationChannelId: "D-CONVERSATION",
    notificationChannelId: "D-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  connector.fetchPendingDecisions = async () => [versionedDecision];
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  connector.core.language = async () => "ja";
  connector.sendNativeMessage = async () => {};

  const message = { id: "M-DUP-1", author: { id: "U1", bot: false }, content: "回答: 承認", channelId: "D-CONVERSATION", attachments: new Map() };
  await connector.handleMessage(message);
  await connector.handleMessage(message);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.body.idempotency_key, requests[1].init.body.idempotency_key);
  assert.equal(requests[0].init.body.expected_version, 7);
});

test("Discord: a button click on an already-settled Decision replies 'already answered' instead of an error", async () => {
  const connector = new DiscordConnector({
    botToken: "discord-settled-test",
    conversationChannelId: "D-CONVERSATION",
    notificationChannelId: "D-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  connector.fetchPendingDecisions = async () => [optionDecision];
  connector.core.request = async () => {
    throw new CoreRequestError(409, "version_conflict", "version conflict");
  };
  connector.core.language = async () => "ja";
  const replies = [];
  const interaction = {
    isButton: () => true,
    channelId: "D-NOTIFICATIONS",
    customId: createDecisionButtonId(optionDecision.id, 1),
    message: { id: "M1" },
    deferred: false,
    replied: false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (opts) => { replies.push(opts); },
    reply: async () => {},
  };
  await connector.handleButtonInteraction(interaction);

  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /却下/u);
  assert.match(replies[0].content, /回答済み/u);
});
