import assert from "node:assert/strict";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

function makeProviderClient(requests) {
  return {
    createSession: async (request) => {
      requests.push(request);
      return {
        provider_session_id: `session-${requests.length}`,
        pid: process.pid,
        send: async () => {},
        events: () => ({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }),
        stop: async () => {},
        terminateImmediately: () => {},
      };
    },
  };
}

const agentRunner = {
  runManagerPlan: async () => { throw new Error("unused"); },
  runWorker: async () => { throw new Error("unused"); },
  runReviewer: async () => { throw new Error("unused"); },
  runAdvisor: async () => { throw new Error("unused"); },
};

async function withStartedCore(t, run) {
  const root = await tempDir(t, "owl-advisor-resident-");
  const requests = [];
  const { core, db } = await createTestCore(t, {
    agentRunner,
    version: "advisor-resident-test",
    owlRoot: root,
    dataDir: root,
    dispatcher: { tick_interval_ms: 25 },
    providerClient: makeProviderClient(requests),
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  await core.start();
  return run(core, db, requests);
}

test("Core start brings the Advisor session up, and clearing the conversation brings up a fresh one", async (t) => {
  await withStartedCore(t, async (core, db, requests) => {
    const running = () => db.all("SELECT id, conversation_id FROM advisor_sessions WHERE status = 'running'");
    // core.start() does not await the resident session, so wait for it, then let ensureResident finish
    // (adoptQueuedTurns) before clearing; clearing mid-start would end the session as "crashed".
    const first = (await waitFor(() => running().length === 1 && requests.length === 1 && running(), { message: "the startup session" }))[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(running().length, 1);
    assert.equal(running()[0].id, first.id);
    assert.equal(requests.length, 1);

    await core.clearConversation(first.conversation_id);
    const fresh = (await waitFor(() => running().length === 1 && running()[0].id !== first.id && running(), { message: "the fresh session" }))[0];
    assert.equal(db.get("SELECT end_reason FROM advisor_sessions WHERE id = ?", first.id).end_reason, "cleared");
    assert.equal(fresh.conversation_id, first.conversation_id);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].provider_session_id, undefined);
  });
});
