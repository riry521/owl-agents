import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDecisionButtonId } from "../../packages/plugin-sdk/dist/shared/index.js";
import {
  DiscordConnector,
  sendNotification,
} from "../../packages/connector-discord/dist/index.js";
import { updateNotification } from "../../packages/connector-discord/dist/notifications.js";
import { discordTimestamp, renderDiscordCard, renderDiscordDecisionDetail } from "../../packages/connector-discord/dist/card.js";

const WORK_ID = "01ARZ3NDEKTSV4RRFFQ69WORK1";
const DECISION_ID = "01ARZ3NDEKTSV4RRFFQ6DECIS1";

function event(type, payload, extra = {}) {
  return {
    kind: "event",
    event_id: `event-${type}`,
    sequence: 8,
    cursor: "8",
    type,
    schema_version: "1.0.0",
    payload,
    ...extra,
  };
}

function paused() {
  return event("work.paused", { work_id: WORK_ID, reason: "waiting for review" }, { work_id: WORK_ID });
}

function opened(overrides = {}) {
  return event("decision.opened", {
    work_id: WORK_ID,
    decision_id: DECISION_ID,
    language: "ja",
    question: "Use the new route?",
    reason: "The current route is unreliable.",
    tried: "Compared both routes.",
    current_state: "Waiting for a decision.",
    options: [
      { label: "No button" },
      { key: "new", label: "Use the new route" },
    ],
    allow_free_text: true,
    ...overrides,
  }, { work_id: WORK_ID });
}

function discordClient(send) {
  let sequence = 0;
  const sends = [];
  return {
    sends,
    client: {
      channels: {
        fetch: async (channelId) => ({
          isTextBased: () => true,
          send: async (message) => {
            sends.push({ channelId, message });
            return send ? send(message, sends) : { id: `M${++sequence}` };
          },
        }),
      },
    },
  };
}

async function decisionReplyConnector() {
  const connector = new DiscordConnector({
    botToken: "test", conversationChannelId: "D-CONVERSATION", notificationChannelId: "D-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1", accountId: "account",
  });
  connector.client.user = { id: "BOT" };
  await connector.core.rememberDecisionMessage(DECISION_ID, {
    channel_id: "D-NOTIFICATIONS", message_ref: "M1", posted_at: "2026-09-28T00:00:00.000Z",
  });
  connector.fetchPendingDecisions = async () => [{ id: DECISION_ID, options: [], allow_free_text: true, reason: "Need a choice" }];
  connector.core.language = async () => "ja";
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, init }); return {}; };
  return { connector, requests };
}

function embedData(send) {
  const embed = send.message.embeds[0];
  return typeof embed.toJSON === "function" ? embed.toJSON() : embed.data;
}

test("notification cards render embed fields, integer colors and preview fallback content", async () => {
  const { sends, client } = discordClient();
  await sendNotification(client, paused(), "D-NOTIFICATIONS");

  assert.equal(sends.length, 1);
  assert.equal(sends[0].message.content, "⏸️ 一時停止しました: Work 9WORK1");
  const data = embedData(sends[0]);
  assert.equal(data.title, "⏸️ 一時停止しました");
  assert.equal(data.color, 0xffb300);
  assert.equal(data.description, "Work 9WORK1");
  assert.deepEqual(data.fields, [{ name: "理由", value: "waiting for review", inline: false }]);
  assert.equal(sends[0].message.allowedMentions.parse.length, 0);

  const alertClient = discordClient();
  await sendNotification(alertClient.client, event("system.alert", { message: "A system notice" }), "D-NOTIFICATIONS");
  const alert = embedData(alertClient.sends[0]);
  assert.equal(alert.title, "⚠️ システム通知");
  assert.equal(alert.color, 0xff9800);
  assert.equal(alert.footer, undefined);
});

test("Discord card renderers enforce Embed limits and render Discord timestamps", () => {
  const { embeds } = renderDiscordCard({
    eventType: "system.alert", language: "ja", emoji: "🚨", title: "t".repeat(300), color: "#123ABC",
    body: "x".repeat(5000), fields: [], footer: null, fallbackText: "preview", actions: [], threadDetail: null, question: null,
  });
  const data = embeds[0].toJSON();
  assert.equal(data.title.length, 256);
  assert.equal(data.description.length, 4096);
  assert.equal(data.color, 0x123abc);

  const detail = renderDiscordDecisionDetail("d".repeat(5000), "en").embeds[0].toJSON();
  assert.equal(detail.title, "📝 Details");
  assert.equal(detail.description.length, 4096);
  assert.equal(detail.color, 0x607d8b);
  assert.equal(discordTimestamp(Date.parse("2026-09-28T10:00:00.999Z")), `<t:${Math.floor(Date.parse("2026-09-28T10:00:00.999Z") / 1000)}:f>`);
});

test("provider notifications use the shared card title, color and Discord time token", async () => {
  const { sends, client } = discordClient();
  await sendNotification(client, event("provider.paused", {
    provider_label: "Anthropic", resume_at: "2026-09-28T10:00:00.000Z", resume_source: "reported",
  }), "D-NOTIFICATIONS");
  await sendNotification(client, event("provider.resumed", { provider_label: "Anthropic" }), "D-NOTIFICATIONS");

  const paused = embedData(sends[0]);
  assert.equal(paused.title, "⏳ 利用上限で停止中");
  assert.equal(paused.color, 0xffb300);
  assert.match(paused.description, /<t:\d+:f>/u);
  assert.doesNotMatch(sends[0].message.content, /<t:/u);
  const resumed = embedData(sends[1]);
  assert.equal(resumed.title, "▶️ 処理を再開しました");
  assert.equal(resumed.color, 0x4caf50);
});

test("decision main card stays short and posts detail as a reply after onPosted", async () => {
  const order = [];
  const { sends, client } = discordClient((message, allSends) => {
    if (message.reply) return { id: "M2" };
    return { id: "M1" };
  });
  await sendNotification(client, opened(), "D-NOTIFICATIONS", {
    onPosted: ({ messageId }) => order.push(`main:${messageId}`),
  });

  assert.equal(sends.length, 2);
  const main = sends[0].message;
  const mainData = embedData(sends[0]);
  assert.equal(mainData.title, "✋ 判断が必要です");
  assert.match(mainData.description, /^❓ Use the new route\?\n\n• No button\n• Use the new route$/u);
  assert.doesNotMatch(mainData.description, /Compared both routes|Waiting for a decision|回答/u);
  assert.match(mainData.footer.text, /ID DECIS1/u);
  const button = main.components[0].toJSON().components[0];
  assert.equal(button.custom_id, createDecisionButtonId(DECISION_ID, 1));
  assert.equal(button.label, "Use the new route");

  const detail = sends[1].message;
  assert.deepEqual(detail.reply, { messageReference: "M1", failIfNotExists: false });
  assert.deepEqual(detail.allowedMentions, { parse: [], repliedUser: false });
  const detailData = embedData(sends[1]);
  assert.equal(detailData.title, "📝 詳細");
  assert.equal(detailData.color, 0x607d8b);
  assert.match(detailData.description, /Compared both routes/u);
  assert.match(detailData.description, /Waiting for a decision/u);
  assert.match(detailData.description, /この詳細メッセージに直接返信/u);
  assert.deepEqual(order, ["main:M1"]);
});

test("decision buttons use at most five rows of five", async () => {
  const options = Array.from({ length: 27 }, (_, index) => ({ key: `k${index}`, label: `Option ${index}` }));
  const { sends, client } = discordClient();
  await sendNotification(client, opened({ options }), "D-NOTIFICATIONS");

  const rows = sends[0].message.components;
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.toJSON().components.length <= 5));
  const buttons = rows.flatMap((row) => row.toJSON().components);
  assert.equal(buttons.length, 25);
  assert.equal(buttons[24].custom_id, createDecisionButtonId(DECISION_ID, 24));
});

test("detail failure does not resend a posted main notification", async () => {
  let mainPosts = 0;
  let details = 0;
  const { client } = discordClient((message) => {
    if (message.reply) {
      details += 1;
      throw Object.assign(new Error("reply rejected"), { status: 403 });
    }
    mainPosts += 1;
    return { id: "M1" };
  });
  let posted = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    await sendNotification(client, opened(), "D-NOTIFICATIONS", {
      retry: { attempts: 1 },
      onPosted: () => { posted += 1; },
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(mainPosts, 1);
  assert.equal(details, 1);
  assert.equal(posted, 1);
});

test("main notification retries a transient send failure before posting detail", async () => {
  let mainPosts = 0;
  let details = 0;
  const posted = [];
  const { client } = discordClient((message) => {
    if (message.reply) {
      details += 1;
      return { id: "M2" };
    }
    mainPosts += 1;
    if (mainPosts === 1) throw Object.assign(new Error("temporary outage"), { status: 503 });
    return { id: "M1" };
  });
  await sendNotification(client, opened(), "D-NOTIFICATIONS", {
    retry: { attempts: 2, baseDelayMs: 0, sleep: async () => {} },
    onPosted: (ref) => posted.push(ref),
  });

  assert.equal(mainPosts, 2);
  assert.equal(details, 1);
  assert.deepEqual(posted, [{ channelId: "D-NOTIFICATIONS", messageId: "M1" }]);
});

test("resolved notification edit uses an embed and clears button rows", async () => {
  const edits = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    messages: { fetch: async () => ({ edit: async (options) => edits.push(options) }) },
  }) } };
  await updateNotification(client, {
    channel_id: "D-NOTIFICATIONS", message_ref: "M1", posted_at: "2026-09-28T00:00:00.000Z",
  }, event("decision.resolved", { decision_id: DECISION_ID, answer: "Continue" }));

  assert.equal(embedData({ message: edits[0] }).title, "☑️ 解決しました");
  assert.equal(embedData({ message: edits[0] }).color, 0x4caf50);
  assert.deepEqual(edits[0].components, []);
  assert.equal(edits[0].content, "☑️ 解決しました: Continue");
  assert.deepEqual(edits[0].allowedMentions, { parse: [] });
});

test("a reply to a decision detail message is routed to the decision after restart-safe reference lookup", async () => {
  const { connector, requests } = await decisionReplyConnector();
  const replies = [];
  await connector.handleMessage({
    id: "M3", author: { id: "U1", bot: false }, content: "Use the new route", channelId: "D-NOTIFICATIONS",
    reference: { messageId: "M2" }, fetchReference: async () => ({
      author: { id: "BOT", bot: true }, reference: { messageId: "M1" },
    }),
    attachments: new Map(), channel: { isDMBased: () => false, isTextBased: () => true, send: async (message) => replies.push(message) },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, `/decisions/${DECISION_ID}/answer`);
  assert.equal(requests[0].init.body.payload.answer, "Use the new route");
  assert.match(replies[0].content, /DECIS1/u);
});

test("a reply to another user's message under a decision notification is not an answer", async () => {
  const { connector, requests } = await decisionReplyConnector();
  await connector.handleMessage({
    id: "M3", author: { id: "U1", bot: false }, content: "Use the new route", channelId: "D-NOTIFICATIONS",
    reference: { messageId: "M2" }, fetchReference: async () => ({
      author: { id: "U2", bot: false }, reference: { messageId: "M1" },
    }),
    attachments: new Map(), channel: { isDMBased: () => false, isTextBased: () => true, send: async () => {} },
  });

  assert.equal(requests.some(({ path }) => path === `/decisions/${DECISION_ID}/answer`), false);
});

test("a reply to the bot's unrelated message is not a decision answer", async () => {
  const { connector, requests } = await decisionReplyConnector();
  await connector.handleMessage({
    id: "M3", author: { id: "U1", bot: false }, content: "Use the new route", channelId: "D-NOTIFICATIONS",
    reference: { messageId: "M2" }, fetchReference: async () => ({
      author: { id: "BOT", bot: true }, reference: { messageId: "OTHER" },
    }),
    attachments: new Map(), channel: { isDMBased: () => false, isTextBased: () => true, send: async () => {} },
  });

  assert.equal(requests.some(({ path }) => path === `/decisions/${DECISION_ID}/answer`), false);
});

test("connector-authored Discord messages (Advisor replies, acknowledgements, error notices) suppress every mention", async () => {
  const { connector } = await decisionReplyConnector();
  const { sends, client } = discordClient();
  connector.client.channels.fetch = client.channels.fetch;
  const originalError = console.error;
  console.error = () => {};
  try {
    await connector.handleAdvisorResponse(event("advisor.responded", {
      origin: { channel: "discord", channel_id: "D-CONVERSATION" },
      reply: "@everyone <@&123> <@456> the build finished",
    }));
    await connector.handleAdvisorResponse(event("advisor.responded", {
      origin: { channel: "discord", channel_id: "D-CONVERSATION" },
      conversation_id: "C1", message_id: "missing",
    }));
  } finally {
    console.error = originalError;
  }
  const replies = [];
  await connector.handleMessage({
    id: "M3", author: { id: "U1", bot: false }, content: "@everyone status", channelId: "D-CONVERSATION",
    reference: { messageId: "M1" }, fetchReference: async () => ({}),
    attachments: new Map(), channel: { isDMBased: () => false, isTextBased: () => true, send: async (message) => replies.push(message) },
  });

  assert.ok(sends.length >= 2, "the Advisor reply and its failure notice were both sent");
  for (const message of [...sends.map((send) => send.message), ...replies]) {
    assert.deepEqual(message.allowedMentions?.parse, [], `mentions must not be parsed in: ${message.content}`);
  }
  assert.ok(replies.length >= 1, "the Decision acknowledgement was sent");
});

test("notification cards show the Work title in embed title, description and content", async () => {
  const { sends, client } = discordClient();
  await sendNotification(client, event("work.completed", { work_id: WORK_ID, work_title: "請求書整理" }, { work_id: WORK_ID }), "D-NOTIFICATIONS");
  assert.match(sends[0].message.content, /請求書整理/u);
  assert.equal(embedData(sends[0]).title, "✅ 完了しました: 請求書整理");
  assert.match(embedData(sends[0]).footer.text, /Work 9WORK1/u);
  await sendNotification(client, opened({ work_title: "請求書整理" }), "D-NOTIFICATIONS");
  assert.match(sends[1].message.content, /請求書整理/u);
  assert.ok(embedData(sends[1]).description.startsWith("請求書整理\n"));
});

async function outboundFileEvent(content, comment) {
  const path = join(await mkdtemp(join(tmpdir(), "owl-discord-file-")), "report.txt");
  await writeFile(path, content);
  return event("advisor.responded", {
    origin: { channel: "discord", channel_id: "D-CONVERSATION" },
    reply: "done",
    outbound_files: [{
      path, name: "report.txt", size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"), ...(comment ? { comment } : {}),
    }],
  });
}

test("Discord uploads each outbound file before the reply and appends the result line", async () => {
  const { connector } = await decisionReplyConnector();
  const { sends, client } = discordClient();
  connector.client.channels.fetch = client.channels.fetch;
  await connector.handleAdvisorResponse(await outboundFileEvent("hello", "@everyone look"));

  assert.equal(sends.length, 2);
  const upload = sends[0];
  assert.equal(upload.channelId, "D-CONVERSATION");
  assert.equal(upload.message.files[0].attachment.toString(), "hello");
  assert.equal(upload.message.files[0].name, "report.txt");
  assert.equal(upload.message.content, "@everyone look");
  assert.deepEqual(upload.message.allowedMentions, { parse: [] });
  assert.match(sends[1].message.content, /^done\n\n✓ ファイルを送りました: report\.txt/);
});

const discordJs = createRequire(new URL("../../packages/connector-discord/package.json", import.meta.url))("discord.js");
const apiError = (code, status) => new discordJs.DiscordAPIError({ code, message: "refused" }, code, status, "POST", "https://discord.test/api", {});

async function pendingFileEvent(extra = {}) {
  const base = await outboundFileEvent("hello");
  base.payload.outbound_files[0].index = 0;
  return { ...base, payload: { ...base.payload, conversation_id: "discord:D-CONVERSATION", turn_id: "turn-1", message_id: "message-1", delivery_pending: true, ...extra } };
}

function reportingConnector(sendError, notice = "Checking the failed upload.") {
  return decisionReplyConnector().then(({ connector }) => {
    const reports = [];
    connector.core.request = async (path, init) => { reports.push({ path, body: init.body }); return { deduplicated: false, followup_pending: true, notice }; };
    const { sends, client } = discordClient((message) => {
      if (message.files && sendError) throw sendError;
      return { id: "M1" };
    });
    connector.client.channels.fetch = client.channels.fetch;
    return { connector, reports, sends };
  });
}

for (const [name, error, expected] of [
  ["DiscordAPIError 50013", apiError(50013, 403), { outcome: "failed", code: "upload_rejected", platform_error: "50013" }],
  ["a 429 response", apiError(0, 429), { outcome: "failed", code: "upload_rate_limited", platform_error: null }],
  ["an HTTPError", new discordJs.HTTPError(502, "Bad Gateway", "POST", "https://discord.test/api", {}), { outcome: "unknown", code: "upload_unknown", platform_error: null }],
]) {
  test(`Discord reports ${name} as ${expected.code} and appends the notice Core returns`, async () => {
    const { connector, reports, sends } = await reportingConnector(error);
    await connector.handleAdvisorResponse(await pendingFileEvent());

    assert.equal(reports.length, 1);
    assert.equal(reports[0].path, "/conversations/discord%3AD-CONVERSATION/advisor-deliveries");
    assert.equal(reports[0].body.payload.turn_id, "turn-1");
    assert.equal(reports[0].body.payload.message_id, "message-1");
    assert.deepEqual(reports[0].body.payload.results.map(({ message, ...rest }) => rest), [{ index: 0, ...expected }]);
    assert.ok(sends.at(-1).message.content.includes("Checking the failed upload."), sends.at(-1).message.content);
  });
}

test("Discord reports a sent file, still posts the reply when the report fails and does not report without delivery_pending", async () => {
  const sentCase = await reportingConnector();
  await sentCase.connector.handleAdvisorResponse(await pendingFileEvent());
  assert.deepEqual(sentCase.reports[0].body.payload.results, [{ index: 0, outcome: "sent" }]);

  const failing = await reportingConnector();
  failing.connector.core.request = async () => { throw new Error("core unreachable"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    await failing.connector.handleAdvisorResponse(await pendingFileEvent());
  } finally {
    console.error = originalError;
  }
  assert.match(failing.sends.at(-1).message.content, /^done/);

  const plain = await reportingConnector();
  await plain.connector.handleAdvisorResponse(await outboundFileEvent("hello"));
  assert.equal(plain.reports.length, 0);
});

test("Discord posts a follow-up reply into the same channel with the label at the start", async () => {
  const { connector, sends } = await reportingConnector();
  const label = "【フォローアップ】";
  await connector.handleAdvisorResponse(event("advisor.responded", {
    origin: { channel: "discord", channel_id: "D-CONVERSATION" }, reply: `${label}\nRetried it.`, followup_of_turn_id: "turn-1",
  }));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].channelId, "D-CONVERSATION");
  assert.ok(sends[0].message.content.startsWith(label), sends[0].message.content);
});

test("Discord reports the Attach Files permission when the upload is refused", async () => {
  const { connector } = await decisionReplyConnector();
  const { sends, client } = discordClient((message) => {
    if (message.files) throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
    return { id: "M1" };
  });
  connector.client.channels.fetch = client.channels.fetch;
  await connector.handleAdvisorResponse(await outboundFileEvent("hello"));

  const reply = sends.at(-1).message.content;
  assert.match(reply, /^done/);
  assert.match(reply, /⚠ ファイルを送れませんでした: report\.txt/);
  assert.match(reply, /Attach Files/);
});
