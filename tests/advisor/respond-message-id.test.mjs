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

test("the next Advisor turn's input carries the previous reply's owl-actions results, including failures", async (t) => {
  const root = await tempDir(t, "owl-advisor-action-results-");
  const sentTurns = [];
  const replies = [
    [
      "Working on it.",
      "```owl-actions",
      JSON.stringify([
        { type: "create_work", description: "Create", payload: { title: "Carry results Work", summary: "Check the result is passed on.", size: "small", project_id: null } },
        { type: "pause_work", description: "Pause", payload: { work_id: "no-such-work-id" } },
      ]),
      "```",
    ].join("\n"),
    "Second reply.",
  ];
  let currentTurn;
  let readySent = false;
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "advisor-action-results-session",
      pid: process.pid,
      send: async (turn) => {
        currentTurn = turn;
        sentTurns.push(turn);
      },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield { type: "session.ready", provider_session_id: "advisor-action-results-session", pid: process.pid };
          }
          yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: replies.shift(), usage: null };
        },
      }),
      stop: async () => {},
    }),
  };
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => { throw new Error("The persistent provider session should handle Advisor replies."); },
  };
  const { core, db } = await createTestCore(t, {
    agentRunner, providerClient, version: "advisor-action-results-test", owlRoot: root, dataDir: root,
    dispatcher: { tick_interval_ms: 25 },
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await core.start();

  const conversation = await core.getActiveConversation();
  const webAccount = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId);
  const first = await insertMessage(db, conversation.conversation_id, webAccount.id, "First request");
  await core.advisorRespond(conversation.conversation_id, first, { channel: "web" });
  const advisorMessage = () => db.get("SELECT body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%'", conversation.conversation_id);
  await waitFor(() => advisorMessage());
  const workId = db.get("SELECT id FROM works WHERE title = 'Carry results Work'")?.id;
  assert.ok(workId, "the create_work action should have created the Work");
  const shownToOwner = advisorMessage().body;

  const second = await insertMessage(db, conversation.conversation_id, webAccount.id, "Second request");
  await core.advisorRespond(conversation.conversation_id, second, { channel: "web" });
  await waitFor(() => sentTurns.length === 2);
  const secondText = sentTurns[1].text;
  const noticeLines = shownToOwner.split("\n").filter((line) => line.includes(workId) || line.includes("no-such-work-id"));
  assert.ok(noticeLines.length >= 1, "the Owner-facing reply reports the results");
  for (const line of noticeLines) assert.ok(secondText.includes(line), `the next turn carries: ${line}`);
  assert.ok(noticeLines.some((line) => !line.includes(workId)), "the failed pause_work notice is a separate line");
  assert.ok(secondText.indexOf("<owl-action-results>") < secondText.indexOf("Second request"));
  assert.equal(sentTurns[0].text.includes("owl-action-results"), false);
});
