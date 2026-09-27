import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { SlackConnector } from "../packages/connector-slack/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("Slack Advisor reply converts Markdown, dispatches owl-actions, and preserves web Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-slack-reply-e2e-"));
  let db;
  let core;
  let coreStarted = false;

  try {
    db = openDatabase(join(root, "owl.sqlite"));
    db.migrate(join(repoRoot, "packages/db/migrations"));

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

    core = new Core({
      db,
      agentRunner,
      providerClient,
      version: "slack-reply-e2e-test",
      owlRoot: root,
      dataDir: root,
      dispatcher: { tick_interval_ms: 25 },
    });
    core.gitGateway().inspectAdvisorWorkspace = async () => ({
      ok: true,
      dirty: false,
      message: "The regression test Advisor workspace is clean.",
    });
    await core.start();
    coreStarted = true;

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

    const slackConversation = await waitFor(
      // Slack conversations are grouped channel-wide (thread_ref is always
      // null); thread_ts is carried separately as the reply destination.
      () => db.get(
        `SELECT id FROM conversations
          WHERE owner_id = ? AND channel = 'slack' AND dm_ref = ? AND thread_ref IS NULL`,
        ownerId,
        slackChannelId,
      ),
      "Slack-originated Advisor conversation",
    );
    const slackReply = await waitFor(
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
    const webReply = await waitFor(
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
  } finally {
    if (coreStarted) await core.stop({ force: true }).catch(() => {});
    if (db) db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Slack top-level posts in a channel share one channel-wide conversation
// (thread_ref is always null); a thread reply lands in that same
// conversation but its Advisor reply must still go back into that thread.
test("Slack groups two top-level posts and a thread reply into one conversation, each reply posted to its own thread_ts", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-slack-multi-turn-e2e-"));
  let db;
  let core;
  let coreStarted = false;

  try {
    db = openDatabase(join(root, "owl.sqlite"));
    db.migrate(join(repoRoot, "packages/db/migrations"));

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

    core = new Core({
      db,
      agentRunner,
      providerClient,
      version: "slack-multi-turn-e2e-test",
      owlRoot: root,
      dataDir: root,
      dispatcher: { tick_interval_ms: 25 },
    });
    core.gitGateway().inspectAdvisorWorkspace = async () => ({
      ok: true,
      dirty: false,
      message: "The regression test Advisor workspace is clean.",
    });
    await core.start();
    coreStarted = true;

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

    const conversation = await waitFor(
      () => db.get(
        `SELECT id FROM conversations
          WHERE owner_id = ? AND channel = 'slack' AND dm_ref = ? AND thread_ref IS NULL`,
        ownerId,
        slackChannelId,
      ),
      "the single Slack channel-wide conversation",
    );

    await waitFor(
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
  } finally {
    if (coreStarted) await core.stop({ force: true }).catch(() => {});
    if (db) db.close();
    await rm(root, { recursive: true, force: true });
  }
});
