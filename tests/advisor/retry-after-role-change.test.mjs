import assert from "node:assert/strict";
import { test } from "node:test";

import { AdvisorSessionManager, AdvisorSessionRuntime } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const NOW = "2030-01-02T03:04:05.000Z";

function fakeProviderSession(sent, hold = null) {
  const queued = [];
  const waiters = [];
  return {
    pid: 901,
    provider_session_id: `provider-session-${sent.length}`,
    exited: false,
    async send(turn) {
      sent.push(turn);
      const deliver = () => {
        const event = { type: "turn.completed", turn_id: turn.turn_id, reply: "reply", usage: null };
        const waiter = waiters.shift();
        if (waiter) waiter({ value: event, done: false });
        else queued.push(event);
      };
      if (hold) hold.releases.push(deliver);
      else setImmediate(deliver);
    },
    events() {
      return { [Symbol.asyncIterator]() { return { next() {
        const event = queued.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        return new Promise((resolveNext) => waiters.push(resolveNext));
      } }; } };
    },
    async stop() { if (hold) hold.stops += 1; },
  };
}

// Leaves one Advisor turn queued on a session whose provider ("anthropic") is paused.
async function harness(t, { pausedProviders = ["anthropic"], hold = null } = {}) {
  const root = await tempDir(t, "owl-advisor-retry-");
  const db = createTestDatabase(root);
  const ownerId = createUlid();
  const accountId = createUlid();
  const conversationId = createUlid();
  const messageId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", ownerId, NOW, NOW);
    tx.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", accountId, ownerId, `web:${ownerId}`, NOW);
    tx.run("INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)", conversationId, ownerId, NOW, NOW);
    tx.run(
      `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, 'question', '[]', ?, ?)`,
      messageId, conversationId, accountId, `web-user:${messageId}`, NOW, NOW,
    );
  });
  const paused = new Set(pausedProviders);
  const sent = [];
  const replies = [];
  let settings = { providerId: "anthropic", harnessId: "claude", model: "claude-test", systemPrompt: "Advisor" };
  const runtime = new AdvisorSessionRuntime({
    db,
    sessionManager: new AdvisorSessionManager(db),
    memorySaver: {},
    providerClient: { createSession: async () => fakeProviderSession(sent, hold) },
    owlRoot: root,
    git: { prepareAdvisorWorkspace: async () => ({ ok: true, worktree_path: root }) },
    getAdvisorSettings: () => settings,
    resolveAttachmentPaths: () => ({ paths: [], notes: [] }),
    isProviderPaused: (provider) => paused.has(provider),
    onReply: async (_conversationId, reply) => { replies.push(reply); return null; },
    onError: async () => {},
  });
  t.after(async () => { await runtime.stop(); db.close(); });
  const session = await runtime.ensureSession(ownerId, conversationId);
  const turnId = await runtime.enqueueTurn(session.id, conversationId, messageId, { turn_id: "", text: "question", origin: { channel: "web" } });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  if (pausedProviders.length > 0) {
    assert.equal(db.get("SELECT status FROM advisor_turns WHERE id = ?", turnId).status, "queued");
    assert.deepEqual(sent, []);
  }
  return { ownerId, conversationId, messageId, accountId, db, runtime, paused, sent, replies, turnId, oldSessionId: session.id, setSettings: (next) => { settings = next; } };
}

const moved = { providerId: "openai", harnessId: "codex", model: "gpt-test", systemPrompt: "Advisor" };

test("queued Advisor turns move to the new provider's session and run once the role leaves a paused provider", async (t) => {
  const ctx = await harness(t);
  ctx.setSettings(moved);
  await ctx.runtime.retryQueuedTurns();
  await waitFor(() => ctx.db.get("SELECT status FROM advisor_turns WHERE id = ?", ctx.turnId).status === "completed", { message: "turn completion", timeoutMs: 5_000 });
  const turn = ctx.db.get("SELECT session_id FROM advisor_turns WHERE id = ?", ctx.turnId);
  assert.notEqual(turn.session_id, ctx.oldSessionId);
  assert.equal(ctx.db.get("SELECT provider_id FROM advisor_sessions WHERE id = ?", turn.session_id).provider_id, "openai");
  assert.equal(ctx.sent.length, 1);
  assert.deepEqual(ctx.replies, ["reply"]);
});

test("queued Advisor turns stay queued when the new provider is also paused", async (t) => {
  const ctx = await harness(t);
  ctx.paused.add("openai");
  ctx.setSettings(moved);
  await ctx.runtime.retryQueuedTurns();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(ctx.db.get("SELECT status FROM advisor_turns WHERE id = ?", ctx.turnId).status, "queued");
  assert.equal(ctx.db.get("SELECT session_id FROM advisor_turns WHERE id = ?", ctx.turnId).session_id, ctx.oldSessionId);
  assert.deepEqual(ctx.sent, []);
});

async function enqueueSecond(ctx) {
  const messageId = createUlid();
  await ctx.db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
     VALUES (?, ?, 'web', ?, ?, 'second', '[]', ?, ?)`,
    messageId, ctx.conversationId, ctx.accountId, `web-user:${messageId}`, NOW, NOW,
  ));
  return ctx.runtime.enqueueTurn(ctx.oldSessionId, ctx.conversationId, messageId, { turn_id: "", text: "second", origin: { channel: "web" } });
}

test("a model change while a turn is in flight does not cut that turn short", async (t) => {
  const hold = { releases: [], stops: 0 };
  const ctx = await harness(t, { pausedProviders: [], hold });
  await waitFor(() => ctx.sent.length === 1, { message: "first turn in flight", timeoutMs: 5_000 });
  const secondId = await enqueueSecond(ctx);
  ctx.setSettings(moved);
  await ctx.runtime.retryQueuedTurns();
  assert.equal(hold.stops, 0);
  assert.equal(ctx.db.get("SELECT status FROM advisor_turns WHERE id = ?", ctx.turnId).status, "running");
  hold.releases.shift()();
  await waitFor(() => ctx.db.get("SELECT status FROM advisor_turns WHERE id = ?", ctx.turnId).status === "completed", { message: "first turn completion", timeoutMs: 5_000 });
  assert.equal(hold.stops, 0);
  assert.equal(ctx.db.get("SELECT error FROM advisor_turns WHERE id = ?", ctx.turnId).error, null);
  assert.ok(secondId);
});

test("retrying without a model change keeps the live session", async (t) => {
  const ctx = await harness(t, { pausedProviders: [] });
  await waitFor(() => ctx.db.get("SELECT status FROM advisor_turns WHERE id = ?", ctx.turnId).status === "completed", { message: "turn completion", timeoutMs: 5_000 });
  await ctx.runtime.retryQueuedTurns();
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM advisor_sessions").n, 1);
  assert.equal(ctx.db.get("SELECT status FROM advisor_sessions WHERE id = ?", ctx.oldSessionId).status, "running");
});
