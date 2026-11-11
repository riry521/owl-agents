import { matchesAnyGlob } from "@owl/shared/glob";
import type { RemakeLimitSettings } from "@owl/shared/remake-limit-settings";

/** One measured file: repo-relative path and the content hash (or "deleted" / "special:<code>" / "conflict"). */
export interface MeasuredFile {
  readonly path: string;
  readonly hash: string;
}

/** One (task, lineage generation) with its last change measurement and the baseline it is compared to. */
export interface RemakeUnit {
  readonly task_id: string;
  readonly generation: number;
  readonly task_type: string;
  /** False when Core could not measure the unit's changes. */
  readonly measured: boolean;
  readonly files: readonly MeasuredFile[];
  /** The previous measurement this unit builds on; null when that one could not be measured. */
  readonly baseline: readonly MeasuredFile[] | null;
  /** The Task was marked base-sync-only when this unit was measured: it neither extends nor breaks the non-functional streak. */
  readonly base_sync_only: boolean;
}

export type RemakeUnitClass = "original" | "neutral" | "functional" | "non_functional";
export type RemakeGateReason =
  | "lineage_review_attempts"
  | "lineage_worker_runs";


/** Paths that differ from the baseline: changed or new in the unit, or present in the baseline but gone from the unit. */
export function touchedPaths(files: readonly MeasuredFile[], baseline: readonly MeasuredFile[]): string[] {
  const before = new Map(baseline.map((file) => [file.path, file.hash]));
  const after = new Map(files.map((file) => [file.path, file.hash]));
  const touched = new Set<string>();
  for (const [path, hash] of after) if (before.get(path) !== hash || hash === "conflict") touched.add(path);
  for (const path of before.keys()) if (!after.has(path)) touched.add(path);
  return [...touched].sort();
}

export function classifyRemakeUnit(unit: RemakeUnit, settings: RemakeLimitSettings): { kind: RemakeUnitClass; touched: string[] } {
  if (unit.base_sync_only) return { kind: "neutral", touched: [] };
  if (unit.generation <= 1) return { kind: "original", touched: [] };
  if (!settings.checked_task_types.includes(unit.task_type) || !unit.measured || unit.baseline === null) return { kind: "neutral", touched: [] };
  const touched = touchedPaths(unit.files, unit.baseline);
  const functional = touched.some((path) => !matchesAnyGlob(path, settings.verification_paths));
  return { kind: functional ? "functional" : "non_functional", touched };
}

export function evaluateRemakeGate(
  usage: { readonly review_attempts: number; readonly worker_runs: number },
  settings: RemakeLimitSettings,
): { blocked: false } | { blocked: true; reason: RemakeGateReason } {
  if (usage.review_attempts >= settings.lineage_review_attempts) return { blocked: true, reason: "lineage_review_attempts" };
  if (usage.worker_runs >= settings.lineage_worker_runs) return { blocked: true, reason: "lineage_worker_runs" };
  return { blocked: false };
}
