import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../../packages/db/dist/index.js";
import { COMPLETED_PROJECT_WORKS_SQL } from "../../packages/core/dist/completed-project-works-query.js";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

test("migration 085 applies to a populated 084 database and both EXISTS in the startup query use the events index", async (t) => {
  const root = await tempDir(t, "owl-events-index-");
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: applies migrations up to 084 first
  t.after(() => db.close());
  const files = (await readdir(migrations)).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(files.includes("085_events_work_type_sequence.sql"));
  const early = join(root, "early");
  await mkdir(early);
  for (const name of files.filter((n) => n < "085")) await copyFile(join(migrations, name), join(early, name));
  db.migrate(early);

  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, created_at)
       VALUES ('e1', 1, 'k1', 'x', NULL, '{}', 'handled', ?)`,
      now,
    );
    return null;
  });

  db.migrate(migrations);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events").n, 1);
  const plan = db.all(`EXPLAIN QUERY PLAN ${COMPLETED_PROJECT_WORKS_SQL}`).map((r) => r.detail);
  const uses = plan.filter((d) => d.includes("idx_events_work_type_sequence"));
  assert.equal(uses.length, 2, plan.join("\n"));
});
