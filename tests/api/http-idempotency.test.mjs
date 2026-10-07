import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../../packages/core/dist/index.js";
import { openDatabase } from "../../packages/db/dist/index.js";
import { command } from "../helpers/core.mjs";
import { createTestDatabase, openTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const WORK_ID = "01J00000000000000000000000";
const ROUTE = `/api/v1/works/${WORK_ID}/archive`;

function envelope(key, payload = {}) {
  return { request_id: `req-${key}`, idempotency_key: key, expected_version: 1, payload };
}

// A Core stand-in that counts how often the command really runs.
function countingCore(counter) {
  return {
    ready: true,
    status: () => ({ services: [], mvp_scope: "test", version: "1.0.0" }),
    subscribe: () => () => {},
    eventsAfter: () => [],
    archiveWork: async () => {
      counter.runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { data: { work_id: WORK_ID, run: counter.runs }, version: 2 };
    },
  };
}

async function boot(t, db, root, counter, serverOptions = {}) {
  const api = await startTestHttpServer(t, { core: countingCore(counter), db, webOut: root, owlRoot: root, dataDir: root, ...serverOptions });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  return { ...api, post: (body) => api.request("POST", ROUTE, body) };
}

const httpRows = (db) => db.all("SELECT key, status_code, response_json FROM idempotency_keys WHERE key LIKE 'http-idempotency:%'");

test("a persisted response replays after Core, DB and server are rebuilt, and a changed body is a 409", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-api-idem-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "owl.db");
  const runs = { count: 0 };
  // Real Core whose archiveWork is spied on, so executions are counted below the HTTP layer.
  const buildCore = (db) => {
    const core = new Core({ agentRunner: {}, version: "test", db, owlRoot: root });
    const archive = core.archiveWork.bind(core);
    core.archiveWork = (...args) => {
      runs.count += 1;
      return archive(...args);
    };
    return core;
  };

  const db1 = createTestDatabase(root);
  const core1 = buildCore(db1);
  const created = await core1.createWork(command({ title: "Idem", summary: "x", size: "normal", project_id: null }, "idem-create"));
  await db1.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'completed', state_version = state_version + 1 WHERE id = ?", created.data.work_id));
  const version = created.version + 1;
  const route = `/api/v1/works/${created.data.work_id}/archive`;
  const body = { request_id: "r1", idempotency_key: "k1", expected_version: version, payload: {} };
  let firstBody;
  await t.test("first boot", async (st) => {
    const api = await startTestHttpServer(st, { core: core1, db: db1, webOut: root, owlRoot: root, dataDir: root });
    if (!api) return;
    const response = await api.request("POST", route, body);
    assert.equal(response.status, 200);
    firstBody = await response.json();
  });
  await core1.stop({ force: true });
  if (!firstBody) {
    db1.close();
    return t.skip("localhost listen is not permitted in this environment");
  }
  assert.equal(runs.count, 1);
  const [row] = httpRows(db1);
  assert.equal(row.status_code, 200);
  assert.deepEqual(JSON.parse(row.response_json), firstBody);
  db1.close();

  const db2 = openDatabase(dbPath);
  const core2 = buildCore(db2);
  t.after(async () => {
    await core2.stop({ force: true });
    db2.close();
  });
  const second = await startTestHttpServer(t, { core: core2, db: db2, webOut: root, owlRoot: root, dataDir: root });
  const replay = await second.request("POST", route, { ...body, request_id: "another-request" });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(runs.count, 1);

  const conflict = await second.request("POST", route, { ...body, expected_version: body.expected_version + 1 });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");
  assert.equal(runs.count, 1);
});

test("concurrent duplicates run once and share one response", async (t) => {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-api-idem-" });
  const counter = { runs: 0 };
  const api = await boot(t, db, root, counter);
  if (!api) return;
  const [a, b] = await Promise.all([api.post(envelope("dup")), api.post(envelope("dup"))]);
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(counter.runs, 1);
});

test("expired rows are swept and the key becomes new again", async (t) => {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-api-idem-" });
  const counter = { runs: 0 };
  const api = await boot(t, db, root, counter, { idempotencyTtlMs: 100 });
  if (!api) return;
  await api.post(envelope("ttl"));
  assert.equal(httpRows(db).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await api.post(envelope("other"));
  assert.equal(httpRows(db).filter((row) => row.key.endsWith(":ttl")).length, 0);
  assert.equal(counter.runs, 2);
  await api.post(envelope("ttl"));
  assert.equal(counter.runs, 3);
});
