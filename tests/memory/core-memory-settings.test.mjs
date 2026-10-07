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

test("memory settings default to pages mode without creating a row", async (t) => {
  const { db, core } = await setup(t);
  const settings = await core.getMemorySettings();
  assert.equal(settings.mode, "pages");
  assert.equal(db.get("SELECT key FROM settings WHERE key = 'memory_mode'"), undefined);
});

test("memory_folder_kinds is saved, read back and validated; memory_mode is untouched", async (t) => {
  const { db, core } = await setup(t);
  await core.start();
  const rules = { version: 1, rules: [{ glob: "research/**", type: "clipping", links: "optional" }] };
  const saved = await core.setMemoryFolderKinds(rules);
  assert.equal((await core.getMemorySettings()).folder_kinds.rules[0].glob, "research/**");
  assert.deepEqual(saved.folder_kinds, (await core.getMemorySettings()).folder_kinds);
  assert.equal(saved.mode, "pages");
  await assert.rejects(() => core.setMemoryFolderKinds({ version: 1, rules: [{ glob: "x/**", type: "not-a-kind" }] }));
  await assert.rejects(() => core.setMemoryFolderKinds("nonsense"));
  assert.equal((await core.getMemorySettings()).folder_kinds.rules.length, 1, "a rejected value leaves the saved rules");
  assert.equal(db.get("SELECT key FROM settings WHERE key = 'memory_mode'"), undefined);
});

test("a database that stores memory_mode legacy reads as pages and the stored value is left alone", async (t) => {
  const { db, core } = await setup(t);
  await db.createWriteLane().transact((tx) => {
    const now = new Date().toISOString();
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_mode', 'owner:default', '1.0.0', ?, ?)", JSON.stringify("legacy"), now);
  });
  assert.equal((await core.getMemorySettings()).mode, "pages");
  assert.equal(JSON.parse(db.get("SELECT value_json FROM settings WHERE key = 'memory_mode'").value_json), "legacy");
});

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
