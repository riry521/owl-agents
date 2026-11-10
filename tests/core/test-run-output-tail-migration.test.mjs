import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../../packages/db/dist/index.js";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const now = "2026-01-01T00:00:00.000Z";
const SUFFIX = "_clear_passed_test_run_output.sql";
const big = "x".repeat(200_000);

test("the migration empties output_tail of passed files only, and VACUUM runs once, not at the next start", async (t) => {
  const root = await tempDir(t, "owl-test-run-output-migration-");
  const dbPath = join(root, "owl.db");
  let db = openDatabase(dbPath); // helpers-exempt: the test applies only the early migrations first
  t.after(() => db.close());
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  const target = files.find((name) => name.endsWith(SUFFIX));
  assert.ok(target, "the migration is found by its name suffix");
  const early = join(root, "early");
  await mkdir(early);
  for (const name of files.filter((name) => name < target)) await copyFile(join(migrations, name), join(early, name));
  db.migrate(early);

  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('o', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES ('p', 'o', 'P', '/x', 'main', '[]', '[]', '[]', ?, ?)`, now, now,
    );
    tx.run(
      `INSERT INTO test_runs (id, project_id, scope, mode, commit_sha, status, started_at, finished_at)
       VALUES ('r', 'p', 'baseline', 'full', 'c', 'failed', ?, ?)`, now, now,
    );
    for (const [file, status] of [["p.mjs", "passed"], ["f.mjs", "failed"], ["e.mjs", "error"], ["t.mjs", "timed_out"], ["q.mjs", "passed"]]) {
      tx.run(
        "INSERT INTO test_run_files (run_id, file, status, duration_ms, exit_code, attempts, failures_json, output_tail) VALUES ('r', ?, ?, 7, 1, 2, '[{\"a\":1}]', ?)",
        file, status, big,
      );
    }
    return null;
  });
  const rows = () => db.all("SELECT * FROM test_run_files ORDER BY file").map((r) => ({ ...r }));
  const before = rows();

  db.migrate(migrations);
  const after = rows();
  const expected = before.map((r) => (r.status === "passed" ? { ...r, output_tail: "" } : r));
  assert.deepEqual(after, expected, "only passed rows lose output_tail; every other column and row is unchanged");
  assert.equal(db.get("PRAGMA freelist_count").freelist_count, 0, "VACUUM returned the freed pages");

  await db.createWriteLane().transact((tx) => {
    tx.run("DELETE FROM test_run_files WHERE file = 'f.mjs'");
    return null;
  });
  const freed = db.get("PRAGMA freelist_count").freelist_count;
  assert.ok(freed > 0);
  db.close();
  db = openDatabase(dbPath); // helpers-exempt: reopening the same file imitates a restart
  db.migrate(migrations);
  assert.equal(db.get("PRAGMA freelist_count").freelist_count, freed, "a second start does not VACUUM");
});
