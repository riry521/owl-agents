import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { createTestRepo } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

async function startApi(t) {
  const { root, db, core: durableCore } = await createTestCore(t, { version: "advisor-window-api-test" }, { prefix: "owl-api-advisor-window-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const token = randomBytes(24).toString("hex");
  const server = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  const request = (method, path, body) => server.request(method, `/api/v1${path}`, body);
  return { db, durableCore, request };
}

async function createProject(api, t, name) {
  const path = await realpath(await createTestRepo(t, { prefix: "owl-api-advisor-window-repo-" }));
  return (await api.durableCore.createProject(command({
    name,
    canonical_path: path,
    base_branch: "main",
    allowed_roots: [path],
    verification_plan: [],
  }, `create-project:${name}`))).data;
}

test("window settings are read and written through /settings/advisor-windows and rejected with the field when invalid", async (t) => {
  const api = await startApi(t);
  if (!api) return;

  const first = await api.request("GET", "/settings/advisor-windows");
  assert.equal(first.status, 200);
  const defaults = (await first.json()).data;
  assert.deepEqual(Object.keys(defaults).sort(), [
    "channel_name_max_length", "channel_name_prefix", "handoff_summary_max_chars",
    "history_handoff_messages", "idle_timeout_seconds", "project_backlog_limit",
  ]);

  const put = await api.request("PUT", "/settings/advisor-windows", command(defaults, "advisor-window-settings:defaults"));
  assert.equal(put.status, 200);
  const second = await api.request("GET", "/settings/advisor-windows");
  assert.deepEqual((await second.json()).data, defaults);

  const changed = { ...defaults, idle_timeout_seconds: 900, channel_name_prefix: "team_" };
  assert.equal((await api.request("PUT", "/settings/advisor-windows", command(changed, "advisor-window-settings:changed"))).status, 200);
  assert.deepEqual((await (await api.request("GET", "/settings/advisor-windows")).json()).data, changed);

  const rejected = await api.request("PUT", "/settings/advisor-windows", command({ ...defaults, channel_name_prefix: "-owl" }, "advisor-window-settings:bad-prefix"));
  assert.equal(rejected.status, 422);
  const body = await rejected.json();
  assert.equal(body.error.code, "validation_error");
  assert.equal(body.error.details.field, "channel_name_prefix");
  assert.deepEqual((await (await api.request("GET", "/settings/advisor-windows")).json()).data, changed, "a rejected PUT changes nothing");
});

test("GET /advisor/windows lists the general window first, then every project, and each window opens its own conversation", async (t) => {
  const api = await startApi(t);
  if (!api) return;
  const projects = [await createProject(api, t, "Alpha"), await createProject(api, t, "Beta")];
  for (const project of projects) await api.durableCore.updateProject(project.id, command({ advisor_window_enabled: true }, `enable-window:${project.id}`));

  const listed = (await (await api.request("GET", "/advisor/windows")).json()).data;
  assert.equal(listed.length, 3);
  assert.equal(listed[0].key, "general");
  assert.equal(listed[0].scope, "general");
  assert.equal(listed[0].project_id, null);
  assert.deepEqual(listed.slice(1).map((window) => window.key), projects.map((project) => project.project_id ?? project.id).sort());
  for (const window of listed.slice(1)) {
    assert.equal(window.scope, "project");
    assert.equal(window.project_id, window.key);
    assert.equal(window.session_status, "none");
    assert.deepEqual(window.channels, []);
  }
  for (const field of [
    "channels", "conversation_id", "key", "last_message_at", "name", "project_id", "scope", "session_status", "window_id",
  ]) assert.ok(field in listed[0], `window has ${field}`);

  const active = await (await api.request("GET", "/advisor/conversation/active")).json();
  const general = await api.request("GET", "/advisor/windows/general/conversation");
  assert.equal(general.status, 200);
  const generalBody = await general.json();
  assert.equal(generalBody.conversation_id, active.conversation_id);

  const projectKey = listed[1].key;
  const projectConversation = await (await api.request("GET", `/advisor/windows/${encodeURIComponent(projectKey)}/conversation`)).json();
  assert.notEqual(projectConversation.conversation_id, active.conversation_id);
  const again = await (await api.request("GET", `/advisor/windows/${encodeURIComponent(projectKey)}/conversation`)).json();
  assert.equal(again.conversation_id, projectConversation.conversation_id, "the window is created once");
  assert.equal((await (await api.request("GET", "/advisor/conversation/active")).json()).conversation_id, active.conversation_id, "a project window never becomes the active conversation");

  const relisted = (await (await api.request("GET", "/advisor/windows")).json()).data;
  assert.equal(relisted[0].conversation_id, active.conversation_id);
  assert.equal(relisted[1].conversation_id, projectConversation.conversation_id);
  assert.equal(relisted[2].conversation_id, null, "a project window that was never opened has no conversation yet");

  const missing = await api.request("GET", "/advisor/windows/not-a-project/conversation");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "advisor_window_not_found");
});

test("deleting a project removes its window and archives its conversation", async (t) => {
  const api = await startApi(t);
  if (!api) return;
  const project = await createProject(api, t, "Gamma");
  const projectId = project.project_id ?? project.id;
  const hidden = await api.request("GET", `/advisor/windows/${encodeURIComponent(projectId)}/conversation`);
  assert.equal(hidden.status, 404, "a switched-off Project's window is not found by URL");
  assert.equal((await hidden.json()).error.code, "advisor_window_not_found");
  assert.equal(api.db.get("SELECT id FROM advisor_windows WHERE project_id = ?", projectId), undefined, "the lookup creates no window");
  await api.durableCore.updateProject(projectId, command({ advisor_window_enabled: true }, `enable-window:${projectId}`));
  const opened = await (await api.request("GET", `/advisor/windows/${encodeURIComponent(projectId)}/conversation`)).json();
  assert.ok(api.db.get("SELECT id FROM advisor_windows WHERE project_id = ?", projectId));

  const windowId = api.db.get("SELECT id FROM advisor_windows WHERE project_id = ?", projectId).id;
  await api.db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO advisor_channel_bindings (id, window_id, provider, channel_id, display_name, created_at, updated_at) VALUES ('binding-gamma', ?, 'slack', 'C-GAMMA', 'owl-gamma', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    windowId,
  ));

  await api.durableCore.deleteProject(projectId, command({ confirmed_work_count: 0 }, "delete-project:gamma"));

  const changed = api.db.all("SELECT payload_json FROM events WHERE type = 'advisor.channel_binding_changed'").map((row) => JSON.parse(row.payload_json));
  assert.deepEqual(changed.map((payload) => [payload.window_id, payload.provider, payload.channel_id, payload.change]), [[windowId, "slack", "C-GAMMA", "unbound"]]);

  assert.equal(api.db.get("SELECT id FROM advisor_windows WHERE project_id = ?", projectId), undefined);
  const conversation = api.db.get("SELECT archived_at, advisor_window_id FROM conversations WHERE id = ?", opened.conversation_id);
  assert.ok(conversation.archived_at);
  assert.equal(conversation.advisor_window_id, null);
  const listed = (await (await api.request("GET", "/advisor/windows")).json()).data;
  assert.deepEqual(listed.map((window) => window.key), ["general"]);
});

test("an Owner with a general window but no web account can still post from the web", async (t) => {
  const api = await startApi(t);
  if (!api) return;
  const active = await (await api.request("GET", "/advisor/conversation/active")).json();
  await api.db.createWriteLane().transact((tx) => tx.run("DELETE FROM connector_accounts WHERE provider = 'web'"));

  const posted = await api.durableCore.postMessage(active.conversation_id, command({ body: "hello from web", attachment_ids: [] }, "web-account:post"));

  assert.ok(posted.data.message_id);
  assert.ok(api.db.get("SELECT id FROM connector_accounts WHERE provider = 'web'"));
  assert.equal(api.db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND provider = 'web' AND body = 'hello from web'", active.conversation_id).n, 1);
});
