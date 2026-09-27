import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "owner:default";

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function insertMessage(db, conversationId, accountId, body) {
  const id = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO messages
         (id, conversation_id, provider, account_id, source_message_id, body,
          attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
      id,
      conversationId,
      accountId,
      `web-user:${id}`,
      body,
      now,
      now,
    );
  });
  return id;
}

function makeProviderClient(capturedRequests) {
  let currentTurn;
  let readySent = false;
  return {
    createSession: async (request) => {
      capturedRequests.push(request);
      currentTurn = undefined;
      readySent = false;
      return {
        provider_session_id: `session-${capturedRequests.length}`,
        pid: process.pid,
        send: async (turn) => {
          currentTurn = turn;
        },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            if (!readySent) {
              readySent = true;
              yield { type: "session.ready", provider_session_id: `session-${capturedRequests.length}`, pid: process.pid };
            }
            while (!currentTurn) await new Promise((r) => setTimeout(r, 10));
            yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: "Acknowledged.", usage: null };
          },
        }),
        stop: async () => {},
      };
    },
  };
}

const noopAgentRunner = {
  runManagerPlan: async () => { throw new Error("This test never creates a Work."); },
  runWorker: async () => { throw new Error("This test never runs a Worker."); },
  runReviewer: async () => { throw new Error("This test never runs a Reviewer."); },
  runAdvisor: async () => { throw new Error("The persistent provider session should handle Advisor replies."); },
};

async function withStartedCore(coreOptions, run) {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-connection-env-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({
    db,
    agentRunner: noopAgentRunner,
    version: "advisor-connection-env-test",
    owlRoot: root,
    dataDir: root,
    dispatcher: { tick_interval_ms: 25 },
    ...coreOptions,
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  let started = false;
  try {
    await core.start();
    started = true;
    return await run(core, db);
  } finally {
    if (started) await core.stop({ force: true }).catch(() => {});
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

function updateAdvisorProvider(core, provider, model) {
  const current = core.getModelSettings();
  return core.updateModelSettings({
    request_id: createUlid(),
    idempotency_key: `test:${createUlid()}`,
    expected_version: current.version,
    payload: {
      roles: current.roles.map(({ role, provider: p, model: m, effort }) =>
        role === "advisor" ? { role, provider, model, effort } : { role, provider: p, model: m, effort },
      ),
    },
  });
}

test("a custom provider's endpoint and API key reach the Advisor's provider session", async () => {
  const capturedRequests = [];
  const providerClient = makeProviderClient(capturedRequests);

  await withStartedCore(
    {
      providerClient,
      getProviderHarness: (providerId) => (providerId === "orca" ? "claude" : undefined),
      getProviderConnectionEnv: (providerId) =>
        providerId === "orca"
          ? { ANTHROPIC_BASE_URL: "https://orca.example/v1", ANTHROPIC_API_KEY: "orca-secret-key" }
          : {},
    },
    async (core, db) => {
      await updateAdvisorProvider(core, "orca", "orca-large");

      const conversation = await core.getActiveConversation();
      const webAccount = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId);
      const messageId = await insertMessage(db, conversation.conversation_id, webAccount.id, "Hello from the custom provider test.");

      await core.advisorRespond(conversation.conversation_id, messageId, { channel: "web" });

      await waitFor(() => {
        const turn = db.get(
          "SELECT status FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1",
          conversation.conversation_id,
        );
        return turn?.status === "completed" ? turn : null;
      }, "the Advisor turn to complete");

      assert.equal(capturedRequests.length, 1);
      const env = capturedRequests[0].env ?? {};
      assert.equal(env.ANTHROPIC_BASE_URL, "https://orca.example/v1");
      assert.equal(env.ANTHROPIC_API_KEY, "orca-secret-key");
      assert.equal(env.OPENAI_BASE_URL, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
    },
  );
});

test("a built-in provider's Advisor session carries no extra connection env", async () => {
  const capturedRequests = [];
  const providerClient = makeProviderClient(capturedRequests);

  await withStartedCore(
    {
      providerClient,
      getProviderConnectionEnv: () => ({}),
    },
    async (core, db) => {
      const conversation = await core.getActiveConversation();
      const webAccount = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId);
      const messageId = await insertMessage(db, conversation.conversation_id, webAccount.id, "Hello from the built-in provider test.");

      await core.advisorRespond(conversation.conversation_id, messageId, { channel: "web" });

      await waitFor(() => {
        const turn = db.get(
          "SELECT status FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1",
          conversation.conversation_id,
        );
        return turn?.status === "completed" ? turn : null;
      }, "the Advisor turn to complete");

      assert.equal(capturedRequests.length, 1);
      const env = capturedRequests[0].env ?? {};
      for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY"]) {
        assert.equal(env[key], undefined, `built-in provider session must not carry ${key}`);
      }
      assert.equal(env.OWL_AGENT_ROLE, "advisor");
    },
  );
});

test("a custom provider without a backend URL fails the Advisor start instead of falling back to the default endpoint", async () => {
  const capturedRequests = [];
  const providerClient = makeProviderClient(capturedRequests);

  await withStartedCore(
    {
      providerClient,
      getProviderHarness: (providerId) => (providerId === "no-backend" ? "claude" : undefined),
      getProviderConnectionEnv: (providerId) => {
        if (providerId === "no-backend") throw new Error("Custom provider 'no-backend' has no backend URL configured.");
        return {};
      },
    },
    async (core, db) => {
      await updateAdvisorProvider(core, "no-backend", "some-model");

      const conversation = await core.getActiveConversation();
      const webAccount = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId);
      const messageId = await insertMessage(db, conversation.conversation_id, webAccount.id, "Hello from the misconfigured provider test.");

      await core.advisorRespond(conversation.conversation_id, messageId, { channel: "web" });

      assert.equal(capturedRequests.length, 0, "a misconfigured provider must never reach the provider session");

      const errorMessage = db.get(
        "SELECT body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:error:%' ORDER BY created_at DESC LIMIT 1",
        conversation.conversation_id,
      );
      assert.ok(errorMessage, "the failed Advisor start should be surfaced as a message");
      assert.match(errorMessage.body, /no-backend/u);
      assert.match(errorMessage.body, /backend URL configured/u);
    },
  );
});
