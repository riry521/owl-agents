import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { Core, createProviderPauseStore } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";

const NOW = "2030-01-02T03:04:05.000Z";
const repoRoot = resolve(process.cwd());

test("advisor session route counts queued and running turns and reports the provider pause", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-api-advisor-session-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const durableCore = new Core({ db, agentRunner: {}, version: "advisor-session-test", owlRoot: root, dataDir, now: () => NOW });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const originalToken = process.env.OWL_API_TOKEN;
  const originalOwner = process.env.OWL_OWNER_ID;
  const token = randomBytes(24).toString("hex");
  process.env.OWL_API_TOKEN = token;
  delete process.env.OWL_OWNER_ID;
  const http = createOwlHttpServer({
    core, db, webOut: root, bind: "127.0.0.1", port: 0,
    contract: { contract_version: "1.0.0" }, owlRoot: root, dataDir,
  });
  t.after(async () => {
    if (http.server.listening) await http.close();
    await durableCore.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = originalToken;
    if (originalOwner !== undefined) process.env.OWL_OWNER_ID = originalOwner;
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return;
    }
    throw error;
  }
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const getSession = async (query = "") => {
    const response = await fetch(`${base}/advisor/session${query}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return response.json();
  };

  const conversation = await durableCore.getActiveConversation();
  const conversationId = conversation.conversation_id;
  const account = db.get("SELECT id FROM connector_accounts WHERE provider = 'web'");
  const write = db.createWriteLane();
  await write.transact((tx) => {
    tx.run(
      `INSERT INTO advisor_sessions (id, status, conversation_id, last_activity_at, provider_id, created_at, updated_at)
       VALUES ('session-1', 'running', ?, ?, 'anthropic', ?, ?)`,
      conversationId, NOW, NOW, NOW,
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
  assert.equal(paused.provider_paused_until, "2030-01-02T04:00:30.000Z");
});
