import assert from "node:assert/strict";
import { test } from "node:test";

import { SlackConnector, sendNotification, shouldNotify } from "../packages/connector-slack/dist/index.js";

const RESUME_AT = "2026-09-27T12:00:30.000Z";
const RESUME_EPOCH = "1790510430";

function event(type, payload) {
  return {
    kind: "event",
    event_id: `event-${type}`,
    sequence: 1,
    cursor: "1",
    type,
    schema_version: "1.0.0",
    work_id: null,
    task_id: null,
    agent_run_id: null,
    created_at: "2026-09-27T11:00:00.000Z",
    payload,
  };
}

async function postText(type, payload, language = "ja") {
  const posts = [];
  await sendNotification(
    { chat: { postMessage: async (message) => { posts.push(message); } } },
    event(type, payload),
    [{ channelId: "" }],
    { language },
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0].blocks[0].text.text, posts[0].text);
  return posts[0].text;
}

test("Slack notifies on provider pause and resume, but not internal pause transitions", () => {
  assert.equal(shouldNotify("provider.paused"), true);
  assert.equal(shouldNotify("provider.resumed"), true);
  assert.equal(shouldNotify("provider.pause_updated"), false);
  assert.equal(shouldNotify("provider.resume_attempted"), false);
});

test("Slack provider pause messages render the localized reason, label, and Slack date token", async () => {
  const date = String.raw`<!date\^${RESUME_EPOCH}\^\{date_short_pretty\} \{time\}\|[0-9]{1,2}:[0-9]{2}(?: [AP]M)?>`;
  const base = { provider: "anthropic", provider_label: "Anthropic", resume_at: RESUME_AT };

  assert.match(await postText("provider.paused", { ...base, resume_source: "reported" }),
    new RegExp(`^⏸ Anthropicが利用上限に達したため、Anthropicを使う処理を止めています。${date}ごろ再開します。$`, "u"));
  assert.match(await postText("provider.paused", { ...base, resume_source: "reported" }, "en"),
    new RegExp(`^⏸ Anthropic hit its usage limit\\. Work that uses Anthropic is on hold until about ${date}\\.$`, "u"));

  assert.match(await postText("provider.paused", { ...base, resume_source: "backoff" }),
    new RegExp(`^⏸ Anthropicが利用上限に達したため、Anthropicを使う処理を止めています。解除時刻が分からないため、${date}ごろに再開を試します。$`, "u"));
  assert.match(await postText("provider.paused", { ...base, resume_source: "backoff" }, "en"),
    new RegExp(`^⏸ Anthropic hit its usage limit\\. The reset time is unknown; Owl will try again around ${date}\\.$`, "u"));

  assert.match(await postText("provider.paused", { ...base, repeat: true, resume_source: "reported" }),
    new RegExp(`^⏸ Anthropicはまだ利用上限のままです。次は${date}ごろに再開を試します。$`, "u"));
  assert.match(await postText("provider.paused", { ...base, repeat: true, resume_source: "reported" }, "en"),
    new RegExp(`^⏸ Anthropic is still at its usage limit\\. Owl will try again around ${date}\\.$`, "u"));

  const fallbackLabel = await postText("provider.paused", { provider: "openai", resume_source: "backoff", resume_at: RESUME_AT });
  assert.match(fallbackLabel, /openai/u);
});

test("Slack provider pause with a missing or invalid resume time does not throw or emit an invalid date token", async () => {
  for (const payload of [
    { provider: "anthropic", resume_source: "backoff" },
    { provider: "anthropic", resume_source: "reported", resume_at: "not-a-date" },
  ]) {
    const message = await postText("provider.paused", payload, "en");
    assert.match(message, /anthropic/u);
    assert.doesNotMatch(message, /<!date\^NaN\^/u);
  }
});

test("Slack provider resumed message is localized", async () => {
  const payload = { provider: "anthropic", provider_label: "Anthropic" };
  assert.equal(await postText("provider.resumed", payload), "▶ Anthropicの利用上限が解除されたため、処理を再開しました。");
  assert.equal(await postText("provider.resumed", payload, "en"), "▶ Anthropic's usage limit has reset. Work has resumed.");
});

test("Slack subscribes to provider pause and resume events", async () => {
  const connector = Object.create(SlackConnector.prototype);
  let subscribed = null;
  connector.socket = {
    on() {},
    start: async () => {},
  };
  connector.core = {
    subscribeEvents: async (types) => { subscribed = types; },
  };

  await connector.start();
  assert.ok(subscribed.includes("provider.paused"));
  assert.ok(subscribed.includes("provider.resumed"));
  assert.equal(subscribed.includes("provider.pause_updated"), false);
  assert.equal(subscribed.includes("provider.resume_attempted"), false);
});
