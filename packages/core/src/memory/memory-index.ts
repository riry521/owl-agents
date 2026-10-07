import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import Database from "better-sqlite3";

import { bodyOf, bodySha256, PAGE_KINDS, parsePage, validatePage, estimatePageTokens, themeTitleKey, PAGE_LIMITS, type PageIssue, type StoredKind } from "./page-format.js";
import { parseMemoryNote, normalizeVaultPath, memoryIdForPath } from "./memory-note-reader.js";
import { CHUNKS_DDL, embedPending, hasVectors, knn, loadVec, removeVectors } from "./memory-vectors.js";
import type { Embedder, RetrievalProfile } from "./embedder.js";
import { type MemoryLogger, type MemoryNoteRow, type MemoryStoragePort, type PageQuery, type PageRow, type PageType, rawPathPrefixes } from "./memory-types.js";

export const MEMORY_INDEX_FILE = "memory-index.sqlite";
export const MEMORY_INDEX_SCHEMA_VERSION = 2;
/** Last day each page was opened; kept apart from `notes` so a replaced note row does not lose it. */
const PAGE_OPENS_DDL = "CREATE TABLE IF NOT EXISTS page_opens (path TEXT PRIMARY KEY, last_opened TEXT NOT NULL)";
const MARKER_FILE = ".owl-knowledge";
const BODY_LIMIT_CHARS = 200_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BATCH = 200;
const MAX_CORRUPT_FILES = 3;

export interface MemoryIndexOptions {
  readonly dataDir: string;
  readonly storage: MemoryStoragePort;
  readonly now?: () => Date;
  readonly notifyDebounceMs?: number;
  readonly watchDebounceMs?: number;
  readonly scanIntervalMs?: number;
  readonly watch?: boolean;
  readonly logger?: MemoryLogger;
  /** Called after every scan; the service uses it to embed what changed. */
  readonly onScanned?: () => void;
}

export interface MemoryScanResult {
  readonly mode: "diff" | "full";
  readonly scanned: number; readonly added: number; readonly updated: number;
  readonly removed: number; readonly unchanged: number; readonly duration_ms: number;
  readonly errors: readonly { path: string; message: string }[];
}

export interface MemoryIndexStatus {
  readonly notes: number; readonly by_type: Record<string, number>; readonly by_folder: Record<string, number>;
  readonly invalid: number; readonly invalid_reasons: Record<string, number>;
  readonly invalid_notes: readonly { path: string; reasons: readonly string[] }[]; readonly unresolved_links: number;
  readonly built_at: string | null; readonly last_scan_at: string | null;
  readonly storage_snapshot_at: string | null;
  /** The storage is disconnected or the latest scan failed. */
  readonly stale: boolean;
  readonly rebuilding: boolean;
  readonly watcher: "watching" | "polling" | "stopped";
  readonly last_error: string | null;
  /** sqlite-vec failed to load: search answers from FTS only. */
  readonly vec_error: string | null;
}

const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE notes (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, title TEXT NOT NULL,
  type TEXT NOT NULL, type_source TEXT NOT NULL CHECK (type_source IN ('frontmatter','inferred')),
  status TEXT NOT NULL DEFAULT 'active', summary TEXT NOT NULL DEFAULT '', summary_source TEXT NOT NULL DEFAULT 'derived',
  importance INTEGER NOT NULL DEFAULT 3, confidence TEXT, scope TEXT NOT NULL DEFAULT 'global',
  project_ids_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]', tags_text TEXT NOT NULL DEFAULT '',
  origin_by TEXT, origin_at TEXT, origin_ref TEXT, created TEXT, updated TEXT, superseded_by TEXT,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  mtime INTEGER NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  body TEXT NOT NULL, valid INTEGER NOT NULL, invalid_reasons_json TEXT NOT NULL DEFAULT '[]', indexed_at TEXT NOT NULL,
  page_type TEXT NOT NULL, page_type_source TEXT NOT NULL CHECK (page_type_source IN ('frontmatter','folder','default')),
  body_sha256 TEXT NOT NULL, integrated_hash TEXT, integrated_at TEXT, token_estimate INTEGER NOT NULL,
  template_valid INTEGER, template_errors_json TEXT NOT NULL DEFAULT '[]', template_warnings_json TEXT NOT NULL DEFAULT '[]',
  links_optional INTEGER NOT NULL DEFAULT 0,
  page_scope TEXT, page_project_id TEXT, related_projects_json TEXT NOT NULL DEFAULT '[]', title_key TEXT, merged_into TEXT,
  source_hash TEXT, generated_at TEXT, owl_new_count INTEGER NOT NULL DEFAULT 0,
  work_id TEXT, work_number INTEGER, source_url TEXT, retrieved_at TEXT
);
CREATE INDEX notes_page ON notes(page_type, page_scope, page_project_id, status);
CREATE INDEX notes_page_type ON notes(page_type, status);
CREATE INDEX notes_filename ON notes(filename);
CREATE INDEX notes_type_status ON notes(type, status);
CREATE INDEX notes_updated ON notes(updated);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, summary, tags, body, tokenize='trigram');
CREATE TABLE links (
  src_rowid INTEGER NOT NULL, raw TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('ulid','path','filename')),
  dst_filename TEXT, dst_rowid INTEGER, PRIMARY KEY (src_rowid, raw)
);
CREATE INDEX links_dst ON links(dst_rowid);
`;

const fold = (text: string): string => text.normalize("NFKC");
const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
const isCorrupt = (error: unknown): boolean => /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database/iu.test(`${(error as { code?: string })?.code ?? ""} ${(error as Error)?.message ?? ""}`);

type NoteDbRow = Record<string, string | number | null>;

function toNoteRow(r: NoteDbRow): MemoryNoteRow {
  return {
    id: r.id as string, path: r.path as string, filename: r.filename as string, title: r.title as string,
    type: r.type as MemoryNoteRow["type"], type_source: r.type_source as MemoryNoteRow["type_source"],
    status: r.status as MemoryNoteRow["status"], summary: r.summary as string, summary_source: r.summary_source as MemoryNoteRow["summary_source"],
    importance: r.importance as number, confidence: r.confidence as string | null, scope: r.scope as MemoryNoteRow["scope"],
    project_ids: JSON.parse(r.project_ids_json as string) as string[], tags: JSON.parse(r.tags_json as string) as string[],
    origin_by: r.origin_by as string | null, origin_at: r.origin_at as string | null, origin_ref: r.origin_ref as string | null,
    created: r.created as string | null, updated: r.updated as string | null,
    mtime: r.mtime as number, sha256: r.sha256 as string, size_bytes: r.size_bytes as number,
    valid: r.valid === 1, invalid_reasons: JSON.parse(r.invalid_reasons_json as string) as string[], superseded_by: r.superseded_by as string | null,
  };
}

function toPageRow(r: NoteDbRow): PageRow {
  return {
    rowid: r.rowid as number, path: r.path as string, filename: r.filename as string, title: r.title as string,
    page_type: r.page_type as StoredKind, page_scope: r.page_scope as PageRow["page_scope"], project_id: r.page_project_id as string | null,
    related_projects: JSON.parse(r.related_projects_json as string) as string[], status: r.status as string, summary: r.summary as string,
    merged_into: r.merged_into as string | null, body_sha256: r.body_sha256 as string, integrated_hash: r.integrated_hash as string | null,
    integrated_at: r.integrated_at as string | null, source_hash: r.source_hash as string | null, generated_at: r.generated_at as string | null,
    token_estimate: r.token_estimate as number, owl_new_count: r.owl_new_count as number,
    template_valid: r.template_valid === null ? null : r.template_valid === 1, template_errors: JSON.parse(r.template_errors_json as string) as PageIssue[],
    work_id: r.work_id as string | null, work_number: r.work_number as number | null, source_url: r.source_url as string | null,
    retrieved_at: r.retrieved_at as string | null, updated: r.updated as string | null, mtime: r.mtime as number,
  };
}

function createSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 3000");
  db.pragma("foreign_keys = OFF");
  db.exec(DDL);
  db.exec(CHUNKS_DDL);
  db.exec(PAGE_OPENS_DDL);
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(MEMORY_INDEX_SCHEMA_VERSION));
}

export function setMeta(db: Database.Database, key: string, value: string | null): void {
  if (value === null) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  else db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getMeta(db: Database.Database, key: string): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}

interface FileInfo { abs: string; mtime: number; size: number }

async function walk(root: string, dir: string, out: Map<string, FileInfo>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, abs, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const info = await lstat(abs);
      out.set(normalizeVaultPath(relative(root, abs)), { abs, mtime: Math.floor(info.mtimeMs), size: info.size });
    }
  }
}

export class MemoryIndex {
  private readonly options: MemoryIndexOptions;
  private database: Database.Database | null = null;
  private running: Promise<MemoryScanResult> | null = null;
  private initialScan: Promise<void> | null = null;
  private dirty = false;
  private rebuilding = false;
  private stopped = true;
  private lastError: string | null = null;
  private lastScanFailed = false;
  private watcher: FSWatcher | null = null;
  private watcherState: "watching" | "polling" | "stopped" = "stopped";
  private notifyTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;

  public constructor(options: MemoryIndexOptions) {
    this.options = options;
  }

  private get indexPath(): string {
    return join(this.options.dataDir, MEMORY_INDEX_FILE);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Creates the index, or opens it and renames it to `.corrupt-<ts>` when it is broken or has another schema_version. */
  public open(): void {
    if (this.database) return;
    mkdirSync(this.options.dataDir, { recursive: true });
    if (existsSync(this.indexPath)) {
      try {
        const db = new Database(this.indexPath);
        try {
          db.pragma("journal_mode = WAL");
          db.pragma("synchronous = NORMAL");
          db.pragma("busy_timeout = 3000");
          const ok = db.pragma("quick_check", { simple: true });
          if (ok !== "ok") throw new Error(`quick_check: ${String(ok)}`);
          if (getMeta(db, "schema_version") !== String(MEMORY_INDEX_SCHEMA_VERSION)) throw new Error("schema_version mismatch");
          db.prepare("SELECT count(*) FROM notes_fts").get();
          db.exec(CHUNKS_DDL);
          db.exec(PAGE_OPENS_DDL);
          this.attach(db);
          return;
        } catch (error) {
          db.close();
          throw error;
        }
      } catch (error) {
        this.quarantine(error);
      }
    }
    const db = new Database(this.indexPath);
    createSchema(db);
    this.attach(db);
  }

  private vecError: string | null = null;

  private attach(db: Database.Database): void {
    this.vecError = loadVec(db);
    if (this.vecError) this.options.logger?.warn(`sqlite-vec unavailable; search uses FTS only: ${this.vecError}`);
    this.database = db;
  }

  public hasVectors(): boolean { return this.vecError === null && hasVectors(this.db()); }
  public nearest(query: Float32Array): { body: number[]; head: number[]; similarity: Map<number, number> } { return knn(this.db(), query); }
  public embedPending(embedder: Embedder, profile: RetrievalProfile, meta: Record<string, string>): Promise<number> {
    if (this.vecError) return Promise.reject(new Error(`sqlite-vec unavailable: ${this.vecError}`));
    return embedPending(this.db(), embedder, profile, meta, (key, value) => setMeta(this.db(), key, value));
  }

  private quarantine(reason: unknown): void {
    this.database?.close();
    this.database = null;
    const suffix = `.corrupt-${stamp(this.now())}`;
    for (const extra of ["", "-wal", "-shm"]) {
      if (existsSync(this.indexPath + extra)) renameSync(this.indexPath + extra, this.indexPath + extra + suffix);
    }
    this.lastError = `index rebuilt: ${(reason as Error)?.message ?? String(reason)}`;
    this.options.logger?.warn(`memory index moved to ${suffix} and will be rebuilt`, reason);
    const old = readdirSync(this.options.dataDir).filter((name) => name.startsWith(`${MEMORY_INDEX_FILE}.corrupt-`) && !/-(?:wal|shm)\.corrupt-|\.corrupt-.*-(?:wal|shm)$/u.test(name)).sort();
    for (const name of old.slice(0, Math.max(0, old.length - MAX_CORRUPT_FILES))) {
      for (const extra of ["", "-wal", "-shm"]) rmSync(join(this.options.dataDir, name) + extra, { force: true });
    }
  }

  public db(): Database.Database {
    if (!this.database) this.open();
    return this.database as Database.Database;
  }

  public async start(): Promise<void> {
    this.open();
    this.stopped = false;
    // The first scan runs in the background so Core start-up is not delayed; searches fall back to the vault walk until it finishes.
    if (this.options.storage.isAvailable()) {
      this.initialScan = this.onStorageAvailable().catch((error) => this.options.logger?.warn("memory index initial scan failed", error));
    }
    this.intervalTimer = setInterval(() => this.notifyChanged(), this.options.scanIntervalMs ?? 3_000);
    this.intervalTimer.unref();
  }

  /** Resolves once the first background scan (started by start()) has finished; rejects when it failed, so stale rows are never served as current. */
  public async whenScanned(): Promise<void> {
    await this.initialScan;
    if (this.lastScanFailed) throw new Error(`memory index scan failed: ${this.lastError ?? "unknown"}`);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.notifyTimer, this.watchTimer, this.intervalTimer]) if (timer) clearTimeout(timer);
    this.notifyTimer = this.watchTimer = this.intervalTimer = null;
    this.closeWatcher();
    await this.initialScan;
    await this.running?.catch(() => undefined);
    this.database?.close();
    this.database = null;
  }

  /** Debounced diff scan. Paths are accepted for API compatibility; the scan always stats the whole vault. */
  public notifyChanged(_paths?: readonly string[]): void {
    if (this.stopped) return;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.refreshChanged().catch((error) => this.options.logger?.warn("memory index scan failed", error));
    }, this.options.notifyDebounceMs ?? 300);
    this.notifyTimer.unref();
  }

  public refreshChanged(): Promise<MemoryScanResult> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    const run = this.scanLoop().finally(() => { if (this.running === run) this.running = null; });
    this.running = run;
    return run;
  }

  private async scanLoop(): Promise<MemoryScanResult> {
    let result: MemoryScanResult;
    do {
      this.dirty = false;
      result = await this.scanOnce();
    } while (this.dirty && !this.stopped);
    return result;
  }

  private emptyResult(mode: "diff" | "full"): MemoryScanResult {
    return { mode, scanned: 0, added: 0, updated: 0, removed: 0, unchanged: 0, duration_ms: 0, errors: [] };
  }

  private async scanOnce(): Promise<MemoryScanResult> {
    if (!this.options.storage.isAvailable()) return this.emptyResult("diff");
    try {
      const result = await this.scanInto(this.db(), "diff");
      this.lastScanFailed = false;
      this.lastError = null;
      return result;
    } catch (error) {
      if (isCorrupt(error)) {
        this.quarantine(error);
        this.open();
        return this.scanInto(this.db(), "full");
      }
      this.lastScanFailed = true;
      this.lastError = (error as Error).message;
      this.options.logger?.warn("memory index scan failed", error);
      return { ...this.emptyResult("diff"), errors: [{ path: "", message: (error as Error).message }] };
    }
  }

  /** Brings `db` in line with the vault: stat everything, re-read what changed, drop what vanished. */
  private async scanInto(db: Database.Database, mode: "diff" | "full"): Promise<MemoryScanResult> {
    const started = Date.now();
    const storage = this.options.storage;
    const result = { added: 0, updated: 0, removed: 0, unchanged: 0, scanned: 0 };
    const errors: { path: string; message: string }[] = [];
    const markerId = await this.readMoveId(storage);
    const dir = await storage.withRead(async () => {
      const root = storage.activeDir();
      const files = new Map<string, FileInfo>();
      await walk(root, root, files);
      result.scanned = files.size;
      const known = new Map<string, { rowid: number; mtime: number; size_bytes: number; sha256: string }>();
      for (const row of db.prepare("SELECT rowid, path, mtime, size_bytes, sha256 FROM notes").all() as { rowid: number; path: string; mtime: number; size_bytes: number; sha256: string }[]) known.set(row.path, row);

      // Rows typed by the old folder rules are read again once ("folder_kinds_hash" is only a marker now).
      const force = getMeta(db, "folder_kinds_hash") !== "none";
      const upserts: { rowid: number | null; parsed: ReturnType<typeof parseMemoryNote>; mtime: number; sha: string; size: number; page: PageColumns }[] = [];
      const touch: { rowid: number; mtime: number }[] = [];
      for (const [path, info] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const old = known.get(path);
        if (!force && old && old.mtime === info.mtime && old.size_bytes === info.size) { result.unchanged += 1; continue; }
        try {
          let content = "";
          let sha = "too_large";
          if (info.size <= MAX_FILE_BYTES) {
            const data = await readFile(info.abs);
            sha = sha256(data);
            if (!force && old && old.sha256 === sha) { touch.push({ rowid: old.rowid, mtime: info.mtime }); result.unchanged += 1; continue; }
            content = data.toString("utf8");
          }
          const parsed = parseMemoryNote(path, content, { mtimeMs: info.mtime });
          upserts.push({ rowid: old?.rowid ?? null, parsed, mtime: info.mtime, sha, size: info.size, page: pageColumns(path, content) });
          if (old) result.updated += 1; else result.added += 1;
        } catch (error) {
          errors.push({ path, message: (error as Error).message });
        }
      }
      const removed = [...known].filter(([path]) => !files.has(path)).map(([, row]) => row.rowid);
      result.removed = removed.length;

      const write = db.transaction(() => {
        for (const rowid of removed) removeNote(db, rowid);
        for (const t of touch) db.prepare("UPDATE notes SET mtime = ? WHERE rowid = ?").run(t.mtime, t.rowid);
      });
      write();
      for (let i = 0; i < upserts.length; i += BATCH) {
        db.transaction(() => { for (const u of upserts.slice(i, i + BATCH)) upsertNote(db, u, this.now().toISOString()); })();
      }
      if (result.added + result.updated + result.removed > 0 || mode === "full") resolveLinks(db);
      return root;
    });
    const nowIso = this.now().toISOString();
    setMeta(db, "folder_kinds_hash", "none");
    setMeta(db, "last_scan_at", nowIso);
    if (!getMeta(db, "built_at")) setMeta(db, "built_at", nowIso);
    setMeta(db, "move_id", markerId);
    setMeta(db, "storage_dir", await realpath(dir).catch(() => dir));
    this.options.onScanned?.();
    return { mode, ...result, duration_ms: Date.now() - started, errors };
  }

  private async readMoveId(storage: MemoryStoragePort): Promise<string> {
    try {
      const marker = JSON.parse(await readFile(join(storage.activeDir(), MARKER_FILE), "utf8")) as { move_id?: unknown };
      return typeof marker.move_id === "string" ? marker.move_id : "none";
    } catch {
      return "none";
    }
  }

  /** Builds a fresh index beside the live one and swaps it in; searches keep answering from the old one meanwhile. */
  public async rebuild(reason: string): Promise<MemoryScanResult> {
    if (!this.options.storage.isAvailable()) throw new Error("memory index rebuild needs the knowledge storage");
    this.rebuilding = true;
    try {
      await this.running?.catch(() => undefined);
      const tempPath = `${this.indexPath}.rebuild-${stamp(this.now())}`;
      for (const extra of ["", "-wal", "-shm"]) rmSync(tempPath + extra, { force: true });
      const fresh = new Database(tempPath);
      let result: MemoryScanResult;
      try {
        createSchema(fresh);
        result = await this.scanInto(fresh, "full");
        const opens = this.database?.prepare("SELECT path, last_opened FROM page_opens").all() as { path: string; last_opened: string }[] | undefined;
        const keep = fresh.prepare("INSERT OR REPLACE INTO page_opens(path, last_opened) VALUES (?, ?)");
        for (const row of opens ?? []) keep.run(row.path, row.last_opened);
        fresh.pragma("wal_checkpoint(TRUNCATE)");
      } catch (error) {
        fresh.close();
        for (const extra of ["", "-wal", "-shm"]) rmSync(tempPath + extra, { force: true });
        throw error;
      }
      fresh.close();
      this.database?.close();
      this.database = null;
      for (const extra of ["-wal", "-shm"]) rmSync(this.indexPath + extra, { force: true });
      renameSync(tempPath, this.indexPath);
      for (const extra of ["-wal", "-shm"]) rmSync(tempPath + extra, { force: true });
      this.open();
      this.lastError = null;
      this.lastScanFailed = false;
      this.options.logger?.info?.(`memory index rebuilt (${reason}): ${result.added} notes`);
      return result;
    } finally {
      this.rebuilding = false;
    }
  }

  public async onStorageAvailable(): Promise<void> {
    if (this.stopped) return;
    // Watch first so changes made during the scan are not missed.
    this.startWatcher();
    const db = this.db();
    const markerId = await this.readMoveId(this.options.storage);
    const dir = await realpath(this.options.storage.activeDir()).catch(() => null);
    const savedMove = getMeta(db, "move_id");
    const savedDir = getMeta(db, "storage_dir");
    const switched = savedMove !== null && ((markerId !== "none" && savedMove !== markerId) || (savedDir !== null && dir !== null && savedDir !== dir));
    try {
      if (switched) await this.rebuild("move_id_changed");
      else await this.refreshChanged();
    } catch (error) {
      this.lastScanFailed = true;
      this.lastError = (error as Error).message;
      this.options.logger?.warn("memory index scan failed", error);
    }
    setMeta(this.db(), "storage_snapshot_at", null);
  }

  public onStorageUnavailable(): void {
    this.closeWatcher();
    if (this.database) setMeta(this.database, "storage_snapshot_at", getMeta(this.database, "last_scan_at"));
  }

  public async onStorageSwitched(): Promise<void> {
    if (this.stopped || !this.options.storage.isAvailable()) return;
    try { await this.rebuild("storage_switched"); } catch (error) { this.options.logger?.warn("memory index rebuild failed", error); }
    this.startWatcher();
  }

  private startWatcher(): void {
    this.closeWatcher();
    if (this.options.watch === false || this.stopped || !this.options.storage.isAvailable()) return;
    try {
      const root = this.options.storage.activeDir();
      this.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename && String(filename).split(sep).some((part) => part.startsWith("."))) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => { this.watchTimer = null; this.notifyChanged(); }, this.options.watchDebounceMs ?? 500);
        this.watchTimer.unref();
      });
      this.watcher.on("error", (error) => {
        console.warn("[owl-core] Memory file watcher failed; falling back to polling.", error);
        this.closeWatcher();
        this.watcherState = "polling";
      });
      this.watcherState = "watching";
    } catch (error) {
      console.warn("[owl-core] Could not start the memory file watcher; falling back to polling.", error);
      this.watcherState = "polling";
    }
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watcherState = this.options.storage.isAvailable() ? "polling" : "stopped";
    if (this.watchTimer) { clearTimeout(this.watchTimer); this.watchTimer = null; }
  }

  public status(): MemoryIndexStatus {
    const db = this.db();
    const counts = (sql: string): Record<string, number> => Object.fromEntries((db.prepare(sql).all() as { k: string; n: number }[]).map((r) => [r.k, r.n]));
    const total = (db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
    const prefixes = rawPathPrefixes();
    const unresolved = (db.prepare(
      `SELECT count(*) AS n FROM links l JOIN notes n ON n.rowid = l.src_rowid WHERE l.dst_rowid IS NULL${prefixes.map(() => " AND substr(n.path, 1, length(?)) <> ?").join("")}`,
    ).get(...prefixes.flatMap((p) => [p, p])) as { n: number }).n;
    const invalidRows = db.prepare("SELECT path, invalid_reasons_json AS r FROM notes WHERE valid = 0 ORDER BY path").all() as { path: string; r: string }[];
    const invalidReasons: Record<string, number> = {};
    for (const row of invalidRows) for (const reason of JSON.parse(row.r) as string[]) invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1;
    return {
      notes: total,
      by_type: counts("SELECT type AS k, count(*) AS n FROM notes GROUP BY type"),
      by_folder: counts("SELECT CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE '.' END AS k, count(*) AS n FROM notes GROUP BY k"),
      invalid: (db.prepare("SELECT count(*) AS n FROM notes WHERE valid = 0").get() as { n: number }).n,
      invalid_reasons: invalidReasons,
      invalid_notes: invalidRows.slice(0, 50).map((row) => ({ path: row.path, reasons: JSON.parse(row.r) as string[] })),
      unresolved_links: unresolved,
      built_at: getMeta(db, "built_at"), last_scan_at: getMeta(db, "last_scan_at"), storage_snapshot_at: getMeta(db, "storage_snapshot_at"),
      stale: !this.options.storage.isAvailable() || this.lastScanFailed,
      rebuilding: this.rebuilding,
      watcher: this.watcherState,
      last_error: this.lastError,
      vec_error: this.vecError,
    };
  }

  /** Page-layout report: count per page_type, template warnings and filenames used by more than one file (design §6). */
  public pageReport(): { by_page_type: Record<string, number>; duplicate_filenames: Record<string, string[]>; template_warnings: { path: string; warnings: string[] }[] } {
    const db = this.db();
    const by_page_type = Object.fromEntries((db.prepare("SELECT page_type AS k, count(*) AS n FROM notes GROUP BY page_type").all() as { k: string; n: number }[]).map((r) => [r.k, r.n]));
    const duplicates = new Map<string, string[]>();
    for (const row of db.prepare("SELECT filename, path FROM notes WHERE filename IN (SELECT filename FROM notes GROUP BY filename HAVING count(*) > 1) ORDER BY path").all() as { filename: string; path: string }[]) {
      duplicates.set(row.filename, [...(duplicates.get(row.filename) ?? []), row.path]);
    }
    const duplicate_filenames: Record<string, string[]> = Object.fromEntries(duplicates);
    const template_warnings = (db.prepare("SELECT path, template_warnings_json AS w FROM notes WHERE template_warnings_json != '[]' ORDER BY path").all() as { path: string; w: string }[])
      .map((r) => ({ path: r.path, warnings: JSON.parse(r.w) as string[] }));
    return { by_page_type, duplicate_filenames, template_warnings };
  }

  public getPageColumns(path: string): { page_type: string; page_type_source: string; body_sha256: string; integrated_hash: string | null; integrated_at: string | null; token_estimate: number; template_valid: number | null; valid: boolean; invalid_reasons: string[] } | null {
    const r = this.db().prepare("SELECT page_type, page_type_source, body_sha256, integrated_hash, integrated_at, token_estimate, template_valid, valid, invalid_reasons_json FROM notes WHERE path = ?").get(normalizeVaultPath(path)) as NoteDbRow | undefined;
    if (!r) return null;
    return {
      page_type: r.page_type as string, page_type_source: r.page_type_source as string, body_sha256: r.body_sha256 as string,
      integrated_hash: r.integrated_hash as string | null, integrated_at: r.integrated_at as string | null, token_estimate: r.token_estimate as number,
      template_valid: r.template_valid as number | null, valid: r.valid === 1, invalid_reasons: JSON.parse(r.invalid_reasons_json as string) as string[],
    };
  }

  private pageRows(where: string, params: (string | number)[], limit?: number): PageRow[] {
    const sql = `SELECT * FROM notes WHERE ${where} ORDER BY path${limit === undefined ? "" : " LIMIT ?"}`;
    return (this.db().prepare(sql).all(...params, ...(limit === undefined ? [] : [limit])) as NoteDbRow[]).map(toPageRow);
  }

  public listPages(query: PageQuery): readonly PageRow[] {
    const where: string[] = [`page_type IN (${query.types.map(() => "?").join(", ") || "NULL"})`, "template_valid = 1"];
    const params: (string | number)[] = [...query.types];
    const statuses = query.status ?? ["active"];
    where.push(`status IN (${statuses.map(() => "?").join(", ") || "NULL"})`);
    params.push(...statuses);
    if (query.scope) { where.push("page_scope = ?"); params.push(query.scope); }
    if (query.project_id !== undefined) { where.push("page_project_id = ?"); params.push(query.project_id); }
    if (query.related_to_project !== undefined) {
      where.push("EXISTS (SELECT 1 FROM json_each(related_projects_json) WHERE value = ?)");
      params.push(query.related_to_project);
    }
    if (query.work_id !== undefined) { where.push("work_id = ?"); params.push(query.work_id); }
    return this.pageRows(where.join(" AND "), params);
  }

  /** `null` is the common index (Home.md is also a common project-index but is not it). */
  public getProjectIndex(projectId: string | null): PageRow | null {
    const rows = projectId === null
      ? this.pageRows("page_type = 'project-index' AND template_valid = 1 AND page_scope = 'common' AND path <> 'Home.md'", [])
      : this.pageRows("page_type = 'project-index' AND template_valid = 1 AND page_scope = 'project' AND page_project_id = ?", [projectId]);
    return rows[0] ?? null;
  }

  /** Matches on `title_key`; archived themes are returned too. */
  public findTheme(scope: "project" | "common", projectId: string | null, title: string): PageRow | null {
    const rows = scope === "project"
      ? this.pageRows("page_type = 'theme' AND page_scope = 'project' AND page_project_id = ? AND title_key = ?", [projectId ?? "", themeTitleKey(title)])
      : this.pageRows("page_type = 'theme' AND page_scope = 'common' AND title_key = ?", [themeTitleKey(title)]);
    return rows.find((row) => row.status === "active") ?? rows[0] ?? null;
  }

  public resolvePageRef(ref: string): PageRow | null {
    const match = this.resolveNoteRef(ref).match;
    return match ? this.pageRows("path = ?", [match.path])[0] ?? null : null;
  }

  /** Active themes never integrated, or edited since (`integrated_hash` differs from `body_sha256`). */
  public pendingIntegration(limit: number): readonly PageRow[] {
    return this.pageRows("page_type = 'theme' AND status = 'active' AND (integrated_hash IS NULL OR integrated_hash != body_sha256)", [], limit);
  }

  /** `day` is `YYYY-MM-DD`. */
  public markOpened(path: string, day: string): void {
    this.db().prepare("INSERT INTO page_opens(path, last_opened) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET last_opened = excluded.last_opened").run(path, day);
  }

  public pageStatus(path: string): string | null {
    return (this.db().prepare("SELECT status FROM notes WHERE path = ?").get(path) as { status: string } | undefined)?.status ?? null;
  }

  public lastOpened(path: string): string | null {
    return (this.db().prepare("SELECT last_opened FROM page_opens WHERE path = ?").get(path) as { last_opened: string } | undefined)?.last_opened ?? null;
  }

  /** Active themes last opened (never opened: last updated) before `cutoff` (`YYYY-MM-DD`); the caller still checks their source Works. */
  public dormantCandidates(cutoff: string): readonly PageRow[] {
    return this.pageRows(`page_type = 'theme' AND status = 'active' AND template_valid = 1
      AND COALESCE((SELECT last_opened FROM page_opens o WHERE o.path = notes.path), COALESCE(updated, '')) < ?`, [cutoff]);
  }

  /** Paths of the notes that link to `path`, `path` itself excluded. */
  public linkSources(path: string): readonly string[] {
    const rows = this.db().prepare(`SELECT DISTINCT n.path AS path FROM links l JOIN notes n ON n.rowid = l.src_rowid
      JOIN notes d ON d.rowid = l.dst_rowid WHERE d.path = ? AND n.path != d.path ORDER BY n.path`).all(normalizeVaultPath(path)) as { path: string }[];
    return rows.map((row) => row.path);
  }

  /** Links from files whose folder rule says `links: optional` are left out. */
  public unresolvedLinks(path?: string): readonly { src: string; raw: string }[] {
    const sql = `SELECT n.path AS src, l.raw AS raw FROM links l JOIN notes n ON n.rowid = l.src_rowid
      WHERE l.dst_rowid IS NULL AND n.links_optional = 0${path === undefined ? "" : " AND n.path = ?"} ORDER BY n.path, l.raw`;
    return this.db().prepare(sql).all(...(path === undefined ? [] : [normalizeVaultPath(path)])) as { src: string; raw: string }[];
  }

  public pageStats(): { by_type: Record<StoredKind, number>; template_invalid: number; theme_over_budget: number; index_over_budget: number; pending_integration: number; unresolved_links: number } {
    const db = this.db();
    const count = (where: string): number => (db.prepare(`SELECT count(*) AS n FROM notes WHERE ${where}`).get() as { n: number }).n;
    const by_type: Record<StoredKind, number> = { theme: 0, "project-index": 0, "work-log": 0, clipping: 0, "conversation-log": 0, legacy: 0, archive: 0 };
    for (const [type, n] of Object.entries(this.pageReport().by_page_type)) by_type[type as StoredKind] = n;
    return {
      by_type,
      template_invalid: count("template_valid = 0"),
      theme_over_budget: count(`page_type = 'theme' AND token_estimate > ${PAGE_LIMITS.theme_tokens}`),
      index_over_budget: count(`page_type = 'project-index' AND token_estimate > ${PAGE_LIMITS.index_tokens}`),
      pending_integration: count("page_type = 'theme' AND status = 'active' AND (integrated_hash IS NULL OR integrated_hash != body_sha256)"),
      unresolved_links: this.unresolvedLinks().length,
    };
  }

  public getByRowid(rowid: number): MemoryNoteRow | null {
    const row = this.db().prepare("SELECT * FROM notes WHERE rowid = ?").get(rowid) as NoteDbRow | undefined;
    return row ? toNoteRow(row) : null;
  }

  /** Resolves an id, path, file name, `[[link]]` or title to a note (design §6.3). */
  public resolveNoteRef(ref: string): { match: MemoryNoteRow | null; candidates: MemoryNoteRow[] } {
    const db = this.db();
    const cleaned = ref.trim().replace(/^\[\[|\]\]$/gu, "").split("|")[0].split("#")[0].trim().normalize("NFC");
    const find = (sql: string, ...params: string[]): MemoryNoteRow[] => (db.prepare(sql).all(...params) as NoteDbRow[]).map(toNoteRow);
    const steps: [string, string[]][] = [
      ["SELECT * FROM notes WHERE id = ?", [cleaned]],
      ["SELECT * FROM notes WHERE path IN (?, ?)", [normalizeVaultPath(cleaned), normalizeVaultPath(/\.md$/u.test(cleaned) ? cleaned : `${cleaned}.md`)]],
      ["SELECT * FROM notes WHERE filename = ?", [cleaned.replace(/\.md$/u, "")]],
      ["SELECT * FROM notes WHERE lower(filename) = lower(?)", [cleaned.replace(/\.md$/u, "")]],
      ["SELECT * FROM notes WHERE title = ?", [cleaned]],
    ];
    for (const [sql, params] of steps) {
      const rows = find(sql, ...params);
      if (rows.length === 1) return { match: rows[0], candidates: [] };
      if (rows.length > 1) return { match: null, candidates: rows };
    }
    return { match: null, candidates: [] };
  }

  /** Reads the live file when the storage is connected; otherwise returns the indexed copy (`stale: true`). */
  public async readBody(row: MemoryNoteRow, maxBytes: number): Promise<{ body: string; truncated: boolean; stale: boolean }> {
    let body: string | null = null;
    if (this.options.storage.isAvailable()) {
      try {
        const data = await this.options.storage.withRead(() => readFile(join(this.options.storage.activeDir(), row.path)));
        if (sha256(data) !== row.sha256) this.notifyChanged([row.path]);
        body = parseMemoryNote(row.path, data.toString("utf8"), { mtimeMs: row.mtime }).body;
      } catch { /* fall back to the index copy */ }
    }
    const stale = body === null;
    if (body === null) body = (this.db().prepare("SELECT body FROM notes WHERE rowid = (SELECT rowid FROM notes WHERE path = ?)").get(row.path) as { body: string } | undefined)?.body ?? "";
    const buffer = Buffer.from(body, "utf8");
    if (buffer.length <= maxBytes) return { body, truncated: false, stale };
    let end = maxBytes;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
    return { body: buffer.subarray(0, end).toString("utf8"), truncated: true, stale };
  }
}

function removeNote(db: Database.Database, rowid: number): void {
  db.prepare("DELETE FROM notes WHERE rowid = ?").run(rowid);
  db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(rowid);
  db.prepare("DELETE FROM links WHERE src_rowid = ?").run(rowid);
  removeVectors(db, rowid);
}

interface PageColumns {
  page_type: PageType | "legacy" | "archive"; page_type_source: "frontmatter" | "folder" | "default"; body_sha256: string;
  integrated_hash: string | null; integrated_at: string | null; token_estimate: number; template_valid: number | null;
  template_errors: PageIssue[]; template_warnings: string[]; links_optional: number;
  page_scope: "project" | "common" | null; page_project_id: string | null; related_projects: string[]; title_key: string | null;
  merged_into: string | null; source_hash: string | null; generated_at: string | null; owl_new_count: number;
  work_id: string | null; work_number: number | null; source_url: string | null; retrieved_at: string | null;
}

/** page_type: archive folders, then a frontmatter `type` of the 4 template kinds, else legacy. Folder rules are not used here (migration only). Hand edits are checked as the owner. */
function pageColumns(path: string, content: string): PageColumns {
  const page = parsePage(content);
  const declared = typeof page.frontmatter.type === "string" ? page.frontmatter.type : "";
  const fromFrontmatter = (PAGE_KINDS as readonly string[]).includes(declared) ? (declared as PageType) : null;
  const archived = /^(?:archive|_history)\//u.test(path);
  const [page_type, page_type_source] = archived ? (["archive", "default"] as const)
    : fromFrontmatter ? ([fromFrontmatter, "frontmatter"] as const) : (["legacy", "default"] as const);
  const str = (key: string): string | null => (typeof page.frontmatter[key] === "string" && page.frontmatter[key] !== "" ? (page.frontmatter[key] as string) : null);
  let template_valid: number | null = null;
  let template_errors: PageIssue[] = [];
  let template_warnings: string[] = [];
  if (!archived && (PAGE_KINDS as readonly string[]).includes(declared)) {
    const result = validatePage(page, { writer: "owner" });
    template_valid = result.ok ? 1 : 0;
    template_errors = [...result.errors];
    template_warnings = result.warnings.map((w) => w.code);
  }
  const body = bodyOf(content);
  const related = page.frontmatter.related_projects;
  const num = page.frontmatter.work_number;
  const scope = str("scope");
  const isPage = !archived && (PAGE_KINDS as readonly string[]).includes(declared);
  return {
    page_type, page_type_source, body_sha256: bodySha256(content), integrated_hash: str("integrated_hash"), integrated_at: str("integrated_at"),
    token_estimate: estimatePageTokens(body), template_valid, template_errors, template_warnings,
    links_optional: page_type === "clipping" ? 1 : 0,
    page_scope: isPage && (scope === "project" || scope === "common") ? scope : null,
    page_project_id: isPage ? str("project_id") : null,
    related_projects: Array.isArray(related) ? related.map(String) : [],
    title_key: declared === "theme" ? themeTitleKey(str("title") ?? "") : null,
    merged_into: str("merged_into"), source_hash: str("source_hash"), generated_at: str("generated_at"),
    owl_new_count: (body.match(/<!--\s*owl:new\b/gu) ?? []).length,
    work_id: str("work_id"), work_number: typeof num === "number" ? num : null, source_url: str("source_url"), retrieved_at: str("retrieved_at"),
  };
}

function upsertNote(
  db: Database.Database,
  u: { rowid: number | null; parsed: ReturnType<typeof parseMemoryNote>; mtime: number; sha: string; size: number; page: PageColumns },
  indexedAt: string,
): void {
  const { row, body, frontmatter, links } = u.parsed;
  if (u.rowid !== null) removeNote(db, u.rowid);
  let id = row.id;
  const reasons = [...row.invalid_reasons, ...(u.size > MAX_FILE_BYTES ? ["too_large"] : []), ...u.page.template_errors.map((e) => `template:${e.code}${e.key ? `:${e.key}` : e.section ? `:${e.section}` : ""}`)];
  const owner = db.prepare("SELECT rowid, path FROM notes WHERE id = ?").get(id) as { rowid: number; path: string } | undefined;
  if (owner && owner.path !== row.path) {
    // Duplicate id: the lexicographically first path keeps it, the other falls back to its path id.
    if (owner.path < row.path) { reasons.push(`duplicate_id:${id}`); id = memoryIdForPath(row.path); }
    else {
      db.prepare("UPDATE notes SET id = ?, valid = 0, invalid_reasons_json = ? WHERE rowid = ?").run(memoryIdForPath(owner.path), JSON.stringify([`duplicate_id:${id}`]), owner.rowid);
    }
  }
  const stored = body.slice(0, BODY_LIMIT_CHARS);
  const info = db.prepare(
    `INSERT INTO notes (rowid, id, path, filename, title, type, type_source, status, summary, summary_source, importance, confidence, scope,
      project_ids_json, tags_json, tags_text, origin_by, origin_at, origin_ref, created, updated, superseded_by, frontmatter_json,
      mtime, sha256, size_bytes, body, valid, invalid_reasons_json, indexed_at,
      page_type, page_type_source, body_sha256, integrated_hash, integrated_at, token_estimate, template_valid, template_errors_json, template_warnings_json, links_optional,
      page_scope, page_project_id, related_projects_json, title_key, merged_into, source_hash, generated_at, owl_new_count,
      work_id, work_number, source_url, retrieved_at)
     VALUES (@rowid, @id, @path, @filename, @title, @type, @type_source, @status, @summary, @summary_source, @importance, @confidence, @scope,
      @project_ids_json, @tags_json, @tags_text, @origin_by, @origin_at, @origin_ref, @created, @updated, @superseded_by, @frontmatter_json,
      @mtime, @sha256, @size_bytes, @body, @valid, @invalid_reasons_json, @indexed_at,
      @page_type, @page_type_source, @body_sha256, @integrated_hash, @integrated_at, @token_estimate, @template_valid, @template_errors_json, @template_warnings_json, @links_optional,
      @page_scope, @page_project_id, @related_projects_json, @title_key, @merged_into, @source_hash, @generated_at, @owl_new_count,
      @work_id, @work_number, @source_url, @retrieved_at)`,
  ).run({
    rowid: u.rowid, id, path: row.path, filename: row.filename, title: row.title, type: row.type, type_source: row.type_source,
    status: row.status, summary: row.summary, summary_source: row.summary_source, importance: row.importance, confidence: row.confidence,
    scope: row.scope, project_ids_json: JSON.stringify(row.project_ids), tags_json: JSON.stringify(row.tags), tags_text: row.tags.join(" "),
    origin_by: row.origin_by, origin_at: row.origin_at, origin_ref: row.origin_ref, created: row.created, updated: row.updated,
    superseded_by: row.superseded_by, frontmatter_json: JSON.stringify(frontmatter), mtime: u.mtime, sha256: u.sha, size_bytes: u.size,
    body: stored, valid: reasons.length === 0 ? 1 : 0, invalid_reasons_json: JSON.stringify(reasons), indexed_at: indexedAt,
    page_type: u.page.page_type, page_type_source: u.page.page_type_source, body_sha256: u.page.body_sha256,
    integrated_hash: u.page.integrated_hash, integrated_at: u.page.integrated_at, token_estimate: u.page.token_estimate,
    template_valid: u.page.template_valid, template_errors_json: JSON.stringify(u.page.template_errors),
    template_warnings_json: JSON.stringify(u.page.template_warnings), links_optional: u.page.links_optional,
    page_scope: u.page.page_scope, page_project_id: u.page.page_project_id, related_projects_json: JSON.stringify(u.page.related_projects),
    title_key: u.page.title_key, merged_into: u.page.merged_into, source_hash: u.page.source_hash, generated_at: u.page.generated_at,
    owl_new_count: u.page.owl_new_count, work_id: u.page.work_id, work_number: u.page.work_number,
    source_url: u.page.source_url, retrieved_at: u.page.retrieved_at,
  });
  const rowid = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO notes_fts (rowid, title, summary, tags, body) VALUES (?, ?, ?, ?, ?)").run(
    rowid, fold(row.title), fold(row.summary), fold(row.tags.join(" ")), fold(stored),
  );
  for (const link of links) db.prepare("INSERT OR IGNORE INTO links (src_rowid, raw, kind) VALUES (?, ?, ?)").run(rowid, link.raw, link.kind);
}

/** Resolves every link against the current notes (ULID → id, path → path or last segment, name → filename). */
function resolveLinks(db: Database.Database): void {
  const notes = db.prepare("SELECT rowid, id, path, filename FROM notes ORDER BY length(path), path").all() as { rowid: number; id: string; path: string; filename: string }[];
  const byId = new Map(notes.map((n) => [n.id, n]));
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const byName = new Map<string, (typeof notes)[number]>();
  for (const n of notes) if (!byName.has(n.filename)) byName.set(n.filename, n);
  const links = db.prepare("SELECT l.src_rowid, l.raw, l.kind, l.dst_rowid, n.path AS src_path FROM links l JOIN notes n ON n.rowid = l.src_rowid").all() as
    { src_rowid: number; raw: string; kind: string; dst_rowid: number | null; src_path: string }[];
  const update = db.prepare("UPDATE links SET dst_rowid = ?, dst_filename = ? WHERE src_rowid = ? AND raw = ?");
  db.transaction(() => {
    for (const l of links) {
      let target: (typeof notes)[number] | undefined;
      if (!rawPathPrefixes().some((prefix) => l.src_path.startsWith(prefix))) {
        if (l.kind === "ulid") target = byId.get(l.raw);
        else if (l.kind === "path") target = byPath.get(normalizeVaultPath(`${l.raw}.md`)) ?? byPath.get(normalizeVaultPath(l.raw)) ?? byName.get(basename(l.raw, ".md"));
        else target = byName.get(l.raw.replace(/\.md$/u, ""));
      }
      if ((target?.rowid ?? null) !== l.dst_rowid) update.run(target?.rowid ?? null, target?.filename ?? null, l.src_rowid, l.raw);
    }
  })();
}
