import assert from "node:assert/strict";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

async function setup(t) {
  const { db, root, core } = await createTestCore(t, { agentRunner, version: "settings-test" }, { prefix: "owl-memory-settings-" });
  return { db, root, core };
}

test("a failing memory storage init is logged and recorded without stopping the storage-available flow", async (t) => {
  const { db, core } = await setup(t);
  core.memory.onStorageAvailable = async () => { throw new Error("memory init broke", { cause: "EACCES" }); };
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args.map(String).join(" ")); });

  await core.onKnowledgeStorageAvailable();
  await core.writeLane.transact(() => null); // the alert is written in the background

  assert.ok(warnings.some((line) => line.includes("memory init broke") && line.includes("EACCES")));
  const alert = db.all("SELECT payload_json FROM events WHERE type = 'system.alert'")
    .map((row) => JSON.parse(row.payload_json))
    .find((payload) => payload.kind === "memory_storage_init_failed");
  assert.ok(alert, "an Owner-visible event is recorded");
  assert.equal(alert.message, "memory init broke");
});
