import assert from "node:assert/strict";
import { test } from "node:test";
import { createViewStore } from "../../apps/web/lib/view-store.mjs";
import { viewKeysForEvent } from "../../apps/web/lib/view-events.mjs";

function harness(options = {}) {
  let time = 1_000;
  const timers = new Map();
  let nextTimer = 1;
  const store = createViewStore({
    now: () => time,
    setTimer: (fn, ms) => {
      timers.set(nextTimer, { fn, due: time + ms });
      return nextTimer++;
    },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });
  return {
    store,
    timers,
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= time) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function counter(data = { n: 1 }) {
  const fetcher = async () => {
    fetcher.calls += 1;
    return { kind: "fresh", value: { data, version: 1, etag: `"e${fetcher.calls}"` } };
  };
  fetcher.calls = 0;
  return fetcher;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("2 回目の購読でキャッシュがすぐ渡り、staleMs 内は取り直さない", async () => {
  const { store, advance } = harness();
  const fetcher = counter();
  const off = store.subscribe("k", () => {});
  await store.load("k", fetcher, { staleMs: 100 });
  off();
  const seen = [];
  store.subscribe("k", (entry) => seen.push(entry));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].data, { n: 1 });
  await store.load("k", fetcher, { staleMs: 100 });
  assert.equal(fetcher.calls, 1);
  advance(150);
  await store.load("k", fetcher, { staleMs: 100 });
  assert.equal(fetcher.calls, 2);
});

test("not_modified は data を保って取得時刻だけ更新し、失敗でも data は消えない", async () => {
  const { store, advance } = harness();
  store.subscribe("k", () => {});
  await store.load("k", counter({ n: 7 }), { staleMs: 0 });
  const before = store.read("k");
  advance(50);
  await store.load("k", async () => ({ kind: "not_modified" }), { staleMs: 0 });
  const kept = store.read("k");
  assert.deepEqual(kept.data, before.data);
  assert.ok(kept.fetchedAt > before.fetchedAt);
  const failure = new Error("boom");
  await store.load("k", async () => { throw failure; }, { staleMs: 0 });
  const failed = store.read("k");
  assert.deepEqual(failed.data, before.data);
  assert.equal(failed.error, failure);
});

test("invalidate は束ねられ、取得中の invalidate は完了後に 1 回だけ追加で走る", async () => {
  const { store } = harness();
  const fetcher = counter();
  store.subscribe("k", () => {});
  await store.load("k", fetcher);
  for (let i = 0; i < 10; i += 1) store.invalidate(["k"]);
  await store.flush();
  assert.equal(fetcher.calls, 2);

  let release;
  const slow = counter();
  const gated = () => new Promise((resolve) => { release = () => resolve(slow()); });
  store.subscribe("g", () => {});
  const first = store.load("g", gated, { staleMs: 0 });
  store.invalidate(["g"]);
  store.invalidate(["g"]);
  const flushed = store.flush();
  await settle();
  release();
  await settle();
  release();
  await Promise.all([first, flushed]);
  assert.equal(slow.calls, 2);
});

test("最長待ちを越えたら連続中でも取り直し、購読者がいないキーは取り直さない", async () => {
  const { store, advance } = harness({ coalesceMs: 100, coalesceMaxWaitMs: 250 });
  const fetcher = counter();
  store.subscribe("k", () => {});
  await store.load("k", fetcher);
  for (let i = 0; i < 5; i += 1) {
    advance(80);
    store.invalidate(["k"]);
  }
  await settle();
  assert.equal(fetcher.calls, 2);

  const idle = counter();
  const off = store.subscribe("idle", () => {});
  await store.load("idle", idle);
  off();
  store.invalidate(["idle"]);
  await store.flush();
  assert.equal(idle.calls, 1);
});

test("待ち時間・保持時間・定期取得の間隔は引数で変えられる", async () => {
  const { store, timers, advance } = harness({ coalesceMs: 5, cacheTtlMs: 20, refreshMs: 40 });
  const fetcher = counter();
  const off = store.subscribe("k", () => {});
  await store.load("k", fetcher);
  store.invalidate(["k"]);
  advance(4);
  assert.equal(fetcher.calls, 1);
  advance(1);
  await settle();
  assert.equal(fetcher.calls, 2);

  store.setPolling("k");
  advance(40);
  await settle();
  assert.equal(fetcher.calls, 3);

  off();
  assert.equal(timers.size, 1);
  advance(20);
  assert.equal(store.read("k"), undefined);
});

test("viewKeysForEvent は表示中のキーのうち関係するものだけを返す", () => {
  const mounted = [
    "board", "archive", "work:w1", "work:w2", "work-designs:w1", "work-core-activity:w1", "work-core-activity:w2", "decision:d1", "events", "agents",
    "advisor-session:c1", "advisor-messages:c1", "advisor-session:c2", "provider-pauses", "settings", "tokens:7d",
  ];
  const keys = (frame) => viewKeysForEvent({ payload: {}, work_id: null, ...frame }, mounted);
  const work = keys({ type: "work.updated", work_id: "w1" });
  assert.ok(["board", "archive", "work:w1", "work-designs:w1", "events"].every((k) => work.includes(k)));
  assert.ok(!work.includes("work:w2"));
  for (const type of ["work.core_activity_started", "work.core_activity_completed"]) {
    const core = keys({ type, work_id: "w1" });
    assert.ok(core.includes("work-core-activity:w1") && core.includes("work:w1"), type);
    assert.ok(!core.includes("work-core-activity:w2"), type);
  }
  const decision = keys({ type: "decision.opened", work_id: "w2", payload: { decision_id: "d1" } });
  assert.ok(["board", "work:w2", "decision:d1"].every((k) => decision.includes(k)));
  const withConversation = keys({ type: "message.posted", work_id: "w1", payload: { conversation_id: "c1" } });
  assert.ok(["advisor-session:c1", "advisor-messages:c1", "work:w1"].every((k) => withConversation.includes(k)));
  assert.ok(!withConversation.includes("advisor-session:c2"));
  const withoutConversation = keys({ type: "message.posted", work_id: "w1" });
  assert.ok(["advisor-session:c1", "advisor-session:c2", "advisor-messages:c1", "work:w1"].every((k) => withoutConversation.includes(k)));
  assert.ok(keys({ type: "agent.started", work_id: "w1" }).includes("agents"));
  assert.ok(!keys({ type: "agent.started" }).includes("agents"));
  assert.deepEqual(keys({ type: "provider.paused" }).sort(), ["events", "provider-pauses", "settings"]);
  assert.deepEqual(keys({ type: "settings.model_updated" }).sort(), ["events", "settings"]);
  assert.deepEqual(keys({ type: "unknown.thing" }), ["events"]);
});
