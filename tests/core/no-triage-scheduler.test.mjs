import assert from "node:assert/strict";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("Core starts and stops without the retired timer or warning", async (t) => {
  const { core } = await createTestCore(t, { agentRunner }, { prefix: "owl-core-scheduler-" });

  const output = [];
  const intervals = [];
  const originalSetInterval = globalThis.setInterval;
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  const originalStderrWrite = process.stderr.write;
  for (const method of Object.keys(originalConsole)) {
    console[method] = (...args) => {
      output.push(args.map(String).join(" "));
      Reflect.apply(originalConsole[method], console, args);
    };
  }
  process.stderr.write = function (chunk, ...args) {
    output.push(String(chunk));
    return Reflect.apply(originalStderrWrite, this, [chunk, ...args]);
  };
  globalThis.setInterval = function (callback, ...args) {
    intervals.push(callback);
    return Reflect.apply(originalSetInterval, this, [callback, ...args]);
  };

  try {
    await core.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await core.stop({ force: true });
  } finally {
    globalThis.setInterval = originalSetInterval;
    process.stderr.write = originalStderrWrite;
    Object.assign(console, originalConsole);
  }

  assert.doesNotMatch(output.join("\n"), /Conversation triage failed/u);
  assert.equal(intervals.some((callback) => /triage/i.test(String(callback))), false);
  assert.equal(Object.getOwnPropertyNames(core).some((name) => /triage/i.test(name)), false);
});
