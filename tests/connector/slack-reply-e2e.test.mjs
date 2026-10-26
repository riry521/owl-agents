import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { SlackConnector } from "../../packages/connector-slack/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";
const slackChannelId = "C-SLACK-REPLY-E2E";
const slackThreadRef = "1712345678.000100";
const workTitle = "Markdown Reply Regression Work";
const workSummary = "Verify Slack reply formatting and create this requested regression Work.";

const markdownReply = [
  "Here is **bold** in the reply.",
  "",
  "# Heading",
  "",
  "[label](https://example.com)",
  "",
  "- first item",
  "- second item",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| Owl | Ready |",
  "",
  "```js",
  "const answer = 42;",
  "```",
].join("\n");

const providerReply = [
  markdownReply,
  "```owl-actions",
  JSON.stringify([{
    type: "create_work",
    description: "Create the Markdown reply regression Work.",
    payload: {
      title: workTitle,
      summary: workSummary,
      size: "small",
      project_id: null,
    },
  }]),
  "```",
].join("\n");

const waitUntil = (predicate, message) => waitFor(predicate, { message });

test("Slack Advisor reply converts Markdown, dispatches owl-actions, and preserves web Markdown", async (t) => {
  let currentTurn;
  let readySent = false;
  const sentTurns = [];
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "slack-reply-e2e-session",
      pid: process.pid,
      send: async (turn) => {
        currentTurn = turn;
        sentTurns.push(turn);
      },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield {
              type: "session.ready",
              provider_session_id: "slack-reply-e2e-session",
              pid: process.pid,
            };
          }
          assert.ok(currentTurn, "the provider should receive a turn before returning its reply");
          yield {
            type: "turn.completed",
            turn_id: currentTurn.turn_id,
            reply: providerReply,
            usage: null,
          };
        },
      }),
      stop: async () => {},
    }),
  };
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("A small Advisor-created Work should skip Manager planning."); },
    runWorker: async () => ({
      outcome: "failed",
      failure_class: "transient",
      error_key: "slack_reply_e2e",
      retry_allowed: false,
      message: "The regression test stops after checking Work creation.",
    }),
    runReviewer: async () => { throw new Error("The reviewer should not run in this regression test."); },
    runAdvisor: async () => { throw new Error("The persistent provider session should handle Advisor replies."); },
  };

  const { db, core } = await createTestCore(t, {
    agentRunner,
    providerClient,
    version: "slack-reply-e2e-test",
    dispatcher: { tick_interval_ms: 25 },
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({
    ok: true,
    dirty: false,
    message: "The regression test Advisor workspace is clean.",
  });
  await core.start();

  const webConversation = await core.getActiveConversation();
  const slackAccountId = createUlid();
  await core.ensureConnectorAccount(ownerId, "slack", slackAccountId);

  const connector = new SlackConnector({
    botToken: "xoxb-slack-reply-e2e-test",
    appToken: "xapp-slack-reply-e2e-test",
    conversationChannelId: slackChannelId,
    notificationChannelId: "C-SLACK-REPLY-E2E-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    apiToken: "slack-reply-e2e-test-token",
    accountId: slackAccountId,
  });
  const postedMessages = [];
  connector.web.chat.postMessage = async (message) => {
    postedMessages.push(message);
    return { ok: true };
  };
  connector.core.requestPage = async () => ({ data: [], cursor: null, has_more: false });
  connector.core.request = async (path, options = {}) => {
    if (path === "/inbound/messages") {
      return core.ingestInbound(ownerId, {
        request_id: options.headers["X-Request-Id"],
        idempotency_key: options.headers["Idempotency-Key"],
        expected_version: 0,
        payload: options.body,
      });
    }

    const messagesPath = /^\/conversations\/([^/]+)\/messages\?/u.exec(path);
    if (messagesPath) {
      const conversationId = decodeURIComponent(messagesPath[1]);
      return {
        data: db.all(
          "SELECT id, body FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
          conversationId,
        ),
      };
    }

    throw new Error(`Unexpected Slack connector Core request: ${path}`);
  };

  await connector.handleMessage({
    user: "U-SLACK-REPLY-E2E",
    text: "Please create a small example Work from this reply.",
    channel: slackChannelId,
    ts: "1712345678.000150",
    thread_ts: slackThreadRef,
  });

  const slackConversation = await waitUntil(
    // Slack conversations are grouped channel-wide (thread_ref is always
    // null); thread_ts is carried separately as the reply destination.
    () => db.get(
      "SELECT conversation_id AS id FROM advisor_windows WHERE owner_id = ? AND scope = 'general'",
      ownerId,
    ),
    "Slack-originated Advisor conversation",
  );
  const slackReply = await waitUntil(
    () => {
      const turn = db.get(
        "SELECT id, status, origin_channel, origin_channel_id, origin_ref FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1",
        slackConversation.id,
      );
      const message = db.get(
        "SELECT id, body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%' ORDER BY created_at DESC LIMIT 1",
        slackConversation.id,
      );
      const work = db.get(
        "SELECT id, title, summary, size, project_id FROM works WHERE title = ? ORDER BY created_at ASC LIMIT 1",
        workTitle,
      );
      return turn?.status === "completed" && message && work ? { turn, message, work } : null;
    },
    "Slack Advisor reply and create_work result",
  );

  assert.equal(slackReply.turn.origin_channel, "slack");
  assert.equal(slackReply.turn.origin_channel_id, slackChannelId);
  assert.equal(slackReply.turn.origin_ref, slackThreadRef);
  assert.equal(slackReply.work.title, workTitle);
  assert.equal(slackReply.work.summary, workSummary);
  assert.equal(slackReply.work.size, "small");
  assert.equal(slackReply.work.project_id, null);

  const slackTurn = sentTurns.find((turn) => turn.text.includes("Please create a small example Work"));
  assert.ok(slackTurn, "the Slack message should be delivered to the Advisor provider");
  assert.match(slackTurn.text, /Slack mrkdwn/u);

  const slackEvent = core.listEventsAfter(null, 100).find(
    (event) => event.type === "advisor.responded" && event.payload.conversation_id === slackConversation.id,
  );
  assert.ok(slackEvent, "Core should publish the completed Slack Advisor response");
  const storedReply = core.listMessages(slackConversation.id, { limit: 200 }).data
    .find((message) => message.id === slackEvent.payload.message_id);
  assert.equal(slackEvent.payload.reply, storedReply?.body, "the event carries the reply body so connectors need not page the conversation");
  await connector.handleCoreEvent(slackEvent);

  assert.equal(postedMessages.length, 1);
  const postedSlackReply = postedMessages[0];
  assert.equal(postedSlackReply.channel, slackChannelId);
  assert.equal(postedSlackReply.thread_ts, slackThreadRef, "the reply should be posted back into the thread it came from");
  assert.match(postedSlackReply.text, /\*bold\*/u);
  assert.match(postedSlackReply.text, /^\*Heading\*$/mu);
  assert.match(postedSlackReply.text, /<https:\/\/example\.com\|label>/u);
  assert.match(postedSlackReply.text, /• first item\n• second item/u);
  assert.match(postedSlackReply.text, /\| Name \| Value \|\n\| --- \| --- \|\n\| Owl \| Ready \|/u);
  assert.ok(postedSlackReply.text.includes("```js\nconst answer = 42;\n```"), "fenced code should stay intact");
  assert.doesNotMatch(postedSlackReply.text, /\*\*|^#{1,6}\s|owl-actions|create_work/u);
  assert.match(postedSlackReply.text, new RegExp(workTitle));

  const webAccount = db.get(
    "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
    ownerId,
  );
  assert.ok(webAccount, "the default web account should exist");
  const now = new Date().toISOString();
  const webUserMessageId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO messages
         (id, conversation_id, provider, account_id, source_message_id, body,
          attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
      webUserMessageId,
      webConversation.conversation_id,
      webAccount.id,
      `web-user:${webUserMessageId}`,
      "Repeat the same Advisor reply through the web channel.",
      now,
      now,
    );
  });

  await core.advisorRespond(webConversation.conversation_id, webUserMessageId, { channel: "web" });
  const webReply = await waitUntil(
    () => {
      const turn = db.get(
        "SELECT id, status, origin_channel FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1",
        webConversation.conversation_id,
      );
      const message = db.get(
        "SELECT id, body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%' ORDER BY created_at DESC LIMIT 1",
        webConversation.conversation_id,
      );
      return turn?.status === "completed" && message ? { turn, message } : null;
    },
    "web Advisor reply",
  );

  assert.equal(webReply.turn.origin_channel, "web");
  assert.ok(
    webReply.message.body.startsWith(markdownReply),
    "web Markdown should remain byte-for-byte unchanged after the action fence is handled",
  );
  assert.equal(
    webReply.message.body.slice(0, markdownReply.length),
    markdownReply,
    "web output must retain GitHub Markdown markers instead of Slack mrkdwn",
  );
  assert.doesNotMatch(webReply.message.body, /owl-actions|"type":"create_work"/u);
  assert.doesNotMatch(webReply.message.body, /<https:\/\/example\.com\|label>/u);
});

// Slack top-level posts in a channel share one channel-wide conversation
// (thread_ref is always null); a thread reply lands in that same
// conversation but its Advisor reply must still go back into that thread.
test("Slack groups two top-level posts and a thread reply into one conversation, each reply posted to its own thread_ts", async (t) => {
  // A persistent Advisor session fake that serves any number of turns in
  // sequence: send() records the turn about to be drained, and each fresh
  // call to events() (Core drains one turn per call) yields session.ready
  // once, then that turn's own reply.
  let readySent = false;
  let currentTurn;
  const sentTurns = [];
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "slack-multi-turn-e2e-session",
      pid: process.pid,
      send: async (turn) => {
        currentTurn = turn;
        sentTurns.push(turn);
      },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield {
              type: "session.ready",
              provider_session_id: "slack-multi-turn-e2e-session",
              pid: process.pid,
            };
          }
          assert.ok(currentTurn, "the provider should receive a turn before returning its reply");
          yield {
            type: "turn.completed",
            turn_id: currentTurn.turn_id,
            reply: `Ack: ${currentTurn.text}`,
            usage: null,
          };
        },
      }),
      stop: async () => {},
    }),
  };
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("This regression test sends no create_work action."); },
    runWorker: async () => { throw new Error("This regression test never starts a Work."); },
    runReviewer: async () => { throw new Error("This regression test never starts a Work."); },
    runAdvisor: async () => { throw new Error("The persistent provider session should handle Advisor replies."); },
  };

  const { db, core } = await createTestCore(t, {
    agentRunner,
    providerClient,
    version: "slack-multi-turn-e2e-test",
    dispatcher: { tick_interval_ms: 25 },
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({
    ok: true,
    dirty: false,
    message: "The regression test Advisor workspace is clean.",
  });
  await core.start();

  // The Advisor reply is recorded under the default web connector account
  // regardless of the originating channel; getActiveConversation() is what
  // creates that account on a fresh database.
  await core.getActiveConversation();
  const slackAccountId = createUlid();
  await core.ensureConnectorAccount(ownerId, "slack", slackAccountId);

  const connector = new SlackConnector({
    botToken: "xoxb-slack-multi-turn-e2e-test",
    appToken: "xapp-slack-multi-turn-e2e-test",
    conversationChannelId: slackChannelId,
    notificationChannelId: "C-SLACK-MULTI-TURN-E2E-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    apiToken: "slack-multi-turn-e2e-test-token",
    accountId: slackAccountId,
  });
  const postedMessages = [];
  connector.web.chat.postMessage = async (message) => {
    postedMessages.push(message);
    return { ok: true };
  };
  connector.core.requestPage = async () => ({ data: [], cursor: null, has_more: false });
  connector.core.request = async (path, options = {}) => {
    if (path === "/inbound/messages") {
      return core.ingestInbound(ownerId, {
        request_id: options.headers["X-Request-Id"],
        idempotency_key: options.headers["Idempotency-Key"],
        expected_version: 0,
        payload: options.body,
      });
    }

    const messagesPath = /^\/conversations\/([^/]+)\/messages\?/u.exec(path);
    if (messagesPath) {
      const conversationId = decodeURIComponent(messagesPath[1]);
      return {
        data: db.all(
          "SELECT id, body FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
          conversationId,
        ),
      };
    }

    throw new Error(`Unexpected Slack connector Core request: ${path}`);
  };

  const tsFirstPost = "1712349000.000100";
  const tsSecondPost = "1712349000.000200";
  const tsThreadReply = "1712349000.000300";

  // Two top-level posts, no thread_ts.
  await connector.handleMessage({
    user: "U-SLACK-MULTI-TURN",
    text: "First top-level question",
    channel: slackChannelId,
    ts: tsFirstPost,
  });
  await connector.handleMessage({
    user: "U-SLACK-MULTI-TURN",
    text: "Second top-level question",
    channel: slackChannelId,
    ts: tsSecondPost,
  });
  // A reply inside the first post's thread.
  await connector.handleMessage({
    user: "U-SLACK-MULTI-TURN",
    text: "A follow-up in the thread",
    channel: slackChannelId,
    ts: tsThreadReply,
    thread_ts: tsFirstPost,
  });

  const conversation = await waitUntil(
    () => db.get(
      "SELECT conversation_id AS id FROM advisor_windows WHERE owner_id = ? AND scope = 'general'",
      ownerId,
    ),
    "the single Slack channel-wide conversation",
  );

  await waitUntil(
    () => {
      const turns = db.all(
        "SELECT status FROM advisor_turns WHERE conversation_id = ?",
        conversation.id,
      );
      return turns.length === 3 && turns.every((turn) => turn.status === "completed") ? turns : null;
    },
    "all three Advisor turns to complete",
  );

  const inboundCount = db.get(
    `SELECT COUNT(*) AS count FROM messages
      WHERE conversation_id = ? AND (source_message_id IS NULL OR source_message_id NOT LIKE 'advisor:%')`,
    conversation.id,
  );
  assert.equal(inboundCount.count, 3, "exactly one conversation holds all three inbound messages");

  const advisorEvents = core.listEventsAfter(null, 200)
    .filter((event) => event.type === "advisor.responded" && event.payload.conversation_id === conversation.id)
    .sort((a, b) => a.sequence - b.sequence);
  assert.equal(advisorEvents.length, 3, "Core should publish one advisor.responded event per turn");

  for (const advisorEvent of advisorEvents) {
    await connector.handleCoreEvent(advisorEvent);
  }

  assert.equal(postedMessages.length, 3);
  const firstReply = postedMessages.find((message) => message.text.includes("First top-level question"));
  const secondReply = postedMessages.find((message) => message.text.includes("Second top-level question"));
  const threadReply = postedMessages.find((message) => message.text.includes("A follow-up in the thread"));

  assert.ok(firstReply, "the reply to the first top-level post should be posted");
  assert.equal(firstReply.channel, slackChannelId);
  assert.equal(firstReply.thread_ts, undefined, "a top-level post's reply is not threaded");

  assert.ok(secondReply, "the reply to the second top-level post should be posted");
  assert.equal(secondReply.channel, slackChannelId);
  assert.equal(secondReply.thread_ts, undefined, "a top-level post's reply is not threaded");

  assert.ok(threadReply, "the reply to the thread reply should be posted");
  assert.equal(threadReply.channel, slackChannelId);
  assert.equal(threadReply.thread_ts, tsFirstPost, "the reply is posted with the thread_ts of the message that triggered it");
});

test("a status exchange sent over the real HTTP route is recorded once, starts no Advisor turn, and rides the next Advisor turn exactly once", async (t) => {
  const sentTurns = [];
  let currentTurn;
  let readySent = false;
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "status-exchange-session",
      pid: process.pid,
      send: async (turn) => {
        currentTurn = turn;
        sentTurns.push(turn);
      },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield { type: "session.ready", provider_session_id: "status-exchange-session", pid: process.pid };
          }
          yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: "ok", usage: null };
        },
      }),
      stop: async () => {},
    }),
  };
  const { db, core, root } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => { throw new Error("unused"); },
      runWorker: async () => { throw new Error("unused"); },
      runReviewer: async () => { throw new Error("unused"); },
      runAdvisor: async () => { throw new Error("The persistent provider session should handle Advisor replies."); },
    },
    providerClient,
    version: "status-exchange-test",
    dispatcher: { tick_interval_ms: 25 },
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await core.start();
  const accountId = createUlid();
  await core.ensureConnectorAccount(ownerId, "slack", accountId);

  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const token = "status-exchange-http-test-token";
  const api = await startTestHttpServer(t, { core: adapter, webOut: root, owlRoot: root }, { token });
  if (!api) return t.skip("localhost listen is unavailable");

  const inbound = (externalId, text, extra = {}) => ({
    provider: "slack",
    account_id: accountId,
    external_message_id: externalId,
    user_id: "U-STATUS",
    channel_id: slackChannelId,
    thread_id: null,
    received_at: new Date().toISOString(),
    text,
    conversation_hint: { work_id: null, dm_ref: slackChannelId, thread_ref: null },
    attachment_ids: [],
    ...extra,
  });
  const post = (body, key) => fetch(`${api.baseUrl}/api/v1/inbound/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-request-id": `req-${key}`, "idempotency-key": `idem-${key}` },
    body: JSON.stringify(body),
  });
  const statusBody = inbound("1712400000.000001", "/status", { status_reply: "FIXED-STATUS-REPLY" });

  const first = await post(statusBody, "status");
  assert.ok(first.status >= 200 && first.status < 300, `status exchange accepted, got ${first.status}`);
  const second = await post(statusBody, "status");
  assert.ok(second.status >= 200 && second.status < 300);
  assert.equal((await second.json()).message_id, (await first.json()).message_id, "the same request replays the first result");

  const conversation = db.get("SELECT conversation_id AS id FROM advisor_windows WHERE owner_id = ? AND scope = 'general'", ownerId);
  const listed = await fetch(`${api.baseUrl}/api/v1/conversations/${conversation.id}/messages`, { headers: { authorization: `Bearer ${token}` } });
  const bodies = (await listed.json()).data.map((message) => message.body);
  assert.deepEqual([...bodies].sort(), ["/status", "FIXED-STATUS-REPLY"], "a duplicate request adds no message");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM advisor_turns WHERE conversation_id = ?", conversation.id).count, 0, "no Advisor turn is created");
  assert.equal(sentTurns.length, 0);

  const normal = await post(inbound("1712400000.000002", "Please check the earlier status."), "normal");
  assert.ok(normal.status >= 200 && normal.status < 300);
  await waitUntil(() => sentTurns.length === 1, "the next turn reaches the provider");
  const occurrences = (text, needle) => text.split(needle).length - 1;
  assert.equal(occurrences(sentTurns[0].text, "FIXED-STATUS-REPLY"), 1);
  assert.equal(occurrences(sentTurns[0].text, "/status"), 1);

  await waitUntil(
    () => db.get("SELECT COUNT(*) AS count FROM advisor_turns WHERE conversation_id = ? AND status = 'completed'", conversation.id).count === 1,
    "first turn completed",
  );
  await post(inbound("1712400000.000003", "And another thing."), "normal2");
  await waitUntil(() => sentTurns.length === 2, "the second turn reaches the provider");
  assert.equal(occurrences(sentTurns[1].text, "FIXED-STATUS-REPLY"), 0, "an exchange already carried is not repeated");

  await post(inbound("1712400000.000004", "/status", { status_reply: "FIXED-SECOND-REPLY" }), "status2");
  await Promise.all([
    post(inbound("1712400000.000005", "parallel one"), "parallel1"),
    post(inbound("1712400000.000006", "parallel two"), "parallel2"),
  ]);
  await waitUntil(() => sentTurns.length >= 3, "a turn carries the second exchange");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sentTurns.reduce((sum, turn) => sum + occurrences(turn.text, "FIXED-SECOND-REPLY"), 0), 1, "simultaneous turns share one copy of the exchange");
  assert.equal(
    db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND json_extract(metadata_json, '$.carried_by') IS NOT NULL", conversation.id).count,
    2,
    "the carrying message is stored with each exchange so a rebuilt turn can add it again",
  );
});

test("a status exchange claimed by a turn that was never stored rides the next turn after a restart", async (t) => {
  const sentTurns = [];
  const providerClient = () => {
    let currentTurn;
    let readySent = false;
    return {
      createSession: async () => ({
        provider_session_id: "status-restart-session",
        pid: process.pid,
        send: async (turn) => {
          currentTurn = turn;
          sentTurns.push(turn);
        },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            if (!readySent) {
              readySent = true;
              yield { type: "session.ready", provider_session_id: "status-restart-session", pid: process.pid };
            }
            yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: "ok", usage: null };
          },
        }),
        stop: async () => {},
      }),
    };
  };
  const coreOptions = {
    agentRunner: {
      runManagerPlan: async () => { throw new Error("unused"); },
      runWorker: async () => { throw new Error("unused"); },
      runReviewer: async () => { throw new Error("unused"); },
      runAdvisor: async () => { throw new Error("The persistent provider session should handle Advisor replies."); },
    },
    version: "status-restart-test",
    dispatcher: { tick_interval_ms: 25 },
  };
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-status-restart-")));
  const db = createTestDatabase(root);
  const first = await createTestCore(t, { ...coreOptions, providerClient: providerClient(), db, owlRoot: root });
  first.core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await first.core.start();
  const accountId = createUlid();
  await first.core.ensureConnectorAccount(ownerId, "slack", accountId);
  const inbound = (externalId, text, extra = {}) => ({
    provider: "slack",
    account_id: accountId,
    external_message_id: externalId,
    user_id: "U-STATUS",
    channel_id: slackChannelId,
    thread_id: null,
    received_at: new Date().toISOString(),
    text,
    conversation_hint: { work_id: null, dm_ref: slackChannelId, thread_ref: null },
    attachment_ids: [],
    ...extra,
  });
  const question = await first.core.ingestInbound(ownerId, command(inbound("1712500000.000001", "/status", { status_reply: "FIXED-RESTART-REPLY" }), "restart-status"));
  // The process ended after claimStatusExchanges marked the answer but before the turn row was written.
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      "UPDATE messages SET metadata_json = json_set(metadata_json, '$.delivered', json('true'), '$.carried_by', ?) WHERE id = ?",
      "message-without-turn",
      question.data.message_id,
    );
  });
  await first.core.stop({ force: true });

  const { core } = await createTestCore(t, { ...coreOptions, providerClient: providerClient(), db, owlRoot: root });
  // Registered after both Cores so their stop hooks run before the DB closes.
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await core.start();
  const metadata = JSON.parse(db.get("SELECT metadata_json FROM messages WHERE id = ?", question.data.message_id).metadata_json);
  assert.equal(metadata.delivered, false);
  assert.equal(metadata.carried_by, undefined);

  await core.ingestInbound(ownerId, command(inbound("1712500000.000002", "What did the status say?"), "restart-normal"));
  await waitUntil(() => sentTurns.length === 1, "the next turn reaches the provider");
  assert.equal(sentTurns[0].text.split("FIXED-RESTART-REPLY").length - 1, 1);
});

test("Slack send_file uploads the materials file to the reply thread before the reply", async (t) => {
  let currentTurn;
  let readySent = false;
  let providerReply;
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "slack-send-file-e2e-session",
      pid: process.pid,
      send: async (turn) => { currentTurn = turn; },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield { type: "session.ready", provider_session_id: "slack-send-file-e2e-session", pid: process.pid };
          }
          yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: providerReply, usage: null };
        },
      }),
      stop: async () => {},
    }),
  };
  const unused = async () => { throw new Error("This send_file regression test never starts a Work."); };
  const { db, core } = await createTestCore(t, {
    agentRunner: { runManagerPlan: unused, runWorker: unused, runReviewer: unused, runAdvisor: unused },
    providerClient,
    version: "slack-send-file-e2e-test",
    dispatcher: { tick_interval_ms: 25 },
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await core.start();
  await core.getActiveConversation();

  const materials = join(core.knowledgeLocation.path, "materials");
  await mkdir(materials, { recursive: true });
  const fileName = "report.txt";
  const content = Buffer.from("materials file contents");
  await writeFile(join(materials, fileName), content);
  const comment = "the requested report";
  providerReply = [
    "Sending the file.",
    "```owl-actions",
    JSON.stringify([{ type: "send_file", description: "Send the report.", payload: { path: join(materials, fileName), comment } }]),
    "```",
  ].join("\n");

  const slackAccountId = createUlid();
  await core.ensureConnectorAccount(ownerId, "slack", slackAccountId);
  const connector = new SlackConnector({
    botToken: "xoxb-slack-send-file-e2e-test",
    appToken: "xapp-slack-send-file-e2e-test",
    conversationChannelId: slackChannelId,
    notificationChannelId: "C-SLACK-SEND-FILE-E2E-NOTIFICATIONS",
    coreApiBase: "http://127.0.0.1:1/api/v1",
    apiToken: "slack-send-file-e2e-test-token",
    accountId: slackAccountId,
  });
  const calls = [];
  const uploads = [];
  const postedMessages = [];
  connector.web.filesUploadV2 = async (args) => {
    calls.push("upload");
    uploads.push(args);
    return { ok: true };
  };
  connector.web.chat.postMessage = async (message) => {
    calls.push("post");
    postedMessages.push(message);
    return { ok: true };
  };
  connector.core.requestPage = async () => ({ data: [], cursor: null, has_more: false });
  connector.core.request = async (path, options = {}) => {
    if (path === "/inbound/messages") {
      return core.ingestInbound(ownerId, {
        request_id: options.headers["X-Request-Id"],
        idempotency_key: options.headers["Idempotency-Key"],
        expected_version: 0,
        payload: options.body,
      });
    }
    throw new Error(`Unexpected Slack connector Core request: ${path}`);
  };

  await connector.handleMessage({
    user: "U-SLACK-SEND-FILE",
    text: "Please send me the report.",
    channel: slackChannelId,
    ts: "1712345678.000150",
    thread_ts: slackThreadRef,
  });
  const slackEvent = await waitUntil(
    () => core.listEventsAfter(null, 100).find((event) => event.type === "advisor.responded" && event.payload.outbound_files),
    "Slack Advisor reply carrying outbound_files",
  );
  await connector.handleCoreEvent(slackEvent);

  assert.deepEqual(calls, ["upload", "post"], "the file is uploaded before the reply is posted");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].channel_id, slackChannelId);
  assert.equal(uploads[0].thread_ts, slackThreadRef);
  assert.equal(uploads[0].filename, fileName);
  assert.ok(Buffer.from(uploads[0].file).equals(content), "the uploaded bytes are the materials file");
  assert.equal(uploads[0].initial_comment, comment);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].thread_ts, slackThreadRef);
  assert.match(postedMessages[0].text.trimEnd().split("\n").at(-1), /^✓ .*report\.txt/u);
});
