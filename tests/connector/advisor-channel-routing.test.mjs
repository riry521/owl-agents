import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { resolveDiscordAdvisorChannel } from "../../packages/connector-discord/dist/index.js";
import { resolveSlackAdvisorChannel } from "../../packages/connector-slack/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { createTestRepo } from "../helpers/git.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";
const slackChannelId = "C-ROUTING-SLACK";
const discordChannelId = "D-ROUTING-DISCORD";

test("messages from unbound Slack and Discord channels join the general window's conversation and its single session", async (t) => {
  let currentTurn;
  let readySent = false;
  let sessionsCreated = 0;
  const sentTurns = [];
  const providerClient = {
    createSession: async () => {
      sessionsCreated += 1;
      return {
        provider_session_id: "channel-routing-session",
        pid: process.pid,
        send: async (turn) => {
          currentTurn = turn;
          sentTurns.push(turn);
        },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            if (!readySent) {
              readySent = true;
              yield { type: "session.ready", provider_session_id: "channel-routing-session", pid: process.pid };
            }
            for (let handled = 0; ; handled += 1) {
              await waitFor(() => sentTurns.length > handled, { message: "the next turn reaches the provider" });
              yield { type: "turn.completed", turn_id: sentTurns[handled].turn_id, reply: `reply ${handled + 1}`, usage: null };
            }
          },
        }),
        stop: async () => {},
      };
    },
  };
  const { db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => { throw new Error("No Work is planned here."); },
      runWorker: async () => { throw new Error("No Worker runs here."); },
      runReviewer: async () => { throw new Error("No Reviewer runs here."); },
      runAdvisor: async () => { throw new Error("The persistent provider session handles replies."); },
    },
    providerClient,
    version: "advisor-channel-routing-test",
    dispatcher: { tick_interval_ms: 25 },
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await core.start();

  const general = await core.getActiveConversation();
  const accounts = { slack: createUlid(), discord: createUlid() };
  await core.ensureConnectorAccount(ownerId, "slack", accounts.slack);
  await core.ensureConnectorAccount(ownerId, "discord", accounts.discord);
  const conversationCount = () => db.get("SELECT COUNT(*) AS count FROM conversations").count;
  const before = conversationCount();

  const inbound = (provider, channelId, externalId, text, threadId = null) => core.ingestInbound(ownerId, command({
    provider,
    account_id: accounts[provider],
    external_message_id: externalId,
    user_id: `U-${provider}`,
    channel_id: channelId,
    thread_id: threadId,
    received_at: new Date().toISOString(),
    text,
    conversation_hint: { work_id: null, dm_ref: channelId, thread_ref: null },
    attachment_ids: [],
  }, `routing:${externalId}`));
  const completedTurns = (count) => waitFor(() => {
    const turns = db.all("SELECT status FROM advisor_turns WHERE conversation_id = ?", general.conversation_id);
    return turns.length === count && turns.every((turn) => turn.status === "completed") ? turns : null;
  }, { message: `${count} completed turns in the general conversation` });

  await inbound("slack", slackChannelId, "slack-1", "from slack", "1712345678.000100");
  await completedTurns(1);
  await inbound("discord", discordChannelId, "discord-1", "from discord");
  await completedTurns(2);

  assert.equal(conversationCount(), before, "no Slack or Discord conversation row is created");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE channel IN ('slack', 'discord')").count, 0);
  for (const provider of ["slack", "discord"]) {
    const row = db.get("SELECT conversation_id FROM messages WHERE provider = ? AND source_message_id LIKE ?", provider, `%${provider}-1`);
    assert.equal(row.conversation_id, general.conversation_id, `${provider} message is in the general conversation`);
  }

  const web = await core.postMessage(general.conversation_id, command({ body: "from web", attachment_ids: [] }, "routing:web-1"));
  assert.ok(web.data.message_id);
  await core.advisorRespond(general.conversation_id, web.data.message_id, { channel: "web" });
  await completedTurns(3);

  assert.equal(sessionsCreated, 1, "Web, Slack and Discord share one session");
  assert.equal(db.get("SELECT COUNT(DISTINCT session_id) AS count FROM advisor_turns").count, 1);
  assert.equal(
    db.get("SELECT window_id FROM advisor_sessions LIMIT 1").window_id,
    db.get("SELECT id FROM advisor_windows WHERE scope = 'general'").id,
  );

  const bodies = core.listMessages(general.conversation_id, { limit: 50 }).data.map((message) => message.body);
  assert.deepEqual(bodies, ["from slack", "reply 1", "from discord", "reply 2", "from web", "reply 3"]);

  const responded = db.all("SELECT payload_json FROM events WHERE type = 'advisor.responded' ORDER BY sequence").map((row) => JSON.parse(row.payload_json));
  assert.equal(responded.length, 3);
  const slackReply = responded.find((payload) => payload.origin?.channel === "slack");
  assert.equal(slackReply.origin.channel_id, slackChannelId);
  assert.equal(slackReply.conversation_id, general.conversation_id);
  assert.equal(responded.find((payload) => payload.origin?.channel === "discord").origin.channel_id, discordChannelId);
});

test("a channel bound to a dedicated window joins that window's conversation and session, and a renamed channel still routes by id", async (t) => {
  const sentTurns = [];
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "bound-routing-session",
      pid: process.pid,
      send: async (turn) => { sentTurns.push(turn); },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "session.ready", provider_session_id: "bound-routing-session", pid: process.pid };
          for (let handled = 0; ; handled += 1) {
            await waitFor(() => sentTurns.length > handled, { message: "the next turn reaches the provider" });
            yield { type: "turn.completed", turn_id: sentTurns[handled].turn_id, reply: `reply ${handled + 1}`, usage: null };
          }
        },
      }),
      stop: async () => {},
    }),
  };
  const { db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => { throw new Error("No Work is planned here."); },
      runWorker: async () => { throw new Error("No Worker runs here."); },
      runReviewer: async () => { throw new Error("No Reviewer runs here."); },
      runAdvisor: async () => { throw new Error("The persistent provider session handles replies."); },
    },
    providerClient,
    version: "advisor-channel-routing-bound-test",
    dispatcher: { tick_interval_ms: 25 },
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await core.start();

  const repo = await realpath(await createTestRepo(t, { prefix: "owl-channel-routing-repo-" }));
  const project = (await core.createProject(command({
    name: "Bound",
    canonical_path: repo,
    base_branch: "main",
    allowed_roots: [repo],
    verification_plan: [],
  }, "routing:project"))).data;
  const window = await core.ensureAdvisorWindow(ownerId, project.id);
  const general = await core.getActiveConversation();
  assert.notEqual(window.conversation_id, general.conversation_id);
  const now = new Date().toISOString();
  const lane = db.createWriteLane();
  const bind = (provider, channelId, name) => lane.transact((tx) => tx.run(
    "INSERT INTO advisor_channel_bindings (id, window_id, provider, channel_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    createUlid(), window.window_id, provider, channelId, name, now, now,
  ));
  await bind("slack", slackChannelId, "owl-bound");
  await bind("discord", discordChannelId, "owl-bound");
  assert.deepEqual(await core.listAdvisorChannelBindings("slack"), [{ window_id: window.window_id, channel_id: slackChannelId }]);

  const accounts = { slack: createUlid(), discord: createUlid() };
  await core.ensureConnectorAccount(ownerId, "slack", accounts.slack);
  await core.ensureConnectorAccount(ownerId, "discord", accounts.discord);
  const inbound = (provider, channelId, externalId, text) => core.ingestInbound(ownerId, command({
    provider,
    account_id: accounts[provider],
    external_message_id: externalId,
    user_id: `U-${provider}`,
    channel_id: channelId,
    thread_id: null,
    received_at: new Date().toISOString(),
    text,
    conversation_hint: { work_id: null, dm_ref: channelId, thread_ref: null },
    attachment_ids: [],
  }, `bound-routing:${externalId}`));
  const completedTurns = (count) => waitFor(() => {
    const turns = db.all("SELECT status FROM advisor_turns WHERE conversation_id = ?", window.conversation_id);
    return turns.length === count && turns.every((turn) => turn.status === "completed") ? turns : null;
  }, { message: `${count} completed turns in the bound window's conversation` });

  await inbound("slack", slackChannelId, "slack-1", "from slack");
  await completedTurns(1);
  // A rename only changes display_name; routing and the reply target use the channel id.
  await lane.transact((tx) => tx.run("UPDATE advisor_channel_bindings SET display_name = 'renamed' WHERE provider = 'slack'"));
  await inbound("slack", slackChannelId, "slack-2", "after rename");
  await completedTurns(2);
  await inbound("discord", discordChannelId, "discord-1", "from discord");
  await completedTurns(3);

  const web = await core.postMessage(window.conversation_id, command({ body: "from web", attachment_ids: [] }, "bound-routing:web-1"));
  await core.advisorRespond(window.conversation_id, web.data.message_id, { channel: "web" });
  await completedTurns(4);

  assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE channel IN ('slack', 'discord')").count, 0);
  assert.equal(db.get("SELECT COUNT(DISTINCT session_id) AS count FROM advisor_turns").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?", general.conversation_id).count, 0);

  const responded = db.all("SELECT payload_json FROM events WHERE type = 'advisor.responded' ORDER BY sequence").map((row) => JSON.parse(row.payload_json));
  const slackReplies = responded.filter((payload) => payload.origin?.channel === "slack");
  assert.equal(slackReplies.length, 2);
  for (const reply of slackReplies) {
    assert.equal(reply.origin.channel_id, slackChannelId);
    assert.equal(reply.conversation_id, window.conversation_id);
  }
  const discordEvent = responded.find((payload) => payload.origin?.channel === "discord");
  assert.equal(resolveSlackAdvisorChannel({ payload: slackReplies[0] }, [], new Map()), null);
  assert.equal(resolveSlackAdvisorChannel({ payload: slackReplies[0] }, ["C-OTHER", slackChannelId], new Map()), slackChannelId);
  assert.equal(resolveDiscordAdvisorChannel({ payload: discordEvent }, ["other", discordChannelId]), discordChannelId);
});
