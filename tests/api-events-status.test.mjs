import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { ExternalCoreAdapter, createCore as createMemoryCore } from "../apps/server/dist/core.js";

function frame(sequence, type = "work.updated") {
  return {
    kind: "event",
    event_id: `01J${String(sequence).padStart(23, "0")}`,
    sequence,
    cursor: String(sequence),
    type,
    schema_version: "1.0.0",
    work_id: null,
    task_id: null,
    agent_run_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    payload: { n: sequence },
  };
}

/** Minimal durable Core double: ascending history with optional hidden (internal) sequences. */
function durableCore(total, hidden = new Set()) {
  const history = [];
  for (let sequence = 1; sequence <= total; sequence += 1) {
    if (!hidden.has(sequence)) history.push(frame(sequence));
  }
  const calls = [];
  return {
    calls,
    history,
    core: {
      subscribe: () => () => {},
      status: () => ({ services: [{ name: "owl-core", state: "running", pid: 1 }], mvp_scope: "core", version: "1.0.0" }),
      listEventsAfter(cursor = 0, limit) {
        calls.push([Number(cursor), limit]);
        const after = history.filter((event) => event.sequence > Number(cursor));
        return limit === undefined ? after : after.slice(0, limit);
      },
      start: async () => {},
      stop: async () => {},
    },
    db: {
      get(sql) {
        assert.match(sql, /MAX\(sequence\)/u);
        return { max_sequence: total };
      },
    },
  };
}

async function startServer(t, core, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-events-"));
  const http = createOwlHttpServer({
    core,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    ...extra,
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return null;
    }
    throw error;
  }
  t.after(() => http.close());
  const address = http.server.address();
  return { base: `http://127.0.0.1:${address.port}`, root };
}

test("GET /system/status reports data_dir so connectors can store file uploads", async (t) => {
  const previousToken = process.env.OWL_API_TOKEN;
  delete process.env.OWL_API_TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
  });
  const core = {
    ready: true,
    status: () => ({ services: [{ name: "owl-core", state: "running", pid: 1 }], mvp_scope: "core", version: "1.0.0" }),
    subscribe: () => () => {},
  };
  const dataDir = await mkdtemp(join(tmpdir(), "owl-api-datadir-"));
  const server = await startServer(t, core, { dataDir });
  if (!server) return;
  const response = await fetch(`${server.base}/api/v1/system/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data_dir, dataDir);
  assert.deepEqual(Object.keys(body).sort(), ["data_dir", "mvp_scope", "services", "version"]);
});

test("GET /events?order=desc returns the newest events first and pages backwards with before", async (t) => {
  const previousToken = process.env.OWL_API_TOKEN;
  delete process.env.OWL_API_TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
  });
  const root = await mkdtemp(join(tmpdir(), "owl-api-events-adapter-"));
  // 250 events with a few internal ones hidden in the newest window.
  const durable = durableCore(250, new Set([249, 245, 120]));
  const adapter = new ExternalCoreAdapter(durable.core, durable.db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const server = await startServer(t, adapter);
  if (!server) return;

  const newest = await (await fetch(`${server.base}/api/v1/events?order=desc&limit=5`)).json();
  assert.deepEqual(newest.data.events.map((event) => event.sequence), [250, 248, 247, 246, 244]);
  assert.equal(newest.data.cursor, "244");
  assert.equal(newest.data.has_more, true);
  // The adapter must not scan the entire history to find the newest page.
  assert.ok(durable.calls.every(([cursor]) => cursor > 0), `expected a bounded window, got ${JSON.stringify(durable.calls)}`);

  const older = await (await fetch(`${server.base}/api/v1/events?order=desc&limit=3&before=${newest.data.cursor}`)).json();
  assert.deepEqual(older.data.events.map((event) => event.sequence), [243, 242, 241]);

  const tail = await (await fetch(`${server.base}/api/v1/events?order=desc&limit=5&before=3`)).json();
  assert.deepEqual(tail.data.events.map((event) => event.sequence), [2, 1]);
  assert.equal(tail.data.has_more, false);

  // Ascending replay is unchanged.
  const ascending = await (await fetch(`${server.base}/api/v1/events?limit=2`)).json();
  assert.deepEqual(ascending.data.events.map((event) => event.sequence), [1, 2]);

  for (const bad of ["order=sideways", "order=desc&before=abc", "before=10"]) {
    const response = await fetch(`${server.base}/api/v1/events?${bad}`);
    assert.equal(response.status, 400, bad);
  }
});

test("GET /events?order=desc leaves out system alerts that carry no message", async (t) => {
  const previousToken = process.env.OWL_API_TOKEN;
  delete process.env.OWL_API_TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
  });
  const root = await mkdtemp(join(tmpdir(), "owl-api-events-alerts-"));
  const durable = durableCore(10);
  Object.assign(durable.history[8], { type: "system.alert", payload: { operation: "turn_running" } });
  Object.assign(durable.history[7], { type: "system.alert", payload: { kind: "work_created", schema_version: "1.0.0" } });
  Object.assign(durable.history[6], { type: "system.alert", payload: { kind: "workflow_tick_failed", message: "stopped" } });
  const adapter = new ExternalCoreAdapter(durable.core, durable.db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const server = await startServer(t, adapter);
  if (!server) return;

  const newest = await (await fetch(`${server.base}/api/v1/events?order=desc&limit=3`)).json();
  assert.deepEqual(newest.data.events.map((event) => event.sequence), [10, 7, 6]);
});

test("GET /events?order=desc works for the standalone MemoryCore too", async (t) => {
  const previousToken = process.env.OWL_API_TOKEN;
  delete process.env.OWL_API_TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
  });
  const core = createMemoryCore({ version: "1.0.0" });
  const server = await startServer(t, core);
  if (!server) return;
  for (let index = 0; index < 4; index += 1) {
    const response = await fetch(`${server.base}/api/v1/works`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: `req-${index}`,
        idempotency_key: `idem-${index}`,
        expected_version: 0,
        payload: { title: `Work ${index}`, summary: "", size: "small", project_id: null },
      }),
    });
    assert.equal(response.status, 201, await response.text());
  }
  const all = await (await fetch(`${server.base}/api/v1/events?limit=200`)).json();
  const sequences = all.data.events.map((event) => event.sequence);
  assert.ok(sequences.length >= 4);
  const desc = await (await fetch(`${server.base}/api/v1/events?order=desc&limit=2`)).json();
  assert.deepEqual(desc.data.events.map((event) => event.sequence), sequences.slice(-2).reverse());
});

test("integration.saved/deleted are process-local control signals and never collide with durable sequences", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-api-integration-events-"));
  const durable = durableCore(7);
  let publish = null;
  durable.core.subscribe = (handler) => {
    publish = handler;
    return () => { publish = null; };
  };
  const adapter = new ExternalCoreAdapter(durable.core, durable.db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const published = [];
  const control = [];
  adapter.subscribe((event) => published.push(event));
  adapter.subscribeControl((signal) => control.push(signal));

  await adapter.deleteIntegration("slack", { request_id: "r", idempotency_key: "i", expected_version: 0 });
  const durableEvent = frame(8, "work.created");
  durable.history.push(durableEvent);
  publish(durableEvent);

  assert.deepEqual(control, [{ type: "integration.deleted", provider: "slack" }]);
  // Only the real durable event reaches WebSocket/SDK subscribers, so their cursor cannot skip sequence 8.
  assert.deepEqual(published.map((event) => [event.sequence, event.type]), [[8, "work.created"]]);
  assert.deepEqual(adapter.eventsAfter(7).map((event) => event.sequence), [8]);
});
