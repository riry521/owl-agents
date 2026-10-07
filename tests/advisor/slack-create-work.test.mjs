import assert from "node:assert/strict";
import { test } from "node:test";

import { createConfiguredCore } from "../../apps/server/dist/core.js";
import { createCore } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { addAdvisorReplyTargetInstruction, parseAdvisorResponse, parseSlackAdvisorResponse } from "../../packages/shared/dist/index.js";
import { SlackConnector } from "../../packages/connector-slack/dist/index.js";
import { command } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
const ownerId = "owner:default";
const apiToken = "advisor-slack-create-work-test-token";

function commandEnvelope(payload) {
  return command(payload, `advisor-slack-create-work:${createUlid()}`);
}

function advisorReply(title, label, includeVisibleText = true, designMode = undefined) {
  return [
    ...(includeVisibleText ? [`${label}-originated **reply** with a [guide](https://example.com/${label.toLowerCase()}).`] : []),
    "```owl-actions",
    JSON.stringify([{
      type: "create_work",
      description: `Create ${label} origin Work`,
      payload: {
        title,
        summary: `Create and verify the ${label} origin regression Work.`,
        size: "small",
        project_id: null,
        ...(designMode ? { design_mode: designMode } : {}),
      },
    }]),
    "```",
  ].join("\n");
}

test("Advisor prompt adds Slack mrkdwn guidance only for Slack replies", () => {
  const nonSlackPrompt = "\tOperator message\r\nwith exact spacing.  ";
  assert.equal(addAdvisorReplyTargetInstruction(nonSlackPrompt, "web"), nonSlackPrompt);
  assert.equal(addAdvisorReplyTargetInstruction(nonSlackPrompt, "discord"), nonSlackPrompt);

  const slackPrompt = addAdvisorReplyTargetInstruction(nonSlackPrompt, "slack");
  assert.match(slackPrompt, /Slack mrkdwn: use \*bold\* with single asterisks, _italic_, ~strike~/u);
  assert.match(slackPrompt, /Do not use # headings/u);
  assert.match(slackPrompt, /• bullets/u);
  assert.match(slackPrompt, /<url\|text> links/u);
  assert.match(slackPrompt, /or tables/u);
  assert.match(slackPrompt, /opening line that is exactly ```owl-actions/u);
  assert.match(slackPrompt, /owl-actions fence format is unchanged/u);
  assert.match(slackPrompt, /Whenever creating a Work, still emit the required action/u);
  assert.ok(slackPrompt.endsWith(nonSlackPrompt), "the original turn text should be preserved byte-for-byte");
});

test("Advisor parser handles wrapped CRLF owl-actions fences and ignores nested code examples", () => {
  const actions = [{
    type: "create_work",
    description: "Create the regression Work",
    payload: { title: "Regression Work", summary: "Verify fence parsing.", size: "small", project_id: null },
  }];
  const wrappedReply = [
    "Visible reply.",
    "```owl-actions json \t",
    JSON.stringify(actions),
    "```",
  ].join("\r\n");
  const parsed = parseAdvisorResponse(JSON.stringify({ reply: wrappedReply, suggested_actions: [] }));
  assert.deepEqual(parsed, { reply: "Visible reply.", suggested_actions: actions });

  const actionOnly = ["```owl-actions", JSON.stringify(actions), "```"].join("\n");
  assert.deepEqual(parseAdvisorResponse(actionOnly), { reply: "", suggested_actions: actions });
  assert.deepEqual(
    parseAdvisorResponse(JSON.stringify({ reply: actionOnly, suggested_actions: [] })),
    { reply: "", suggested_actions: actions },
  );

  const nestedActions = [
    "Visible reply.",
    "````markdown",
    "```owl-actions",
    JSON.stringify(actions),
    "```",
    "````",
  ].join("\n");
  assert.deepEqual(parseAdvisorResponse(nestedActions), { reply: nestedActions, suggested_actions: [] });

  const secondAction = {
    type: "create_work",
    description: "Create the second Work",
    payload: { title: "Second Work", summary: "Verify multiple fences.", size: "small", project_id: null },
  };
  const multipleFences = [
    "Visible reply.",
    "```owl-actions",
    JSON.stringify(actions),
    "```",
    "Between actions.",
    "```owl-actions",
    JSON.stringify([secondAction]),
    "```",
  ].join("\n");
  assert.deepEqual(parseSlackAdvisorResponse(multipleFences), {
    reply: "Visible reply.\n\nBetween actions.",
    suggested_actions: [...actions, secondAction],
  });
  assert.deepEqual(parseAdvisorResponse(multipleFences), {
    reply: "Visible reply.\n\nBetween actions.",
    suggested_actions: [],
  }, "non-Slack parsing should retain its existing multiple-fence behavior");

  const unlabelledFence = ["Visible reply.", "```", JSON.stringify(actions), "```"].join("\n");
  assert.deepEqual(parseSlackAdvisorResponse(unlabelledFence), {
    reply: unlabelledFence,
    suggested_actions: [],
  });

  const jsonTaggedFence = ["Visible reply.", "```json", JSON.stringify(actions), "```"].join("\n");
  assert.deepEqual(parseSlackAdvisorResponse(jsonTaggedFence), {
    reply: jsonTaggedFence,
    suggested_actions: [],
  });

  const unlabelledCodeExample = ["Example:", "```", JSON.stringify([{ type: "example", value: 1 }]), "```"].join("\n");
  assert.deepEqual(parseSlackAdvisorResponse(unlabelledCodeExample), {
    reply: unlabelledCodeExample,
    suggested_actions: [],
  });
  assert.deepEqual(parseAdvisorResponse(unlabelledCodeExample), {
    reply: unlabelledCodeExample,
    suggested_actions: [],
  });

  const inlineCodeExample = "Show `owl-actions` literally next to this ``` code marker.";
  assert.deepEqual(parseSlackAdvisorResponse(inlineCodeExample), {
    reply: inlineCodeExample,
    suggested_actions: [],
  });

  const actionThenVisibleText = [
    "Visible reply.",
    "```owl-actions json  ",
    JSON.stringify(actions),
    "```",
    "Text after the action block.",
  ].join("\r\n");
  assert.deepEqual(parseSlackAdvisorResponse(actionThenVisibleText), {
    reply: "Visible reply.\r\n\r\nText after the action block.",
    suggested_actions: actions,
  });

  const incompleteFence = ["Visible reply.", "```owl-actions", JSON.stringify(actions)].join("\n");
  assert.deepEqual(parseSlackAdvisorResponse(incompleteFence), {
    reply: "Visible reply.",
    suggested_actions: [],
  });

  const malformedFence = [
    "Visible before.",
    "```owl-actions malformed-header",
    JSON.stringify(actions),
    "```",
    "Visible after.",
  ].join("\r\n");
  assert.deepEqual(parseSlackAdvisorResponse(malformedFence), {
    reply: "Visible before.\r\n\r\nVisible after.",
    suggested_actions: [],
  }, "malformed owl-actions fences should be hidden without executing their payload");

  const exactVisibleWhitespace = "  Slack visible text.\r\n";
  assert.deepEqual(parseSlackAdvisorResponse(exactVisibleWhitespace), {
    reply: exactVisibleWhitespace,
    suggested_actions: [],
  });

  const malformedWrapper = [
    "{malformed legacy wrapper",
    "Visible reply.",
    "```owl-actions",
    JSON.stringify(actions),
    "```",
  ].join("\r\n");
  assert.deepEqual(parseSlackAdvisorResponse(malformedWrapper), {
    reply: "{malformed legacy wrapper\r\nVisible reply.",
    suggested_actions: actions,
  }, "Slack should still parse a valid fence when an outer JSON wrapper is malformed");

  const emptyActions = ["```owl-actions", "[]", "```"].join("\n");
  assert.deepEqual(parseSlackAdvisorResponse(emptyActions), {
    reply: "",
    suggested_actions: [],
  }, "an empty action fence should be hidden without making parsing fail open");
});

test("Slack parsing preserves ordinary code fences and safely strips malformed owl-actions JSON", () => {
  const malformedReasons = [];
  const reply = [
    "Visible before.",
    "```ts",
    "const example = ````owl-actions`;",
    "```",
    "```owl-actions",
    "[{ not valid JSON }]",
    "```",
    "Visible after.",
  ].join("\r\n");

  let parsed;
  assert.doesNotThrow(() => {
    parsed = parseSlackAdvisorResponse(reply, (reason) => malformedReasons.push(reason));
  });
  assert.deepEqual(parsed, {
    reply: [
      "Visible before.",
      "```ts",
      "const example = ````owl-actions`;",
      "```",
      "",
      "Visible after.",
    ].join("\r\n"),
    suggested_actions: [],
  });
  assert.deepEqual(malformedReasons, ["invalid_fence_json"]);
});

test("Slack and web Advisor turns parse owl-actions and create Works end to end", async (t) => {
  const root = await tempDir(t, "owl-advisor-slack-create-work-");
  const previousEnvironment = Object.fromEntries(
    ["OWL_CORE_MODE", "OWL_API_TOKEN", "OWL_OWNER_ID"].map((key) => [key, process.env[key]]),
  );
  process.env.OWL_CORE_MODE = "external";
  process.env.OWL_API_TOKEN = apiToken;
  process.env.OWL_OWNER_ID = ownerId;

  let db;
  let core;
  let unsubscribe;
  try {
    db = createTestDatabase(root);

    let currentTurn;
    const sentTurns = [];
    let sessionRequest;
    let readySent = false;
    const providerClient = {
      createSession: async (request) => {
        sessionRequest = request;
        return {
          provider_session_id: "advisor-slack-create-work-session",
          pid: process.pid,
          send: async (turn) => { currentTurn = turn; sentTurns.push(turn); },
          events: () => ({
            async *[Symbol.asyncIterator]() {
              if (!readySent) {
                readySent = true;
                yield {
                  type: "session.ready",
                  provider_session_id: "advisor-slack-create-work-session",
                  pid: process.pid,
                };
              }
              assert.ok(currentTurn, "the Advisor must receive a turn before its events are read");
              const isSlack = currentTurn.text.includes("SLACK_ORIGIN:");
              yield {
                type: "turn.completed",
                turn_id: currentTurn.turn_id,
                reply: isSlack
                  ? JSON.stringify({
                    reply: advisorReply("**Slack-origin regression Work**", "Slack", false)
                      .replace("```owl-actions", "```owl-actions ")
                      .replace(/\n/gu, "\r\n"),
                    suggested_actions: [],
                  })
                  : advisorReply("Web-origin regression Work", "Web", true, "lead"),
                usage: null,
              };
            },
          }),
          stop: async () => {},
        };
      },
    };
    const agentRunner = {
      runManagerPlan: async () => { throw new Error("small Advisor-created Works should skip Manager planning"); },
      runWorker: async () => ({
        outcome: "failed",
        failure_class: "transient",
        error_key: "advisor_slack_create_work_test",
        retry_allowed: false,
        message: "Test stops after verifying the Work was dispatched.",
      }),
      runReviewer: async () => { throw new Error("Reviewer should not run in this regression test."); },
      runAdvisor: async () => ({ reply: "" }),
    };
    core = await createConfiguredCore({
      db,
      agentRunner,
      providerClient,
      version: "advisor-slack-create-work-test",
      owlRoot: root,
      dataDir: root,
    });
    await core.setLanguage("ja");
    const webConversation = await core.getActiveConversation();
    const slackAccountId = createUlid();
    await core.ensureConnectorAccount(ownerId, "slack", slackAccountId);

    const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root });
    if (!api) return t.skip("localhost listen is unavailable");

    const apiBase = `${api.baseUrl}/api/v1`;
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`,
    };
    const advisorEvents = [];
    unsubscribe = core.subscribe((event) => {
      if (event.type === "advisor.responded") advisorEvents.push(event);
    });

    const slackChannelId = "D-SLACK-CREATE-WORK";
    const slackThreadRef = "1712345678.000100";
    const slackMessageRef = "1712345678.000150";
    const connector = new SlackConnector({
      botToken: "xoxb-advisor-slack-create-work-test",
      appToken: "xapp-advisor-slack-create-work-test",
      conversationChannelId: slackChannelId,
      notificationChannelId: "C-SLACK-NOTIFICATIONS",
      coreApiBase: apiBase,
      apiToken,
      accountId: slackAccountId,
    });
    let postedSlackReply;
    connector.web.chat.postMessage = async (message) => {
      postedSlackReply = message;
      return { ok: true };
    };

    // Exercise SlackConnector.handleMessage so the actual connector builds
    // provider=slack plus the same dm_ref/thread_ref conversation hint it posts.
    await connector.handleMessage({
      user: "U-SLACK-USER",
      text: "SLACK_ORIGIN: create a small example Work",
      channel: slackChannelId,
      ts: slackMessageRef,
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
      { message: "Slack conversation from the inbound message" },
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
        const work = db.get("SELECT id, title, summary, state FROM works WHERE title = ?", "**Slack-origin regression Work**");
        return turn?.status === "completed" && message && work ? { turn, message, work } : null;
      },
      { message: "Slack Advisor reply and created Work" },
    );

    assert.equal(slackReply.turn.origin_channel, "slack");
    assert.equal(slackReply.turn.origin_channel_id, slackChannelId);
    assert.equal(slackReply.turn.origin_ref, slackThreadRef);
    assert.match(slackReply.message.body, /^✓ Work「\*\*Slack-origin regression Work\*\*」を起票し/u);
    assert.doesNotMatch(slackReply.message.body, /```owl-actions/u);
    assert.equal(slackReply.work.title, "**Slack-origin regression Work**", "action payload text must stay raw until Core parses and dispatches it");
    assert.equal(slackReply.work.summary, "Create and verify the Slack origin regression Work.");
    assert.ok(slackReply.work.id, "Core should persist the Slack-requested Work");
    const slackTurn = sentTurns.find((turn) => turn.text.includes("SLACK_ORIGIN:"));
    assert.ok(slackTurn, "the Slack-origin message should be sent to the shared Advisor session");
    assert.match(slackTurn.text, /Slack mrkdwn: use \*bold\* with single asterisks, _italic_, ~strike~/u);
    assert.match(slackTurn.text, /Do not use # headings/u);
    assert.match(slackTurn.text, /• bullets/u);
    assert.match(slackTurn.text, /<url\|text> links/u);
    assert.match(slackTurn.text, /or tables/u);
    assert.match(slackTurn.text, /opening line that is exactly ```owl-actions/u);
    assert.match(slackTurn.text, /owl-actions fence format is unchanged/u);
    assert.match(slackTurn.text, /Whenever creating a Work, still emit the required action/u);
    assert.doesNotMatch(sessionRequest.system_prompt, /Write user-visible text in Slack mrkdwn/u, "the shared system prompt must stay channel-neutral");

    const slackEvent = await waitFor(
      () => advisorEvents.find((event) => event.payload.conversation_id === slackConversation.id),
      { message: "Slack advisor.responded event" },
    );
    assert.deepEqual(slackEvent.payload.origin, {
      channel: "slack",
      channel_id: slackChannelId,
      ref: slackThreadRef,
    });
    assert.deepEqual(slackEvent.payload.suggested_actions, [], "handled create_work actions should not be emitted as suggestions");

    // The Slack connector fetches the persisted reply by the emitted message
    // ID before posting it, so this also checks the body delivered to Slack.
    await connector.handleCoreEvent(slackEvent);
    assert.equal(postedSlackReply.channel, slackChannelId);
    assert.equal(postedSlackReply.thread_ts, slackThreadRef, "the reply should be posted back into the thread it came from");
    assert.match(postedSlackReply.text, /Work「\*Slack-origin regression Work\*」を起票し/u);
    assert.doesNotMatch(postedSlackReply.text, /```owl-actions/u);
    assert.doesNotMatch(postedSlackReply.text, /create_work|Create and verify the Slack origin regression Work/u);

    // Preserve the normal web-origin path through the existing conversation
    // message endpoint and the same persistent Advisor session.
    const webResponse = await fetch(`${apiBase}/conversations/${encodeURIComponent(webConversation.conversation_id)}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(commandEnvelope({ body: "WEB_ORIGIN: create a small example Work", attachment_ids: [] })),
    });
    assert.equal(webResponse.status, 201);
    const webConversationId = webConversation.conversation_id;
    const webReply = await waitFor(
      () => {
        const turn = db.get(
          "SELECT id, status, origin_channel, origin_channel_id, origin_ref FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1",
          webConversationId,
        );
        const message = db.get(
          "SELECT id, body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%' ORDER BY created_at DESC LIMIT 1",
          webConversationId,
        );
        const work = db.get("SELECT id, design_mode FROM works WHERE title = ?", "Web-origin regression Work");
        return turn?.status === "completed" && message && work ? { turn, message, work } : null;
      },
      { message: "web Advisor reply and created Work" },
    );
    assert.equal(webReply.turn.origin_channel, "web");
    assert.equal(webReply.turn.origin_channel_id, null);
    assert.equal(webReply.turn.origin_ref, null);
    const webTurn = sentTurns.find((turn) => turn.text.startsWith("WEB_ORIGIN: create a small example Work"));
    assert.ok(webTurn, "non-Slack messages should keep their original prompt at the start of the turn");
    assert.match(webTurn.text, /<owl-project-search>/u, "each turn should include the current Project catalog");
    assert.match(webTurn.text, /always search this complete, current Project catalog/u);
    assert.doesNotMatch(webTurn.text, /Write user-visible text in Slack mrkdwn/u);
    assert.match(webReply.message.body, /^Web-originated \*\*reply\*\* with a \[guide\]\(https:\/\/example\.com\/web\)\./u);
    assert.match(webReply.message.body, /Work「Web-origin regression Work」を起票し/u);
    assert.doesNotMatch(webReply.message.body, /```owl-actions/u);
    assert.ok(webReply.work.id, "Core should persist the web-requested Work");
    assert.equal(webReply.work.design_mode, "lead", "Advisor's explicit design routing request must persist");
  } finally {
    unsubscribe?.();
    if (core) await core.shutdown({ force: true, timeoutMs: 1_000 }).catch(() => {});
    if (db) db.close();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a one-shot Slack Advisor turn strips owl-actions fences from the reply and runs create_work", async (t) => {
  const root = await tempDir(t, "owl-advisor-slack-one-shot-");
  const previousEnvironment = Object.fromEntries(
    ["OWL_CORE_MODE", "OWL_API_TOKEN", "OWL_OWNER_ID"].map((key) => [key, process.env[key]]),
  );
  process.env.OWL_CORE_MODE = "external";
  process.env.OWL_API_TOKEN = apiToken;
  process.env.OWL_OWNER_ID = ownerId;

  let db;
  let core;
  try {
    db = createTestDatabase(root);

    let advisorRequest;
    const secondAction = {
      type: "create_work",
      description: "Create Slack's second compatibility Work",
      payload: {
        title: "Slack second regression Work",
        summary: "Verify a second action fence is parsed and dispatched.",
        size: "small",
        project_id: null,
      },
    };
    const slackReply = [
      advisorReply("Slack one-shot regression Work", "Slack compatibility"),
      "Visible text between action fences.",
      "```owl-actions json",
      JSON.stringify([secondAction]),
      "```",
      "Visible text after the second action fence.",
      "```owl-actions",
      "[{ not valid JSON }]",
      "```",
      "Visible code example:",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\r\n");
    const agentRunner = {
      runAdvisor: async (request) => {
        advisorRequest = request;
        return { reply: slackReply, suggested_actions: [] };
      },
      runManagerPlan: async () => { throw new Error("small Advisor-created Works should skip Manager planning"); },
      runWorker: async () => ({
        outcome: "failed",
        failure_class: "deterministic",
        error_key: "advisor_slack_one_shot_test",
        retry_allowed: false,
        message: "Test stops after verifying the Work was dispatched.",
      }),
      runReviewer: async () => { throw new Error("Reviewer should not run in this regression test."); },
    };
    core = createCore({
      db,
      agentRunner,
      version: "advisor-slack-one-shot-test",
      owlRoot: root,
      dataDir: root,
    });
    const createWorkCalls = [];
    const createWork = core.createWork.bind(core);
    core.createWork = async (command) => {
      createWorkCalls.push(command);
      return createWork(command);
    };

    await core.getActiveConversation();
    const slackChannelId = "C-SLACK-ONE-SHOT";
    const slackThreadRef = "1712345678.000200";
    const slackAccountId = createUlid();
    await core.ensureConnectorAccount(ownerId, "slack", slackAccountId);

    const envelope = commandEnvelope({
      provider: "slack",
      account_id: slackAccountId,
      external_message_id: "1712345678.000250",
      user_id: "U-SLACK-ONE-SHOT",
      channel_id: slackChannelId,
      thread_id: slackThreadRef,
      received_at: new Date().toISOString(),
      text: "Create a small example Work from Slack.",
      conversation_hint: { work_id: null, dm_ref: slackChannelId, thread_ref: slackThreadRef },
      attachment_ids: [],
    });
    const inbound = await core.ingestInbound(ownerId, envelope);
    const message = await waitFor(
      () => db.get(
        "SELECT id, body, source_message_id FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%' ORDER BY created_at DESC LIMIT 1",
        inbound.data.conversation_id,
      ),
      { message: "one-shot Slack Advisor reply message" },
    );
    const work = db.get("SELECT id, title FROM works WHERE title = ?", "Slack one-shot regression Work");
    const secondWork = db.get("SELECT id, title FROM works WHERE title = ?", "Slack second regression Work");

    assert.ok(advisorRequest, "the one-shot Advisor should receive the Slack-originated turn");
    assert.match(advisorRequest.system_prompt, /Slack mrkdwn: use \*bold\* with single asterisks, _italic_, ~strike~/u);
    assert.ok(work, "Core should execute the create_work fence on the compatibility path");
    assert.ok(secondWork, "Core should execute multiple Slack create_work fences in source order");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM works WHERE title = ?", "Slack one-shot regression Work").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM works WHERE title = ?", "Slack second regression Work").count, 1);
    const turnId = message.source_message_id.split(":").at(-1);
    assert.equal(createWorkCalls.length, 2, "each Slack create_work action should invoke Core's existing create-work path exactly once");
    assert.deepEqual(createWorkCalls.map((call) => ({
      request_id: call.request_id,
      idempotency_key: call.idempotency_key,
      expected_version: call.expected_version,
      payload: call.payload,
    })), [
      {
        request_id: turnId,
        idempotency_key: `advisor-work:${turnId}:0:create`,
        expected_version: 0,
        payload: {
          title: "Slack one-shot regression Work",
          summary: "Create and verify the Slack compatibility origin regression Work.",
          size: "small",
          project_id: null,
        },
      },
      {
        request_id: turnId,
        idempotency_key: `advisor-work:${turnId}:1:create`,
        expected_version: 0,
        payload: {
          title: "Slack second regression Work",
          summary: "Verify a second action fence is parsed and dispatched.",
          size: "small",
          project_id: null,
        },
      },
    ]);
    assert.match(message.body, /^Slack compatibility-originated \*\*reply\*\*/u);
    assert.match(message.body, /Work「Slack one-shot regression Work」を起票し/u);
    assert.match(message.body, /Work「Slack second regression Work」を起票し/u);
    assert.match(message.body, /Visible text between action fences\./u);
    assert.match(message.body, /Visible text after the second action fence\./u);
    assert.match(message.body, /Visible code example:\r?\n```ts\r?\nconst answer = 42;\r?\n```/u);
    assert.doesNotMatch(message.body, /```owl-actions|create_work|Create and verify the Slack compatibility origin Work/u);
    assert.doesNotMatch(message.body, /not valid JSON/u, "malformed action content must not leak into the visible reply");

    const event = {
      id: createUlid(),
      type: "advisor.responded",
      payload: {
        conversation_id: inbound.data.conversation_id,
        message_id: message.id,
        suggested_actions: [],
        origin: { channel: "slack", channel_id: slackChannelId, ref: slackThreadRef },
      },
    };

    const connector = new SlackConnector({
      botToken: "xoxb-advisor-slack-one-shot-test",
      appToken: "xapp-advisor-slack-one-shot-test",
      conversationChannelId: slackChannelId,
      notificationChannelId: "C-SLACK-NOTIFICATIONS",
      coreApiBase: "http://127.0.0.1:1/api/v1",
      apiToken,
      accountId: slackAccountId,
    });
    const posts = [];
    connector.core.request = async () => ({ data: [{ id: event.payload.message_id, body: message.body }] });
    connector.web.chat.postMessage = async (post) => {
      posts.push(post);
      return { ok: true };
    };
    await connector.handleCoreEvent(event);

    assert.equal(posts.length, 1);
    assert.equal(posts[0].channel, slackChannelId);
    assert.match(posts[0].text, /Work「Slack one-shot regression Work」を起票し/u);
    assert.match(posts[0].text, /Work「Slack second regression Work」を起票し/u);
    assert.match(posts[0].text, /^Slack compatibility-originated \*reply\* with a /u);
    assert.match(posts[0].text, /Visible text after the second action fence\./u);
    assert.match(posts[0].text, /Visible code example:/u);
    assert.doesNotMatch(posts[0].text, /```owl-actions|create_work|Create and verify the Slack compatibility origin Work/u);
    assert.doesNotMatch(posts[0].text, /not valid JSON/u);
  } finally {
    if (core) await core.stop({ force: true }).catch(() => {});
    if (db) db.close();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a web Advisor reply without owl-actions is stored unchanged", async (t) => {
  const root = await tempDir(t, "owl-advisor-nonslack-passthrough-");
  const previousEnvironment = Object.fromEntries(
    ["OWL_CORE_MODE", "OWL_API_TOKEN", "OWL_OWNER_ID"].map((key) => [key, process.env[key]]),
  );
  process.env.OWL_CORE_MODE = "external";
  process.env.OWL_API_TOKEN = apiToken;
  process.env.OWL_OWNER_ID = ownerId;

  let db;
  let core;
  const originalReply = "  Plain **visible** reply.\r\n```ts\r\nconst answer = 42;\r\n```\r\n";
  try {
    db = createTestDatabase(root);
    core = createCore({
      db,
      agentRunner: {
        runAdvisor: async () => ({ reply: originalReply, suggested_actions: [] }),
        runManagerPlan: async () => { throw new Error("No Work should be created in the passthrough test."); },
        runWorker: async () => { throw new Error("No Worker should run in the passthrough test."); },
        runReviewer: async () => { throw new Error("No Reviewer should run in the passthrough test."); },
      },
      version: "advisor-nonslack-passthrough-test",
      owlRoot: root,
      dataDir: root,
    });

    const conversation = await core.getActiveConversation();
    const webAccount = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId);
    assert.ok(webAccount);
    const now = new Date().toISOString();
    const userMessageId = createUlid();
    await db.createWriteLane().transact((transaction) => {
      transaction.run(
        `INSERT INTO messages
           (id, conversation_id, provider, account_id, source_message_id, body,
            attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?)`,
        userMessageId,
        conversation.conversation_id,
        webAccount.id,
        `web-user:${userMessageId}`,
        "Reply with the supplied text.",
        JSON.stringify([]),
        now,
        now,
      );
    });

    await core.advisorRespond(conversation.conversation_id, userMessageId, { channel: "web" });
    const storedReply = db.get(
      "SELECT body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%' ORDER BY created_at DESC LIMIT 1",
      conversation.conversation_id,
    );
    assert.ok(storedReply);
    assert.equal(storedReply.body, originalReply);
  } finally {
    if (core) await core.stop({ force: true }).catch(() => {});
    if (db) db.close();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
