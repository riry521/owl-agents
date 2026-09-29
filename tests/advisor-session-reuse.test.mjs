import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AdvisorSessionManager, AdvisorSessionRuntime } from "../packages/core/dist/index.js";
import { ProviderResumeUnsupportedError } from "../packages/shared/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const settings = {
  providerId: "anthropic",
  harnessId: "claude",
  model: "claude-opus-5-5",
  systemPrompt: "Advisor system prompt",
};

const settingsHash = createHash("sha256").update(settings.systemPrompt).digest("hex");

function createRuntime({ session, providerClient = {}, sessionManager = {}, advisorSettings = settings }) {
  const db = {
    createWriteLane() {
      return {
        write: async () => undefined,
      };
    },
    get() {
      return undefined;
    },
  };
  return new AdvisorSessionRuntime({
    db,
    sessionManager: {
      getActiveSession: () => session,
      ...sessionManager,
    },
    memorySaver: {},
    providerClient,
    owlRoot: "/owl",
    getAdvisorSettings: () => advisorSettings,
    onReply: async () => null,
    onError: async () => {},
  });
}

test("Advisor reuses one live provider session when a turn comes from another interface conversation", async () => {
  const session = {
    id: "advisor-session",
    conversation_id: "slack-conversation",
    status: "running",
    provider_id: settings.providerId,
    harness_id: settings.harnessId,
    model: settings.model,
    effort: null,
  };
  const runtime = createRuntime({ session });
  const driver = { events: () => ({ [Symbol.asyncIterator]: async function* () {} }) };
  runtime.activeDriver = driver;
  runtime.activeSessionId = session.id;
  runtime.activeSystemPrompt = settings.systemPrompt;

  const selected = await runtime.ensureSession("owner", "web-conversation");

  assert.equal(selected, session);
  assert.equal(runtime.activeDriver, driver);
});

test("Advisor resumes a shared session in its original workspace across interface conversations", async () => {
  const session = {
    id: "advisor-session",
    conversation_id: "slack-conversation",
    status: "suspended",
    system_prompt_sha256: settingsHash,
    provider_id: settings.providerId,
    harness_id: settings.harnessId,
    model: settings.model,
    effort: null,
    provider_session_id: "provider-session",
    workspace_path: "/owl/.owl-workspaces/advisor/original-conversation",
  };
  let createRequest;
  const driver = {
    pid: 42,
    provider_session_id: "provider-session",
    events: () => ({ [Symbol.asyncIterator]: async function* () {} }),
  };
  const runtime = createRuntime({
    session,
    sessionManager: {
      resumeSession: async () => {},
      setWorkspace: async () => {},
    },
    providerClient: {
      createSession: async (request) => {
        createRequest = request;
        return driver;
      },
    },
  });

  const selected = await runtime.ensureSession("owner", "discord-conversation");

  assert.equal(createRequest.cwd, session.workspace_path);
  assert.equal(createRequest.provider_session_id, session.provider_session_id);
  assert.equal(selected.conversation_id, session.conversation_id);
  assert.equal(selected.id, session.id);
});

test("a changed system prompt ends the live session and starts one with the new prompt", async () => {
  const session = {
    id: "advisor-session",
    owner_id: "owner",
    conversation_id: "web-conversation",
    status: "running",
    provider_id: settings.providerId,
    harness_id: settings.harnessId,
    model: settings.model,
    effort: null,
    transcript_path: "/owl/transcripts/old.jsonl",
  };
  const updated = { ...settings, systemPrompt: "Advisor system prompt\n\n--- BEGIN OWL RULES ---\n[system] new rule\n--- END OWL RULES ---" };
  const runtime = createRuntime({ session, advisorSettings: updated });
  runtime.activeDriver = { events: () => ({ [Symbol.asyncIterator]: async function* () {} }) };
  runtime.activeSessionId = session.id;
  runtime.activeSystemPrompt = settings.systemPrompt;
  const calls = [];
  runtime.stopSession = async (id, reason) => { calls.push(["stop", id, reason]); };
  runtime.createSession = async (ownerId, conversationId, next) => {
    calls.push(["create", ownerId, conversationId, next.systemPrompt]);
    return { id: "new-session" };
  };

  const selected = await runtime.ensureSession("owner", "web-conversation");

  assert.equal(selected.id, "new-session");
  assert.deepEqual(calls, [
    ["stop", session.id, "owner_requested"],
    ["create", "owner", "web-conversation", updated.systemPrompt],
  ]);
});

test("a resume the provider cannot apply ends the old session and starts a fresh one with the current prompt", async () => {
  const session = {
    id: "advisor-session",
    owner_id: "owner",
    conversation_id: "slack-conversation",
    status: "suspended",
    system_prompt_sha256: settingsHash,
    provider_id: settings.providerId,
    harness_id: "codex",
    model: settings.model,
    effort: null,
    provider_session_id: "provider-session",
    workspace_path: "/owl/.owl-workspaces/advisor/original-conversation",
    transcript_path: null,
  };
  const calls = [];
  const runtime = createRuntime({
    session,
    sessionManager: {
      endSession: async (id, reason) => { calls.push(["end", id, reason]); },
    },
    providerClient: {
      createSession: async () => { throw new ProviderResumeUnsupportedError("codex", "Invalid params"); },
    },
  });
  runtime.createSession = async (ownerId, conversationId, next) => {
    calls.push(["create", ownerId, conversationId, next.systemPrompt]);
    return { id: "fresh-session" };
  };

  const selected = await runtime.ensureSession("owner", "discord-conversation");

  assert.equal(selected.id, "fresh-session");
  assert.deepEqual(calls, [
    ["end", session.id, "resume_failed"],
    ["create", "owner", "slack-conversation", settings.systemPrompt],
  ]);
});

test("any other resume failure still ends the session and is reported", async () => {
  const session = {
    id: "advisor-session",
    owner_id: "owner",
    conversation_id: "slack-conversation",
    status: "suspended",
    system_prompt_sha256: settingsHash,
    provider_id: settings.providerId,
    harness_id: "codex",
    model: settings.model,
    effort: null,
    provider_session_id: "provider-session",
    workspace_path: "/owl/.owl-workspaces/advisor/original-conversation",
  };
  const ended = [];
  const runtime = createRuntime({
    session,
    sessionManager: { endSession: async (id, reason) => { ended.push(reason); } },
    providerClient: { createSession: async () => { throw new Error("spawn failed"); } },
  });
  runtime.createSession = async () => assert.fail("no fresh session for an ordinary failure");

  await assert.rejects(runtime.ensureSession("owner", "web-conversation"), /spawn failed/);
  assert.deepEqual(ended, ["resume_failed"]);
});

// --- Dead-driver recovery ------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A controllable in-memory ProviderSession. `exited` flips like the real drivers' done flag. */
for (const [label, hash] of [["a different prompt hash", "0".repeat(64)], ["no stored prompt hash", null]]) {
  test(`a suspended session with ${label} is replaced and its queued turns move to the new session`, async () => {
    const session = {
      id: "advisor-session",
      owner_id: "owner",
      conversation_id: "slack-conversation",
      status: "suspended",
      system_prompt_sha256: hash,
      provider_id: settings.providerId,
      harness_id: settings.harnessId,
      model: settings.model,
      effort: null,
      provider_session_id: "provider-session",
      workspace_path: "/owl/.owl-workspaces/advisor/original-conversation",
    };
    const calls = [];
    const runtime = createRuntime({
      session,
      providerClient: { createSession: async () => { throw new Error("must not resume"); } },
    });
    runtime.stopSession = async (id, reason) => { calls.push(["stop", id, reason]); };
    runtime.createSession = async () => ({ id: "new-session" });
    runtime.moveTurnsToSession = async (from, to) => { calls.push(["move", from, to]); };

    const selected = await runtime.ensureSession("owner", "slack-conversation");

    assert.equal(selected.id, "new-session");
    assert.deepEqual(calls, [
      ["stop", session.id, "owner_requested"],
      ["move", session.id, "new-session"],
    ]);
  });
}

test("a suspended session with the same prompt hash is resumed", async () => {
  const session = {
    id: "advisor-session",
    owner_id: "owner",
    conversation_id: "slack-conversation",
    status: "suspended",
    system_prompt_sha256: settingsHash,
    provider_id: settings.providerId,
    harness_id: settings.harnessId,
    model: settings.model,
    effort: null,
    provider_session_id: "provider-session",
    workspace_path: "/owl/.owl-workspaces/advisor/original-conversation",
  };
  const resumed = [];
  const runtime = createRuntime({
    session,
    sessionManager: {
      resumeSession: async (...args) => { resumed.push(args); },
      setWorkspace: async () => {},
    },
    providerClient: {
      createSession: async () => ({
        pid: 42,
        provider_session_id: "provider-session",
        events: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      }),
    },
  });

  const selected = await runtime.ensureSession("owner", "slack-conversation");

  assert.equal(selected.id, session.id);
  assert.deepEqual(resumed, [[session.id, 42, "provider-session", settingsHash]]);
});

function fakeProviderSession(pid, { failSend = false, sendGate = null } = {}) {
  const queue = [];
  const waiters = [];
  const push = (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  };
  const session = {
    pid,
    provider_session_id: `provider-${pid}`,
    exited: false,
    sent: [],
    stopReasons: [],
    async send(turn) {
      session.sent.push(turn);
      if (sendGate) await sendGate;
      if (session.exited || failSend) {
        session.exited = true;
        throw new Error("advisor session process has already exited; cannot send a turn");
      }
      setImmediate(() => push({ type: "turn.completed", turn_id: turn.turn_id, reply: `reply from ${pid}`, usage: null }));
    },
    events() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              const queued = queue.shift();
              if (queued) return Promise.resolve({ value: queued, done: false });
              return new Promise((resolveNext) => waiters.push(resolveNext));
            },
          };
        },
      };
    },
    async stop(reason) {
      session.stopReasons.push(reason);
    },
  };
  return session;
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function createLiveRuntime(t, providerSessions) {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-d1-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const now = new Date().toISOString();
  const ownerId = createUlid();
  const accountId = createUlid();
  const conversationId = createUlid();
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
  });
  const addMessage = async (body) => {
    const messageId = createUlid();
    await db.createWriteLane().transact((transaction) => {
      transaction.run(
        `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
        messageId, conversationId, accountId, `web-user:${messageId}`, body, now, now,
      );
    });
    return messageId;
  };

  const replies = [];
  const errors = [];
  const createRequests = [];
  const runtime = new AdvisorSessionRuntime({
    db,
    sessionManager: new AdvisorSessionManager(db),
    memorySaver: {},
    providerClient: {
      execute: async () => { throw new Error("not used"); },
      createSession: async (request) => {
        createRequests.push(request);
        const next = providerSessions.shift();
        if (!next) throw new Error("no fake provider session left");
        return next;
      },
    },
    owlRoot: root,
    getAdvisorSettings: () => settings,
    onReply: async (_conversationId, reply, turnId) => {
      replies.push({ reply, turnId });
      return null;
    },
    onError: async (_conversationId, error, turnId) => {
      errors.push({ error, turnId });
    },
  });
  t.after(async () => {
    await runtime.stop();
    db.close();
  });

  const sendTurn = async (sessionId, text) => {
    const messageId = await addMessage(text);
    return runtime.enqueueTurn(sessionId, conversationId, messageId, { turn_id: "", text, origin: { channel: "web" } });
  };
  const sessionRow = (id) => db.get("SELECT id, status, end_reason FROM advisor_sessions WHERE id = ?", id);
  const turnRow = (id) => db.get("SELECT id, session_id, status, error FROM advisor_turns WHERE id = ?", id);
  return { runtime, db, ownerId, conversationId, replies, errors, createRequests, sendTurn, sessionRow, turnRow };
}

test("a driver that exited while idle is replaced on the next turn, and a send failure retries once on a fresh session", async (t) => {
  // Part 1: the held driver died while no turn was in flight. The next
  // ensureSession must not reuse it.
  {
    const first = fakeProviderSession(101);
    const second = fakeProviderSession(102);
    const live = await createLiveRuntime(t, [first, second]);
    const session1 = await live.runtime.ensureSession(live.ownerId, live.conversationId);
    const turn1 = await live.sendTurn(session1.id, "first question");
    await waitFor(() => live.replies.length === 1, "first reply");
    assert.equal(live.replies[0].reply.startsWith("reply from 101"), true);

    first.exited = true;
    const session2 = await live.runtime.ensureSession(live.ownerId, live.conversationId);
    assert.notEqual(session2.id, session1.id, "an exited driver is not reused");
    assert.deepEqual(first.stopReasons, ["crashed"]);
    assert.equal(live.sessionRow(session1.id).status, "ended");
    assert.equal(live.sessionRow(session1.id).end_reason, "crashed");
    assert.equal(live.runtime.activeDriver, second);

    const turn2 = await live.sendTurn(session2.id, "second question");
    await waitFor(() => live.replies.length === 2, "second reply");
    assert.equal(live.replies[1].reply.startsWith("reply from 102"), true);
    assert.equal(live.turnRow(turn1).status, "completed");
    assert.equal(live.turnRow(turn2).status, "completed");
    assert.deepEqual(live.errors, []);
  }

  // Part 2: the driver dies between ensureSession and send (exited is only
  // discovered by the send rejection). The turn, and the turn queued behind
  // it, move to one fresh session; send is retried exactly once.
  {
    let releaseSend;
    const gate = new Promise((resolveGate) => { releaseSend = resolveGate; });
    const dying = fakeProviderSession(201, { failSend: true, sendGate: gate });
    const fresh = fakeProviderSession(202);
    const live = await createLiveRuntime(t, [dying, fresh]);
    const session1 = await live.runtime.ensureSession(live.ownerId, live.conversationId);
    const turnA = await live.sendTurn(session1.id, "question A");
    await waitFor(() => dying.sent.length === 1, "first send attempt");
    const turnB = await live.sendTurn(session1.id, "question B");
    releaseSend();

    await waitFor(() => live.replies.length === 2, "both replies");
    assert.deepEqual(live.errors, []);
    assert.deepEqual(dying.stopReasons, ["send_failed"]);
    assert.equal(dying.sent.length, 1);
    assert.deepEqual(fresh.sent.map((turn) => turn.turn_id), [turnA, turnB]);
    assert.equal(live.createRequests.length, 2, "exactly one replacement session");
    const freshSessionId = live.turnRow(turnA).session_id;
    assert.notEqual(freshSessionId, session1.id);
    assert.equal(live.turnRow(turnA).status, "completed");
    assert.equal(live.turnRow(turnB).session_id, freshSessionId);
    assert.equal(live.turnRow(turnB).status, "completed");
    assert.equal(live.sessionRow(session1.id).status, "ended");
    assert.equal(live.sessionRow(freshSessionId).status, "running");
    assert.deepEqual(live.replies.map((entry) => entry.reply.startsWith("reply from 202")), [true, true]);
  }

  // Part 3: the retry also fails. The turn fails once; no second retry.
  {
    const dying = fakeProviderSession(301, { failSend: true });
    const alsoDying = fakeProviderSession(302, { failSend: true });
    const live = await createLiveRuntime(t, [dying, alsoDying]);
    const session1 = await live.runtime.ensureSession(live.ownerId, live.conversationId);
    const turn = await live.sendTurn(session1.id, "question");
    await waitFor(() => live.errors.length === 1, "turn failure");
    await waitFor(() => live.turnRow(turn).status === "failed", "failed turn row");
    assert.equal(live.createRequests.length, 2, "a single retry");
    assert.equal(dying.sent.length, 1);
    assert.equal(alsoDying.sent.length, 1);
    assert.deepEqual(alsoDying.stopReasons, ["send_failed"]);
    assert.equal(live.runtime.activeDriver, null, "the failed replacement is not kept for the next turn");
    assert.deepEqual(live.replies, []);
  }
});

test("concurrent ensureSession calls for the same owner create only one provider session", async (t) => {
  const only = fakeProviderSession(401);
  const live = await createLiveRuntime(t, [only]);

  const [session1, session2] = await Promise.all([
    live.runtime.ensureSession(live.ownerId, live.conversationId),
    live.runtime.ensureSession(live.ownerId, live.conversationId),
  ]);

  assert.equal(session1.id, session2.id, "both callers should end up sharing the same session");
  assert.equal(live.createRequests.length, 1, "only one provider session should be created for two concurrent callers");
});

test("a session replaced while its turn is still sending does not orphan the replacement's queue", async (t) => {
  let releaseSend;
  const gate = new Promise((resolveGate) => { releaseSend = resolveGate; });
  const original = fakeProviderSession(501, { sendGate: gate });
  const replacement = fakeProviderSession(502);
  const live = await createLiveRuntime(t, [original, replacement]);

  const session1 = await live.runtime.ensureSession(live.ownerId, live.conversationId);
  const turnA = await live.sendTurn(session1.id, "question A");
  await waitFor(() => original.sent.length === 1, "the first turn's send to reach the gate");

  // A model change arrives while turn A's send is still in flight.
  live.runtime.config.getAdvisorSettings = () => ({ ...settings, model: "claude-opus-6" });
  const session2 = await live.runtime.ensureSession(live.ownerId, live.conversationId);
  assert.notEqual(session2.id, session1.id, "the drifted model should replace the session");
  const turnB = await live.sendTurn(session2.id, "question B");

  releaseSend();

  await waitFor(() => live.replies.length === 2, "both turns to complete");
  assert.equal(live.turnRow(turnA).session_id, session1.id);
  assert.equal(live.turnRow(turnA).status, "completed");
  assert.equal(live.turnRow(turnB).session_id, session2.id);
  assert.equal(live.turnRow(turnB).status, "completed");
  assert.deepEqual(original.sent.map((sent) => sent.turn_id), [turnA]);
  assert.deepEqual(replacement.sent.map((sent) => sent.turn_id), [turnB]);
  assert.deepEqual(live.errors, []);
});

test("ensureResident brings a session up when none exists, and never stops an idle one", async (t) => {
  const only = fakeProviderSession(601);
  const live = await createLiveRuntime(t, [only]);

  await live.runtime.ensureResident(live.ownerId, live.conversationId);
  const row = live.db.get("SELECT id, status FROM advisor_sessions WHERE status = 'running'");
  assert.equal(row.status, "running");
  assert.equal(live.createRequests.length, 1);

  await live.db.createWriteLane().transact((tx) =>
    tx.run("UPDATE advisor_sessions SET last_activity_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", row.id));
  await live.runtime.ensureResident(live.ownerId, live.conversationId);
  assert.equal(live.sessionRow(row.id).status, "running");
  assert.equal(live.sessionRow(row.id).end_reason, null);
  assert.deepEqual(only.stopReasons, []);
  assert.equal(live.createRequests.length, 1);
});

test("keep-alive replaces a driver that died with a fresh session", async (t) => {
  const first = fakeProviderSession(611);
  const second = fakeProviderSession(612);
  const live = await createLiveRuntime(t, [first, second]);
  const one = await live.runtime.ensureSession(live.ownerId, live.conversationId);
  first.exited = true;

  await live.runtime.ensureResident(live.ownerId, live.conversationId);
  const now = live.db.get("SELECT id FROM advisor_sessions WHERE status = 'running'");
  assert.notEqual(now.id, one.id);
  assert.equal(live.sessionRow(one.id).end_reason, "crashed");
  assert.equal(live.createRequests.length, 2);
});

test("a settings change brings up a session on the new model", async (t) => {
  const first = fakeProviderSession(621);
  const second = fakeProviderSession(622);
  const live = await createLiveRuntime(t, [first, second]);
  await live.runtime.ensureResident(live.ownerId, live.conversationId);

  live.runtime.config.getAdvisorSettings = () => ({ ...settings, model: "claude-opus-6" });
  await live.runtime.ensureResident(live.ownerId, live.conversationId);
  const running = live.db.get("SELECT model FROM advisor_sessions WHERE status = 'running'");
  assert.equal(running.model, "claude-opus-6");
  assert.equal(live.createRequests.length, 2);
});

test("a paused provider means the resident session is not started", async (t) => {
  const unused = fakeProviderSession(631);
  const live = await createLiveRuntime(t, [unused]);
  live.runtime.config.isProviderPaused = () => true;

  await live.runtime.ensureResident(live.ownerId, live.conversationId);
  assert.equal(live.createRequests.length, 0);
  assert.equal(live.db.get("SELECT COUNT(*) AS n FROM advisor_sessions").n, 0);
});

test("ending the session and calling ensureResident brings up a fresh one (clear)", async (t) => {
  const first = fakeProviderSession(641);
  const second = fakeProviderSession(642);
  const live = await createLiveRuntime(t, [first, second]);
  const one = await live.runtime.ensureSession(live.ownerId, live.conversationId);

  await live.runtime.stopSession(one.id, "cleared");
  await live.runtime.ensureResident(live.ownerId, live.conversationId);
  const running = live.db.get("SELECT id, provider_session_id FROM advisor_sessions WHERE status = 'running'");
  assert.notEqual(running.id, one.id);
  assert.equal(live.sessionRow(one.id).end_reason, "cleared");
  assert.equal(live.createRequests.length, 2);
  assert.equal(live.createRequests[1].provider_session_id, undefined);
});

test("ensureResident leaves a running or queued turn alone when settings change", async (t) => {
  let releaseSend;
  const gate = new Promise((resolveGate) => { releaseSend = resolveGate; });
  const first = fakeProviderSession(651, { sendGate: gate });
  const live = await createLiveRuntime(t, [first, fakeProviderSession(652)]);
  const one = await live.runtime.ensureSession(live.ownerId, live.conversationId);
  await live.sendTurn(one.id, "running");
  await waitFor(() => first.sent.length === 1, "the first send to reach the gate");
  await live.sendTurn(one.id, "queued");

  live.runtime.config.getAdvisorSettings = () => ({ ...settings, model: "claude-opus-6" });
  await live.runtime.ensureResident(live.ownerId, live.conversationId);
  assert.equal(live.createRequests.length, 1);
  assert.equal(live.sessionRow(one.id).status, "running");

  releaseSend();
  await waitFor(() => live.replies.length === 2, "both turns to complete");
  assert.deepEqual(live.errors, []);
});

test("a settings change racing a send does not fail the turn", async (t) => {
  const first = fakeProviderSession(661);
  const second = fakeProviderSession(662);
  const live = await createLiveRuntime(t, [first, second]);
  const messageId = createUlid();
  const now = new Date().toISOString();
  const account = live.db.get("SELECT id FROM connector_accounts LIMIT 1");
  await live.db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
     VALUES (?, ?, 'web', ?, ?, 'q', '[]', ?, ?)`,
    messageId, live.conversationId, account.id, `web-user:${messageId}`, now, now,
  ));
  await live.runtime.ensureResident(live.ownerId, live.conversationId);
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));

  live.runtime.config.getAdvisorSettings = () => ({ ...settings, model: "claude-opus-6" });
  const [sent] = await Promise.all([
    live.runtime.ensureSessionAndEnqueue(live.ownerId, live.conversationId, messageId, { turn_id: "", text: "q", origin: { channel: "web" } }),
    live.runtime.ensureResident(live.ownerId, live.conversationId),
  ]);
  await waitFor(() => live.replies.length === 1, "the turn to complete");
  assert.equal(live.turnRow(sent.turnId).status, "completed");
  assert.equal(live.sessionRow(live.turnRow(sent.turnId).session_id).status, "running");
  assert.deepEqual(live.errors, []);
});

test("shutdown during a slow resident spawn terminates the new driver", async (t) => {
  const slow = fakeProviderSession(671);
  slow.terminated = false;
  slow.terminateImmediately = () => { slow.terminated = true; };
  const live = await createLiveRuntime(t, []);
  let releaseSpawn;
  const spawnGate = new Promise((resolveGate) => { releaseSpawn = resolveGate; });
  let spawning = false;
  live.runtime.config.providerClient.createSession = async () => { spawning = true; await spawnGate; return slow; };

  const resident = live.runtime.ensureResident(live.ownerId, live.conversationId);
  const settled = resident.then(() => "ok", (error) => error.message);
  await waitFor(() => spawning, "the spawn to start");
  live.runtime.stopImmediately();
  releaseSpawn();

  assert.match(await settled, /shutting down/);
  assert.equal(slow.terminated, true);
  assert.equal(live.runtime.activeDriver, null);
  assert.equal(live.db.get("SELECT COUNT(*) AS n FROM advisor_sessions WHERE status IN ('starting', 'running')").n, 0);
});
