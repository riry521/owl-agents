import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AdvisorSessionManager } from "../packages/core/dist/index.js";
import { EMPTY_ADVISOR_REPLY_NOTICE, parseAdvisorTurnReply } from "../packages/core/dist/advisor-runtime.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a non-Slack Advisor reply that the strict parser rejects is kept instead of failing the turn", () => {
  for (const channel of ["web", "terminal", "discord"]) {
    // Starts with "{" but is not the legacy envelope.
    const braces = "{curly} braces start this plain answer.";
    assert.deepEqual(parseAdvisorTurnReply(channel, braces), { reply: braces, suggested_actions: [] });

    // Legacy envelope with an invalid suggested_actions list keeps the reply.
    const envelope = JSON.stringify({ reply: "Done.", suggested_actions: "not-an-array" });
    const parsedEnvelope = parseAdvisorTurnReply(channel, envelope);
    assert.equal(parsedEnvelope.reply.includes("Done."), true);
    assert.deepEqual(parsedEnvelope.suggested_actions, []);
  }
});

test("a well-formed non-Slack reply still yields its owl-actions", () => {
  const raw = "Creating it now.\n```owl-actions\n[{\"type\":\"create_work\",\"description\":\"Archive\"}]\n```\n";
  const parsed = parseAdvisorTurnReply("web", raw);
  assert.equal(parsed.reply, "Creating it now.");
  assert.deepEqual(parsed.suggested_actions, [{ type: "create_work", description: "Archive" }]);
});

test("an empty Advisor reply is surfaced as a visible notice on every channel", () => {
  for (const channel of ["web", "slack", "terminal"]) {
    assert.deepEqual(parseAdvisorTurnReply(channel, "   \n"), { reply: EMPTY_ADVISOR_REPLY_NOTICE, suggested_actions: [] });
  }
  // A reply that is only a malformed action block has nothing to show either.
  const onlyBrokenBlock = "```owl-actions\nnot json\n```\n";
  assert.equal(parseAdvisorTurnReply("web", onlyBrokenBlock).reply, EMPTY_ADVISOR_REPLY_NOTICE);
});

test("the idle-timeout sweep skips a session whose turn is still running", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-stale-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  t.after(() => db.close());

  const now = new Date().toISOString();
  const ownerId = createUlid();
  const accountId = createUlid();
  const conversationId = createUlid();
  const messageId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", ownerId, now, now);
    transaction.run(
      "INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)",
      accountId, ownerId, `web:${ownerId}`, now,
    );
    transaction.run(
      "INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)",
      conversationId, ownerId, now, now,
    );
    transaction.run(
      `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, 'Long question', '[]', ?, ?)`,
      messageId, conversationId, accountId, `web-user:${messageId}`, now, now,
    );
  });

  const manager = new AdvisorSessionManager(db, { idleTimeoutMinutes: 1 });
  const session = await manager.startSession(ownerId, conversationId);
  await manager.activateSession(session.id, 4242);
  const later = new Date(Date.now() + 10 * 60 * 1000);
  assert.equal(manager.getStaleSession(later)?.id, session.id, "an idle session with no running turn is stale");

  const turnId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO advisor_turns (id, session_id, conversation_id, user_message_id, status, origin_channel, queued_at, started_at)
       VALUES (?, ?, ?, ?, 'running', 'web', ?, ?)`,
      turnId, session.id, conversationId, messageId, now, now,
    );
  });
  assert.equal(manager.getStaleSession(later), null, "a running turn keeps the session alive");

  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE advisor_turns SET status = 'completed', completed_at = ? WHERE id = ?", now, turnId);
  });
  assert.equal(manager.getStaleSession(later)?.id, session.id, "once the turn settles the session can time out again");
});
