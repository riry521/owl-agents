import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { ChannelAdminError } from "../../packages/plugin-sdk/dist/index.js";
import { defaultChannelName } from "../../packages/shared/dist/advisor-window-settings.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { createTestRepo } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const token = "channels-owner-token";

function fakeAdmin(overrides = {}) {
  const calls = [];
  let created = 0;
  const admin = {
    calls,
    createChannel: async (name) => { calls.push(["create", name]); created += 1; return { channel_id: `C-NEW-${created}`, name, bot_is_member: true }; },
    renameChannel: async (id, name) => { calls.push(["rename", id, name]); return { channel_id: id, name, bot_is_member: true }; },
    describeChannel: async (id) => { calls.push(["describe", id]); return { channel_id: id, name: `existing-${id}`, bot_is_member: true }; },
    ...overrides,
  };
  return admin;
}

async function startApi(t, admins = {}, { guard = false } = {}) {
  const { root, db, core: durableCore } = await createTestCore(t, { version: "advisor-window-channels-test" }, { prefix: "owl-api-window-channels-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const guardTokens = guard ? GuardTokenRegistry.open(join(root, "guard-tokens")) : undefined;
  if (guardTokens) t.after(() => guardTokens.clear());
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const channelAdmins = { channelAdmin: (provider) => admins[provider] ?? null };
  const server = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir, channelAdmins, guardTokens }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  const request = (method, path, body, authorization = token) => fetch(`${server.baseUrl}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${authorization}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const project = async (name) => {
    const path = await realpath(await createTestRepo(t, { prefix: "owl-api-window-channels-repo-" }));
    const created = (await durableCore.createProject(command({ name, canonical_path: path, base_branch: "main", allowed_roots: [path], verification_plan: [] }, `create-project:${name}`))).data;
    return { ...created, project_id: created.project_id ?? created.id };
  };
  return { db, durableCore, core, request, project, guardTokens, root };
}

const channelsPath = (key, provider = "") => `/advisor/windows/${key}/channels${provider ? `/${provider}` : ""}`;
const send = (api, method, key, provider, payload, idempotencyKey) =>
  api.request(method, channelsPath(key, provider), command(payload, idempotencyKey));
const errorOf = async (response) => (await response.json()).error;

test("POST creates the channel with the typed name, or the default name, and binds the returned channel_id", async (t) => {
  const slack = fakeAdmin();
  const api = await startApi(t, { slack });
  if (!api) return;
  const first = await api.project("Owl Agents");
  const second = await api.project("Second App");
  const settings = await api.durableCore.getAdvisorWindowSettings();

  const typed = await send(api, "POST", first.project_id, "slack", { name: "My Custom Channel" }, "create-typed");
  assert.equal(typed.status, 201);
  assert.deepEqual(slack.calls[0], ["create", "my-custom-channel"]);
  const body = (await typed.json()).data;
  assert.deepEqual(body, { provider: "slack", channel_id: "C-NEW-1", display_name: "my-custom-channel" });

  const defaulted = await send(api, "POST", second.project_id, "slack", {}, "create-default");
  assert.equal(defaulted.status, 201);
  const expected = defaultChannelName("Second App", second.project_id, settings);
  assert.deepEqual(slack.calls[1], ["create", expected]);
  assert.ok(expected.startsWith(settings.channel_name_prefix));

  const bindings = await api.durableCore.listAdvisorChannelBindings("slack");
  assert.deepEqual(bindings.map((binding) => binding.channel_id).sort(), ["C-NEW-1", "C-NEW-2"]);
});

test("POST with the same idempotency_key creates one channel; a second POST with a new key is 409 window_channel_exists", async (t) => {
  const slack = fakeAdmin();
  const api = await startApi(t, { slack });
  if (!api) return;
  const project = await api.project("Idempotent");
  const one = await send(api, "POST", project.project_id, "slack", { name: "once" }, "same-key");
  const two = await send(api, "POST", project.project_id, "slack", { name: "once" }, "same-key");
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.deepEqual((await two.json()).data, (await one.json()).data);
  assert.equal(slack.calls.filter(([kind]) => kind === "create").length, 1);
  const again = await send(api, "POST", project.project_id, "slack", { name: "twice" }, "other-key");
  assert.equal(again.status, 409);
  assert.equal((await errorOf(again)).code, "window_channel_exists");
});

test("PATCH renames through the bound channel_id and updates display_name; without a binding it is 404", async (t) => {
  const slack = fakeAdmin();
  const api = await startApi(t, { slack });
  if (!api) return;
  const project = await api.project("Rename Me");
  const missing = await send(api, "PATCH", project.project_id, "slack", { name: "x" }, "rename-none");
  assert.equal(missing.status, 404);
  assert.equal((await errorOf(missing)).code, "channel_binding_not_found");

  await send(api, "POST", project.project_id, "slack", { name: "before" }, "rename-create");
  const renamed = await send(api, "PATCH", project.project_id, "slack", { name: "After Name" }, "rename-do");
  assert.equal(renamed.status, 200);
  assert.deepEqual(slack.calls.at(-1), ["rename", "C-NEW-1", "after-name"]);
  assert.equal((await renamed.json()).data.display_name, "after-name");
  const window = await api.durableCore.ensureAdvisorWindow("owner:default", project.project_id);
  assert.equal((await api.durableCore.getAdvisorChannelBinding(window.window_id, "slack")).display_name, "after-name");
});

test("PUT binds an existing channel and rejects configured channels, channels bound elsewhere, and channels the bot is not in", async (t) => {
  const discord = fakeAdmin({
    describeChannel: async (id) => ({ channel_id: id, name: `found-${id}`, bot_is_member: id !== "D-OUTSIDE" }),
  });
  const api = await startApi(t, { discord });
  if (!api) return;
  const first = await api.project("First");
  const second = await api.project("Second");

  const bound = await send(api, "PUT", first.project_id, "discord", { channel_id: "D-EXISTING" }, "bind-1");
  assert.equal(bound.status, 200);
  assert.deepEqual((await bound.json()).data, { provider: "discord", channel_id: "D-EXISTING", display_name: "found-D-EXISTING" });

  const elsewhere = await send(api, "PUT", second.project_id, "discord", { channel_id: "D-EXISTING" }, "bind-2");
  assert.equal(elsewhere.status, 409);
  const elsewhereError = await errorOf(elsewhere);
  assert.equal(elsewhereError.code, "channel_already_bound");
  assert.equal(elsewhereError.details.window_key, first.project_id);

  const outside = await send(api, "PUT", second.project_id, "discord", { channel_id: "D-OUTSIDE" }, "bind-3");
  assert.equal(outside.status, 422);
  assert.equal((await errorOf(outside)).code, "channel_bot_not_member");

  const rebound = await send(api, "PUT", first.project_id, "discord", { channel_id: "D-OTHER" }, "bind-4");
  assert.equal(rebound.status, 200);
  assert.deepEqual((await api.durableCore.listAdvisorChannelBindings("discord")).map((binding) => binding.channel_id), ["D-OTHER"]);
});

test("permission errors become 422 integration_permission_missing with details.needed; a stopped connector is 503 integration_not_running", async (t) => {
  const slack = fakeAdmin({
    createChannel: async () => { throw new ChannelAdminError("permission_missing", "The Slack app lacks the channels:manage scope.", { needed: ["channels:manage"] }); },
  });
  const api = await startApi(t, { slack });
  if (!api) return;
  const project = await api.project("Permissions");

  const denied = await send(api, "POST", project.project_id, "slack", { name: "x" }, "perm-1");
  assert.equal(denied.status, 422);
  const error = await errorOf(denied);
  assert.equal(error.code, "integration_permission_missing");
  assert.deepEqual(error.details, { provider: "slack", operation: "create", needed: ["channels:manage"] });

  const stopped = await send(api, "POST", project.project_id, "discord", { name: "x" }, "stopped-1");
  assert.equal(stopped.status, 503);
  const stoppedError = await errorOf(stopped);
  assert.equal(stoppedError.code, "integration_not_running");
  assert.equal(stoppedError.details.provider, "discord");
  assert.equal(typeof stoppedError.details.configured, "boolean");
});

test("GET re-reads display_name with describeChannel and keeps channel_id", async (t) => {
  let current = "before";
  const slack = fakeAdmin({
    describeChannel: async (id) => ({ channel_id: id, name: current, bot_is_member: true }),
    createChannel: async () => ({ channel_id: "C-STABLE", name: "before", bot_is_member: true }),
  });
  const api = await startApi(t, { slack });
  if (!api) return;
  const project = await api.project("Reread");
  await send(api, "POST", project.project_id, "slack", { name: "before" }, "reread-create");

  const read = async () => (await (await api.request("GET", channelsPath(project.project_id))).json()).data.channels;
  let slackEntry = (await read()).find((entry) => entry.provider === "slack");
  assert.deepEqual(slackEntry.binding, { channel_id: "C-STABLE", display_name: "before" });
  assert.equal(slackEntry.running, true);

  current = "renamed-in-slack";
  slackEntry = (await read()).find((entry) => entry.provider === "slack");
  assert.deepEqual(slackEntry.binding, { channel_id: "C-STABLE", display_name: "renamed-in-slack" });
  const discordEntry = (await read()).find((entry) => entry.provider === "discord");
  assert.equal(discordEntry.running, false);
  assert.equal(discordEntry.binding, null);
  const window = await api.durableCore.ensureAdvisorWindow("owner:default", project.project_id);
  assert.equal((await api.durableCore.getAdvisorChannelBinding(window.window_id, "slack")).display_name, "renamed-in-slack");
});

test("the general window cannot get a channel here, and an unknown project is 404", async (t) => {
  const api = await startApi(t, { slack: fakeAdmin() });
  if (!api) return;
  const general = await send(api, "POST", "general", "slack", { name: "x" }, "general-1");
  assert.equal(general.status, 422);
  assert.equal((await errorOf(general)).code, "validation_error");
  const unknown = await send(api, "POST", "no-such-project", "slack", { name: "x" }, "unknown-1");
  assert.equal(unknown.status, 404);
  assert.equal((await errorOf(unknown)).code, "advisor_window_not_found");
});

test("an Advisor guard token cannot create, bind or rename channels", async (t) => {
  const slack = fakeAdmin();
  const api = await startApi(t, { slack }, { guard: true });
  if (!api) return;
  const project = await api.project("Guarded");
  const lease = api.guardTokens.issue({ agent_run_id: "run-advisor", role: "advisor" });
  const { readFile } = await import("node:fs/promises");
  const advisorToken = (await readFile(lease.file, "utf8")).trim();
  for (const [method, payload] of [["POST", { name: "x" }], ["PUT", { channel_id: "C1" }], ["PATCH", { name: "y" }]]) {
    const response = await api.request(method, channelsPath(project.project_id, "slack"), command(payload, `advisor-${method}`), advisorToken);
    assert.equal(response.status, 403, method);
  }
  assert.deepEqual(slack.calls, []);
});

const turnOn = async (api, project, id) => {
  const response = await api.request("PATCH", `/projects/${project.project_id}`, command({ advisor_window_enabled: true }, id));
  assert.equal(response.status, 200);
  return (await response.json()).data;
};
const withOwnerId = (api, ownerUserId) => { api.core.getIntegrations = async () => [{ provider: "slack", owner_user_id: ownerUserId }]; };
const inviting = (extra = {}) => {
  const admin = fakeAdmin(extra);
  admin.invites = [];
  admin.inviteUsers = extra.inviteUsers ?? (async (channel, ids) => { admin.invites.push([channel, [...ids]]); });
  return admin;
};
const creates = (admin) => admin.calls.filter(([op]) => op === "create").length;

test("turning a window on creates and binds a Slack channel, then invites the configured Owner ID", async (t) => {
  const slack = inviting();
  const api = await startApi(t, { slack });
  if (!api) return;
  withOwnerId(api, "U-OWNER");
  const project = await api.project("Invite App");
  const settings = await api.durableCore.getAdvisorWindowSettings();
  const data = await turnOn(api, project, "on-slack");
  assert.deepEqual(slack.calls[0], ["create", defaultChannelName("Invite App", project.project_id, settings)]);
  assert.deepEqual(slack.invites, [["C-NEW-1", ["U-OWNER"]]]);
  assert.equal(data.advisor_window_enabled, true);
  assert.equal(data.window_channels.slack.invite, "invited");
  assert.equal((await api.durableCore.listAdvisorChannelBindings("slack")).length, 1);
});

test("only running providers get channels: Slack only, Discord only, both, neither; Discord is never invited", async (t) => {
  for (const [label, providers] of [["slack", ["slack"]], ["discord", ["discord"]], ["both", ["slack", "discord"]], ["none", []]]) {
    const admins = Object.fromEntries(providers.map((p) => [p, inviting()]));
    const api = await startApi(t, admins);
    if (!api) return;
    withOwnerId(api, "U-OWNER");
    const data = await turnOn(api, await api.project(`Matrix ${label}`), `on-${label}`);
    assert.equal(data.advisor_window_enabled, true);
    assert.deepEqual(Object.keys(data.window_channels).sort(), [...providers].sort(), label);
    for (const p of providers) assert.equal(creates(admins[p]), 1, `${label}:${p}`);
    if (admins.discord) assert.equal(admins.discord.invites.length, 0);
  }
});

test("an already bound provider is skipped, and saving ON again creates no second channel", async (t) => {
  const slack = inviting();
  const discord = inviting();
  const api = await startApi(t, { slack, discord });
  if (!api) return;
  withOwnerId(api, "U-OWNER");
  const project = await api.project("Bound App");
  const window = await api.durableCore.ensureAdvisorWindow("owner:default", project.project_id);
  await api.durableCore.bindAdvisorChannel(window.window_id, "slack", "C-EXISTING", "existing");
  const data = await turnOn(api, project, "on-bound-1");
  assert.equal(data.window_channels.slack.status, "already_bound");
  assert.equal(creates(slack), 0);
  assert.equal(creates(discord), 1);
  await turnOn(api, project, "on-bound-2");
  assert.equal(creates(discord), 1);
});

test("a missing Owner Slack ID skips the invite but keeps the window and the binding, and says so", async (t) => {
  const slack = inviting();
  const api = await startApi(t, { slack });
  if (!api) return;
  withOwnerId(api, null);
  const data = await turnOn(api, await api.project("No Id App"), "on-no-id");
  assert.equal(slack.invites.length, 0);
  assert.equal(data.advisor_window_enabled, true);
  assert.equal(data.window_channels.slack.status, "bound");
  assert.equal(data.window_channels.slack.invite, "skipped_no_owner_user_id");
  assert.equal((await api.durableCore.listAdvisorChannelBindings("slack")).length, 1);
});

test("create and invite failures keep the window ON and return per-provider reasons with the missing permissions", async (t) => {
  const slack = inviting({ inviteUsers: async () => { throw new ChannelAdminError("permission_missing", "no invite scope", { needed: ["channels:manage"] }); } });
  const discord = inviting({ createChannel: async () => { throw new ChannelAdminError("permission_missing", "Manage Channels missing", { needed: ["Manage Channels"] }); } });
  const api = await startApi(t, { slack, discord });
  if (!api) return;
  withOwnerId(api, "U-OWNER");
  const data = await turnOn(api, await api.project("Failing App"), "on-fail");
  assert.equal(data.advisor_window_enabled, true);
  assert.equal(data.window_channels.slack.status, "bound");
  assert.equal(data.window_channels.slack.invite, "failed");
  assert.deepEqual(data.window_channels.slack.invite_error.needed, ["channels:manage"]);
  assert.equal(data.window_channels.discord.status, "failed");
  assert.equal(data.window_channels.discord.error.code, "integration_permission_missing");
  assert.deepEqual(data.window_channels.discord.error.needed, ["Manage Channels"]);
});

const inviteOwnerPath = (key) => channelsPath(key, "slack/invite-owner");
const bindSlack = async (api, project, channelId) => {
  const window = await api.durableCore.ensureAdvisorWindow("owner:default", project.project_id);
  await api.durableCore.bindAdvisorChannel(window.window_id, "slack", channelId, `name-${channelId}`);
};
const invitePost = (api, path, id) => api.request("POST", path, command({}, id));

test("per-window invite-owner invites the saved owner_user_id, maps failures, and treats already_in_channel as success", async (t) => {
  const slack = inviting();
  const api = await startApi(t, { slack });
  if (!api) return;
  withOwnerId(api, "U-OWNER");
  const project = await api.project("Invite Later");
  const none = await invitePost(api, inviteOwnerPath(project.project_id), "inv-none");
  assert.equal(none.status, 404);
  assert.equal((await errorOf(none)).code, "channel_binding_not_found");
  await bindSlack(api, project, "C-1");
  const ok = await invitePost(api, inviteOwnerPath(project.project_id), "inv-ok");
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).data, { provider: "slack", window_key: project.project_id, channel_id: "C-1", display_name: "name-C-1", invite: "invited" });
  assert.deepEqual(slack.invites, [["C-1", ["U-OWNER"]]]);

  slack.inviteUsers = async () => { throw new ChannelAdminError("permission_missing", "no scope", { needed: ["channels:manage"] }); };
  const denied = await invitePost(api, inviteOwnerPath(project.project_id), "inv-denied");
  assert.equal(denied.status, 422);
  const error = await errorOf(denied);
  assert.equal(error.code, "integration_permission_missing");
  assert.deepEqual(error.details.needed, ["channels:manage"]);

  slack.inviteUsers = async () => { throw new ChannelAdminError("provider_error", "already", { provider_code: "already_in_channel" }); };
  const already = await invitePost(api, inviteOwnerPath(project.project_id), "inv-already");
  assert.equal(already.status, 200);
  assert.equal((await already.json()).data.invite, "already_in_channel");
});

test("invite-all covers Slack channels only and keeps going after a failure", async (t) => {
  const slack = inviting();
  const discord = inviting();
  const api = await startApi(t, { slack, discord });
  if (!api) return;
  withOwnerId(api, "U-OWNER");
  const [a, b, c] = [await api.project("All A"), await api.project("All B"), await api.project("All C")];
  await bindSlack(api, a, "C-A");
  await bindSlack(api, b, "C-B");
  await bindSlack(api, c, "C-C");
  const window = await api.durableCore.ensureAdvisorWindow("owner:default", a.project_id);
  await api.durableCore.bindAdvisorChannel(window.window_id, "discord", "D-A", "discord-a");
  slack.inviteUsers = async (channel, ids) => {
    slack.invites.push([channel, [...ids]]);
    if (channel === "C-B") throw new ChannelAdminError("permission_missing", "no scope", { needed: ["channels:manage"] });
    if (channel === "C-C") throw new ChannelAdminError("provider_error", "already", { provider_code: "already_in_channel" });
  };
  const response = await invitePost(api, "/settings/integrations/slack/invite-owner", "all-1");
  assert.equal(response.status, 200);
  const { results } = (await response.json()).data;
  assert.deepEqual(slack.invites, [["C-A", ["U-OWNER"]], ["C-B", ["U-OWNER"]], ["C-C", ["U-OWNER"]]]);
  assert.equal(discord.invites.length, 0);
  assert.deepEqual(results.map((r) => [r.window_key, r.channel_id, r.display_name, r.invite]), [
    [a.project_id, "C-A", "name-C-A", "invited"],
    [b.project_id, "C-B", "name-C-B", "failed"],
    [c.project_id, "C-C", "name-C-C", "already_in_channel"],
  ]);
  assert.deepEqual(results[1].error, { code: "integration_permission_missing", message: "no scope", needed: ["channels:manage"] });
});

test("invite-owner is 422 owner_user_id_missing without calling inviteUsers; GET reports owner_user_id_set", async (t) => {
  const slack = inviting();
  const api = await startApi(t, { slack });
  if (!api) return;
  const project = await api.project("No Owner Id");
  await bindSlack(api, project, "C-1");
  const owned = async () => (await (await api.request("GET", channelsPath(project.project_id))).json()).data.channels.map((c) => [c.provider, c.owner_user_id_set]);
  withOwnerId(api, "");
  for (const [index, path] of [inviteOwnerPath(project.project_id), "/settings/integrations/slack/invite-owner"].entries()) {
    const response = await invitePost(api, path, `missing-${index}`);
    assert.equal(response.status, 422);
    const error = await errorOf(response);
    assert.equal(error.code, "owner_user_id_missing");
    assert.match(error.message, /設定画面/u);
  }
  assert.equal(slack.invites.length, 0);
  assert.deepEqual(await owned(), [["slack", false], ["discord", false]]);
  withOwnerId(api, "U-OWNER");
  assert.deepEqual(await owned(), [["slack", true], ["discord", false]]);
});

test("saving owner_user_id does not invite", async (t) => {
  const slack = inviting();
  const api = await startApi(t, { slack });
  if (!api) return;
  await bindSlack(api, await api.project("Save Only"), "C-1");
  const saved = await api.request("PUT", "/settings/integrations/slack", command({ bot_token: "xoxb-test", app_token: "xapp-test", conversation_channel_id: "C-CONV", owner_user_id: "U-OWNER" }, "save-owner"));
  assert.equal(saved.status, 200);
  assert.deepEqual(slack.invites, []);
});

test("Discord invite-owner is 422 invite_not_supported and never calls inviteUsers", async (t) => {
  const discord = inviting();
  const api = await startApi(t, { discord });
  if (!api) return;
  withOwnerId(api, "U-OWNER");
  const response = await invitePost(api, channelsPath((await api.project("Discord Inv")).project_id, "discord/invite-owner"), "inv-discord");
  assert.equal(response.status, 422);
  assert.equal((await errorOf(response)).code, "invite_not_supported");
  assert.equal(discord.invites.length, 0);
});
