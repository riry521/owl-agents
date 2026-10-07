import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { repoRoot } from "../helpers/paths.mjs";

const envelope = (payload, key, expectedVersion = 0) => ({ request_id: randomUUID(), idempotency_key: `wc:${key}`, expected_version: expectedVersion, payload });

async function setup(t) {
  const { root, db, core: durableCore } = await createTestCore(t, {
    version: "api-work-conversation-test",
    dispatcher: { tick_interval_ms: 25 },
  }, { prefix: "owl-api-work-conversation-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const adapter = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  // A Core without getWorkConversation: hide it on both the adapter and the wrapped Core.
  const bare = new Proxy(adapter, {
    get: (target, prop) => (prop === "getWorkConversation" || prop === "core" ? undefined : Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop)),
  });
  const token = randomBytes(32).toString("hex");
  // Only the first server sets OWL_API_TOKEN; the second one reuses it.
  const start = async (core, options) => {
    const server = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir }, options);
    if (!server) return null;
    return (path, { method = "GET", body } = {}) => fetch(`${server.baseUrl}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const request = await start(adapter, { token });
  const requestBare = request && await start(bare);
  if (!request || !requestBare) { t.skip("localhost listen is not permitted"); return null; }
  return { db, core: durableCore, request, requestBare };
}

async function createWork(core, db, title, state = "running") {
  const workId = (await core.createWork(envelope({ title, summary: "", size: "small", project_id: null }, `create:${title}`))).data.work_id;
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = ?, state_version = 1, updated_at = ? WHERE id = ?", state, new Date().toISOString(), workId);
  });
  return workId;
}

const yamlText = readFileSync(join(repoRoot, "contracts/openapi/owl-api-v1.yaml"), "utf8");
const schemaBlock = yamlText.slice(yamlText.indexOf("    WorkConversationMessage:"), yamlText.indexOf("    WorkConversationResponse:"));
const contractKeys = [...schemaBlock.slice(schemaBlock.indexOf("      properties:")).matchAll(/^ {8}(\w+):$/gm)].map((m) => m[1]);

test("GET /works/{id}/conversation returns the 200 shape, empty for no conversation, and validates limit", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { core, db, request, requestBare } = env;
  const workId = await createWork(core, db, "conversation shape");

  const empty = await request(`/works/${workId}/conversation`);
  assert.equal(empty.status, 200);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.data.work_id, workId);
  assert.deepEqual(emptyBody.data.messages, []);
  assert.equal(emptyBody.data.truncated, false);

  for (const [i, body] of ["one", "two", "three"].entries()) {
    const posted = await request(`/works/${workId}/messages`, { method: "POST", body: envelope({ body }, `msg${i}`, 1) });
    assert.equal(posted.status, 202);
  }
  const ok = await (await request(`/works/${workId}/conversation?limit=2`)).json();
  assert.equal(ok.data.truncated, true);
  assert.deepEqual(ok.data.messages.map((m) => m.body), ["two", "three"]);
  for (const m of ok.data.messages) {
    assert.ok(Array.isArray(m.in_reply_to));
    assert.ok("instruction" in m);
    assert.equal(typeof m.received_at, "string");
    for (const key of Object.keys(m)) assert.ok(contractKeys.includes(key), `undeclared key ${key}`);
    assert.equal(m.conversation_id, ok.data.conversation_id);
  }
  const all = await (await request(`/works/${workId}/conversation`)).json();
  assert.equal(all.data.truncated, false);
  assert.equal(all.data.messages.length, 3);

  for (const limit of ["1", "500"]) assert.equal((await request(`/works/${workId}/conversation?limit=${limit}`)).status, 200);
  for (const limit of ["0", "501", "-1", "abc", "1.5"]) {
    const response = await request(`/works/${workId}/conversation?limit=${limit}`);
    assert.equal(response.status, 400, `limit=${limit}`);
    assert.equal((await response.json()).error.code, "validation_error");
  }

  const missing = await request(`/works/${createUlid()}/conversation`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "work_not_found");

  const unavailable = await requestBare(`/works/${workId}/conversation`);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "dependency_unavailable");
});

test("POST /works/{id}/messages with reopen rejects a stale expected_version with 409", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { core, db, request } = env;
  const workId = await createWork(core, db, "version conflict", "completed");
  const stale = await request(`/works/${workId}/messages`, { method: "POST", body: envelope({ body: "stale", reopen: true }, "stale", 5) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "version_conflict");
  const conversation = await (await request(`/works/${workId}/conversation`)).json();
  assert.deepEqual(conversation.data.messages, []);
});
