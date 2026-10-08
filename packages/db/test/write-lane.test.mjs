import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../dist/index.js";

const migrations = resolve(import.meta.dirname, "..", "migrations");

function migratedDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), "owl-db-write-lane-"));
  const db = openDatabase(join(dir, "owl.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.migrate(migrations);
  return db;
}

test("a write lane transaction that SQLite already rolled back rejects with the original error and leaves the lane usable", async (t) => {
  const db = migratedDatabase(t);
  const lane = db.createWriteLane();
  await lane.transact((tx) => {
    tx.run("CREATE TABLE guarded (value INTEGER)");
    tx.run("CREATE TRIGGER guarded_reject BEFORE INSERT ON guarded WHEN NEW.value < 0 BEGIN SELECT RAISE(ROLLBACK, 'negative value rejected'); END");
    return null;
  });

  await assert.rejects(
    lane.transact((tx) => {
      tx.run("INSERT INTO guarded (value) VALUES (1)");
      tx.run("INSERT INTO guarded (value) VALUES (-1)");
      return null;
    }),
    /negative value rejected/u,
  );
  await assert.rejects(
    lane.write({
      event: { idempotencyKey: "rollback-check", type: "test.rollback", payload: {} },
      outbox: [],
      mutateState: (tx) => tx.run("INSERT INTO guarded (value) VALUES (-2)"),
    }),
    /negative value rejected/u,
  );

  assert.equal(db.get("SELECT COUNT(*) AS count FROM guarded").count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE idempotency_key = 'rollback-check'").count, 0);
  await lane.transact((tx) => tx.run("INSERT INTO guarded (value) VALUES (2)"));
  assert.equal(db.get("SELECT COUNT(*) AS count FROM guarded").count, 1);
});
