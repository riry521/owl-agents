import assert from "node:assert/strict";
import { test } from "node:test";

import { autoRecoveryLimit } from "../../packages/core/dist/auto-recovery.js";
import { DEFAULT_AUTO_RECOVERY_SETTINGS } from "../../packages/shared/dist/auto-recovery-settings.js";
import { createTestCore } from "../helpers/core.mjs";

// auto_recovery is how many automatic recoveries each reason gets before a Decision is opened.

async function store(db, key, value) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES (?, 'owner:default', '1.0.0', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      key, JSON.stringify(value), now,
    );
  });
}

test("without a stored value the limit is the default and there is no warning", async (t) => {
  const { core, db } = await createTestCore(t);
  const view = await core.getAutoRecoverySettings();
  assert.equal(view.limit, DEFAULT_AUTO_RECOVERY_SETTINGS.limit);
  assert.deepEqual(view.warnings, []);
  assert.equal(autoRecoveryLimit(db, "output_format"), DEFAULT_AUTO_RECOVERY_SETTINGS.limit);
});

test("a saved limit is used, for every integer from 0 to 10, and bad values are not saved", async (t) => {
  const { core, db } = await createTestCore(t);
  assert.equal((await core.setAutoRecoverySettings({ limit: 1 })).limit, 1);
  assert.equal(autoRecoveryLimit(db, "output_format"), 1);
  assert.equal((await core.setAutoRecoverySettings({ limit: 0 })).limit, 0);
  assert.equal((await core.setAutoRecoverySettings({ limit: 10 })).limit, 10);
  for (const bad of [{ limit: 11 }, { limit: -1 }, { limit: 1.5 }, { limit: "2" }, { limit: 1, extra: 1 }, {}, null]) {
    await assert.rejects(core.setAutoRecoverySettings(bad), (error) => error.code === "validation_error", JSON.stringify(bad));
  }
  assert.equal((await core.getAutoRecoverySettings()).limit, 10, "a rejected save changes nothing");
});

test("an invalid stored value falls back to the default and reports a warning", async (t) => {
  const { core, db } = await createTestCore(t);
  await store(db, "auto_recovery", { limit: 99 });
  const view = await core.getAutoRecoverySettings();
  assert.equal(view.limit, DEFAULT_AUTO_RECOVERY_SETTINGS.limit);
  assert.equal(view.warnings.length, 1);
  assert.equal(autoRecoveryLimit(db, "output_format"), DEFAULT_AUTO_RECOVERY_SETTINGS.limit);
});

test("final_auto_continue_limit is read for final_incomplete only while auto_recovery is not stored", async (t) => {
  const { core, db } = await createTestCore(t);
  await store(db, "final_auto_continue_limit", 5);
  assert.equal(autoRecoveryLimit(db, "final_incomplete"), 5);
  assert.equal(autoRecoveryLimit(db, "output_format"), DEFAULT_AUTO_RECOVERY_SETTINGS.limit, "other reasons never read it");
  await core.setAutoRecoverySettings({ limit: 3 });
  assert.equal(autoRecoveryLimit(db, "final_incomplete"), 3);
});
