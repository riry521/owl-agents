import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createProviderPauseStore } from "../../packages/core/dist/index.js";
import { openDatabase } from "../../packages/db/dist/index.js";
import { createTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

const now = "2030-01-02T03:04:05.000Z";

async function temporaryDatabase(t) {
  const root = await tempDir(t, "owl-provider-pause-");
  let db = createTestDatabase(root);
  t.after(() => {
    db?.close();
  });
  return {
    root,
    get db() { return db; },
    setDb(next) { db = next; },
  };
}

test("records reported and backoff resume times", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createProviderPauseStore(db, () => now);

  const reported = await store.recordRateLimit({ provider: "anthropic", resets_at: "2030-01-02T04:00:00.000Z" });
  assert.equal(reported.state, "paused");
  assert.equal(reported.resume_source, "reported");
  assert.equal(reported.reported_resets_at, "2030-01-02T04:00:00.000Z");
  assert.equal(reported.resume_at, "2030-01-02T04:00:30.000Z");

  const backoff = await store.recordRateLimit({ provider: "openai", resets_at: null });
  assert.equal(backoff.resume_source, "backoff");
  assert.equal(backoff.backoff_step, 0);
  assert.equal(backoff.resume_at, "2030-01-02T03:19:05.000Z");

  const missingReset = await store.recordRateLimit({ provider: "google" });
  assert.equal(missingReset.resume_at, "2030-01-02T03:19:05.000Z");
});

test("re-pausing after a resume advances the unknown-reset backoff", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createProviderPauseStore(db, () => now);

  let row = await store.recordRateLimit({ provider: "anthropic", resets_at: null });
  assert.equal(row.resume_at, "2030-01-02T03:19:05.000Z");
  for (const [step, minutes] of [[1, 30], [2, 60], [3, 60]]) {
    row = await store.resume("anthropic");
    assert.equal(row.state, "probing");
    row = await store.recordRateLimit({ provider: "anthropic", resets_at: null });
    assert.equal(row.backoff_step, step);
    assert.equal(row.resume_at, new Date(Date.parse(now) + minutes * 60_000).toISOString());
  }
});

test("lists paused providers and removes one after a successful resume", async (t) => {
  const { db } = await temporaryDatabase(t);
  let clock = now;
  const store = createProviderPauseStore(db, () => clock);
  await store.recordRateLimit({ provider: "anthropic", resets_at: null });
  await store.recordRateLimit({ provider: "openai", resets_at: "2030-01-02T04:00:00.000Z" });

  assert.deepEqual(store.list().map((row) => row.provider).sort(), ["anthropic", "openai"]);
  await store.resume("anthropic");
  await store.noteProviderSucceeded("anthropic", now);
  assert.deepEqual(store.list().map((row) => row.provider), ["openai"]);

  clock = "2030-01-02T04:04:05.000Z";
  const freshPause = await store.recordRateLimit({ provider: "anthropic", resets_at: null });
  assert.equal(freshPause.paused_at, clock);
  assert.equal(freshPause.backoff_step, 0);
  assert.equal(freshPause.resume_at, "2030-01-02T04:19:05.000Z");
});

test("pause state and resume time survive reopening the database", async (t) => {
  const temporary = await temporaryDatabase(t);
  const store = createProviderPauseStore(temporary.db, () => now);
  const recorded = await store.recordRateLimit({ provider: "anthropic", resets_at: "2030-01-02T04:00:00.000Z" });
  temporary.db.close();
  const reopened = openDatabase(join(temporary.root, "owl.db")); // helpers-exempt: reopens the same database file to test persistence
  temporary.setDb(reopened);

  const restored = createProviderPauseStore(reopened, () => now).list();
  assert.deepEqual(restored, [recorded]);
});
