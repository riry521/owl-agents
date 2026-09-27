import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/core.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));

function envelope(payload, key) {
  return {
    request_id: createUlid(),
    idempotency_key: `immediate-shutdown:${key}:${createUlid()}`,
    expected_version: 0,
    payload,
  };
}

function timeoutAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  });
}

test("Core shutdown terminates a Work run without waiting for its provider result", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-immediate-shutdown-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));

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
  const core = new Core({ db, agentRunner, version: "shutdown-test", owlRoot: root, dispatcher: { tick_interval_ms: 5 } });

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
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
