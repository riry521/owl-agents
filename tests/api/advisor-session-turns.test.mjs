import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createProviderPauseStore } from "../../packages/core/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { createTestRepo } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const NOW = "2030-01-02T03:04:05.000Z";

test("advisor session route counts queued and running turns and reports the provider pause", async (t) => {
  const { root, db, core: durableCore } = await createTestCore(
    t,
    { version: "advisor-session-test", now: () => NOW },
    { prefix: "owl-api-advisor-session-" },
  );
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const originalOwner = process.env.OWL_OWNER_ID;
  const token = randomBytes(24).toString("hex");
  delete process.env.OWL_OWNER_ID;
  t.after(() => {
    if (originalOwner !== undefined) process.env.OWL_OWNER_ID = originalOwner;
  });
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return;
  }
  const getSession = async (query = "") => {
    const response = await api.request("GET", `/api/v1/advisor/session${query}`);
    assert.equal(response.status, 200);
    return response.json();
  };

  const conversation = await durableCore.getActiveConversation();
  const conversationId = conversation.conversation_id;
  const account = db.get("SELECT id FROM connector_accounts WHERE provider = 'web'");
  const write = db.createWriteLane();
  await write.transact((tx) => {
    tx.run(
      `INSERT INTO advisor_sessions (id, status, conversation_id, window_id, last_activity_at, provider_id, created_at, updated_at)
       VALUES ('session-1', 'running', ?, (SELECT advisor_window_id FROM conversations WHERE id = ?), ?, 'anthropic', ?, ?)`,
      conversationId, conversationId, NOW, NOW, NOW,
    );
    for (const [index, status] of ["queued", "running", "completed"].entries()) {
      tx.run(
        `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body,
                               attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, 'hello', '[]', ?, ?)`,
        `message-${index}`, conversationId, account.id, `src-${index}`, NOW, NOW,
      );
      tx.run(
        `INSERT INTO advisor_turns (id, session_id, conversation_id, user_message_id, status, origin_channel, queued_at)
         VALUES (?, 'session-1', ?, ?, ?, 'web', ?)`,
        `turn-${index}`, conversationId, `message-${index}`, status, NOW,
      );
    }
  });

  const idle = await getSession();
  assert.equal(idle.queued_turns, 1);
  assert.equal(idle.running_turns, 1);
  assert.equal(idle.provider_paused_until, null);

  // Another interface's queued turn is not counted for this conversation.
  await write.transact((tx) => {
    tx.run(
      `INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at)
       VALUES ('other-conversation', (SELECT owner_id FROM conversations WHERE id = ?), 'slack', 0, ?, ?)`,
      conversationId, NOW, NOW,
    );
    tx.run(
      `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body,
                             attachment_ids_json, received_at, created_at)
       VALUES ('message-other', 'other-conversation', 'web', ?, 'src-other', 'hi', '[]', ?, ?)`,
      account.id, NOW, NOW,
    );
    tx.run(
      `INSERT INTO advisor_turns (id, session_id, conversation_id, user_message_id, status, origin_channel, queued_at)
       VALUES ('turn-other', 'session-1', 'other-conversation', 'message-other', 'queued', 'slack', ?)`,
      NOW,
    );
  });
  assert.equal((await getSession()).queued_turns, 2);
  const scoped = await getSession(`?conversation_id=${conversationId}`);
  assert.equal(scoped.queued_turns, 1);
  assert.equal(scoped.running_turns, 1);

  await createProviderPauseStore(db, () => NOW).recordRateLimit({ provider: "anthropic", resets_at: "2030-01-02T04:00:00.000Z" });
  const paused = await getSession();
  assert.equal(paused.provider_paused_until, "2030-01-02T04:01:30.000Z");
});

test("advisor session route resolves a project window from its conversation or the window key, and restart touches only the named window", async (t) => {
  const { root, db, core: durableCore } = await createTestCore(
    t,
    { version: "advisor-session-window-test", now: () => NOW },
    { prefix: "owl-api-advisor-session-window-" },
  );
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const token = randomBytes(24).toString("hex");
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return;
  }
  const repo = await realpath(await createTestRepo(t, { prefix: "owl-api-advisor-session-window-repo-" }));
  const project = (await durableCore.createProject(command({
    name: "Alpha",
    canonical_path: repo,
    base_branch: "main",
    allowed_roots: [repo],
    verification_plan: [],
  }, "create-project:alpha"))).data;
  const projectId = project.project_id ?? project.id;
  const general = await durableCore.ensureAdvisorWindow("owner:default", "general");
  const alpha = await durableCore.ensureAdvisorWindow("owner:default", projectId);
  await db.createWriteLane().transact((tx) => {
    for (const [id, window] of [["session-general", general], ["session-alpha", alpha]]) {
      tx.run(
        `INSERT INTO advisor_sessions (id, status, conversation_id, window_id, last_activity_at, provider_id, created_at, updated_at)
         VALUES (?, 'running', ?, ?, ?, 'anthropic', ?, ?)`,
        id, window.conversation_id, window.window_id, NOW, NOW, NOW,
      );
    }
  });
  const getSession = async (query) => (await api.request("GET", `/api/v1/advisor/session${query}`)).json();

  assert.equal((await getSession("")).window_id, general.window_id, "without a hint the general window answers");
  assert.equal((await getSession(`?conversation_id=${alpha.conversation_id}`)).window_id, alpha.window_id);
  assert.equal((await getSession(`?window=${projectId}`)).window_id, alpha.window_id);
  assert.equal((await getSession("?window=general")).window_id, general.window_id);
  assert.equal((await getSession("?window=no-such-project")).status, "none");

  const restarted = await api.request("POST", "/api/v1/advisor/session/restart", { window: projectId });
  assert.equal(restarted.status, 200);
  const statusOf = (id) => db.get("SELECT status FROM advisor_sessions WHERE id = ?", id).status;
  assert.equal(statusOf("session-alpha"), "ended");
  assert.equal(statusOf("session-general"), "running", "the other window's session is untouched");

  const defaulted = await api.request("POST", "/api/v1/advisor/session/restart", {});
  assert.equal(defaulted.status, 200);
  assert.equal(statusOf("session-general"), "ended", "no window in the body means the general window");
});
