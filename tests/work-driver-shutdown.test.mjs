import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkDriver } from "../packages/core/dist/work-driver.js";

test("shutdown stops scheduling without waiting for an in-flight Work", async () => {
  let finishTick;
  let markTickStarted;
  const tickCompletion = new Promise((resolve) => { finishTick = resolve; });
  const tickStarted = new Promise((resolve) => { markTickStarted = resolve; });
  const driver = new WorkDriver({
    tick: async () => {
      markTickStarted();
      await tickCompletion;
    },
    getState: () => "running",
    onTickError: async () => {},
    tickIntervalMs: 1,
  });

  driver.start(["work-1"]);
  await tickStarted;
  driver.stopScheduling();
  finishTick();
  await driver.stop();
  assert.equal(driver.isStarted(), false);
});

test("a wake during an in-flight tick runs exactly one more tick after it", async () => {
  let ticks = 0;
  let finishFirst;
  let markStarted;
  const firstCompletion = new Promise((resolve) => { finishFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const driver = new WorkDriver({
    tick: async () => {
      ticks += 1;
      if (ticks === 1) {
        markStarted();
        await firstCompletion;
      }
    },
    getState: () => "running",
    onTickError: async () => {},
    tickIntervalMs: 60_000,
  });

  driver.start();
  driver.wake("work-1");
  await firstStarted;
  driver.wake("work-1");
  driver.wake("work-1");
  finishFirst();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ticks, 2);
  await driver.stop();
});

test("a wake after scheduling stopped does nothing", async () => {
  let ticks = 0;
  const driver = new WorkDriver({
    tick: async () => { ticks += 1; },
    getState: () => "running",
    onTickError: async () => {},
    tickIntervalMs: 60_000,
  });

  driver.start();
  driver.stopScheduling();
  driver.wake("work-1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ticks, 0);
});
