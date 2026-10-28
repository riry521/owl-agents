import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SlackConnector, sendNotification } from "../../packages/connector-slack/dist/index.js";
import { parseAdvisorResponse } from "../../packages/shared/dist/index.js";

test("Slack Advisor posting strips owl-actions and converts Markdown before posting", async () => {
  const connector = new SlackConnector({
    botToken: "xoxb-slack-post-test",
    appToken: "xapp-slack-post-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const posts = [];
  connector.web = { chat: { postMessage: async (message) => posts.push(message) } };

  await connector.handleCoreEvent({
    kind: "event",
    event_id: "event-slack-post-test",
    sequence: 1,
    cursor: "1",
    type: "advisor.responded",
    schema_version: "1.0.0",
    payload: {
      conversation_id: "slack:C-CONVERSATION:thread",
      message_id: "message-slack-post-test",
      reply: [
        "This is **bold** and _italic_ with a [guide](https://example.com/guide).",
        "- First item",
        "",
        "```ts",
        'const literal = "**unchanged** [link](https://example.com)";',
        "```",
        "",
        "```owl-actions",
        JSON.stringify([{
          type: "create_work",
          description: "Create a **new** work item with a [guide](https://example.com/action).",
          payload: { secret: "NEVER_POST", title: "**raw action title**" },
        }]),
        "```",
      ].join("\n"),
      origin: { channel: "slack", channel_id: "C-CONVERSATION", ref: "1712345678.000100" },
    },
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-CONVERSATION");
  assert.match(posts[0].text, /This is \*bold\* and _italic_ with a <https:\/\/example\.com\/guide\|guide>\./u);
  assert.match(posts[0].text, /• First item/u);
  assert.match(posts[0].text, /```ts\nconst literal = "\*\*unchanged\*\* \[link\]\(https:\/\/example\.com\)";\n```/u);
  assert.doesNotMatch(posts[0].text, /owl-actions|create_work|NEVER_POST|Create a \*new\* work item/u);
  assert.doesNotMatch(posts[0].text, /\*\*raw action title\*\*/u);
});

test("Slack notification renders a colored Block Kit card with plain fallback text", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (message) => { posts.push(message); return { ts: "1.1" }; } } };
  await sendNotification(client, {
    kind: "event",
    event_id: "event-slack-notification-test",
    sequence: 1,
    cursor: "1",
    type: "work.completed",
    schema_version: "1.0.0",
    payload: { title: "**Finished** with a [guide](https://example.com/finish)" },
  }, [{ channelId: "C-NOTIFICATIONS" }]);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "✅ 完了しました: Finished with a guide");
  assert.equal(posts[0].blocks.length, 1);
  assert.equal(posts[0].blocks[0].text.text, "*✅ 完了しました: Finished with a <https://example.com/finish|guide>*");
  assert.equal(posts[0].attachments.length, 1);
  assert.equal(posts[0].attachments[0].color, "#4CAF50");
  assert.equal(posts[0].attachments[0].fallback, posts[0].text);
  assert.equal(posts[0].attachments[0].blocks.length, 0);
});

test("Slack notification sections stay within the Block Kit text limit after Markdown conversion", async () => {
  const posts = [];
  await sendNotification({ chat: { postMessage: async (message) => { posts.push(message); return { ts: "1.2" }; } } }, {
    kind: "event",
    event_id: "event-slack-section-limit-test",
    sequence: 2,
    cursor: "2",
    type: "system.alert",
    schema_version: "1.0.0",
    payload: { message: "&".repeat(1_200), remediation: "Review the alert" },
  }, [{ channelId: "C-NOTIFICATIONS" }]);

  const attachmentBlocks = posts[0].attachments[0].blocks;
  assert.ok(attachmentBlocks.length <= 50);
  for (const block of [...posts[0].blocks, ...attachmentBlocks]) {
    if (block.type === "section") assert.ok(block.text.text.length <= 3_000);
  }
});

test("Slack decision detail retries independently after remembering the main message", async () => {
  const messages = [];
  const posted = [];
  const order = [];
  let mainAttempts = 0;
  let detailAttempts = 0;
  const client = { chat: { postMessage: async (message) => {
    messages.push(message);
    if (message.thread_ts) {
      detailAttempts += 1;
      order.push("detail");
      throw Object.assign(new Error("temporary detail failure"), { code: "slack_webapi_request_error" });
    }
    mainAttempts += 1;
    if (mainAttempts === 1) throw Object.assign(new Error("temporary main failure"), { code: "slack_webapi_request_error" });
    return { ts: "1710000000.123" };
  } } };
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    await sendNotification(client, {
      kind: "event",
      event_id: "event-slack-decision-thread-test",
      sequence: 9,
      cursor: "9",
      type: "decision.opened",
      schema_version: "1.0.0",
      payload: {
        decision_id: "01ARZ3NDEKTSV4RRFFQ6DECIS1",
        question: "Choose one",
        reason: "Full background",
        current_state: "Waiting",
        tried: "Checked logs",
        options: [{ key: "yes", label: "Yes" }],
        recommended: "yes",
        allow_free_text: true,
      },
    }, [{ channelId: "C-NOTIFICATIONS" }], {
      retry: { attempts: 2, baseDelayMs: 0, sleep: async () => {} },
      onPosted: (ref) => { posted.push(ref); order.push("onPosted"); },
    });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(mainAttempts, 2, "the main message retries its transient failure");
  assert.equal(detailAttempts, 2, "the detail uses its own retry cycle");
  assert.deepEqual(posted, [{ channelId: "C-NOTIFICATIONS", ts: "1710000000.123" }]);
  assert.equal(messages[2].thread_ts, "1710000000.123");
  assert.match(messages[2].text, /Full background/u);
  assert.deepEqual(order, ["onPosted", "detail", "detail"]);
});

test("Slack posting converts before chunking and keeps code fences and links intact", async () => {
  const connector = new SlackConnector({
    botToken: "xoxb-slack-post-chunk-test",
    appToken: "xapp-slack-post-chunk-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const posts = [];
  connector.web = { chat: { postMessage: async (message) => posts.push(message) } };

  const source = [
    "**Intro**",
    `${"x".repeat(39_965)} [Guide](https://example.com/guide)`,
    "```ts",
    ...Array.from({ length: 2_200 }, () => 'const literal = "**unchanged** [link](https://example.com)";'),
    "```",
    "Tail **bold**",
  ].join("\n");
  await connector.handleCoreEvent({
    kind: "event",
    event_id: "event-slack-chunk-test",
    sequence: 1,
    cursor: "1",
    type: "advisor.responded",
    schema_version: "1.0.0",
    payload: {
      conversation_id: "slack:C-CONVERSATION:thread",
      reply: source,
      origin: { channel: "slack", channel_id: "C-CONVERSATION", ref: "1712345678.000100" },
    },
  });

  assert.ok(posts.length > 2, "long messages should be posted as multiple Slack messages");
  assert.ok(posts.every((post) => post.text.length <= 40_000), "every message must stay within Slack's text limit");
  assert.match(posts[0].text, /^\*Intro\*/u, "Markdown conversion happens before the message is split");
  assert.ok(posts.some((post) => post.text.includes("<https://example.com/guide|Guide>")));
  assert.ok(posts.every((post) => !/<https?:\/\/[^>]*$/.test(post.text)), "links must not be cut between chunks");

  const codePosts = posts.filter((post) => post.text.includes("const literal"));
  assert.ok(codePosts.length > 1, "a large code block should be split across messages");
  for (const post of codePosts) {
    assert.match(post.text, /^```ts\n/u);
    assert.match(post.text, /\n```(?:\n)?$/u, "each code chunk should have a complete closing fence");
    assert.match(post.text, /\*\*unchanged\*\* \[link\]\(https:\/\/example\.com\)/u, "code contents should remain unchanged");
  }
  assert.ok(posts.some((post) => post.text.includes("Tail *bold*")));
});

test("Advisor parsing preserves Markdown for non-Slack consumers", () => {
  const markdown = "This is **bold** with a [guide](https://example.com/guide).";
  assert.deepEqual(parseAdvisorResponse(markdown), {
    reply: markdown,
    suggested_actions: [],
  });
});

test("Slack notifications show the Work title in the header and text", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (message) => { posts.push(message); return { ts: "1.1" }; } } };
  const base = { kind: "event", sequence: 1, cursor: "1", schema_version: "1.0.0" };
  await sendNotification(client, { ...base, event_id: "e-wt-1", type: "work.completed", payload: { work_id: "W000000", work_title: "請求書整理" } }, [{ channelId: "C1" }]);
  assert.match(posts[0].blocks[0].text.text, /完了しました: 請求書整理/u);
  assert.match(posts[0].text, /請求書整理/u);
  await sendNotification(client, {
    ...base, event_id: "e-wt-2", type: "decision.opened",
    payload: { work_id: "W000000", work_title: "請求書整理", decision_id: "D0000000000000", question: "どうする？", options: [] },
  }, [{ channelId: "C1" }]);
  assert.match(posts[1].text, /請求書整理/u);
  assert.match(posts[1].attachments[0].blocks[0].text.text, /^請求書整理\n/u);
});

async function outboundFixture(content = "file body") {
  const dir = await mkdtemp(join(tmpdir(), "owl-slack-outbound-"));
  const path = join(dir, "report.txt");
  await writeFile(path, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { path, name: "report.txt", size: Buffer.byteLength(content), sha256 };
}

function outboundConnector(order, uploadError) {
  const connector = new SlackConnector({
    botToken: "xoxb-slack-post-test",
    appToken: "xapp-slack-post-test",
    conversationChannelId: "C-CONVERSATION",
    notificationChannelId: "C-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const posts = [];
  const uploads = [];
  connector.web = {
    chat: { postMessage: async (message) => { order.push("post"); posts.push(message); } },
    filesUploadV2: async (args) => {
      order.push("upload");
      uploads.push(args);
      if (uploadError) throw uploadError;
    },
  };
  return { connector, posts, uploads };
}

const advisorEvent = (outbound_files, reply = "Done.\n\nNotice line") => ({
  kind: "event",
  event_id: "event-slack-outbound",
  sequence: 1,
  cursor: "1",
  type: "advisor.responded",
  schema_version: "1.0.0",
  payload: {
    conversation_id: "slack:C-CONVERSATION:thread",
    reply,
    action_results: "Notice line",
    outbound_files,
    origin: { channel: "slack", channel_id: "C-CONVERSATION", ref: "1712345678.000100" },
  },
});

test("Slack uploads each outbound file before the reply and appends the sent line after Core notices", async () => {
  const file = await outboundFixture();
  const order = [];
  const { connector, posts, uploads } = outboundConnector(order);
  await connector.handleCoreEvent(advisorEvent([{ ...file, comment: "**here**" }]));

  assert.deepEqual(order, ["upload", "post"]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].channel_id, "C-CONVERSATION");
  assert.equal(uploads[0].thread_ts, "1712345678.000100");
  assert.equal(uploads[0].file.toString(), "file body");
  assert.equal(uploads[0].filename, "report.txt");
  assert.equal(uploads[0].initial_comment, "*here*");
  assert.match(posts[0].text, /Notice line\n✓ ファイルを送りました: report\.txt（9B）$|Notice line\n✓ Sent the file: report\.txt \(9B\)$/u);
});

test("Slack reports the files:write hint when the upload lacks the scope and still posts the reply", async () => {
  const file = await outboundFixture();
  const order = [];
  const error = Object.assign(new Error("An API error occurred: missing_scope"), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: "missing_scope" },
  });
  const { connector, posts } = outboundConnector(order, error);
  await connector.handleCoreEvent(advisorEvent([file]));

  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Done\./u);
  assert.match(posts[0].text, /report\.txt/u);
  assert.match(posts[0].text, /files:write/u);
});

test("Slack does not upload a file whose contents changed after Core checked it", async () => {
  const file = await outboundFixture();
  await writeFile(file.path, "different body!");
  const order = [];
  const { connector, posts, uploads } = outboundConnector(order);
  await connector.handleCoreEvent(advisorEvent([file]));

  assert.equal(uploads.length, 0);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /ファイルが変わりました|the file changed after it was checked/u);
});

const pendingEvent = (files, extra = {}) => {
  const event = advisorEvent(files.map((file, index) => ({ ...file, index })));
  return { ...event, payload: { ...event.payload, turn_id: "turn-1", message_id: "message-1", delivery_pending: true, ...extra } };
};
const stubCore = (connector, notice = "Checking the failed upload.") => {
  const requests = [];
  connector.core.request = async (path, init) => { requests.push({ path, body: init.body }); return { deduplicated: false, followup_pending: true, notice }; };
  return requests;
};
const slackError = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

for (const [name, error, expected] of [
  ["not_in_channel", slackError("slack_webapi_platform_error", { data: { ok: false, error: "not_in_channel" } }), { outcome: "failed", code: "upload_rejected", platform_error: "not_in_channel" }],
  ["rate limiting", slackError("slack_webapi_rate_limited_error", { retryAfter: 3 }), { outcome: "failed", code: "upload_rate_limited", platform_error: null }],
  ["a request error", slackError("slack_webapi_request_error", { original: new Error("socket hang up") }), { outcome: "unknown", code: "upload_unknown", platform_error: null }],
]) {
  test(`Slack reports ${name} as ${expected.code} and appends the notice Core returns`, async () => {
    const file = await outboundFixture();
    const { connector, posts } = outboundConnector([], error);
    const requests = stubCore(connector);
    await connector.handleCoreEvent(pendingEvent([file]));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/conversations/slack%3AC-CONVERSATION%3Athread/advisor-deliveries");
    assert.equal(requests[0].body.payload.turn_id, "turn-1");
    assert.equal(requests[0].body.payload.message_id, "message-1");
    assert.deepEqual(requests[0].body.payload.results.map(({ message, ...rest }) => rest), [{ index: 0, ...expected }]);
    assert.match(requests[0].body.payload.results[0].message, /report\.txt/u);
    assert.equal(posts.length, 1);
    assert.ok(posts[0].text.includes("Checking the failed upload."), posts[0].text);
  });
}

test("Slack reports a changed file as failed/changed and a successful upload as sent without calling the upload", async () => {
  const changed = await outboundFixture();
  await writeFile(changed.path, "different body!");
  const first = outboundConnector([]);
  const firstRequests = stubCore(first.connector);
  await first.connector.handleCoreEvent(pendingEvent([changed]));
  assert.equal(first.uploads.length, 0);
  assert.deepEqual(firstRequests[0].body.payload.results.map(({ message, ...rest }) => rest), [{ index: 0, outcome: "failed", code: "changed", platform_error: null }]);

  const ok = await outboundFixture();
  const second = outboundConnector([]);
  const secondRequests = stubCore(second.connector, "");
  await second.connector.handleCoreEvent(pendingEvent([ok]));
  assert.deepEqual(secondRequests[0].body.payload.results, [{ index: 0, outcome: "sent" }]);
  assert.ok(!second.posts[0].text.includes("undefined"));
});

test("Slack still posts the reply when the delivery report fails, and does not report an event without delivery_pending", async () => {
  const file = await outboundFixture();
  const failing = outboundConnector([]);
  failing.connector.core.request = async () => { throw new Error("core unreachable"); };
  await failing.connector.handleCoreEvent(pendingEvent([file]));
  assert.equal(failing.posts.length, 1);
  assert.match(failing.posts[0].text, /Done\./u);

  const plain = outboundConnector([]);
  const requests = stubCore(plain.connector);
  await plain.connector.handleCoreEvent(advisorEvent([file]));
  assert.equal(requests.length, 0);
  assert.equal(plain.posts.length, 1);
});

test("Slack posts a follow-up reply into the same thread with the label at the start", async () => {
  const { connector, posts } = outboundConnector([]);
  const label = "【フォローアップ】";
  const event = advisorEvent([], `${label}\nRetried it.`);
  await connector.handleCoreEvent({ ...event, event_id: "event-followup", payload: { ...event.payload, followup_of_turn_id: "turn-1", action_results: "" } });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-CONVERSATION");
  assert.equal(posts[0].thread_ts, "1712345678.000100");
  assert.ok(posts[0].text.startsWith(label), posts[0].text);
});
