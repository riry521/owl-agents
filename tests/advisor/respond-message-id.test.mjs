import assert from "node:assert/strict";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";

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

test("advisorRespond dispatches the referenced message's own body, not whichever message is newest", async (t) => {
  const root = await tempDir(t, "owl-advisor-respond-message-id-");

  {
    const sentTurns = [];
    let currentTurn;
    let readySent = false;
    const providerClient = {
      createSession: async () => ({
        provider_session_id: "advisor-respond-message-id-session",
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
                provider_session_id: "advisor-respond-message-id-session",
                pid: process.pid,
              };
            }
            assert.ok(currentTurn, "the provider should receive a turn before returning its reply");
            yield {
              type: "turn.completed",
              turn_id: currentTurn.turn_id,
              reply: `Acknowledged: ${currentTurn.text}`,
              usage: null,
            };
          },
        }),
        stop: async () => {},
      }),
    };
    const agentRunner = {
      runManagerPlan: async () => { throw new Error("This regression test never creates a Work."); },
      runWorker: async () => { throw new Error("This regression test never runs a Worker."); },
      runReviewer: async () => { throw new Error("This regression test never runs a Reviewer."); },
      runAdvisor: async () => { throw new Error("The persistent provider session should handle Advisor replies."); },
    };

    const { core, db } = await createTestCore(t, {
      agentRunner,
      providerClient,
      version: "advisor-respond-message-id-test",
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

    const conversation = await core.getActiveConversation();
    const webAccount = db.get(
      "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
      ownerId,
    );
    assert.ok(webAccount, "the default web account should exist");

    const olderMessageId = await insertMessage(db, conversation.conversation_id, webAccount.id, "Older message body");
    const newerMessageId = await insertMessage(db, conversation.conversation_id, webAccount.id, "Newer message body");
    assert.notEqual(olderMessageId, newerMessageId);

    await core.advisorRespond(conversation.conversation_id, olderMessageId, { channel: "web" });

    const reply = await waitFor(
      () => {
        const turn = db.get(
          "SELECT id, status, user_message_id FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1",
          conversation.conversation_id,
        );
        return turn?.status === "completed" ? turn : null;
      },
      { message: "the Advisor turn triggered by the older message to complete" },
    );

    assert.equal(reply.user_message_id, olderMessageId, "the turn should be attributed to the message that was actually referenced");
    assert.equal(sentTurns.length, 1);
    assert.ok(
      sentTurns[0].text.startsWith("Older message body"),
      `the dispatched turn text must come from the referenced message, not the most recently inserted one: ${sentTurns[0].text}`,
    );
    assert.doesNotMatch(
      sentTurns[0].text,
      /Newer message body/u,
      "the newer message's body must never leak into a turn dispatched for the older message",
    );
  }
});
