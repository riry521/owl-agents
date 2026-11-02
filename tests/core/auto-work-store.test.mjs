import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { NoopGitGateway } from "../../packages/core/dist/index.js";
import { AutoWorkStore } from "../../packages/core/dist/auto-work/store.js";
import { createTestCore } from "../helpers/core.mjs";

const key = (value) => createHash("sha256").update(value).digest("hex");

async function setup(t) {
  const { db } = await createTestCore(t, { git: new NoopGitGateway(), version: "auto-work-store" }, { prefix: "owl-auto-work-store-", start: true });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'owner:default', ?, ?)", now, now);
    for (const id of ["proj1", "proj2"]) {
      tx.run(
        `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
           verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
         VALUES (?, 'owner:default', ?, ?, 'main', '[]', '[]', '[]', ?, ?)`,
        id, id, `/tmp/${id}`, now, now,
      );
    }
  });
  return { db, store: new AutoWorkStore(db) };
}

const event = (overrides = {}) => ({
  project_id: "proj1", source: "failure_notice", kind: "process_failed", dedupe_key: key("a"), day_key: "2026-11-2",
  title: "", detail: "", verdict: "created", verdict_reason: "ok", occurred_at: "2026-11-02T00:00:00.000Z", ...overrides,
});

test("an event is written with defaults, read back, and updated", async (t) => {
  const { store } = await setup(t);
  const created = await store.insertEvent(event({ title: "t", detail: "d", backlog_item_ids: ["b1"], github_is_pull_request: true }));
  assert.equal(created.title, "t");
  assert.deepEqual(created.backlog_item_ids, ["b1"]);
  assert.equal(created.github_is_pull_request, true);
  assert.equal(created.judge, null);
  assert.equal(created.work_id, null);
  assert.equal(created.dedupe_key.length, 64);

  const bare = await store.insertEvent(event({ verdict: "judging" }));
  assert.deepEqual(bare.backlog_item_ids, []);
  assert.equal(bare.title, "");
  assert.equal(bare.github_is_pull_request, null);

  const updated = await store.updateEvent(bare.id, { verdict: "not_worth", verdict_reason: "low", judge: { worth: false }, action: "draft" });
  assert.equal(updated.verdict, "not_worth");
  assert.deepEqual(updated.judge, { worth: false });
  assert.equal(updated.action, "draft");
  assert.ok(updated.updated_at >= bare.updated_at);
  assert.equal(store.getEvent(bare.id).verdict, "not_worth");
  assert.equal(store.getEvent("missing"), null);
  await assert.rejects(() => store.insertEvent(event({ verdict: "bogus" })));
});

test("events list newest first and filter by project, source, verdict and work", async (t) => {
  const { db, store } = await setup(t);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('work1', 'owner:default', 'proj1', 'W', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      now, now,
    );
  });
  const ids = [];
  for (const [project_id, source, verdict, work_id] of [
    ["proj1", "failure_notice", "created", "work1"],
    ["proj1", "github", "duplicate", undefined],
    ["proj2", "github", "created", undefined],
    ["proj1", "scheduled_check", "daily_cap", undefined],
  ]) {
    ids.push((await store.insertEvent(event({ project_id, source, verdict, work_id }))).id);
    await new Promise((resolve) => setTimeout(resolve, 3)); // created_at has millisecond resolution
  }

  const all = store.listEvents({ limit: 10 }).map((row) => row.id);
  assert.deepEqual(all, [...ids].reverse());
  assert.deepEqual(store.listEvents({ limit: 2 }).map((row) => row.id), all.slice(0, 2));
  assert.deepEqual(store.listEvents({ limit: 2, offset: 2 }).map((row) => row.id), all.slice(2));
  assert.deepEqual(store.listEvents({ limit: 10, project_id: "proj2" }).map((row) => row.id), [ids[2]]);
  assert.deepEqual(store.listEvents({ limit: 10, source: "github" }).map((row) => row.id), [ids[2], ids[1]]);
  assert.deepEqual(store.listEvents({ limit: 10, verdict: "created" }).map((row) => row.id), [ids[2], ids[0]]);
  assert.deepEqual(store.listEvents({ limit: 10, work_id: "work1" }).map((row) => row.id), [ids[0]]);
  assert.deepEqual(store.listEvents({ limit: 10, project_id: "proj1", source: "github", verdict: "created" }), []);

  await db.createWriteLane().transact((tx) => { tx.run("DELETE FROM works WHERE id = 'work1'"); });
  assert.equal(store.getEvent(ids[0]).work_id, null, "deleting a Work keeps the event");
  await db.createWriteLane().transact((tx) => { tx.run("DELETE FROM projects WHERE id = 'proj2'"); });
  assert.equal(store.getEvent(ids[2]), null, "deleting a Project removes its events");
});

test("a GitHub cursor is saved per list and replaced on the next save", async (t) => {
  const { store } = await setup(t);
  assert.equal(store.getCursor("proj1", "issues"), null);
  const first = { since: "2026-11-01T00:00:00.000Z", last_polled_at: "2026-11-01T00:00:00.000Z", last_completed_at: null, last_error: "output_truncated" };
  await store.saveCursor("proj1", "issues", "owner/name", first);
  await store.saveCursor("proj1", "comments", "owner/name", { ...first, since: "2026-10-31T00:00:00.000Z", last_error: null });
  assert.deepEqual(store.getCursor("proj1", "issues"), { repo: "owner/name", ...first });
  const next = { ...first, since: "2026-11-02T00:00:00.000Z", last_completed_at: "2026-11-02T00:00:00.000Z", last_error: null };
  await store.saveCursor("proj1", "issues", "owner/name", next);
  assert.deepEqual(store.getCursor("proj1", "issues"), { repo: "owner/name", ...next });
  assert.equal(store.getCursor("proj1", "comments").since, "2026-10-31T00:00:00.000Z");
  await store.resetGithub("proj1");
  assert.equal(store.getCursor("proj1", "comments"), null);
});

const item = (id, updatedAt, overrides = {}) => ({
  item_type: "issue", item_id: id, issue_number: Number(id), updated_at: updatedAt, created_in_window: true, payload: { id, updatedAt }, ...overrides,
});

test("the ledger records items once, re-queues newer updates, and counts by state", async (t) => {
  const { store } = await setup(t);
  await store.recordItems("proj1", "owner/name", [item("3", "2026-11-01T03:00:00Z"), item("1", "2026-11-01T01:00:00Z"), item("2", "2026-11-01T02:00:00Z", { item_type: "comment", created_in_window: false })]);
  assert.deepEqual(store.listPendingItems("proj1", "issue", 10).map((row) => row.item_id), ["1", "3"]);
  assert.equal(store.listPendingItems("proj1", "issue", 1).length, 1);
  assert.equal(store.getItem("proj1", "comment", "2").created_in_window, false);
  assert.deepEqual(store.getItem("proj1", "issue", "1").payload, { id: "1", updatedAt: "2026-11-01T01:00:00Z" });

  await store.markItemProcessed("proj1", "issue", "1", "event-1");
  const processed = store.getItem("proj1", "issue", "1");
  assert.equal(processed.state, "processed");
  assert.equal(processed.payload, null);
  assert.equal(processed.event_id, "event-1");
  assert.ok(processed.processed_at);

  // The same or an older update returned again is ignored; a newer one is pending again and keeps created_in_window.
  await store.recordItems("proj1", "owner/name", [item("1", "2026-11-01T01:00:00Z"), item("1", "2026-11-01T00:00:00Z")]);
  assert.equal(store.getItem("proj1", "issue", "1").state, "processed");
  await store.recordItems("proj1", "owner/name", [item("1", "2026-11-01T05:00:00Z", { created_in_window: false })]);
  const requeued = store.getItem("proj1", "issue", "1");
  assert.equal(requeued.state, "pending");
  assert.equal(requeued.updated_at, "2026-11-01T05:00:00Z");
  assert.equal(requeued.created_in_window, true);
  assert.equal(requeued.event_id, "event-1");

  assert.deepEqual(store.countItems("proj1", "issue"), { pending: 2, processed: 0, failed: 0 });
  assert.deepEqual(store.countItems("proj2", "issue"), { pending: 0, processed: 0, failed: 0 });
});

test("failed attempts count up to the limit, then the item stops being pending until it is updated", async (t) => {
  const { store } = await setup(t);
  await store.recordItems("proj1", "owner/name", [item("7", "2026-11-01T01:00:00Z")]);
  await store.markItemAttemptFailed("proj1", "issue", "7", "boom", 2);
  assert.equal(store.getItem("proj1", "issue", "7").state, "pending");
  assert.equal(store.getItem("proj1", "issue", "7").attempts, 1);
  await store.markItemAttemptFailed("proj1", "issue", "7", "boom", 2);
  const failed = store.getItem("proj1", "issue", "7");
  assert.equal(failed.state, "failed");
  assert.equal(failed.last_error, "boom");
  assert.deepEqual(store.listPendingItems("proj1", "issue", 10), []);
  assert.equal(store.countItems("proj1", "issue").failed, 1);

  await store.recordItems("proj1", "owner/name", [item("7", "2026-11-01T09:00:00Z")]);
  const retried = store.getItem("proj1", "issue", "7");
  assert.equal(retried.state, "pending");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.last_error, null);
});

test("cleanup removes only processed items older than the cutoff", async (t) => {
  const { store } = await setup(t);
  await store.recordItems("proj1", "owner/name", [item("1", "2026-11-01T01:00:00Z"), item("2", "2026-11-01T02:00:00Z"), item("3", "2026-11-01T01:30:00Z"), item("4", "2026-11-01T03:00:00Z")]);
  await store.markItemProcessed("proj1", "issue", "1", null);
  await store.markItemProcessed("proj1", "issue", "2", null);
  await store.markItemAttemptFailed("proj1", "issue", "3", "x", 1);
  const removed = await store.deleteProcessedBefore("proj1", "2026-11-01T02:00:00Z");
  assert.equal(removed, 1);
  assert.equal(store.getItem("proj1", "issue", "1"), null);
  assert.equal(store.getItem("proj1", "issue", "2").state, "processed");
  assert.equal(store.getItem("proj1", "issue", "3").state, "failed");
  assert.equal(store.getItem("proj1", "issue", "4").state, "pending");
});
