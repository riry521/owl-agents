import assert from "node:assert/strict";
import { test } from "node:test";

import { SlackConnector, sendNotification } from "../packages/connector-slack/dist/index.js";
import { parseAdvisorResponse } from "../packages/shared/dist/index.js";

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
