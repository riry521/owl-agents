import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { rename as renameFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createUlid } from "../../db/dist/index.js";

import { HumanReadableError } from "./errors.js";

export type KnowledgeStorageState = "available" | "unavailable" | "moving";
export type KnowledgeUnavailableReason =
  | "invalid_path" | "missing" | "not_directory" | "permission_denied"
  | "not_writable" | "marker_missing" | "timeout" | "io_error";
export type KnowledgeMoveMode = "move" | "relink";
export type KnowledgeMoveStage =
  | "validating" | "draining" | "scanning" | "copying" | "verifying" | "switching" | "cleaning_up";

export interface KnowledgeMoveWarning {
  readonly code: "source_cleanup_incomplete";
  readonly path: string;
  readonly remaining_files: number;
}

export interface KnowledgeStorageStatus {
  readonly path: string;
  readonly default_path: string;
  readonly custom: boolean;
  readonly state: KnowledgeStorageState;
  readonly reason: KnowledgeUnavailableReason | null;
  readonly checked_at: string | null;
  readonly move: {
    readonly target: string;
    readonly mode: KnowledgeMoveMode;
    readonly stage: KnowledgeMoveStage;
    readonly started_at: string;
    readonly files_total: number | null;
    readonly files_done: number;
  } | null;
  readonly last_move: {
    readonly from: string; readonly to: string; readonly mode: KnowledgeMoveMode;
    readonly finished_at: string; readonly files: number; readonly bytes: number;
    readonly warnings: readonly KnowledgeMoveWarning[];
  } | null;
  readonly interrupted_move: {
    readonly source: string; readonly target: string;
    readonly stage: KnowledgeMoveStage; readonly started_at: string;
  } | null;
}

export interface KnowledgeMoveResult {
  readonly status: KnowledgeStorageStatus;
  readonly moved: { readonly files: number; readonly bytes: number };
  readonly warnings: readonly KnowledgeMoveWarning[];
}

export interface KnowledgeStoragePersistence {
  /** Raw stored value ("" = the default <OWL_ROOT>/knowledge). */
  read(): string;
  /** Synchronous and atomic; throws on failure and then leaves the setting unchanged. */
  write(value: string): void;
}

/** The subset of node:fs/promises that moving and probing use; tests inject failures through it. */
export type KnowledgeFs = Pick<
  typeof nodeFs,
  "stat" | "lstat" | "readdir" | "mkdir" | "copyFile" | "readFile" | "writeFile" | "unlink" | "rmdir" | "utimes" | "chmod" | "realpath"
>;

export interface KnowledgeLocationOptions {
  readonly owlRoot: string;
  readonly dataDir: string;
  readonly persistence?: KnowledgeStoragePersistence;
  readonly now?: () => string;
  readonly fs?: KnowledgeFs;
  readonly pollIntervalMs?: number;
  readonly unavailablePollIntervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly onAvailable?: () => void | Promise<void>;
  readonly onUnavailable?: (reason: KnowledgeUnavailableReason) => void;
  /** Called after the location switched to a new directory (drop caches there). */
  readonly onSwitched?: () => void;
}

export const KNOWLEDGE_MARKER_FILE = ".owl-knowledge";
const JOURNAL_FILE = "knowledge-move.json";
const MAX_PATH_LENGTH = 1024;
const ACCESS_ERROR_CODES = new Set(["ENOENT", "ENOTDIR", "EEXIST", "EIO", "ENXIO", "ENODEV", "ESTALE", "ETIMEDOUT", "EACCES", "EPERM", "EROFS"]);

function storageError(code: string, message: string, details: Record<string, unknown> = {}): HumanReadableError {
  return new HumanReadableError({ code, message, remediation: "Check the knowledge storage settings and try again.", details });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

/**
 * Normalizes a stored or requested knowledge directory: "" for the default location,
 * otherwise an absolute resolved path. Throws `validation_error` for anything else.
 */
export function normalizeKnowledgeDirInput(value: string, defaultDir?: string): string {
  const invalid = () => new HumanReadableError({
    code: "validation_error",
    message: "The knowledge storage path must be an absolute path.",
    remediation: "Enter an absolute path.",
    details: { field: "path", reason: "absolute" },
  });
  if (typeof value !== "string") throw invalid();
  let text = value.trim();
  if (text === "") return "";
  if (text.length > MAX_PATH_LENGTH || text.includes("\0")) throw invalid();
  if (text === "~" || text.startsWith("~/")) text = join(homedir(), text.slice(1));
  if (!isAbsolute(text)) throw invalid();
  const resolved = resolve(text);
  return defaultDir !== undefined && resolved === resolve(defaultDir) ? "" : resolved;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isSafeRelativePath(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  return path !== "" && !isAbsolute(path) && resolvedPath !== resolvedRoot && isInside(resolvedRoot, resolvedPath);
}

// Entries excluded from target emptiness checks and file-set verification.
function isIgnoredEntry(path: string): boolean {
  return path === ".DS_Store" || path.endsWith(`${sep}.DS_Store`) || path === KNOWLEDGE_MARKER_FILE;
}

function isManifest(value: unknown, source: string, target: string): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<Manifest>;
  return Array.isArray(manifest.dirs)
    && manifest.dirs.every((dir) => typeof dir === "string" && isSafeRelativePath(source, dir))
    && Array.isArray(manifest.files)
    && manifest.files.every((file) => typeof file === "object" && file !== null
      && typeof file.rel === "string"
      && isSafeRelativePath(source, file.rel)
      && isSafeRelativePath(target, file.rel)
      && Number.isFinite(file.size)
      && typeof file.sha256 === "string"
      && /^[a-f\d]{64}$/u.test(file.sha256));
}

interface Manifest {
  dirs: string[];
  files: Array<{ rel: string; size: number; mtimeMs: number; atimeMs: number; mode: number; sha256: string }>;
}

interface Journal {
  move_id: string;
  source: string;
  target: string;
  mode: KnowledgeMoveMode;
  created_target: boolean;
  stage: KnowledgeMoveStage;
  started_at: string;
  manifest?: Manifest;
}

/** Single source of truth for where knowledge lives, whether it is usable, and move/lease coordination. */
export class KnowledgeLocation {
  private readonly owlRoot: string;
  private readonly dataDir: string;
  private readonly defaultPath: string;
  private readonly persistence?: KnowledgeStoragePersistence;
  private readonly now: () => string;
  private readonly fs: KnowledgeFs;
  private readonly pollMs: number;
  private readonly unavailablePollMs: number;
  private readonly probeTimeoutMs: number;
  private readonly onAvailable?: () => void | Promise<void>;
  private readonly onUnavailable?: (reason: KnowledgeUnavailableReason) => void;
  private readonly onSwitched?: () => void;

  private currentPath: string;
  private custom: boolean;
  private everAvailable = false;
  private state: KnowledgeStorageState = "available";
  private reason: KnowledgeUnavailableReason | null = null;
  private checkedAt: string | null = null;
  private moveInfo: { -readonly [K in keyof NonNullable<KnowledgeStorageStatus["move"]>]: NonNullable<KnowledgeStorageStatus["move"]>[K] } | null = null;
  private lastMove: KnowledgeStorageStatus["last_move"] = null;
  private interrupted: KnowledgeStorageStatus["interrupted_move"] = null;

  private writers = 0;
  private readers = 0;
  private moving = false;
  private switching = false;
  private waiters: Array<() => void> = [];
  private readonly leases = new AsyncLocalStorage<{ lease: "read" | "write" }>();
  private checking: Promise<KnowledgeStorageStatus> | null = null;
  private probeInFlight: Promise<KnowledgeUnavailableReason | null> | null = null;
  private moveRun: Promise<unknown> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  public constructor(options: KnowledgeLocationOptions) {
    this.owlRoot = options.owlRoot;
    this.dataDir = options.dataDir;
    this.defaultPath = join(options.owlRoot, "knowledge");
    this.persistence = options.persistence;
    this.now = options.now ?? (() => new Date().toISOString());
    this.fs = options.fs ?? nodeFs;
    this.pollMs = options.pollIntervalMs ?? 30_000;
    this.unavailablePollMs = options.unavailablePollIntervalMs ?? 10_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
    this.onAvailable = options.onAvailable;
    this.onUnavailable = options.onUnavailable;
    this.onSwitched = options.onSwitched;
    const raw = this.persistence?.read() ?? "";
    this.currentPath = this.defaultPath;
    this.custom = false;
    try {
      const normalized = normalizeKnowledgeDirInput(raw, this.defaultPath);
      if (normalized !== "") {
        this.currentPath = normalized;
        this.custom = true;
      }
    } catch {
      this.currentPath = raw;
      this.custom = true;
      this.state = "unavailable";
      this.reason = "invalid_path";
    }
  }

  public get path(): string {
    return this.currentPath;
  }

  public activeDir(): string {
    if (this.state === "unavailable") throw this.unavailableError();
    return this.currentPath;
  }

  /** Throws `knowledge_storage_unavailable` while the storage cannot be used. */
  public assertAvailable(): void {
    if (this.state === "unavailable") throw this.unavailableError();
  }

  public isAvailable(): boolean {
    return this.state !== "unavailable";
  }

  public hasEverBeenAvailable(): boolean {
    return this.everAvailable;
  }

  public status(): KnowledgeStorageStatus {
    return {
      path: this.currentPath,
      default_path: this.defaultPath,
      custom: this.custom,
      state: this.state,
      reason: this.state === "unavailable" ? this.reason : null,
      checked_at: this.checkedAt,
      move: this.state === "moving" && this.moveInfo ? { ...this.moveInfo } : null,
      last_move: this.lastMove,
      interrupted_move: this.interrupted,
    };
  }

  private unavailableError(): HumanReadableError {
    return storageError("knowledge_storage_unavailable", "The knowledge storage is unavailable.", {
      path: this.currentPath, reason: this.reason, checked_at: this.checkedAt,
    });
  }

  // ---------------------------------------------------------------- availability

  public async initialize(): Promise<KnowledgeStorageStatus> {
    this.stopped = false;
    if (!this.custom && !this.everAvailable) await this.fs.mkdir(this.currentPath, { recursive: true }).catch(() => undefined);
    await this.recoverJournal();
    const status = await this.check();
    this.schedulePoll();
    return status;
  }

  public check(): Promise<KnowledgeStorageStatus> {
    if (this.state === "moving") return Promise.resolve(this.status());
    if (this.checking) return this.checking;
    if (this.probeInFlight) return Promise.resolve(this.status());
    const run = this.runCheck().finally(() => {
      if (this.checking === run) this.checking = null;
    });
    this.checking = run;
    return run;
  }

  private async runCheck(): Promise<KnowledgeStorageStatus> {
    const reason = await this.probe();
    if (this.state === "moving") return this.status();
    const was = this.state;
    this.checkedAt = this.now();
    this.reason = reason;
    this.state = reason ? "unavailable" : "available";
    if (!reason) this.everAvailable = true;
    if (reason && was !== "unavailable") {
      console.warn("[owl-core] knowledge storage unavailable", { path: this.currentPath, reason });
      this.onUnavailable?.(reason);
    }
    if (!reason && was === "unavailable") {
      console.warn("[owl-core] knowledge storage available again", { path: this.currentPath });
      this.writers += 1;
      try {
        await this.leases.run({ lease: "write" }, async () => this.onAvailable?.());
      } catch (error) {
        console.error("[owl-core] knowledge storage recovery failed", error);
      } finally {
        this.writers -= 1;
        this.notify();
      }
    }
    return this.status();
  }

  private async probe(): Promise<KnowledgeUnavailableReason | null> {
    try {
      normalizeKnowledgeDirInput(this.currentPath, this.defaultPath);
    } catch {
      return "invalid_path";
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<KnowledgeUnavailableReason>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), this.probeTimeoutMs);
    });
    try {
      const probe = this.probeOnce();
      this.probeInFlight = probe;
      void probe.then(
        () => { if (this.probeInFlight === probe) this.probeInFlight = null; },
        () => { if (this.probeInFlight === probe) this.probeInFlight = null; },
      );
      return await Promise.race([probe, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async probeOnce(): Promise<KnowledgeUnavailableReason | null> {
    const path = this.currentPath;
    let info: Awaited<ReturnType<KnowledgeFs["stat"]>>;
    try {
      info = await this.fs.stat(path);
    } catch (error) {
      return mapErrorReason(error);
    }
    if (!info.isDirectory()) return "not_directory";
    if (this.custom) {
      try {
        await this.fs.stat(join(path, KNOWLEDGE_MARKER_FILE));
      } catch (error) {
        return errorCode(error) === "ENOENT" ? "marker_missing" : mapErrorReason(error);
      }
    }
    const probe = join(path, `.owl-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await this.fs.writeFile(probe, "", { flag: "wx" });
    } catch (error) {
      return mapWriteProbeErrorReason(error);
    }
    try {
      await this.fs.unlink(probe);
    } catch (error) {
      return mapWriteProbeErrorReason(error);
    }
    return null;
  }

  public noteAccessError(error: unknown): void {
    const code = errorCode(error);
    if (code && ACCESS_ERROR_CODES.has(code)) void this.check().catch(() => undefined);
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const delay = this.state === "unavailable" ? this.unavailablePollMs : this.pollMs;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.check().catch(() => undefined).finally(() => this.schedulePoll());
    }, delay);
    this.pollTimer.unref?.();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.moveRun?.catch(() => undefined);
    await this.checking?.catch(() => undefined);
  }

  // ---------------------------------------------------------------- leases

  private notify(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  }

  private async until(condition: () => boolean): Promise<void> {
    while (!condition()) await new Promise<void>((wake) => this.waiters.push(wake));
  }

  public async withWrite<T>(fn: () => Promise<T>): Promise<T> {
    if (this.leases.getStore()) return fn();
    for (;;) {
      await this.until(() => !this.moving);
      if (this.moving) continue;
      const canPrepareDefault = !this.custom && !this.everAvailable;
      if (canPrepareDefault) break;
      this.assertAvailable();
      const status = await this.check();
      if (status.state === "unavailable") throw this.unavailableError();
      if (status.state === "moving" || this.moving) continue;
      break;
    }
    this.writers += 1;
    try {
      if (!this.custom && !this.everAvailable) {
        await this.fs.mkdir(this.currentPath, { recursive: true });
        const status = await this.check();
        if (status.state === "unavailable") throw this.unavailableError();
      }
      return await this.leases.run({ lease: "write" }, fn);
    } catch (error) {
      const code = errorCode(error);
      if (code && ACCESS_ERROR_CODES.has(code)) {
        await this.refreshAfterWriteAccessError(error);
        throw this.unavailableError();
      }
      throw error;
    } finally {
      this.writers -= 1;
      this.notify();
    }
  }

  private async refreshAfterWriteAccessError(error: unknown): Promise<void> {
    await this.check().catch(() => undefined);
    if (this.state === "unavailable") return;
    const reason = mapWriteErrorReason(error);
    this.state = "unavailable";
    this.reason = reason;
    this.checkedAt = this.now();
    console.warn("[owl-core] knowledge storage unavailable", { path: this.currentPath, reason });
    this.onUnavailable?.(reason);
  }

  public async withRead<T>(fn: () => Promise<T>): Promise<T> {
    if (this.leases.getStore()) return fn();
    this.assertAvailable();
    await this.until(() => !this.switching);
    this.assertAvailable();
    this.readers += 1;
    try {
      return await this.leases.run({ lease: "read" }, fn);
    } catch (error) {
      const code = errorCode(error);
      if (code && ACCESS_ERROR_CODES.has(code)) {
        await this.check().catch(() => undefined);
        if (this.state === "unavailable") throw this.unavailableError();
      }
      throw error;
    } finally {
      this.readers -= 1;
      this.notify();
    }
  }

  // ---------------------------------------------------------------- move

  public move(input: { path: string; mode: KnowledgeMoveMode }): Promise<KnowledgeMoveResult> {
    if (!this.persistence) {
      return Promise.reject(storageError("dependency_unavailable", "Knowledge storage persistence is not configured."));
    }
    if (this.moveRun) {
      return Promise.reject(storageError("knowledge_storage_moving", "A knowledge storage move is already running."));
    }
    const run = this.runMove(input).finally(() => {
      if (this.moveRun === run) this.moveRun = null;
    });
    this.moveRun = run;
    return run;
  }

  private invalidTarget(reason: string, extra: Record<string, unknown> = {}): HumanReadableError {
    return storageError("knowledge_target_invalid", "The knowledge storage target is not usable.", { reason, ...extra });
  }

  private async nearestReal(path: string): Promise<string> {
    const missing: string[] = [];
    let current = resolve(path);
    for (;;) {
      try {
        return join(await this.fs.realpath(current), ...missing.reverse());
      } catch (error) {
        const parent = dirname(current);
        if (parent === current || errorCode(error) !== "ENOENT") throw error;
        missing.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
        current = parent;
      }
    }
  }

  private async protectedPaths(): Promise<string[]> {
    const real = async (path: string) => this.fs.realpath(path).catch(() => resolve(path));
    return [resolve("/"), await real(homedir()), await real(this.owlRoot), await real(this.dataDir)];
  }

  private async runMove(input: { path: string; mode: KnowledgeMoveMode }): Promise<KnowledgeMoveResult> {
    const { mode } = input;
    const normalized = normalizeKnowledgeDirInput(input.path, this.defaultPath);
    const target = normalized === "" ? this.defaultPath : normalized;
    const source = this.currentPath;
    if (mode === "move" && this.state !== "available") {
      throw this.state === "moving"
        ? storageError("knowledge_storage_moving", "A knowledge storage move is already running.")
        : this.unavailableError();
    }
    if (mode === "relink" && this.state !== "unavailable") {
      throw this.invalidTarget("relink_requires_unavailable");
    }

    // validating
    const createdTarget = await this.validateTarget(source, target, mode);
    const startedAt = this.now();
    const journal: Journal = {
      move_id: createUlid(), source, target, mode, created_target: createdTarget, stage: "validating", started_at: startedAt,
    };
    const previousState = { state: this.state, reason: this.reason };
    this.moveInfo = { target, mode, stage: "validating", started_at: startedAt, files_total: null, files_done: 0 };
    const copied: { dirs: string[]; files: string[] } = { dirs: [], files: [] };
    let stage: KnowledgeMoveStage = "validating";
    const setStage = async (next: KnowledgeMoveStage) => {
      stage = next;
      this.moveInfo!.stage = next;
      journal.stage = next;
      await this.writeJournal(journal);
    };
    let switched = false;
    let createdMarker = false;
    let keepJournal = false;
    try {
      this.state = "moving";
      this.moving = true;
      await setStage("draining");
      await this.until(() => this.writers === 0);

      let manifest: Manifest = { dirs: [], files: [] };
      let bytes = 0;
      if (mode === "move") {
        await setStage("scanning");
        manifest = await this.scan(source);
        this.moveInfo!.files_total = manifest.files.length;
        await setStage("copying");
        await this.copyAll(source, target, manifest, copied);
        await setStage("verifying");
        await this.verify(source, target, manifest);
        bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
      }
      createdMarker = await this.writeMarker(target, mode === "move" ? await this.sourceLayout(source) : undefined);
      await setStage("switching");
      this.switching = true;
      await this.until(() => this.readers === 0);
      const previous = { raw: this.persistence!.read() ?? "", custom: this.custom, everAvailable: this.everAvailable, checkedAt: this.checkedAt };
      this.persistence!.write(normalized);
      switched = true;
      this.currentPath = target;
      this.custom = normalized !== "";
      this.state = "available";
      this.everAvailable = true;
      this.reason = null;
      this.checkedAt = this.now();

      let warnings: KnowledgeMoveWarning[] = [];
      if (mode === "move") {
        journal.manifest = manifest;
        try {
          await setStage("cleaning_up");
        } catch (journalError) {
          // Nothing was deleted yet: put the original setting back. If that fails, keep the journal for recovery.
          keepJournal = true;
          this.persistence!.write(previous.raw);
          this.currentPath = source;
          this.custom = previous.custom;
          this.everAvailable = previous.everAvailable;
          this.checkedAt = previous.checkedAt;
          this.state = previousState.state;
          this.reason = previousState.reason;
          switched = false;
          keepJournal = false;
          throw journalError;
        }
      }
      // Writes stay paused until the cleaning_up journal is durable (or the failure is fully rolled back).
      this.switching = false;
      this.moving = false;
      this.notify();
      this.afterSwitch();
      if (mode === "move") {
        warnings = await this.cleanupSource(source, target, manifest);
      }
      await this.removeJournal();
      this.lastMove = { from: source, to: target, mode, finished_at: this.now(), files: manifest.files.length, bytes, warnings };
      return { status: this.status(), moved: { files: manifest.files.length, bytes }, warnings };
    } catch (error) {
      if (switched) {
        if (!keepJournal) await this.removeJournal();
        throw error;
      }
      const cleaned = await this.removeCopied(target, copied, createdTarget, createdMarker);
      await this.removeJournal();
      this.state = previousState.state;
      this.reason = previousState.reason;
      if (error instanceof HumanReadableError && error.code === "knowledge_move_failed") {
        throw storageError("knowledge_move_failed", error.message, { ...error.details, source_intact: true, target_cleaned: cleaned });
      }
      throw storageError("knowledge_move_failed", "Moving the knowledge storage failed. The original data and setting are unchanged.", {
        stage,
        reason: error instanceof Error ? error.message : String(error),
        source_intact: true,
        target_cleaned: cleaned,
      });
    } finally {
      this.switching = false;
      this.moving = false;
      this.moveInfo = null;
      this.notify();
      this.schedulePoll();
    }
  }

  private afterSwitch(): void {
    try {
      this.onSwitched?.();
    } catch (error) {
      console.warn("[owl-core] knowledge switch hook failed", error);
    }
  }

  private async validateTarget(source: string, target: string, mode: KnowledgeMoveMode): Promise<boolean> {
    const sourceReal = await this.fs.realpath(source).catch(() => resolve(source));
    const targetReal = await this.nearestReal(target).catch(() => {
      throw this.invalidTarget("parent_missing");
    });
    if (targetReal === sourceReal) throw this.invalidTarget("same_as_current");
    if (isInside(sourceReal, targetReal) || isInside(targetReal, sourceReal)) throw this.invalidTarget("nested");
    const reserved = await this.protectedPaths();
    const dataReal = reserved[3];
    if (reserved.includes(targetReal) || isInside(dataReal, targetReal) || isInside(targetReal, reserved[2]) || isInside(targetReal, dataReal)) {
      throw this.invalidTarget("reserved");
    }
    let createdTarget = false;
    let info: Awaited<ReturnType<KnowledgeFs["stat"]>> | null = null;
    try {
      info = await this.fs.stat(target);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw this.invalidTarget("not_writable");
    }
    if (info) {
      if (!info.isDirectory()) throw this.invalidTarget("not_directory");
      if (mode === "move") {
        const names = (await this.fs.readdir(target)).filter((name) => !isIgnoredEntry(name));
        if (names.length > 0) throw this.invalidTarget("not_empty");
      }
    } else {
      const parent = await this.nearestExisting(target);
      if (!(await this.fs.stat(parent)).isDirectory()) throw this.invalidTarget("parent_missing");
      try {
        await this.fs.mkdir(target, { recursive: true, mode: 0o700 });
      } catch {
        throw this.invalidTarget("not_writable");
      }
      createdTarget = true;
    }
    const probe = join(target, `.owl-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await this.fs.writeFile(probe, "", { flag: "wx" });
      await this.fs.unlink(probe);
    } catch {
      if (createdTarget) await this.fs.rmdir(target).catch(() => undefined);
      throw this.invalidTarget("not_writable");
    }
    return createdTarget;
  }

  private async nearestExisting(path: string): Promise<string> {
    let current = resolve(path);
    for (;;) {
      try {
        await this.fs.stat(current);
        return current;
      } catch {
        const parent = dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    }
  }

  private async scan(source: string): Promise<Manifest> {
    const manifest: Manifest = { dirs: [], files: [] };
    const unsupported: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const name of await this.fs.readdir(join(source, rel))) {
        const childRel = rel === "" ? name : join(rel, name);
        if (isIgnoredEntry(childRel)) continue;
        const info = await this.fs.lstat(join(source, childRel));
        if (info.isDirectory()) {
          manifest.dirs.push(childRel);
          await walk(childRel);
        } else if (info.isFile()) {
          const sha256 = createHash("sha256").update(await this.fs.readFile(join(source, childRel))).digest("hex");
          manifest.files.push({ rel: childRel, size: info.size, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs, mode: info.mode & 0o777, sha256 });
        } else if (unsupported.length < 20) {
          unsupported.push(childRel);
        }
      }
    };
    await walk("");
    if (unsupported.length > 0) {
      throw storageError("knowledge_move_failed", "The knowledge storage contains entries that cannot be copied.", {
        stage: "scanning", reason: "unsupported_entry", paths: unsupported,
      });
    }
    return manifest;
  }

  private async copyAll(source: string, target: string, manifest: Manifest, copied: { dirs: string[]; files: string[] }): Promise<void> {
    for (const dir of manifest.dirs) {
      await this.fs.mkdir(join(target, dir), { recursive: true });
      copied.dirs.push(dir);
    }
    for (const file of manifest.files) {
      await this.fs.copyFile(join(source, file.rel), join(target, file.rel), nodeFs.constants.COPYFILE_EXCL);
      copied.files.push(file.rel);
      await this.fs.chmod(join(target, file.rel), file.mode);
      await this.fs.utimes(join(target, file.rel), file.atimeMs / 1000, file.mtimeMs / 1000);
      this.moveInfo!.files_done += 1;
    }
  }

  private async verify(source: string, target: string, manifest: Manifest): Promise<void> {
    const expected = new Set(manifest.files.map((file) => file.rel).filter((path) => !isIgnoredEntry(path)));
    const found: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const name of await this.fs.readdir(join(target, rel))) {
        const childRel = rel === "" ? name : join(rel, name);
        if (rel === "" && name === KNOWLEDGE_MARKER_FILE) continue;
        const info = await this.fs.lstat(join(target, childRel));
        if (info.isDirectory()) await walk(childRel);
        else if (!isIgnoredEntry(childRel)) found.push(childRel);
      }
    };
    await walk("");
    const failed = (reason: string) => storageError("knowledge_move_failed", "Verifying the copied knowledge failed.", { stage: "verifying", reason });
    if (found.length !== expected.size || found.some((rel) => !expected.has(rel))) throw failed("file_set_mismatch");
    for (const file of manifest.files) {
      const copy = await this.fs.readFile(join(target, file.rel));
      if (copy.length !== file.size || createHash("sha256").update(copy).digest("hex") !== file.sha256) throw failed("checksum_mismatch");
      const original = await this.fs.lstat(join(source, file.rel));
      if (original.size !== file.size || original.mtimeMs !== file.mtimeMs) throw failed("source_changed");
    }
  }

  /** The layout the source marker records, so a moved pages vault is not taken for a legacy one and archived on the next start. */
  private async sourceLayout(source: string): Promise<string | undefined> {
    try {
      const parsed: unknown = JSON.parse(await this.fs.readFile(join(source, KNOWLEDGE_MARKER_FILE), "utf8"));
      const layout = typeof parsed === "object" && parsed !== null ? (parsed as { layout?: unknown }).layout : undefined;
      return typeof layout === "string" ? layout : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[owl-core] Could not read the knowledge marker in ${source}:`, error);
      return undefined;
    }
  }

  private async writeMarker(target: string, layout?: string): Promise<boolean> {
    const marker = join(target, KNOWLEDGE_MARKER_FILE);
    try {
      await this.fs.stat(marker);
      return false;
    } catch {
      try {
        await this.fs.writeFile(marker, JSON.stringify({ format: 1, moved_at: this.now(), move_id: createUlid(), ...(layout ? { layout } : {}) }), { mode: 0o600, flag: "wx" });
        return true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
    }
  }

  private async removeCopied(target: string, copied: { dirs: string[]; files: string[] }, createdTarget: boolean, createdMarker: boolean): Promise<boolean> {
    let clean = true;
    const attempt = async (op: () => Promise<unknown>) => { try { await op(); } catch (error) { if (errorCode(error) !== "ENOENT") clean = false; } };
    for (const rel of copied.files) await attempt(() => this.fs.unlink(join(target, rel)));
    for (const rel of [...copied.dirs].sort((a, b) => b.length - a.length)) await attempt(() => this.fs.rmdir(join(target, rel)));
    if (createdMarker) await attempt(() => this.fs.unlink(join(target, KNOWLEDGE_MARKER_FILE)));
    if (createdTarget) await attempt(() => this.fs.rmdir(target));
    return clean;
  }

  private async cleanupSource(source: string, target: string, manifest: Manifest): Promise<KnowledgeMoveWarning[]> {
    const guarded = await this.protectedPaths();
    const real = await this.fs.realpath(source).catch(() => resolve(source));
    if (guarded.includes(real)) {
      return [{ code: "source_cleanup_incomplete", path: source, remaining_files: await this.countFiles(source).catch(() => manifest.files.length) }];
    }
    let remaining = 0;
    for (const file of manifest.files) {
      if (!isSafeRelativePath(source, file.rel) || !isSafeRelativePath(target, file.rel)) {
        remaining += 1;
        continue;
      }
      let original: Buffer;
      try {
        const info = await this.fs.lstat(join(source, file.rel));
        if (!info.isFile()) {
          remaining += 1;
          continue;
        }
        original = await this.fs.readFile(join(source, file.rel));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") remaining += 1;
        continue;
      }
      if (original.length !== file.size || createHash("sha256").update(original).digest("hex") !== file.sha256) {
        remaining += 1;
        continue;
      }
      try {
        const info = await this.fs.lstat(join(target, file.rel));
        if (!info.isFile()) {
          remaining += 1;
          continue;
        }
        const copy = await this.fs.readFile(join(target, file.rel));
        if (copy.length !== file.size || createHash("sha256").update(copy).digest("hex") !== file.sha256) {
          remaining += 1;
          continue;
        }
      } catch {
        remaining += 1;
        continue;
      }
      try {
        await this.fs.unlink(join(source, file.rel));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") remaining += 1;
      }
    }
    remaining = await this.countFiles(source).catch(() => Math.max(remaining, 1));
    for (const rel of [...manifest.dirs].sort((a, b) => b.length - a.length)) {
      if (isSafeRelativePath(source, rel)) await this.fs.rmdir(join(source, rel)).catch(() => undefined);
    }
    if (remaining === 0) await this.fs.unlink(join(source, KNOWLEDGE_MARKER_FILE)).catch(() => undefined);
    await this.fs.rmdir(source).catch(() => undefined);
    return remaining > 0 ? [{ code: "source_cleanup_incomplete", path: source, remaining_files: remaining }] : [];
  }

  private async countFiles(source: string): Promise<number> {
    let count = 0;
    const walk = async (dir: string, root = false): Promise<void> => {
      for (const name of await this.fs.readdir(dir)) {
        // .DS_Store is never copied or removed (isIgnoredEntry), so it is not a file left behind.
        if ((root && name === KNOWLEDGE_MARKER_FILE) || name === ".DS_Store") continue;
        const path = join(dir, name);
        const info = await this.fs.lstat(path);
        if (info.isDirectory()) await walk(path);
        else count += 1;
      }
    };
    try {
      await walk(source, true);
      return count;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return count;
      throw error;
    }
  }

  // ---------------------------------------------------------------- journal

  private journalPath(): string {
    return join(this.dataDir, JOURNAL_FILE);
  }

  private async writeJournal(journal: Journal): Promise<void> {
    await this.fs.mkdir(this.dataDir, { recursive: true });
    const temp = `${this.journalPath()}.tmp`;
    await this.fs.writeFile(temp, JSON.stringify(journal));
    await renameFile(temp, this.journalPath());
  }

  private async removeJournal(): Promise<void> {
    await this.fs.unlink(this.journalPath()).catch(() => undefined);
  }

  private async recoverJournal(): Promise<void> {
    let journal: Journal;
    try {
      journal = JSON.parse(await this.fs.readFile(this.journalPath(), "utf8")) as Journal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[owl-core] Ignoring unreadable knowledge move journal ${this.journalPath()}:`, error);
      return;
    }
    if (journal.stage === "cleaning_up" && resolve(this.currentPath) === resolve(journal.target)) {
      let warnings: KnowledgeMoveWarning[];
      let manifest: Manifest | undefined;
      if (isManifest(journal.manifest, journal.source, journal.target)) {
        manifest = journal.manifest;
      } else if (journal.manifest === undefined) {
        // Older journals did not persist a manifest. Treat a source scan only as a
        // candidate list; cleanup still requires matching source and target hashes.
        manifest = await this.scan(journal.source).catch(() => undefined);
      }
      if (manifest) {
        try {
          warnings = await this.cleanupSource(journal.source, journal.target, manifest);
        } catch (error) {
          console.warn("[owl-core] knowledge move cleanup could not be resumed", error);
          warnings = [{
            code: "source_cleanup_incomplete",
            path: journal.source,
            remaining_files: await this.countFiles(journal.source).catch(() => manifest!.files.length),
          }];
        }
      } else {
        warnings = [{
          code: "source_cleanup_incomplete",
          path: journal.source,
          remaining_files: await this.countFiles(journal.source).catch(() => 0),
        }];
      }
      this.lastMove = {
        from: journal.source,
        to: journal.target,
        mode: journal.mode,
        finished_at: this.now(),
        files: manifest?.files.length ?? 0,
        bytes: manifest?.files.reduce((sum, file) => sum + file.size, 0) ?? 0,
        warnings,
      };
    } else {
      this.interrupted = { source: journal.source, target: journal.target, stage: journal.stage, started_at: journal.started_at };
    }
    await this.removeJournal();
  }
}

function mapErrorReason(error: unknown): KnowledgeUnavailableReason {
  switch (errorCode(error)) {
    case "ENOENT": return "missing";
    case "ENOTDIR": return "not_directory";
    case "EACCES":
    case "EPERM": return "permission_denied";
    case "EROFS": return "not_writable";
    default: return "io_error";
  }
}

function mapWriteProbeErrorReason(error: unknown): KnowledgeUnavailableReason {
  switch (errorCode(error)) {
    case "EACCES":
    case "EPERM":
    case "EROFS": return "not_writable";
    default: return mapErrorReason(error);
  }
}

function mapWriteErrorReason(error: unknown): KnowledgeUnavailableReason {
  switch (errorCode(error)) {
    case "EACCES":
    case "EPERM":
    case "EROFS": return "not_writable";
    default: return mapErrorReason(error);
  }
}
