import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { CODEX_PROVIDER_API_KEY_ENV, CODEX_PROVIDER_BASE_URL_ENV } from "../../packages/shared/dist/index.js";
import { resolveAgentExecutables } from "../../apps/server/dist/agent-runner.js";
import { customProviderConnectionEnv } from "../../apps/server/dist/core.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";

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

async function withStartedCore(t, coreOptions, run) {
  const root = await tempDir(t, "owl-advisor-connection-env-");
  const { core, db } = await createTestCore(t, {
    agentRunner: noopAgentRunner,
    version: "advisor-connection-env-test",
    owlRoot: root,
    dataDir: root,
    dispatcher: { tick_interval_ms: 25 },
    ...coreOptions,
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await core.start();
  return run(core, db);
}

function updateAdvisorProvider(core, provider, model) {
  const current = core.getModelSettings();
  return core.updateModelSettings(command({
    roles: current.roles.map(({ role, provider: p, model: m, effort }) =>
      role === "advisor" ? { role, provider, model, effort } : { role, provider: p, model: m, effort },
    ),
  }, `test:${createUlid()}`, current.version));
}

test("a custom provider's endpoint and API key reach the Advisor's provider session", async (t) => {
  const capturedRequests = [];
  const providerClient = makeProviderClient(capturedRequests);

  await withStartedCore(
    t,
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
      }, { message: "the Advisor turn to complete" });

      // The resident Advisor may already have started on the default provider before the switch.
      const orcaRequests = capturedRequests.filter((request) => request.model === "orca-large");
      assert.equal(orcaRequests.length, 1);
      const env = orcaRequests[0].env ?? {};
      assert.equal(env.ANTHROPIC_BASE_URL, "https://orca.example/v1");
      assert.equal(env.ANTHROPIC_API_KEY, "orca-secret-key");
      assert.equal(env.OPENAI_BASE_URL, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env[CODEX_PROVIDER_BASE_URL_ENV], undefined);
      assert.equal(env[CODEX_PROVIDER_API_KEY_ENV], undefined);
    },
  );
});

test("a built-in provider's Advisor session carries no extra connection env", async (t) => {
  const capturedRequests = [];
  const providerClient = makeProviderClient(capturedRequests);

  await withStartedCore(
    t,
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
      }, { message: "the Advisor turn to complete" });

      assert.equal(capturedRequests.length, 1);
      const env = capturedRequests[0].env ?? {};
      for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY", CODEX_PROVIDER_BASE_URL_ENV, CODEX_PROVIDER_API_KEY_ENV]) {
        assert.equal(env[key], undefined, `built-in provider session must not carry ${key}`);
      }
      assert.equal(env.OWL_AGENT_ROLE, "advisor");
      // The MCP env's OWL_AGENT_RUN_ID comes from this value: it must be the Advisor's session id.
      const session = db.get("SELECT id FROM advisor_sessions WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1", conversation.conversation_id);
      assert.ok(session?.id);
      assert.equal(env.OWL_AGENT_RUN_ID, session.id);
    },
  );
});

test("a custom provider without a backend URL fails the Advisor start instead of falling back to the default endpoint", async (t) => {
  const capturedRequests = [];
  const providerClient = makeProviderClient(capturedRequests);

  await withStartedCore(
    t,
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

      assert.equal(
        capturedRequests.filter((request) => request.model === "some-model").length,
        0,
        "a misconfigured provider must never reach the provider session",
      );

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

test("a custom provider's connection env uses the Codex variables for a codex harness and Anthropic's for claude", () => {
  const source = { OWL_PROVIDER_ORCA_API_KEY: "orca-secret-key" };
  const codex = { harnessId: "codex", backendUrl: "https://orca.example/v1", apiKeySource: "env:OWL_PROVIDER_ORCA_API_KEY" };
  assert.deepEqual(customProviderConnectionEnv("orca", codex, source), {
    [CODEX_PROVIDER_BASE_URL_ENV]: "https://orca.example/v1",
    [CODEX_PROVIDER_API_KEY_ENV]: "orca-secret-key",
  });
  assert.deepEqual(customProviderConnectionEnv("orca", { ...codex, harnessId: "claude" }, source), {
    ANTHROPIC_BASE_URL: "https://orca.example/v1",
    ANTHROPIC_API_KEY: "orca-secret-key",
  });
  // No key source, or a source variable that is unset: the key is left out.
  assert.deepEqual(customProviderConnectionEnv("orca", { ...codex, apiKeySource: undefined }, source), {
    [CODEX_PROVIDER_BASE_URL_ENV]: "https://orca.example/v1",
  });
  assert.deepEqual(customProviderConnectionEnv("orca", codex, {}), {
    [CODEX_PROVIDER_BASE_URL_ENV]: "https://orca.example/v1",
  });
  assert.throws(() => customProviderConnectionEnv("orca", { ...codex, backendUrl: undefined }, source), /no backend URL/);
});

test("the opencode executable comes from OWL_OPENCODE_EXECUTABLE, then PATH, unless the selection names one", async (t) => {
  const dir = await tempDir(t, "owl-opencode-bin-");
  const onPath = join(dir, "opencode");
  await writeFile(onPath, "#!/bin/sh\n");
  await chmod(onPath, 0o755);
  const saved = process.env.OWL_OPENCODE_EXECUTABLE;
  t.after(() => {
    if (saved === undefined) delete process.env.OWL_OPENCODE_EXECUTABLE;
    else process.env.OWL_OPENCODE_EXECUTABLE = saved;
  });
  process.env.OWL_OPENCODE_EXECUTABLE = "/configured/opencode";
  assert.equal((await resolveAgentExecutables({ harness: "claude" }, undefined, dir)).opencode, "/configured/opencode");
  delete process.env.OWL_OPENCODE_EXECUTABLE;
  assert.equal((await resolveAgentExecutables({ harness: "claude" }, undefined, dir)).opencode, onPath);
  assert.equal((await resolveAgentExecutables({ harness: "opencode" }, "/selected/opencode", dir)).opencode, "/selected/opencode");
});

test("a custom opencode provider gets opencode's own connection variables and no Anthropic or Codex ones", () => {
  const custom = { harnessId: "opencode", backendUrl: "https://orca.example/v1", apiKeySource: "env:OWL_PROVIDER_ORCA_API_KEY" };
  assert.deepEqual(customProviderConnectionEnv("orca", custom, { OWL_PROVIDER_ORCA_API_KEY: "orca-secret-key" }), {
    OWL_OPENCODE_BASE_URL: "https://orca.example/v1",
    OWL_OPENCODE_API_KEY_ENV: "OWL_PROVIDER_ORCA_API_KEY",
    OWL_PROVIDER_ORCA_API_KEY: "orca-secret-key",
  });
});

test("an opencode Advisor model is accepted and its session is created with the opencode adapter", async (t) => {
  const capturedRequests = [];
  const providerClient = makeProviderClient(capturedRequests);

  await withStartedCore(t, { providerClient }, async (core, db) => {
    await updateAdvisorProvider(core, "opencode", "fake-provider/fake-model");
    const snapshot = core.getAdvisorSettingsSnapshot();
    assert.equal(snapshot.harnessId, "opencode");
    assert.match(snapshot.systemPrompt, /Owl Advisor/u);
    assert.doesNotMatch(snapshot.systemPrompt, /Harness tool names/u);

    const conversation = await core.getActiveConversation();
    const webAccount = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId);
    const messageId = await insertMessage(db, conversation.conversation_id, webAccount.id, "Hello from the opencode test.");
    await core.advisorRespond(conversation.conversation_id, messageId, { channel: "web" });
    await waitFor(() => {
      const turn = db.get("SELECT status FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1", conversation.conversation_id);
      return turn?.status === "completed" ? turn : null;
    }, { message: "the Advisor turn to complete" });
    const requests = capturedRequests.filter((request) => request.model === "fake-provider/fake-model");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].adapter, "opencode");
    assert.match(requests[0].system_prompt, /Owl Advisor/u);
  });
});
