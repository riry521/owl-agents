import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid, openDatabase } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const now = "2026-01-01T00:00:00.000Z";

test("the Advisor window migration folds each Owner's conversations and sessions into one general window", async (t) => {
  const root = await tempDir(t, "owl-advisor-window-migration-");
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: the test applies only the early migrations first
  t.after(() => db.close());
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes("074_advisor_windows.sql"));
  const early = join(root, "early");
  await mkdir(early);
  for (const name of files.filter((name) => name < "074")) await copyFile(join(migrations, name), join(early, name));
  db.migrate(early);

  const owners = [createUlid(), createUlid(), createUlid()];
  const accounts = {};
  const id = {
    activeWeb: createUlid(), archivedWeb: createUlid(), slack: createUlid(), discord: createUlid(), work: createUlid(),
    workRow: createUlid(), slackOnly: createUlid(), endedSession: createUlid(), suspendedSession: createUlid(), runningSession: createUlid(),
  };
  const messageIds = [];
  let counter = 0;
  const addMessage = (tx, conversationId, provider, ownerId) => {
    // Ids are minted one after another, so Web and Slack/Discord messages interleave in id order.
    const messageId = createUlid(Date.parse(now) + counter++);
    tx.run(
      `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      messageId, conversationId, provider, accounts[`${ownerId}:${provider}`], `s:${messageId}`, `body ${messageId}`, now, now,
    );
    messageIds.push({ id: messageId, conversationId, provider, ownerId });
    return messageId;
  };
  const addConversation = (tx, conversationId, ownerId, channel, { active = 0, dmRef = null, workId = null, archived = null, updatedAt = now } = {}) => tx.run(
    "INSERT INTO conversations (id, owner_id, work_id, channel, dm_ref, is_active, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    conversationId, ownerId, workId, channel, dmRef, active, archived, now, updatedAt,
  );
  const addSession = (tx, sessionId, conversationId, status, endReason) => tx.run(
    `INSERT INTO advisor_sessions (id, status, conversation_id, last_activity_at, end_reason, ended_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId, status, conversationId, now, endReason, endReason ? now : null, now, now,
  );

  const uploadId = createUlid();
  const turnId = createUlid();
  await db.createWriteLane().transact((tx) => {
    for (const ownerId of owners) {
      tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'o', ?, ?)", ownerId, now, now);
      for (const provider of ["web", "slack", "discord"]) {
        const accountId = createUlid();
        accounts[`${ownerId}:${provider}`] = accountId;
        tx.run(
          "INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, ?, ?, ?)",
          accountId, ownerId, provider, `${provider}:${ownerId}`, now,
        );
      }
    }
    const [owner1, , owner3] = owners;
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, ?, NULL, 'Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      id.workRow, owner1, now, now,
    );
    addConversation(tx, id.activeWeb, owner1, "web", { active: 1, updatedAt: "2026-01-01T00:00:01.000Z" });
    addConversation(tx, id.archivedWeb, owner1, "web", { archived: now });
    addConversation(tx, id.slack, owner1, "slack", { dmRef: "C-SLACK", updatedAt: "2026-01-01T00:00:09.000Z" });
    addConversation(tx, id.discord, owner1, "discord", { dmRef: "D-DISCORD" });
    addConversation(tx, id.work, owner1, "web", { workId: id.workRow });
    addConversation(tx, id.slackOnly, owner3, "slack", { dmRef: "C-OWNER3" });

    addMessage(tx, id.activeWeb, "web", owner1);
    addMessage(tx, id.slack, "slack", owner1);
    addMessage(tx, id.activeWeb, "web", owner1);
    const slackUserMessage = addMessage(tx, id.slack, "slack", owner1);
    addMessage(tx, id.discord, "discord", owner1);
    addMessage(tx, id.archivedWeb, "web", owner1);
    addMessage(tx, id.work, "web", owner1);
    addMessage(tx, id.slackOnly, "slack", owner3);
    addMessage(tx, id.slackOnly, "slack", owner3);

    addSession(tx, id.endedSession, id.archivedWeb, "ended", "idle_timeout");
    addSession(tx, id.suspendedSession, id.slack, "suspended", null);
    addSession(tx, id.runningSession, id.activeWeb, "running", null);
    tx.run(
      `INSERT INTO advisor_turns (id, session_id, conversation_id, user_message_id, status, origin_channel, origin_channel_id, queued_at)
       VALUES (?, ?, ?, ?, 'completed', 'slack', 'C-SLACK', ?)`,
      turnId, id.endedSession, id.slack, slackUserMessage, now,
    );
    tx.run(
      `INSERT INTO inbound_uploads (id, provider, account_id, external_attachment_id, request_id, idempotency_key, request_hash, conversation_id,
                                    filename, declared_bytes, expires_at, status, created_at)
       VALUES (?, 'slack', ?, 'att-1', 'req-1', 'idem-1', ?, ?, 'a.txt', 3, ?, 'registered', ?)`,
      uploadId, accounts[`${owner1}:slack`], "0".repeat(64), id.slack, now, now,
    );
    return null;
  });
  const totals = () => owners.map((ownerId) => db.get(
    `SELECT (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.owner_id = ?) AS messages,
            (SELECT COUNT(*) FROM advisor_turns t JOIN conversations c ON c.id = t.conversation_id WHERE c.owner_id = ?) AS turns`,
    ownerId, ownerId,
  ));
  const before = totals();
  const messagesBefore = db.all("SELECT id, provider, body, received_at FROM messages ORDER BY id");

  db.migrate(migrations);

  const [owner1, owner2, owner3] = owners;
  const windowsOf = (ownerId) => db.all("SELECT id, scope, project_id, conversation_id FROM advisor_windows WHERE owner_id = ?", ownerId);
  const [general] = windowsOf(owner1);
  assert.equal(windowsOf(owner1).length, 1);
  assert.equal(general.scope, "general");
  assert.equal(general.project_id, null);
  assert.equal(general.conversation_id, id.activeWeb, "the former active Web conversation is canonical");

  const windowOfConversation = (conversationId) => db.get("SELECT advisor_window_id AS w FROM conversations WHERE id = ?", conversationId).w;
  for (const conversationId of [id.activeWeb, id.archivedWeb, id.slack, id.discord]) assert.equal(windowOfConversation(conversationId), general.id);
  assert.equal(windowOfConversation(id.work), null, "a Work conversation stays outside every window");

  const conversationOf = (messageId) => db.get("SELECT conversation_id AS c FROM messages WHERE id = ?", messageId).c;
  for (const message of messageIds.filter((entry) => entry.ownerId === owner1)) {
    const moved = message.conversationId === id.slack || message.conversationId === id.discord;
    const expected = moved ? id.activeWeb : message.conversationId;
    assert.equal(conversationOf(message.id), expected, `message ${message.id} of ${message.provider}`);
  }
  assert.equal(db.get("SELECT conversation_id AS c FROM advisor_turns WHERE id = ?", turnId).c, id.activeWeb);
  assert.equal(db.get("SELECT conversation_id AS c FROM inbound_uploads WHERE id = ?", uploadId).c, id.activeWeb);
  assert.deepEqual(db.all("SELECT id, provider, body, received_at FROM messages ORDER BY id"), messagesBefore, "ids, bodies, providers and times are unchanged");

  for (const conversationId of [id.slack, id.discord]) {
    assert.ok(db.get("SELECT archived_at AS a FROM conversations WHERE id = ?", conversationId).a, "the folded row is kept and archived");
  }
  assert.equal(db.get("SELECT archived_at AS a FROM conversations WHERE id = ?", id.activeWeb).a, null);

  const { core } = await createTestCore(t, { owlRoot: root, db });
  const listed = core.listMessages(id.activeWeb, { limit: 100 }).data;
  const expectedIds = messageIds
    .filter((entry) => entry.ownerId === owner1 && [id.activeWeb, id.slack, id.discord].includes(entry.conversationId))
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(listed.map((message) => message.id), expectedIds);
  assert.deepEqual(new Set(listed.map((message) => message.source)), new Set(["web", "slack", "discord"]));
  assert.equal(core.listMessages(id.archivedWeb).data.length, 1);
  assert.equal(core.listMessages(id.work).data.length, 1);

  assert.deepEqual(totals(), before, "per-Owner message and turn totals are unchanged");

  const sessionRow = (sessionId) => db.get("SELECT window_id, status, end_reason FROM advisor_sessions WHERE id = ?", sessionId);
  assert.equal(sessionRow(id.endedSession).window_id, general.id);
  assert.equal(sessionRow(id.endedSession).end_reason, "idle_timeout");
  assert.deepEqual(sessionRow(id.suspendedSession), { window_id: general.id, status: "ended", end_reason: "core_restart" });
  assert.deepEqual(sessionRow(id.runningSession), { window_id: general.id, status: "running", end_reason: null });

  assert.equal(windowsOf(owner2).length, 0, "an Owner without conversations gets no window");
  const [owner3Window] = windowsOf(owner3);
  assert.equal(owner3Window.conversation_id, id.slackOnly, "a Slack-only Owner keeps its Slack conversation as canonical");
  assert.equal(db.get("SELECT archived_at AS a FROM conversations WHERE id = ?", id.slackOnly).a, null);

  await assert.rejects(
    db.createWriteLane().transact((tx) => {
      tx.run(
        "INSERT INTO advisor_windows (id, owner_id, scope, project_id, conversation_id, created_at, updated_at) VALUES (?, ?, 'general', NULL, ?, ?, ?)",
        createUlid(), owner1, id.archivedWeb, now, now,
      );
      return null;
    }),
    /UNIQUE constraint failed/,
  );
  await assert.rejects(
    db.createWriteLane().transact((tx) => {
      tx.run(
        `INSERT INTO advisor_sessions (id, status, conversation_id, window_id, last_activity_at, created_at, updated_at)
         VALUES (?, 'starting', ?, ?, ?, ?, ?)`,
        createUlid(), id.activeWeb, general.id, now, now, now,
      );
      return null;
    }),
    /UNIQUE constraint failed/,
  );
});
