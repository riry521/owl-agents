import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CoreClient } from "../../packages/plugin-sdk/dist/index.js";
import { FileConnectorStateStore } from "../../packages/plugin-sdk/dist/shared/index.js";
import { tempDir } from "../helpers/temp.mjs";

async function tempStateFile(t) {
  const dir = await tempDir(t, "owl-connector-state-");
  return join(dir, "sub", "slack-ACCT.json");
}

// --- FileConnectorStateStore --------------------------------------------------

test("FileConnectorStateStore: load() returns null before anything is saved", async (t) => {
  const store = new FileConnectorStateStore(await tempStateFile(t));
  assert.equal(await store.load(), null);
});

test("FileConnectorStateStore: save() then load() round-trips the cursor and decision map with owner-only permissions, creating missing directories", async (t) => {
  const path = await tempStateFile(t);
  const store = new FileConnectorStateStore(path);
  const state = {
    schema_version: 1,
    cursor: 42,
    decisions: {
      "01ARZ3NDEKTSV4RRFFQ6AAAAA1": { channel_id: "C-NOTIFICATIONS", message_ref: "1700000000.100", posted_at: "2026-09-25T00:00:00.000Z" },
    },
  };
  await store.save(state);

  const loaded = await store.load();
  assert.deepEqual(loaded, state);

  const info = await stat(path);
  assert.equal(info.mode & 0o777, 0o600);

  // A second save overwrites in place (atomically via tmp+rename), not appends.
  await store.save({ schema_version: 1, cursor: 43, decisions: {} });
  assert.deepEqual(await store.load(), { schema_version: 1, cursor: 43, decisions: {} });
});

async function writeRaw(path, contents) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

test("FileConnectorStateStore: load() throws on a corrupt file instead of silently discarding it", async (t) => {
  const path = await tempStateFile(t);
  await writeRaw(path, "{ not json");
  const store = new FileConnectorStateStore(path);
  await assert.rejects(store.load(), /not valid JSON/u);
});

test("FileConnectorStateStore: load() throws on an unrecognized schema_version", async (t) => {
  const path = await tempStateFile(t);
  await writeRaw(path, JSON.stringify({ schema_version: 2, cursor: 0, decisions: {} }));
  const store = new FileConnectorStateStore(path);
  await assert.rejects(store.load(), /schema_version/u);
});

test("FileConnectorStateStore: load() throws on a malformed decisions map", async (t) => {
  const path = await tempStateFile(t);
  await writeRaw(path, JSON.stringify({ schema_version: 1, cursor: 0, decisions: { X: { channel_id: "C" } } }));
  const store = new FileConnectorStateStore(path);
  await assert.rejects(store.load(), /invalid entry for decision X/u);
});

// --- CoreClient persistence (polling transport; no real WebSocket needed) ----

function corePollingClient(stateFile) {
  const client = new CoreClient({
    core_api_base: "http://127.0.0.1:1/api/v1",
    state_store: stateFile ? new FileConnectorStateStore(stateFile) : undefined,
  });
  return client;
}

test("CoreClient: persists the event cursor after each handled event, ack-after-settle, even when the handler throws", async (t) => {
  const stateFile = await tempStateFile(t);
  // Pre-seed a cursor as if this connector already ran before, so polling
  // processes the fake events on its very first tick instead of only
  // establishing a discard-history baseline (the fresh-connector behaviour).
  await new FileConnectorStateStore(stateFile).save({ schema_version: 1, cursor: 1, decisions: {} });
  const client = corePollingClient(stateFile);

  const events = [
    { event_id: "e2", sequence: 2, cursor: "2", type: "decision.opened", payload: { decision_id: "D2" } },
    { event_id: "e3", sequence: 3, cursor: "3", type: "decision.opened", payload: { decision_id: "D3" } },
  ];
  client.request = async () => ({ events, cursor: "3", has_more: false });

  const handled = [];
  const handler = async (event) => {
    handled.push(event.event_id);
    if (event.event_id === "e3") throw new Error("handler blew up on e3");
  };

  await client.subscribeEvents(["decision.opened"], handler);
  // startPolling fires its first poll() without awaiting it from subscribeEvents.
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.close();

  assert.deepEqual(handled, ["e2", "e3"]);

  const persisted = await new FileConnectorStateStore(stateFile).load();
  assert.ok(persisted, "state file was written");
  assert.equal(persisted.cursor, 3, "the cursor advances past a failed handler, not just successful ones");
});

test("CoreClient: rememberDecisionMessage/forgetDecisionMessage persist the Decision-to-message map and reload it on the next instance", async (t) => {
  const stateFile = await tempStateFile(t);
  const client = corePollingClient(stateFile);
  client.request = async () => ({ events: [], cursor: null, has_more: false });
  await client.subscribeEvents([], async () => {});

  await client.rememberDecisionMessage("D1", { channel_id: "C1", message_ref: "T1", posted_at: "2026-09-25T00:00:00.000Z" });
  await client.rememberDecisionMessage("D2", { channel_id: "C1", message_ref: "T2", posted_at: "2026-09-25T00:00:01.000Z" });
  client.close();

  assert.deepEqual(client.decisionMessage("D1"), { channel_id: "C1", message_ref: "T1", posted_at: "2026-09-25T00:00:00.000Z" });
  assert.equal([...client.listDecisionMessages().keys()].length, 2);

  // A fresh CoreClient backed by the same state file picks up the persisted map on its first subscribeEvents call.
  const reloaded = corePollingClient(stateFile);
  reloaded.request = async () => ({ events: [], cursor: null, has_more: false });
  await reloaded.subscribeEvents([], async () => {});
  assert.deepEqual(reloaded.decisionMessage("D2"), { channel_id: "C1", message_ref: "T2", posted_at: "2026-09-25T00:00:01.000Z" });
  reloaded.close();

  await reloaded.forgetDecisionMessage("D2");
  const afterForget = await new FileConnectorStateStore(stateFile).load();
  assert.deepEqual(Object.keys(afterForget.decisions), ["D1"]);
});

test("CoreClient: without a state_store, cursor and decisions stay in memory only (no file written)", async (t) => {
  const client = corePollingClient(null);
  client.request = async () => ({ events: [], cursor: null, has_more: false });
  await client.subscribeEvents([], async () => {});
  await client.rememberDecisionMessage("D1", { channel_id: "C1", message_ref: "T1", posted_at: "2026-09-25T00:00:00.000Z" });
  assert.deepEqual(client.decisionMessage("D1"), { channel_id: "C1", message_ref: "T1", posted_at: "2026-09-25T00:00:00.000Z" });
  client.close();
});
