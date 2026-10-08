import assert from "node:assert/strict";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";

function envelope(payload, key) {
  return command(payload, `immediate-shutdown:${key}:${createUlid()}`);
}

function timeoutAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  });
}

test("Core shutdown terminates a Work run without waiting for its provider result", async (t) => {
  let markWorkerStarted;
  const workerStarted = new Promise((resolvePromise) => { markWorkerStarted = resolvePromise; });
  let cancelRequest = null;
  const neverFinishes = new Promise(() => {});
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("Small Work must skip Manager planning."); },
    runWorker: async () => {
      markWorkerStarted();
      return neverFinishes;
    },
    runReviewer: async () => { throw new Error("Reviewer should not run."); },
    runAdvisor: async () => ({ reply: "" }),
    cancelAgent: async (invocationId, force) => { cancelRequest = { invocationId, force }; },
  };
  const { db, core } = await createTestCore(t, { agentRunner, version: "shutdown-test", dispatcher: { tick_interval_ms: 5 } }, { prefix: "owl-immediate-shutdown-" });

  try {
    await core.start();
    const created = await core.createWork(envelope({
      title: "Keep this request",
      summary: "This persisted task must survive an immediate server shutdown.",
      size: "small",
      project_id: null,
    }, "create"));
    await core.startWork(created.data.work_id, {
      ...envelope({ mode: "small" }, "start"),
      expected_version: created.version,
    });
    await Promise.race([
      workerStarted,
      timeoutAfter(5_000, "Worker did not start"),
    ]);

    await Promise.race([
      core.stop(),
      timeoutAfter(500, "Core waited for the provider result"),
    ]);

    assert.deepEqual(cancelRequest, { invocationId: db.get("SELECT id FROM agent_runs WHERE work_id = ?", created.data.work_id).id, force: true });
    assert.equal(db.get("SELECT summary FROM works WHERE id = ?", created.data.work_id).summary, "This persisted task must survive an immediate server shutdown.");
    assert.equal(db.get("SELECT status FROM tasks WHERE work_id = ?", created.data.work_id).status, "running");
  } finally {
    await core.stop().catch(() => {});
  }
});

test("Core shutdown waits for a running worktree reconcile, even when it fails", async (t) => {
  for (const startCore of [true, false]) {
    await waitsForReconcile(t, startCore);
  }
});

async function waitsForReconcile(t, startCore) {
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("Manager should not run."); },
    runWorker: async () => { throw new Error("Worker should not run."); },
    runReviewer: async () => { throw new Error("Reviewer should not run."); },
    runAdvisor: async () => ({ reply: "" }),
    cancelAgent: async () => {},
  };
  const { core } = await createTestCore(t, { agentRunner, version: "shutdown-test", dispatcher: { tick_interval_ms: 5 } }, { prefix: "owl-shutdown-reconcile-" });
  let markSweepStarted;
  const sweepStarted = new Promise((resolvePromise) => { markSweepStarted = resolvePromise; });
  let sweepFinishedAt = null;

  try {
    if (startCore) await core.start();
    core.workspaceSweeper.sweep = async () => {
      markSweepStarted();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      sweepFinishedAt = Date.now();
      throw new Error("sweep failed");
    };
    const created = await core.createWork(envelope({ title: "Reconcile me", summary: "Reconciled in the background.", size: "small", project_id: null }, "create"));
    // cancelWork purges the workspace itself, so the background reconcile is started directly.
    core.trackWorktreeReconcile(created.data.work_id, "test_reconcile");
    await Promise.race([sweepStarted, timeoutAfter(5_000, "Reconcile did not start")]);
    await core.stop();
    assert.notEqual(sweepFinishedAt, null, `stop() resolved before the reconcile finished (started=${startCore})`);
  } finally {
    await core.stop().catch(() => {});
  }
}

test("Core shutdown waits for background research writes before it drains the write lane", async (t) => {
  const { core } = await createTestCore(t, { version: "shutdown-test" }, { prefix: "owl-shutdown-research-" });
  await core.start();
  const order = [];
  const drain = core.writeLane.drain.bind(core.writeLane);
  core.writeLane.drain = async () => { order.push("drain"); return drain(); };
  core.researchRecorder.idle = async () => { order.push("research_idle"); };
  await core.stop();
  // Other components drain the same lane earlier; only the final drain closes the window.
  assert.deepEqual(order.slice(-2), ["research_idle", "drain"]);
});
