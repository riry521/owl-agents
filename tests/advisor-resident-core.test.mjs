import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

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

async function withStartedCore(run) {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-resident-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const requests = [];
  const core = new Core({
    db,
    agentRunner,
    version: "advisor-resident-test",
    owlRoot: root,
    dataDir: root,
    dispatcher: { tick_interval_ms: 25 },
    providerClient: makeProviderClient(requests),
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  let started = false;
  try {
    await core.start();
    started = true;
    return await run(core, db, requests);
  } finally {
    if (started) await core.stop({ force: true }).catch(() => {});
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("Core start brings the Advisor session up, and clearing the conversation brings up a fresh one", async () => {
  await withStartedCore(async (core, db, requests) => {
    const running = () => db.all("SELECT id, conversation_id FROM advisor_sessions WHERE status = 'running'");
    const first = (await waitFor(() => running().length === 1 && running(), "the startup session"))[0];
    assert.equal(requests.length, 1);

    await core.clearConversation(first.conversation_id);
    const fresh = (await waitFor(() => running().length === 1 && running()[0].id !== first.id && running(), "the fresh session"))[0];
    assert.equal(db.get("SELECT end_reason FROM advisor_sessions WHERE id = ?", first.id).end_reason, "cleared");
    assert.equal(fresh.conversation_id, first.conversation_id);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].provider_session_id, undefined);
  });
});
