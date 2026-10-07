import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createUlid, utcNow } from "./ids";

type SqliteDatabase = Database.Database;

const MIGRATION_FILENAME_PATTERN = /^(\d{3})_[A-Za-z0-9_]+\.sql$/;
const LOCK_LEASE_MS = 30_000;

// Migration 002 was released once with an internal design-document path in a
// SQL comment. The public-tree cleanup changed only that comment, but the raw
// file checksum consequently changed after some databases had already applied
// the migration. Keep the exact pre-cleanup checksum as a narrow compatibility
// alias; arbitrary edits to applied SQL remain rejected.
const MIGRATION_CHECKSUM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "002_advisor_persistent_session.sql": ["35056aa0a3d4c94925b2909230216baf122d7abbaa979519df29aa1d50d4cb0a"],
};

const BOOTSTRAP_LOCK_SQL = `
CREATE TABLE IF NOT EXISTS schema_migration_lock (
  lock_id INTEGER NOT NULL PRIMARY KEY CHECK (lock_id = 1),
  holder_id TEXT NOT NULL CHECK (length(holder_id) BETWEEN 1 AND 128),
  acquired_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  CHECK (lease_expires_at >= acquired_at)
);
INSERT OR IGNORE INTO schema_migration_lock
  (lock_id, holder_id, acquired_at, lease_expires_at)
VALUES (1, 'bootstrap', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
`;

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly checksum: string;
  readonly holderId: string;
}

export class MigrationError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

interface MigrationArtifact {
  readonly version: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

interface MigrationRow {
  readonly version: string;
  readonly filename: string;
  readonly checksum: string;
  readonly status: string;
  readonly applied_at: string | null;
}

interface LockRow {
  readonly lock_id: number;
  readonly holder_id: string;
  readonly acquired_at: string;
  readonly lease_expires_at: string;
}

export function runMigrations(
  database: SqliteDatabase,
  migrationsDirectory: string,
  holderId: string = `${process.pid}:${createUlid()}`,
): MigrationRunResult {
  const artifacts = loadMigrationArtifacts(migrationsDirectory);
  let transactionStarted = false;

  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;

    const hasLockTable = tableExists(database, "schema_migration_lock");
    const hasMigrationsTable = tableExists(database, "schema_migrations");
    if (hasLockTable !== hasMigrationsTable) {
      throw new MigrationError(
        "Migration metadata is incomplete; schema_migrations and schema_migration_lock must exist together.",
      );
    }
    if (!hasLockTable) {
      if (hasMigrationsTable || hasUserTables(database)) {
        throw new MigrationError(
          "Migration metadata is incomplete; schema_migration_lock is missing and startup was refused.",
        );
      }
      database.exec(BOOTSTRAP_LOCK_SQL);
    } else {
      assertLockTableShape(database);
    }

    acquireLock(database, holderId);
    if (hasMigrationsTable) {
      assertSchemaMigrationsShape(database);
    }

    const existingRows = hasMigrationsTable
      ? (database.prepare("SELECT version, filename, checksum, status, applied_at FROM schema_migrations").all() as MigrationRow[])
      : [];
    if (hasMigrationsTable && existingRows.length === 0) {
      throw new MigrationError(
        "schema_migrations exists without an APPLIED migration row; startup was refused.",
      );
    }
    validateExistingRows(existingRows, artifacts);

    const existingByVersion = new Map(existingRows.map((row) => [row.version, row]));
    const applied: string[] = [];
    const skipped: string[] = [];
    let lastChecksum = "";

    for (const artifact of artifacts) {
      const existing = existingByVersion.get(artifact.version);
      if (existing) {
        if (
          existing.filename !== artifact.filename ||
          !checksumMatches(artifact, existing.checksum) ||
          existing.status !== "APPLIED" ||
          existing.applied_at === null
        ) {
          throw new MigrationError(
            "Applied migration identity or status does not match the committed artifact; startup was refused.",
          );
        }
        skipped.push(existing.version);
      } else {
        database.exec(artifact.sql);
        database
          .prepare(
            `INSERT INTO schema_migrations (version, filename, checksum, status, applied_at)
             VALUES (?, ?, ?, 'APPLIED', ?)`,
          )
          .run(artifact.version, artifact.filename, artifact.checksum, utcNow());
        applied.push(artifact.version);
      }

      const appliedRow = database
        .prepare("SELECT version, filename, checksum, status, applied_at FROM schema_migrations WHERE version = ?")
        .get(artifact.version) as MigrationRow | undefined;
      if (
        !appliedRow ||
        appliedRow.filename !== artifact.filename ||
        !checksumMatches(artifact, appliedRow.checksum) ||
        appliedRow.status !== "APPLIED" ||
        appliedRow.applied_at === null
      ) {
        throw new MigrationError("Migration verification failed; startup was refused.");
      }
      lastChecksum = artifact.checksum;
    }

    releaseLock(database, holderId);
    database.exec("COMMIT");
    transactionStarted = false;
    return { applied, skipped, checksum: lastChecksum, holderId };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK");
      transactionStarted = false;
    }
    if (error instanceof MigrationError) {
      throw error;
    }
    throw new MigrationError("Database migration failed; startup was refused.", { cause: error });
  }
}

function checksumMatches(artifact: MigrationArtifact, checksum: string): boolean {
  return checksum === artifact.checksum || MIGRATION_CHECKSUM_ALIASES[artifact.filename]?.includes(checksum) === true;
}

function loadMigrationArtifacts(migrationsDirectory: string): MigrationArtifact[] {
  const directory = resolve(migrationsDirectory);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    throw new MigrationError("Migration directory could not be read; startup was refused.", { cause: error });
  }

  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql"));
  if (sqlFiles.length === 0) {
    throw new MigrationError("Migration directory must contain at least one migration file; startup was refused.");
  }

  const artifacts: MigrationArtifact[] = [];
  const seenVersions = new Set<string>();
  for (const filename of sqlFiles) {
    const match = MIGRATION_FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new MigrationError(
        `Migration filename "${filename}" does not match the required NNN_description.sql pattern; startup was refused.`,
      );
    }
    const version = match[1];
    if (seenVersions.has(version)) {
      throw new MigrationError(`Duplicate migration version "${version}" was found; startup was refused.`);
    }
    seenVersions.add(version);

    const filePath = join(directory, filename);
    if (!statSync(filePath).isFile()) {
      throw new MigrationError("Migration artifact is not a regular file; startup was refused.");
    }
    const sql = readFileSync(filePath, "utf8");
    const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
    artifacts.push({ version, filename, sql, checksum });
  }

  artifacts.sort((a, b) => a.version.localeCompare(b.version));
  for (const [index, artifact] of artifacts.entries()) {
    const expectedVersion = String(index + 1).padStart(3, "0");
    if (artifact.version !== expectedVersion) {
      throw new MigrationError(
        `Migration versions must be contiguous starting at 001; expected "${expectedVersion}" but found "${artifact.version}"; startup was refused.`,
      );
    }
  }

  return artifacts;
}

function tableExists(database: SqliteDatabase, tableName: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { present: number } | undefined;
  return row?.present === 1;
}

function hasUserTables(database: SqliteDatabase): boolean {
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.length > 0;
}

function assertSchemaMigrationsShape(database: SqliteDatabase): void {
  const columns = database.pragma("table_info('schema_migrations')") as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const name of ["version", "filename", "checksum", "status", "applied_at"]) {
    if (!byName.has(name)) {
      throw new MigrationError("schema_migrations shape is not the canonical contract; startup was refused.");
    }
  }
  if (byName.get("applied_at")?.notnull !== 1 || byName.get("status")?.notnull !== 1) {
    throw new MigrationError("schema_migrations requires applied_at and status to be NOT NULL; startup was refused.");
  }
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { sql: string | null } | undefined;
  if (!table?.sql || !/status\s*=\s*'APPLIED'/i.test(table.sql)) {
    throw new MigrationError("schema_migrations must allow only status='APPLIED'; startup was refused.");
  }
}

function assertLockTableShape(database: SqliteDatabase): void {
  const columns = database.pragma("table_info('schema_migration_lock')") as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const names = new Set(columns.map((column) => column.name));
  for (const name of ["lock_id", "holder_id", "acquired_at", "lease_expires_at"]) {
    if (!names.has(name)) {
      throw new MigrationError("schema_migration_lock shape is not the canonical contract; startup was refused.");
    }
  }
  if (
    columns.length !== 4 ||
    columns.some((column) => column.notnull !== 1) ||
    columns.find((column) => column.name === "lock_id")?.pk !== 1
  ) {
    throw new MigrationError("schema_migration_lock shape is not the canonical contract; startup was refused.");
  }
  const row = database
    .prepare("SELECT lock_id, holder_id, acquired_at, lease_expires_at FROM schema_migration_lock WHERE lock_id = 1")
    .get() as LockRow | undefined;
  const count = database.prepare("SELECT COUNT(*) AS count FROM schema_migration_lock").get() as { count: number };
  if (!row || count.count !== 1) {
    throw new MigrationError("schema_migration_lock must contain exactly lock_id=1; startup was refused.");
  }
}

function acquireLock(database: SqliteDatabase, holderId: string): void {
  if (holderId.length < 1 || holderId.length > 128) {
    throw new MigrationError("Migration lock holder identity is invalid; startup was refused.");
  }
  const lock = database
    .prepare("SELECT lock_id, holder_id, acquired_at, lease_expires_at FROM schema_migration_lock WHERE lock_id = 1")
    .get() as LockRow | undefined;
  if (!lock) {
    throw new MigrationError("Migration lock row is missing; startup was refused.");
  }
  const now = utcNow();
  const acquiredAt = Date.parse(lock.acquired_at);
  const leaseExpiresAtMs = Date.parse(lock.lease_expires_at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs < acquiredAt) {
    throw new MigrationError("Migration lock timestamps are invalid; startup was refused.");
  }
  const leaseExpiresAt = new Date(Date.now() + LOCK_LEASE_MS).toISOString();
  const leaseIsActive = Date.parse(lock.lease_expires_at) > nowMs;
  if (leaseIsActive && lock.holder_id !== holderId) {
    throw new MigrationError("Another process holds the migration lock; startup was refused.");
  }
  const result = database
    .prepare(
      `UPDATE schema_migration_lock
       SET holder_id = ?, acquired_at = ?, lease_expires_at = ?
       WHERE lock_id = 1 AND (lease_expires_at <= ? OR holder_id = ?)`,
    )
    .run(holderId, now, leaseExpiresAt, now, holderId);
  if (result.changes !== 1) {
    throw new MigrationError("Migration lock acquisition failed; startup was refused.");
  }
}

function releaseLock(database: SqliteDatabase, holderId: string): void {
  const result = database
    .prepare(
      `UPDATE schema_migration_lock
       SET lease_expires_at = acquired_at
       WHERE lock_id = 1 AND holder_id = ?`,
    )
    .run(holderId);
  if (result.changes !== 1) {
    throw new MigrationError("Migration lock release failed; startup was refused.");
  }
}

function validateExistingRows(rows: readonly MigrationRow[], artifacts: readonly MigrationArtifact[]): void {
  const knownVersions = new Set(artifacts.map((artifact) => artifact.version));
  for (const row of rows) {
    if (row.status !== "APPLIED" || row.applied_at === null) {
      throw new MigrationError("schema_migrations contains a non-APPLIED or NULL-applied row; startup was refused.");
    }
    if (!knownVersions.has(row.version)) {
      throw new MigrationError("Unknown migration version is recorded; startup was refused.");
    }
  }
}
