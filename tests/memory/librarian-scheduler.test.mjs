import assert from "node:assert/strict";
import { test } from "node:test";

import { LibrarianScheduler, nextLibrarianRunAt, parseLibrarianTime } from "../../packages/core/dist/librarian-scheduler.js";

class FakeClock {
  constructor(now) {
    this.value = new Date(now);
    this.timers = new Map();
    this.nextId = 0;
    this.unrefCount = 0;
  }

  now() {
    return new Date(this.value);
  }

  setTimeout(callback, ms) {
    const handle = { id: ++this.nextId, unref: () => { this.unrefCount += 1; } };
    this.timers.set(handle, { callback, at: this.value.getTime() + ms });
    return handle;
  }

  clearTimeout(handle) {
    this.timers.delete(handle);
  }

  async advanceTo(now) {
    const target = new Date(now).getTime();
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.timers.delete(next[0]);
      this.value = new Date(next[1].at);
      next[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.value = new Date(target);
  }
}

test("local time parsing and next run use strict future host-local times", () => {
  assert.deepEqual(parseLibrarianTime("03:05"), { hour: 3, minute: 5 });
  assert.equal(parseLibrarianTime("3:05"), null);
  assert.equal(parseLibrarianTime("24:00"), null);
  const after = new Date(2026, 8, 28, 15, 0, 0);
  assert.equal(nextLibrarianRunAt(["15:00", "03:00"], after)?.getTime(), new Date(2026, 8, 29, 3).getTime());
});

test("scheduler runs at the configured local time and unreferences its timer", async () => {
  const clock = new FakeClock(new Date(2026, 8, 28, 14, 59));
  let runs = 0;
  const scheduler = new LibrarianScheduler({ run: async () => { runs += 1; }, clock, maxTickMs: 60_000 });
  scheduler.start(["15:00"]);

  await clock.advanceTo(new Date(2026, 8, 28, 15, 0));

  assert.equal(runs, 1);
  assert.ok(clock.unrefCount > 0);
  assert.equal(scheduler.nextRunAt()?.getTime(), new Date(2026, 8, 29, 15).getTime());
  await scheduler.stop();
});

test("scheduler reschedule replaces the next local run time", async () => {
  const clock = new FakeClock(new Date(2026, 8, 28, 9, 0));
  const scheduler = new LibrarianScheduler({ run: async () => {}, clock, maxTickMs: 60_000 });
  scheduler.start(["09:30"]);
  assert.equal(scheduler.nextRunAt()?.getTime(), new Date(2026, 8, 28, 9, 30).getTime());

  scheduler.reschedule(["10:30"]);

  assert.equal(scheduler.nextRunAt()?.getTime(), new Date(2026, 8, 28, 10, 30).getTime());
  await scheduler.stop();
});

test("scheduler does not overlap runs and continues after a run failure", async () => {
  const clock = new FakeClock(new Date(2026, 8, 28, 9, 0));
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const warnings = [];
  const scheduler = new LibrarianScheduler({
    run: () => {
      runs += 1;
      if (runs === 1) return pending;
      throw new Error("expected test failure");
    },
    clock,
    maxTickMs: 60_000,
    logger: { warn: (message, error) => warnings.push(`${message} ${error?.message ?? error}`) },
  });
  scheduler.start(["09:01", "09:02"]);
  await clock.advanceTo(new Date(2026, 8, 28, 9, 1));
  await clock.advanceTo(new Date(2026, 8, 28, 9, 2));
  assert.equal(runs, 1);
  release();
  await Promise.resolve();
  await Promise.resolve();
  await clock.advanceTo(new Date(2026, 8, 29, 9, 1));

  assert.equal(runs, 2);
  assert.match(warnings.join("\n"), /expected test failure/u);
  await scheduler.stop();
});

test("stop clears the scheduled run", async () => {
  const clock = new FakeClock(new Date(2026, 8, 28, 9, 0));
  let runs = 0;
  const scheduler = new LibrarianScheduler({ run: async () => { runs += 1; }, clock, maxTickMs: 60_000 });
  scheduler.start(["09:01"]);
  await scheduler.stop();
  await clock.advanceTo(new Date(2026, 8, 28, 9, 2));

  assert.equal(runs, 0);
  assert.equal(scheduler.nextRunAt(), null);
});
