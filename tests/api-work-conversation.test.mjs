import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { Core } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const envelope = (payload, key, expectedVersion = 0) => ({ request_id: randomUUID(), idempotency_key: `wc:${key}`, expected_version: expectedVersion, payload });

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-work-conversation-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const durableCore = new Core({ db, agentRunner: {}, version: "api-work-conversation-test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  const adapter = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  // A Core without getWorkConversation: hide it on both the adapter and the wrapped Core.
  const bare = new Proxy(adapter, {
    get: (target, prop) => (prop === "getWorkConversation" || prop === "core" ? undefined : Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop)),
  });
  const originalToken = process.env.OWL_API_TOKEN;
  const token = randomBytes(32).toString("hex");
  process.env.OWL_API_TOKEN = token;
  const servers = [];
  const start = async (core) => {
    const http = createOwlHttpServer({ core, db, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root, dataDir });
    await http.listen();
    servers.push(http);
    const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
    return (path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  t.after(async () => {
    for (const http of servers) if (http.server.listening) await http.close();
    await durableCore.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = originalToken;
  });
  try {
    const request = await start(adapter);
    const requestBare = await start(bare);
    return { db, core: durableCore, request, requestBare };
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("localhost listen is not permitted"); return null; }
    throw error;
  }
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
