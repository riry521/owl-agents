import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAdvisorRateLimitReply } from "../../packages/core/dist/advisor-text.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

process.env.TZ = "UTC";

const resetAt = "2030-01-02T04:05:00.000Z";

async function insertMessage(db, conversationId, accountId, body) {
  const id = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO messages
         (id, conversation_id, provider, account_id, source_message_id, body,
          attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
      id,
      conversationId,
      accountId,
      `web-user:${id}`,
      body,
      now,
      now,
    );
  });
  return id;
}

async function exerciseRateLimit(t, { language, reportedReset, queueSecondTurn = false }) {
  const root = await tempDir(t, "owl-advisor-rate-limit-");
  const sentTurns = [];
  let currentTurn;
  let readySent = false;
  let releaseRateLimit = () => {};
  const rateLimitGate = queueSecondTurn
    ? new Promise((resolvePromise) => { releaseRateLimit = resolvePromise; })
    : Promise.resolve();
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "advisor-rate-limit-session",
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
              provider_session_id: "advisor-rate-limit-session",
              pid: process.pid,
            };
          }
          await rateLimitGate;
          assert.ok(currentTurn, "the provider must receive the turn before reporting its limit");
          yield {
            type: "turn.failed",
            turn_id: currentTurn.turn_id,
            error: "429 Too many requests",
            rate_limit: {
              resets_at: reportedReset,
              source: reportedReset === null ? null : "event",
            },
          };
        },
      }),
      stop: async () => {},
    }),
  };

  {
    const { core, db } = await createTestCore(t, {
      agentRunner: {
        runManagerPlan: async () => { throw new Error("No Work should be created in this test."); },
        runWorker: async () => { throw new Error("No Worker should run in this test."); },
        runReviewer: async () => { throw new Error("No Reviewer should run in this test."); },
        runAdvisor: async () => { throw new Error("The persistent Advisor provider should handle replies."); },
      },
      providerClient,
      version: "advisor-rate-limit-reply-test",
      owlRoot: root,
      dataDir: root,
    });
    core.gitGateway().inspectAdvisorWorkspace = async () => ({
      ok: true,
      dirty: false,
      message: "The test Advisor workspace is clean.",
    });
    await core.start();
    await core.setLanguage(language);

    const conversation = await core.getActiveConversation();
    const account = db.get(
      "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
      "owner:default",
    );
    assert.ok(account, "the default web account should exist");
    const userMessageId = await insertMessage(db, conversation.conversation_id, account.id, "Please answer this once.");

    await core.advisorRespond(conversation.conversation_id, userMessageId, { channel: "web" });
    let secondUserMessageId = null;
    if (queueSecondTurn) {
      await waitFor(() => sentTurns.length === 1, { message: "the first Advisor turn to reach the Provider" });
      secondUserMessageId = await insertMessage(db, conversation.conversation_id, account.id, "Please answer this next.");
      await core.advisorRespond(conversation.conversation_id, secondUserMessageId, { channel: "web" });
      releaseRateLimit();
    }

    const turn = await waitFor(
      () => db.get(
        "SELECT id, status FROM advisor_turns WHERE user_message_id = ? ORDER BY queued_at DESC LIMIT 1",
        userMessageId,
      )?.status === "failed"
        ? db.get("SELECT id, status FROM advisor_turns WHERE user_message_id = ? ORDER BY queued_at DESC LIMIT 1", userMessageId)
        : null,
      { message: "the Advisor rate-limited turn to fail" },
    );
    const reply = await waitFor(
      () => db.get(
        "SELECT body FROM messages WHERE source_message_id = ?",
        `advisor:${conversation.conversation_id}:${turn.id}`,
      ),
      { message: "the Advisor rate-limit reply to be persisted" },
    );
    if (queueSecondTurn) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const pause = db.get("SELECT * FROM provider_pauses WHERE provider = 'anthropic'");
    const queuedTurn = secondUserMessageId === null
      ? null
      : db.get("SELECT id, status FROM advisor_turns WHERE user_message_id = ?", secondUserMessageId);

    return { reply: reply.body, pause, sentTurns, queuedTurn };
  }
}

test("Advisor replies with the reported reset time in Japanese and English and records the Provider pause", async (t) => {
  for (const language of ["ja", "en"]) {
    await t.test(language === "ja" ? "replies in Japanese with the reported reset time" : "replies in English with the reported reset time", async (subtest) => {
      const result = await exerciseRateLimit(subtest, { language, reportedReset: resetAt });
      const formatted = new Intl.DateTimeFormat(language === "ja" ? "ja-JP" : "en-US", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(resetAt));

      assert.ok(result.reply.includes(formatted), "the reply should include the provider-reported reset time");
      assert.match(result.reply, /\b(?:UTC|GMT)\b/u, "the reply should identify the time zone");
      assert.match(result.reply, language === "ja" ? /ごろ解除/u : /reset around/u);
      assert.equal(result.sentTurns.length, 1, "the same request must not be sent again automatically");
      assert.equal(result.pause?.state, "paused", "the rate limit must pause its Provider");
      assert.equal(result.pause?.provider, "anthropic");
      assert.equal(result.pause?.reported_resets_at, resetAt);
    });
  }
});

test("Advisor leaves queued turns unsent while their Provider is paused", async (t) => {
  const result = await exerciseRateLimit(t, { language: "en", reportedReset: resetAt, queueSecondTurn: true });

  assert.equal(result.sentTurns.length, 1, "the second queued turn must not be sent to the paused Provider");
  assert.equal(result.queuedTurn?.status, "queued", "the second turn must remain queued for later processing");
  assert.equal(result.pause?.state, "paused");
});

test("Advisor uses the next scheduled attempt when the Provider reports no reset time", async (t) => {
  const result = await exerciseRateLimit(t, { language: "en", reportedReset: null });
  const scheduled = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(result.pause.resume_at));

  assert.ok(result.reply.includes(scheduled), "the reply should include the store's next scheduled attempt time");
  assert.match(result.reply, /next attempt is scheduled around/u);
  assert.equal(result.pause?.resume_source, "backoff");
  assert.equal(result.sentTurns.length, 1, "the request must not be resent while the Provider is paused");
});

test("Advisor uses an unknown-time message when neither reset nor next attempt is available", () => {
  assert.match(formatAdvisorRateLimitReply("ja", null, null), /解除時刻は未定/u);
  assert.match(formatAdvisorRateLimitReply("en", null, null), /reset time is unknown/u);
});
