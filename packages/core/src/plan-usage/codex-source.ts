import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PlanUsageFetchResult, PlanUsageSnapshot, PlanUsageSource } from "../../../shared/dist/plan-usage.js";
import { codexRateLimitsObservation, findCodexRateLimits } from "../../../shared/dist/plan-usage-codex.js";

export interface CodexSessionLogSourceOptions {
  readonly codexHome?: string;
  readonly now?: () => Date;
  readonly maxDayDirs?: number;
  readonly maxFiles?: number;
  readonly tailBytes?: number;
  readonly maxBytesPerFile?: number;
}

interface Candidate {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface Cache {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly snapshot: PlanUsageSnapshot;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isDirectory(entry: { isDirectory(): boolean }): boolean {
  try { return entry.isDirectory(); } catch { return false; }
}

async function childDirectories(path: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => pattern.test(entry.name) && isDirectory(entry))
    .map((entry) => join(path, entry.name))
    .sort((a, b) => b.localeCompare(a));
}

async function findCandidates(sessionsPath: string, maxDayDirs: number, maxFiles: number): Promise<Candidate[]> {
  const dayDirs: string[] = [];
  const years = await childDirectories(sessionsPath, /^\d{4}$/u);
  for (const year of years) {
    for (const month of await childDirectories(year, /^\d{2}$/u)) {
      for (const day of await childDirectories(month, /^\d{2}$/u)) {
        dayDirs.push(day);
        if (dayDirs.length >= maxDayDirs) break;
      }
      if (dayDirs.length >= maxDayDirs) break;
    }
    if (dayDirs.length >= maxDayDirs) break;
  }

  const candidates: Candidate[] = [];
  for (const dayDir of dayDirs) {
    const files = await readdir(dayDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.name.startsWith("rollout-") || !file.name.endsWith(".jsonl") || !file.isFile()) continue;
      const path = join(dayDir, file.name);
      try {
        const info = await stat(path);
        candidates.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // A session file may be rotated or removed while it is being enumerated.
      }
    }
    if (candidates.length >= maxFiles && dayDirs.indexOf(dayDir) >= 1) break;
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path)).slice(0, maxFiles);
}

function observedDate(record: unknown, fallback: Date): Date {
  if (typeof record === "object" && record !== null && !Array.isArray(record)) {
    const timestamp = (record as Record<string, unknown>).timestamp;
    if (typeof timestamp === "string") {
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed)) return new Date(parsed);
    }
  }
  return fallback;
}

async function snapshotFromFile(candidate: Candidate, tailBytes: number, maxBytesPerFile: number): Promise<PlanUsageSnapshot | null> {
  const handle = await open(candidate.path, "r");
  try {
    const readLimit = Math.min(candidate.size, maxBytesPerFile);
    let end = candidate.size;
    let total = 0;
    let text = "";
    const fallbackDate = new Date(candidate.mtimeMs);

    while (end > 0 && total < readLimit) {
      const length = Math.min(tailBytes, readLimit - total, end);
      const start = end - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead <= 0) break;
      text = `${buffer.subarray(0, bytesRead).toString("utf8")}${text}`;
      total += bytesRead;
      end = start;

      const lines = text.split(/\r?\n/u);
      if (end > 0) lines.shift(); // The first line starts before this tail segment.
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.includes("rate_limits")) continue;
        try {
          const record: unknown = JSON.parse(line);
          const rateLimits = findCodexRateLimits(record);
          if (rateLimits === null) continue;
          const snapshot = codexRateLimitsObservation(rateLimits, observedDate(record, fallbackDate), "codex_session_log");
          if (snapshot !== null) return snapshot;
        } catch {
          // Ignore incomplete or malformed JSONL rows.
        }
      }
      if (bytesRead < length) break;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function result(status: PlanUsageFetchResult["status"], detail: string | null = null): PlanUsageFetchResult {
  return { status, snapshot: null, detail };
}

export function createCodexSessionLogSource(options: CodexSessionLogSourceOptions = {}): PlanUsageSource {
  const codexHome = options.codexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const now = options.now ?? (() => new Date());
  const maxDayDirs = positiveInteger(options.maxDayDirs, 8);
  const maxFiles = positiveInteger(options.maxFiles, 30);
  const tailBytes = positiveInteger(options.tailBytes, 256 * 1024);
  const maxBytesPerFile = positiveInteger(options.maxBytesPerFile, 2 * 1024 * 1024);
  let cache: Cache | null = null;

  return {
    harness: "codex",
    origin: "codex_session_log",
    async fetch(_signal: AbortSignal): Promise<PlanUsageFetchResult> {
      try {
        const sessionsPath = join(codexHome, "sessions");
        try {
          await stat(sessionsPath);
        } catch (error) {
          if (isNotFound(error)) return result("not_installed");
          throw error;
        }

        const candidates = await findCandidates(sessionsPath, maxDayDirs, maxFiles);
        if (candidates.length === 0) {
          cache = null;
          return result("no_data", "no_sessions");
        }
        const newest = candidates[0];
        if (cache !== null && cache.path === newest.path && cache.mtimeMs === newest.mtimeMs && cache.size === newest.size) {
          return { status: "ok", snapshot: cache.snapshot, detail: null };
        }

        for (const candidate of candidates) {
          try {
            const snapshot = await snapshotFromFile(candidate, tailBytes, maxBytesPerFile);
            if (snapshot === null) continue;
            cache = candidate === newest
              ? { path: candidate.path, mtimeMs: candidate.mtimeMs, size: candidate.size, snapshot }
              : null;
            return { status: "ok", snapshot, detail: null };
          } catch {
            // An unreadable or concurrently removed session does not hide older logs.
          }
        }
        cache = null;
        return result("no_data", "no_rate_limits");
      } catch {
        return result("error", "source_threw");
      }
    },
  };
}
