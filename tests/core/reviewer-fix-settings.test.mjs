import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewerFixSettings } from "../../packages/core/dist/reviewer-fix.js";
import { DEFAULT_REVIEWER_FIX_SETTINGS } from "../../packages/shared/dist/reviewer-fix-settings.js";
import { createTestCore } from "../helpers/core.mjs";

// reviewer_fix is the size limit (lines and files) of a fix the Reviewer may make itself.

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

test("without a stored value the limits are the defaults (30 lines, 3 files)", async (t) => {
  const { core } = await createTestCore(t);
  assert.deepEqual(await core.getReviewerFixSettings(), DEFAULT_REVIEWER_FIX_SETTINGS);
});

test("a saved value is read back and bad values are not saved", async (t) => {
  const { core, db } = await createTestCore(t);
  assert.deepEqual(await core.setReviewerFixSettings({ max_changed_lines: 0, max_changed_files: 100 }), { max_changed_lines: 0, max_changed_files: 100 });
  assert.deepEqual(reviewerFixSettings(db), { max_changed_lines: 0, max_changed_files: 100 });
  const bad = [
    { max_changed_lines: 1001, max_changed_files: 3 },
    { max_changed_lines: 30, max_changed_files: -1 },
    { max_changed_lines: 1.5, max_changed_files: 3 },
    { max_changed_lines: "30", max_changed_files: 3 },
    { max_changed_lines: 30, max_changed_files: 3, extra: 1 },
    {},
    null,
  ];
  for (const value of bad) {
    await assert.rejects(core.setReviewerFixSettings(value), (error) => error.code === "validation_error", JSON.stringify(value));
  }
  assert.deepEqual(await core.getReviewerFixSettings(), { max_changed_lines: 0, max_changed_files: 100 }, "a rejected save changes nothing");
});

test("an invalid stored value falls back to the default for that key only", async (t) => {
  const { core, db } = await createTestCore(t);
  await store(db, "reviewer_fix", { max_changed_lines: 5000, max_changed_files: 7 });
  assert.deepEqual(await core.getReviewerFixSettings(), { max_changed_lines: 30, max_changed_files: 7 });
});
