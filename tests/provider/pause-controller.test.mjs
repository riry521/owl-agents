import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createProviderPauseController, createProviderPauseStore } from "../../packages/core/dist/index.js";
import { openDatabase } from "../../packages/db/dist/index.js";
import { createTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

function fakeClock(initial) {
  let current = Date.parse(initial);
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => new Date(current).toISOString(),
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: current + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      current += milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= current).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          if (!timers.delete(id)) continue;
          timer.callback();
        }
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
      }
    },
    get pending() { return timers.size; },
  };
}

async function database(t) {
  const root = await tempDir(t, "owl-provider-pause-controller-");
  let db = createTestDatabase(root);
  t.after(() => {
    db?.close();
  });
  return { root, get db() { return db; }, reopen() {
    db.close();
    db = openDatabase(join(root, "owl.db")); // helpers-exempt: reopens the same database file to test persistence
  } };
}

test("pause controller resumes at the stored deadline, advances backoff after another limit, and restores timers", async (t) => {
  const temporary = await database(t);
  const clock = fakeClock("2030-01-02T03:04:05.000Z");
  const store = createProviderPauseStore(temporary.db, clock.now);
  const events = [];
  const resumed = [];
  let controller = createProviderPauseController({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    emitEvent: async (event) => events.push(event),
    onResume: async (provider) => resumed.push(provider),
  });
  controller.start();

  const first = await controller.recordRateLimit({ provider: "anthropic", resets_at: "2030-01-02T04:00:00.000Z" });
  assert.equal(first.resume_at, "2030-01-02T04:00:30.000Z");
  assert.equal(controller.isPaused("claude"), true);
  assert.equal(events[0].type, "provider.paused");
  assert.deepEqual(events[0].payload, {
    provider: "anthropic", provider_label: "Anthropic", resume_at: "2030-01-02T04:00:30.000Z",
    resume_source: "reported", reported_resets_at: "2030-01-02T04:00:00.000Z", backoff_step: 0, repeat: false,
  });

  await clock.advance(56 * 60_000 + 25_000);
  assert.equal(store.list()[0].state, "probing");
  assert.equal(controller.isPaused("anthropic"), false);
  assert.deepEqual(resumed, ["anthropic"]);
  assert.equal(events[1].type, "provider.resumed");

  const second = await controller.recordRateLimit({ provider: "claude", resets_at: null });
  assert.equal(second.backoff_step, 1);
  assert.equal(second.resume_at, "2030-01-02T04:30:30.000Z");
  assert.equal(events[2].payload.repeat, true);

  controller.stop();
  temporary.reopen();
  const restoredStore = createProviderPauseStore(temporary.db, clock.now);
  controller = createProviderPauseController({
    store: restoredStore,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    emitEvent: async (event) => events.push(event),
    onResume: async (provider) => resumed.push(provider),
  });
  controller.start();
  assert.equal(clock.pending, 1);
  await clock.advance(30 * 60_000);
  assert.equal(restoredStore.list()[0].state, "probing");
  assert.equal(events.at(-1).type, "provider.resumed");
  assert.deepEqual(resumed, ["anthropic", "anthropic"]);
  controller.stop();
  assert.equal(clock.pending, 0);
});

test("resumeNow probes immediately, clears the timer, and leaves probing, active, and missing providers unchanged", async (t) => {
  const temporary = await database(t);
  const clock = fakeClock("2030-01-02T03:04:05.000Z");
  const store = createProviderPauseStore(temporary.db, clock.now);
  const events = [];
  const resumed = [];
  const controller = createProviderPauseController({ store, now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    emitEvent: async (event) => events.push(event), onResume: async (provider) => resumed.push(provider) });
  t.after(() => controller.stop());
  controller.start();
  await controller.recordRateLimit({ provider: "codex" });
  assert.equal(clock.pending, 1);
  const row = await controller.resumeNow(" OPENAI/CODEX ");
  assert.equal(row.state, "probing");
  assert.equal(row.resume_at, clock.now());
  assert.equal(row.probe_started_at, clock.now());
  assert.equal(clock.pending, 0);
  assert.deepEqual(resumed, ["openai"]);
  assert.equal(events.at(-1).type, "provider.resumed");
  assert.deepEqual(await controller.resumeNow("codex"), row);
  assert.equal(await controller.resumeNow("missing"), null);
  const active = await controller.noteProviderSucceeded("codex", clock.now());
  assert.equal(active.state, "active");
  assert.deepEqual(await controller.resumeNow("openai"), active);
  await clock.advance(15 * 60_000);
  assert.deepEqual(resumed, ["openai"]);
  assert.equal(events.length, 2);
});
