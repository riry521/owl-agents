import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelType, PermissionFlagsBits } from "../../packages/connector-discord/node_modules/discord.js/src/index.js";

import { createDiscordConnector } from "../../packages/connector-discord/dist/index.js";
import { createSlackConnector } from "../../packages/connector-slack/dist/index.js";
import { isChannelAdminError } from "../../packages/plugin-sdk/dist/index.js";

const slackConfig = { botToken: "bot", appToken: "app", conversationChannelId: "C-CONF", notificationChannelId: "C-CONF", coreApiBase: "http://127.0.0.1:1/api/v1", accountId: "acct" };
const discordConfig = { botToken: "bot", conversationChannelId: "D-CONF", notificationChannelId: "D-CONF", coreApiBase: "http://127.0.0.1:1/api/v1", accountId: "acct" };

function slackWith(conversations) {
  const connector = createSlackConnector(slackConfig);
  connector.web = { conversations };
  return connector.channelAdmin();
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

test("Slack creates, renames and describes channels through conversations.create, rename and info", async () => {
  const calls = [];
  const admin = slackWith({
    create: async (args) => { calls.push(["create", args]); return { channel: { id: "C1", name: args.name, is_member: true } }; },
    rename: async (args) => { calls.push(["rename", args]); return { channel: { id: args.channel, name: args.name } }; },
    info: async (args) => { calls.push(["info", args]); return { channel: { id: args.channel, name: "shown", is_member: false } }; },
  });
  assert.deepEqual(await admin.createChannel("owl-app"), { channel_id: "C1", name: "owl-app", bot_is_member: true });
  assert.deepEqual(await admin.renameChannel("C1", "owl-new"), { channel_id: "C1", name: "owl-new", bot_is_member: true });
  assert.deepEqual(await admin.describeChannel("C1"), { channel_id: "C1", name: "shown", bot_is_member: false });
  assert.deepEqual(calls, [
    ["create", { name: "owl-app", is_private: false }],
    ["rename", { channel: "C1", name: "owl-new" }],
    ["info", { channel: "C1" }],
  ]);
});

test("Slack invites users through conversations.invite and maps its failures", async () => {
  const calls = [];
  const admin = slackWith({ invite: async (args) => { calls.push(args); return { ok: true }; } });
  await admin.inviteUsers("C1", ["U1", "U2"]);
  assert.deepEqual(calls, [{ channel: "C1", users: "U1,U2" }]);
  const failing = slackWith({ invite: async () => { throw Object.assign(new Error("slack"), { data: { error: "missing_scope", needed: "channels:manage" } }); } });
  const error = await rejection(failing.inviteUsers("C1", ["U1"]));
  assert.equal(error.code, "permission_missing");
  assert.deepEqual(error.needed, ["channels:manage"]);
});

test("Slack errors map to channel admin codes, with the missing scopes in needed", async () => {
  const failing = (error, extra = {}) => slackWith({ create: async () => { throw Object.assign(new Error("slack"), { data: { error, ...extra } }); } });
  const missing = await rejection(failing("missing_scope", { needed: "channels:manage,channels:read" }).createChannel("x"));
  assert.ok(isChannelAdminError(missing));
  assert.equal(missing.code, "permission_missing");
  assert.deepEqual(missing.needed, ["channels:manage", "channels:read"]);
  for (const [slackError, code] of [
    ["name_taken", "name_taken"], ["invalid_name_specials", "invalid_name"], ["channel_not_found", "not_found"],
    ["not_in_channel", "bot_not_in_channel"], ["restricted_action", "not_authorized"], ["something_else", "provider_error"],
  ]) {
    const error = await rejection(failing(slackError).createChannel("x"));
    assert.equal(error.code, code, slackError);
  }
  const limited = await rejection(slackWith({ create: async () => { throw Object.assign(new Error("rate"), { retryAfter: 7 }); } }).createChannel("x"));
  assert.equal(limited.code, "rate_limited");
  assert.equal(limited.retry_after_seconds, 7);
});

function discordGuild({ canManage, memberFlags = [] }) {
  const calls = [];
  const me = { permissions: { has: (flag) => canManage && flag === PermissionFlagsBits.ManageChannels } };
  const guild = { members: { me } };
  const channelWith = (id, name) => ({
    id, name, guild, isDMBased: () => false,
    permissionsFor: () => ({ has: (flag) => (flag === PermissionFlagsBits.ManageChannels ? canManage : memberFlags.includes(flag)) }),
    edit: async (args) => { calls.push(["edit", id, args]); return channelWith(id, args.name); },
  });
  guild.channels = { create: async (args) => { calls.push(["create", args]); return channelWith("D1", args.name); } };
  const client = { channels: { fetch: async (id) => { calls.push(["fetch", id]); return channelWith(id, `name-${id}`); } } };
  const connector = createDiscordConnector(discordConfig);
  connector.client = client;
  return { admin: connector.channelAdmin(), calls };
}

test("Discord creates, renames and describes channels through guild.channels.create, channel.edit and channels.fetch", async () => {
  const everything = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  const { admin, calls } = discordGuild({ canManage: true, memberFlags: everything });
  assert.deepEqual(await admin.createChannel("owl-app"), { channel_id: "D1", name: "owl-app", bot_is_member: true });
  assert.deepEqual(await admin.renameChannel("D2", "owl-new"), { channel_id: "D2", name: "owl-new", bot_is_member: true });
  assert.deepEqual(await admin.describeChannel("D2"), { channel_id: "D2", name: "name-D2", bot_is_member: true });
  assert.deepEqual(calls, [
    ["fetch", "D-CONF"],
    ["create", { name: "owl-app", type: ChannelType.GuildText }],
    ["fetch", "D2"],
    ["edit", "D2", { name: "owl-new" }],
    ["fetch", "D2"],
  ]);
  const partial = discordGuild({ canManage: true, memberFlags: [PermissionFlagsBits.ViewChannel] });
  const missing = await rejection(partial.admin.describeChannel("D2"));
  assert.equal(missing.code, "bot_not_in_channel");
  assert.deepEqual(missing.needed, ["SendMessages", "ReadMessageHistory"]);
});

test("Discord without Manage Channels reports permission_missing and does not call the API", async () => {
  const { admin, calls } = discordGuild({ canManage: false });
  for (const attempt of [() => admin.createChannel("x"), () => admin.renameChannel("D2", "x")]) {
    const error = await rejection(attempt());
    assert.equal(error.code, "permission_missing");
    assert.deepEqual(error.needed, ["ManageChannels"]);
  }
  assert.ok(!calls.some(([kind]) => kind === "create" || kind === "edit"));
});

test("Discord API error codes map to channel admin codes", async () => {
  const connector = createDiscordConnector(discordConfig);
  const guild = { members: { me: { permissions: { has: () => true } } } };
  guild.channels = { create: async () => { throw current; } };
  connector.client = { channels: { fetch: async () => ({ isDMBased: () => false, guild }) } };
  let current;
  const admin = connector.channelAdmin();
  const expected = [
    [Object.assign(new Error("d"), { code: 50013 }), "permission_missing"],
    [Object.assign(new Error("d"), { code: 50035 }), "invalid_name"],
    [Object.assign(new Error("d"), { code: 10003 }), "not_found"],
    [Object.assign(new Error("d"), { code: 50001 }), "bot_not_in_channel"],
    [Object.assign(new Error("d"), { status: 429, timeToReset: 2500 }), "rate_limited"],
    [Object.assign(new Error("d"), { code: 1 }), "provider_error"],
  ];
  for (const [error, code] of expected) {
    current = error;
    const result = await rejection(admin.createChannel("x"));
    assert.equal(result.code, code);
    if (code === "permission_missing") assert.deepEqual(result.needed, ["ManageChannels"]);
    if (code === "rate_limited") assert.equal(result.retry_after_seconds, 3);
  }
});
