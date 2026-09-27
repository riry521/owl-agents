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

test("Slack notification text and mrkdwn blocks are converted before posting", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (message) => posts.push(message) } };
  await sendNotification(client, {
    kind: "event",
    event_id: "event-slack-notification-test",
    sequence: 1,
    cursor: "1",
    type: "work.completed",
    schema_version: "1.0.0",
    payload: { title: "**Finished** with a [guide](https://example.com/finish)" },
  }, [{ channelId: "C-NOTIFICATIONS" }]);

  assert.equal(posts[0].text, "完了しました: *Finished* with a <https://example.com/finish|guide>");
  assert.equal(posts[0].blocks[0].text.text, "完了しました: *Finished* with a <https://example.com/finish|guide>");
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
