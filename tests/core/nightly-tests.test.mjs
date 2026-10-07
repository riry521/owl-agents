import assert from "node:assert/strict";
import { test } from "node:test";

import { NoopGitGateway } from "../../packages/core/dist/index.js";
import { parseTapFailures } from "../../packages/core/dist/nightly-tests.js";
import { createTestCore } from "../helpers/core.mjs";

class FakeClock {
  constructor(now) {
    this.value = new Date(now);
    this.timers = new Map();
  }
  now() { return new Date(this.value); }
  setTimeout(callback, ms) {
    const handle = {};
    this.timers.set(handle, { callback, at: this.value.getTime() + ms });
    return handle;
  }
  clearTimeout(handle) { this.timers.delete(handle); }
  async advanceTo(now) {
    const target = new Date(now).getTime();
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.timers.delete(next[0]);
      this.value = new Date(next[1].at);
      next[1].callback();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    this.value = new Date(target);
  }
}

const tap = (...names) => names.map((name, i) => `# Subtest: ${name}\nnot ok ${i + 1} - ${name}\n  ---\n  location: '/w/tests/a.test.mjs:3:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    boom\n  ...\n`).join("");
const ok = (failures) => ({ status: "completed", base_commit: "abc", exit_code: failures.length ? 1 : 0, timed_out: false, error: null, failures, output_tail: "" });
const fail = (name) => ({ file: "tests/a.test.mjs", name, line: 3, message: "boom" });

async function setup(t, executor, clock) {
  const { db, core } = await createTestCore(t, {
    git: new NoopGitGateway(),
    version: "nightly-test",
    nightlyTests: { executor, clock },
  }, { prefix: "owl-nightly-", start: true });
  await core.updateNightlyTestSettings({ time: "04:00" });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
       verification_plan_json, worktree_prepare_argv_json, nightly_test_argv_json, created_at, updated_at)
     VALUES (?, 'owner:default', 'P', '/tmp/p', 'main', '[]', '[]', '[]', '["fake","test"]', ?, ?)`,
    "proj1", now, now,
  ));
  return { core, db };
}

test("only failures absent from the previous run are backlogged; fixed ones come back when they fail again", async (t) => {
  const results = [tap("a", "b"), tap("a", "b", "c"), tap("c"), tap("a"), tap("a")];
  const { core, db } = await setup(t, async () => ok(parseTapFailures(results.shift(), "/w")));
  const counts = [];
  for (let i = 0; i < 5; i += 1) counts.push((await core.runNightlyTests())[0].new_failure_count);
  // Run 4: "a" returns after being fixed (its first item is still open). Run 5: still failing, not stacked.
  assert.deepEqual(counts, [2, 1, 0, 1, 0]);
  const items = db.all("SELECT problem, source, work_id FROM backlog_items");
  assert.equal(items.length, 4);
  assert.ok(items.every((item) => item.source === "nightly_test" && item.work_id === null));
});

test("a failure that returns after a passing run is backlogged again without touching the old item", async (t) => {
  const results = [tap("a"), "", tap("a")];
  const { core } = await setup(t, async () => ok(parseTapFailures(results.shift(), "/w")));
  const counts = [];
  for (let i = 0; i < 3; i += 1) counts.push((await core.runNightlyTests())[0].backlog_item_ids.length);
  assert.deepEqual(counts, [1, 0, 1]);
});

test("a failed execution is recorded and Core keeps running; the next run still compares with the last good one", async (t) => {
  const results = [
    () => ok([fail("a")]),
    () => { throw new Error("spawn exploded"); },
    () => ({ ...ok([]), status: "error", error: "spawn fake ENOENT", exit_code: null }),
    () => ({ ...ok([]), status: "error", error: "Timed out after 1000 ms", exit_code: null, timed_out: true }),
    () => ok([fail("a"), fail("b")]),
  ];
  const { core, db } = await setup(t, async () => results.shift()());
  const statuses = [];
  const news = [];
  for (let i = 0; i < 5; i += 1) {
    const [run] = await core.runNightlyTests();
    statuses.push(run.status);
    news.push(run.new_failure_count);
  }
  assert.deepEqual(statuses, ["failed", "error", "error", "error", "failed"]);
  assert.deepEqual(news, [1, 0, 0, 0, 1]);
  assert.match(db.get("SELECT error FROM nightly_test_runs WHERE error LIKE 'Timed out%'").error, /Timed out after 1000 ms/);
  assert.match(db.get("SELECT error FROM nightly_test_runs WHERE error LIKE 'spawn%'").error, /spawn exploded/);
});

test("parseTapFailures reads the failed tests from TAP output", async () => {
  const failures = parseTapFailures(tap("one", "two") + "not ok 3 - skipped # SKIP\n", "/w");
  assert.deepEqual(failures.map((f) => [f.file, f.name, f.line, f.message]), [
    ["tests/a.test.mjs", "one", 3, "boom"],
    ["tests/a.test.mjs", "two", 3, "boom"],
  ]);
});

test("the run happens once at the configured time, and changing the time moves it", async (t) => {
  const clock = new FakeClock("2026-10-04T10:00:00");
  let calls = 0;
  const { core } = await setup(t, async () => { calls += 1; return ok([]); }, clock);
  assert.equal((await core.getNightlyTestSettings()).time, "04:00");
  await clock.advanceTo("2026-10-05T03:59:00");
  assert.equal(calls, 0);
  await clock.advanceTo("2026-10-05T04:01:00");
  assert.equal(calls, 1);
  await clock.advanceTo("2026-10-05T23:00:00");
  assert.equal(calls, 1);

  await core.updateNightlyTestSettings({ time: "23:30" });
  assert.equal((await core.getNightlyTestSettings()).time, "23:30");
  await clock.advanceTo("2026-10-05T23:29:00");
  assert.equal(calls, 1);
  await clock.advanceTo("2026-10-05T23:31:00");
  assert.equal(calls, 1, "already ran today, so the new time must not run it again");
  await clock.advanceTo("2026-10-06T23:31:00");
  assert.equal(calls, 2);
  await assert.rejects(core.updateNightlyTestSettings({ time: "25:00" }));
});
