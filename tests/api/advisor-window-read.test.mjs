import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const at = (n) => `2026-09-30T00:00:0${n}.000Z`;

async function setup(t) {
  const { root, db, core: durableCore } = await createTestCore(t, { version: "advisor-window-read-test" }, { prefix: "owl-api-window-read-", start: true });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const server = await startTestHttpServer(t, { core: new ExternalCoreAdapter(durableCore, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir }, { token: randomBytes(24).toString("hex") });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  const conversationId = (await durableCore.getActiveConversation()).conversation_id;
  const write = db.createWriteLane();
  const accountId = db.get("SELECT id FROM connector_accounts WHERE provider = 'web'").id;
  await write.transact((tx) => tx.run(
    `INSERT INTO advisor_sessions (id, status, conversation_id, window_id, last_activity_at, provider_id, created_at, updated_at)
     VALUES ('session-1', 'running', ?, (SELECT advisor_window_id FROM conversations WHERE id = ?), ?, 'anthropic', ?, ?)`,
    conversationId, conversationId, at(0), at(0), at(0),
  ));
  const message = (tx, id, receivedAt) => tx.run(
    `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
     VALUES (?, ?, 'web', ?, ?, 'x', '[]', ?, ?)`,
    id, conversationId, accountId, `src-${id}`, receivedAt, receivedAt,
  );
  /** An Owner message at second n; with reply true, also the Advisor reply to it at n + 1 (a follow-up turn is the same shape). */
  const ask = (n, reply = true) => write.transact((tx) => {
    message(tx, `q${n}`, at(n));
    if (reply) message(tx, `r${n}`, at(n + 1));
    tx.run(
      `INSERT INTO advisor_turns (id, session_id, conversation_id, user_message_id, reply_message_id, status, origin_channel, queued_at)
       VALUES (?, 'session-1', ?, ?, ?, ?, 'web', ?)`,
      `t${n}`, conversationId, `q${n}`, reply ? `r${n}` : null, reply ? "completed" : "queued", at(n),
    );
  });
  const list = async () => (await (await server.request("GET", "/api/v1/advisor/windows")).json()).data;
  const general = async () => (await list()).find((window) => window.key === "general");
  const read = (key, payload, id) => server.request("PUT", `/api/v1/advisor/windows/${key}/read`, command(payload, `read:${id}`));
  /** Advisor replies that all arrive at the same instant, to tell them apart only by message id. */
  const askTied = (n, ids) => write.transact((tx) => {
    message(tx, `q${n}`, at(n));
    ids.forEach((id, i) => {
      message(tx, id, at(n + 1));
      tx.run(
        `INSERT INTO advisor_turns (id, session_id, conversation_id, user_message_id, reply_message_id, status, origin_channel, queued_at)
         VALUES (?, 'session-1', ?, ?, ?, 'completed', 'web', ?)`,
        `t${n}-${i}`, conversationId, `q${n}`, id, at(n),
      );
    });
  });
  /** A status question at second n and the Advisor's status reply s<n> to it, which has no advisor_turns row. */
  const status = (n) => write.transact((tx) => {
    message(tx, `q${n}`, at(n));
    message(tx, `s${n}`, at(n + 1));
    tx.run("UPDATE messages SET source_message_id = ? WHERE id = ?", `advisor:status:s${n}`, `s${n}`);
  });
  return { db, durableCore, root, server, conversationId, ask, askTied, status, general, read };
}

test("PUT /advisor/windows/:key/read marks a window read and a later reply makes it unread again", async (t) => {
  const env = await setup(t);
  if (!env) return;
  assert.equal((await env.general()).has_unread, false);

  await env.ask(1, false);
  assert.equal((await env.general()).has_unread, false, "the Owner's own message is not unread");

  await env.ask(2);
  assert.equal((await env.general()).has_unread, true);

  const put = await env.read("general", {}, 1);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).data.has_unread, false);
  assert.equal((await env.general()).has_unread, false);
  assert.equal(env.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'advisor.window_read'").n, 1);

  await env.ask(4);
  assert.equal((await env.general()).has_unread, true);
});

test("a read position through a message id leaves later replies unread and never moves back", async (t) => {
  const env = await setup(t);
  if (!env) return;
  await env.ask(1);
  await env.ask(3);

  assert.equal((await env.read("general", { read_through_message_id: "q1" }, 1)).status, 400, "Owner message is not a reply");
  assert.equal((await env.read("general", { read_through_message_id: 5 }, 2)).status, 400);
  assert.equal((await env.read("general", { read_through_message_id: "r1" }, 3)).status, 200);
  assert.equal((await env.general()).has_unread, true, "r3 arrived after r1");
  assert.equal((await env.read("general", { read_through_message_id: "r3" }, 5)).status, 200);
  assert.equal((await env.general()).has_unread, false);
  await env.read("general", { read_through_message_id: "r1" }, 6);
  assert.equal((await env.general()).has_unread, false, "an older position does not move it back");
});

test("a status reply shown last reads through the replies before it, not the ones after", async (t) => {
  const env = await setup(t);
  if (!env) return;
  await env.ask(1);
  await env.status(3);
  await env.ask(5);
  assert.equal((await env.read("general", { read_through_message_id: "s3" }, 1)).status, 200, "a status reply is an Advisor message the Owner saw");
  assert.equal((await env.general()).has_unread, true, "r5 arrived after the status reply");
  assert.equal((await env.read("general", { read_through_message_id: "r5" }, 2)).status, 200);
  assert.equal((await env.general()).has_unread, false);
});

test("a stored reply reaches subscribers at once and already counts as unread, before the runtime marks its turn completed", async (t) => {
  const env = await setup(t);
  if (!env) return;
  await env.ask(1, false);
  const seen = [];
  env.durableCore.subscribe(async (event) => { if (event.type === "advisor.responded") seen.push((await env.general()).has_unread); });
  await env.durableCore.advisorActions.persistAdvisorReply(env.conversationId, "here", "t1", { channel: "web" }, []);
  assert.deepEqual(seen, [true], "the window list fetched on advisor.responded shows the dot");
  assert.equal(env.db.get("SELECT status FROM advisor_turns WHERE id = 't1'").status, "queued");
});

test("PUT /advisor/windows/:key/read returns 404 for a key that is not in the list", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const missing = await env.read(createUlid(), {}, 1);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "advisor_window_not_found");
});

test("replies that share a received_at stay unread after the one that was read, whatever their ids sort to", async (t) => {
  const env = await setup(t);
  if (!env) return;
  await env.askTied(1, ["tie-b", "tie-a"]);
  assert.equal((await env.read("general", { read_through_message_id: "tie-b" }, 1)).status, 200);
  assert.equal((await env.general()).has_unread, true, "tie-a arrived after tie-b at the same time, though its id sorts first");
  assert.equal((await env.read("general", {}, 2)).status, 200);
  assert.equal((await env.general()).has_unread, false, "no payload reads through the reply stored last");
  await env.read("general", { read_through_message_id: "tie-b" }, 3);
  assert.equal((await env.general()).has_unread, false, "the earlier-stored reply does not move the position back");
});

for (const [name, readThrough, expected] of [["a read window stays read", "r3", false], ["an unread window stays unread", "r1", true]]) {
  test(`${name} after a Core restart on the same DB, seen by a separate HTTP client`, async (t) => {
    const env = await setup(t);
    if (!env) return;
    await env.ask(1);
    await env.ask(3);
    await env.read("general", { read_through_message_id: readThrough }, 1);
    assert.equal((await env.general()).has_unread, expected);

    await env.durableCore.stop({ force: true });
    env.durableCore.stop = async () => {}; // stop() closes the DB, so the cleanup hook must not stop it again
    const reopened = createTestDatabase(env.root);
    const { core: restarted } = await createTestCore(t, { db: reopened, owlRoot: env.root, version: "advisor-window-read-test" }, { start: true });
    assert.equal((await restarted.listAdvisorWindows())[0].has_unread, expected);

    const dataDir = join(env.root, "data");
    const other = await startTestHttpServer(t, { core: new ExternalCoreAdapter(restarted, reopened, env.root, dataDir), db: reopened, webOut: env.root, owlRoot: env.root, dataDir }, { token: "other-client-token" });
    if (!other) return;
    const windows = (await (await other.request("GET", "/api/v1/advisor/windows")).json()).data;
    assert.equal(windows.find((window) => window.key === "general").has_unread, expected);
  });
}
