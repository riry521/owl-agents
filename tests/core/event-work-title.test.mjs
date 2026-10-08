import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";

const NOW = "2030-01-02T03:04:05.000Z";

test("notification events get payload.work_title on live frames and history", async (t) => {
  const { root, db, core } = await createTestCore(t, { version: "event-work-title-test", now: () => new Date().toISOString() }, { prefix: "owl-event-work-title-" });
  await mkdir(join(root, "data"), { recursive: true });
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", NOW, NOW);
    tx.run("INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('w1', 'owner:default', 'Release work', '', 'normal', 'ready', '[]', '[]', ?, ?)", NOW, NOW);
    const events = [
      ["e1", "work.completed", "w1", { work_id: "w1" }],
      ["e2", "decision.opened", "w1", { decision_id: "d1", title: "Pick one" }],
      ["e3", "system.alert", "w1", { message: "boom" }],
      ["e4", "system.alert", null, { message: "global" }],
      ["e5", "provider.paused", null, { provider: "anthropic" }],
      ["e6", "work.paused", "w1", { work_title: "Custom" }],
      ["e7", "task.completed", "w1", { task_id: "t1" }],
    ];
    events.forEach(([id, type, workId, payload], i) => {
      tx.run(
        "INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
        id, i + 1, `key-${id}`, type, workId, JSON.stringify(payload), NOW,
      );
    });
  });
  const live = new Map();
  core.subscribe((event) => { live.set(event.event_id, event.payload); });
  await core.start();

  const history = new Map(core.listEventsAfter(null).map((frame) => [frame.event_id, frame.payload]));
  for (const frames of [live, history]) {
    assert.equal(frames.get("e1").work_title, "Release work");
    assert.equal(frames.get("e2").work_title, "Release work");
    assert.equal(frames.get("e2").title, "Pick one");
    assert.equal(frames.get("e3").work_title, "Release work");
    assert.equal("work_title" in frames.get("e4"), false);
    assert.equal("work_title" in frames.get("e5"), false);
    assert.equal(frames.get("e6").work_title, "Custom");
    assert.equal("work_title" in frames.get("e7"), false);
  }
  const stored = db.get("SELECT payload_json FROM events WHERE id = 'e1'");
  assert.equal(stored.payload_json, JSON.stringify({ work_id: "w1" }));
});

test("event history fills a limited page with visible events when internal dispatcher alerts come first", async (t) => {
  const { root, db, core } = await createTestCore(t, { version: "event-history-limit-test", now: () => new Date().toISOString() }, { prefix: "owl-event-history-limit-" });
  await mkdir(join(root, "data"), { recursive: true });
  await db.createWriteLane().transact((tx) => {
    const events = [
      ["i1", "system.alert", { internal_dispatcher_marker: true }],
      ["i2", "system.alert", { internal_dispatcher_marker: true }],
      ["n1", "system.alert", { internal_dispatcher_marker: 1 }],
      ["v1", "work.completed", { work_id: "w1" }],
      ["v2", "work.paused", { work_id: "w1" }],
    ];
    events.forEach(([id, type, payload], i) => {
      tx.run(
        "INSERT INTO events (id, sequence, idempotency_key, type, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'handled', ?)",
        id, i + 1, `key-${id}`, type, JSON.stringify(payload), NOW,
      );
    });
  });
  assert.deepEqual(core.listEventsAfter(null, 3).map((frame) => frame.event_id), ["n1", "v1", "v2"]);
});
