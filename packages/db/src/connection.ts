import Database from "better-sqlite3";
import { resolve } from "node:path";
import { runMigrations, type MigrationRunResult } from "./migration-runner";
import { WriteLane } from "./write-lane";

type SqliteValue = string | number | bigint | Buffer | null;

export interface SqlitePragmas {
  readonly journalMode: string;
  readonly busyTimeout: number;
  readonly foreignKeys: number;
}

export class OwlDatabase {
  private readonly handle: Database.Database;
  private readonly writeLane: WriteLane;

  private constructor(handle: Database.Database) {
    this.handle = handle;
    this.writeLane = WriteLane.create(handle);
  }

  public static open(filename: string): OwlDatabase {
    if (filename.trim().length === 0) {
      throw new Error("A SQLite database path is required.");
    }
    const handle = new Database(filename);
    try {
      handle.pragma("journal_mode = WAL");
      handle.pragma("busy_timeout = 5000");
      handle.pragma("foreign_keys = ON");
      const pragmas = readPragmas(handle);
      if (pragmas.journalMode.toLowerCase() !== "wal" || pragmas.busyTimeout !== 5000 || pragmas.foreignKeys !== 1) {
        throw new Error("SQLite connection settings could not be applied.");
      }
      return new OwlDatabase(handle);
    } catch (error) {
      handle.close();
      throw error;
    }
  }

  public migrate(migrationsDirectory: string = resolve(__dirname, "..", "migrations")): MigrationRunResult {
    return runMigrations(this.handle, migrationsDirectory);
  }

  public createWriteLane(): WriteLane {
    return this.writeLane;
  }

  public all<T extends object>(sql: string, ...parameters: SqliteValue[]): T[] {
    return this.handle.prepare(sql).all(...parameters) as T[];
  }

  public get<T extends object>(sql: string, ...parameters: SqliteValue[]): T | undefined {
    return this.handle.prepare(sql).get(...parameters) as T | undefined;
  }

  public pragmas(): SqlitePragmas {
    return readPragmas(this.handle);
  }

  public close(): void {
    this.handle.close();
  }
}

function readPragmas(handle: Database.Database): SqlitePragmas {
  return {
    journalMode: String(handle.pragma("journal_mode", { simple: true })),
    busyTimeout: Number(handle.pragma("busy_timeout", { simple: true })),
    foreignKeys: Number(handle.pragma("foreign_keys", { simple: true })),
  };
}

export function openDatabase(filename: string): OwlDatabase {
  return OwlDatabase.open(filename);
}
