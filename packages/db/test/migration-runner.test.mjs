import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { MigrationError, openDatabase } from "../dist/index.js";

const packageRoot = resolve(import.meta.dirname, "..");
const migrations = join(packageRoot, "migrations");

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "owl-db-migrations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a migration that SQLite rolls back itself fails as a MigrationError that keeps the cause and applies nothing", (t) => {
  const dir = scratchDir(t);
  const migrationsDir = join(dir, "migrations");
  mkdirSync(migrationsDir);
  const first = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()[0];
  copyFileSync(join(migrations, first), join(migrationsDir, first));
  writeFileSync(
    join(migrationsDir, "002_raise_rollback.sql"),
    `CREATE TABLE guarded (value INTEGER);
CREATE TRIGGER guarded_reject BEFORE INSERT ON guarded BEGIN SELECT RAISE(ROLLBACK, 'migration data rejected'); END;
INSERT INTO guarded (value) VALUES (1);
`,
  );

  const db = openDatabase(join(dir, "owl.db"));
  t.after(() => db.close());
  assert.throws(
    () => db.migrate(migrationsDir),
    (error) => error instanceof MigrationError && /migration data rejected/u.test(String(error.cause?.message)),
  );
  assert.equal(db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('guarded', 'schema_migrations')").count, 0);
});

test("owl-db migrate without --migrations-dir applies the package migrations and reports the latest applied version", (t) => {
  const dir = scratchDir(t);
  const database = join(dir, "owl.db");
  const result = spawnSync(process.execPath, [join(packageRoot, "dist/cli.js"), "migrate", "--database", database], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  const versions = readdirSync(migrations).filter((name) => name.endsWith(".sql")).map((name) => name.slice(0, 3)).sort();
  assert.deepEqual(report.applied, versions);
  assert.equal(report.appliedRow.version, versions.at(-1));
});
