import type { PlanUsageFetchResult, PlanUsageHarness, PlanUsageOrigin, PlanUsageSnapshot, PlanUsageStatus, PlanUsageWindow, PlanUsageWindowKind, PlanUsageWindowState } from "../../../shared/dist/plan-usage.js";
import type { CoreDatabase } from "../types.js";

export interface PlanUsageRow {
  readonly harness: PlanUsageHarness;
  readonly origin: PlanUsageOrigin;
  readonly status: PlanUsageStatus;
  readonly detail: string | null;
  readonly snapshot: PlanUsageSnapshot | null;
  readonly observed_at: string | null;
  readonly checked_at: string;
}

interface StoredPlanUsageRow {
  harness: string;
  origin: string;
  status: string;
  detail: string | null;
  snapshot_json: string | null;
  observed_at: string | null;
  checked_at: string;
}

const HARNESS = new Set<PlanUsageHarness>(["claude", "codex"]);
const ORIGIN = new Set<PlanUsageOrigin>(["claude_usage_api", "claude_rate_limit_event", "codex_live", "codex_session_log"]);
const WINDOW_KIND = new Set<PlanUsageWindowKind>(["five_hour", "weekly", "weekly_opus", "weekly_sonnet", "weekly_oauth_apps", "other"]);
const WINDOW_STATE = new Set<PlanUsageWindowState>(["normal", "warning", "limited"]);
const STATUS = new Set<PlanUsageStatus>([
  "ok", "disabled", "not_configured", "not_logged_in", "expired", "unauthorized", "rate_limited",
  "unavailable", "unrecognized", "error", "not_installed", "no_data",
]);

function safeText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function safeIso(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

/** Copies only contract fields, so accidental source extras (including credentials) never reach storage. */
export function sanitizePlanUsageSnapshot(value: unknown, expected?: { harness: PlanUsageHarness; origin: PlanUsageOrigin }): PlanUsageSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!HARNESS.has(raw.harness as PlanUsageHarness) || !ORIGIN.has(raw.origin as PlanUsageOrigin)) return null;
  if (expected && (raw.harness !== expected.harness || raw.origin !== expected.origin)) return null;
  const observedAt = safeIso(raw.observed_at);
  if (!observedAt || !Array.isArray(raw.windows)) return null;
  const windows: PlanUsageWindow[] = [];
  for (const item of raw.windows) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const window = item as Record<string, unknown>;
    const id = safeText(window.id, 128);
    if (!id || !WINDOW_KIND.has(window.kind as PlanUsageWindowKind)) continue;
    const usedPercent = window.used_percent === null
      ? null
      : typeof window.used_percent === "number" && Number.isFinite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100
        ? window.used_percent
        : undefined;
    const windowMinutes = window.window_minutes === null
      ? null
      : Number.isSafeInteger(window.window_minutes) && Number(window.window_minutes) > 0
        ? Number(window.window_minutes)
        : undefined;
    const resetsAt = window.resets_at === null ? null : safeIso(window.resets_at);
    const state = window.state === null
      ? null
      : WINDOW_STATE.has(window.state as PlanUsageWindowState)
        ? window.state as PlanUsageWindowState
        : undefined;
    const label = window.label === null ? null : safeText(window.label, 128);
    if (usedPercent === undefined || windowMinutes === undefined || (window.resets_at !== null && resetsAt === null)
      || state === undefined || (window.label !== null && label === null)) continue;
    windows.push({
      id,
      kind: window.kind as PlanUsageWindowKind,
      used_percent: usedPercent,
      resets_at: resetsAt,
      window_minutes: windowMinutes,
      state,
      label,
    });
  }
  if (windows.length === 0) return null;
  const planType = raw.plan_type === null
    ? null
    : typeof raw.plan_type === "string" && /^[a-z0-9_-]{1,32}$/iu.test(raw.plan_type)
      ? raw.plan_type
      : null;
  return {
    harness: raw.harness as PlanUsageHarness,
    origin: raw.origin as PlanUsageOrigin,
    windows,
    plan_type: planType,
    observed_at: observedAt,
  };
}

export function sanitizePlanUsageStatus(value: unknown): PlanUsageStatus {
  return STATUS.has(value as PlanUsageStatus) ? value as PlanUsageStatus : "error";
}

export function sanitizePlanUsageDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^http_[1-5][0-9]{2}$/u.test(value)) return value;
  return new Set([
    "source_threw", "invalid_result", "unrecognized_response", "network", "timeout", "redirect",
    "keychain_timeout", "keychain_error", "file_unreadable", "invalid_json", "no_access_token",
  ]).has(value) ? value : null;
}

export class PlanUsageStore {
  private warnedAboutSnapshot = false;
  private warnedAboutRead = false;

  public constructor(private readonly db: CoreDatabase) {}

  public list(): PlanUsageRow[] {
    let rows: StoredPlanUsageRow[];
    try {
      rows = this.db.all<StoredPlanUsageRow>(
        "SELECT harness, origin, status, detail, snapshot_json, observed_at, checked_at FROM plan_usage_snapshots ORDER BY harness, origin",
      );
    } catch (error) {
      if (!this.warnedAboutRead) {
        this.warnedAboutRead = true;
        console.warn("[owl-plan-usage] Could not read plan usage snapshots.", error);
      }
      return [];
    }
    return rows.flatMap((row) => {
      if (!HARNESS.has(row.harness as PlanUsageHarness) || !ORIGIN.has(row.origin as PlanUsageOrigin) || !STATUS.has(row.status as PlanUsageStatus)) return [];
      let snapshot: PlanUsageSnapshot | null = null;
      if (row.snapshot_json !== null) {
        try {
          snapshot = sanitizePlanUsageSnapshot(JSON.parse(row.snapshot_json) as unknown, {
            harness: row.harness as PlanUsageHarness,
            origin: row.origin as PlanUsageOrigin,
          });
          if (!snapshot) this.warnInvalidSnapshot();
        } catch {
          this.warnInvalidSnapshot();
        }
      }
      return [{
        harness: row.harness as PlanUsageHarness,
        origin: row.origin as PlanUsageOrigin,
        status: row.status as PlanUsageStatus,
        detail: sanitizePlanUsageDetail(row.detail),
        snapshot,
        observed_at: row.observed_at,
        checked_at: row.checked_at,
      }];
    });
  }

  public recordCheck(result: PlanUsageFetchResult & { readonly harness: PlanUsageHarness; readonly origin: PlanUsageOrigin }, checkedAt: string): Promise<void> {
    const status = sanitizePlanUsageStatus(result.status);
    const snapshot = status === "ok" ? sanitizePlanUsageSnapshot(result.snapshot, { harness: result.harness, origin: result.origin }) : null;
    const snapshotJson = snapshot ? JSON.stringify(snapshot) : null;
    const detail = sanitizePlanUsageDetail(result.detail);
    return this.db.createWriteLane().transact((tx) => {
      tx.run(
        `INSERT INTO plan_usage_snapshots (harness, origin, status, detail, snapshot_json, observed_at, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(harness, origin) DO UPDATE SET
           status = excluded.status,
           detail = excluded.detail,
           snapshot_json = CASE WHEN excluded.status = 'ok' THEN excluded.snapshot_json ELSE plan_usage_snapshots.snapshot_json END,
           observed_at = CASE WHEN excluded.status = 'ok' THEN excluded.observed_at ELSE plan_usage_snapshots.observed_at END,
           checked_at = excluded.checked_at`,
        result.harness,
        result.origin,
        status,
        detail,
        snapshotJson,
        snapshot?.observed_at ?? null,
        checkedAt,
      );
    });
  }

  public recordObservation(snapshot: PlanUsageSnapshot, checkedAt: string): Promise<void> {
    const sanitized = sanitizePlanUsageSnapshot(snapshot);
    if (!sanitized) return Promise.resolve();
    return this.db.createWriteLane().transact((tx) => {
      tx.run(
        `INSERT INTO plan_usage_snapshots (harness, origin, status, detail, snapshot_json, observed_at, checked_at)
         VALUES (?, ?, 'ok', NULL, ?, ?, ?)
         ON CONFLICT(harness, origin) DO UPDATE SET
           status = 'ok', detail = NULL, snapshot_json = excluded.snapshot_json,
           observed_at = excluded.observed_at, checked_at = excluded.checked_at`,
        sanitized.harness,
        sanitized.origin,
        JSON.stringify(sanitized),
        sanitized.observed_at,
        checkedAt,
      );
    });
  }

  private warnInvalidSnapshot(): void {
    if (this.warnedAboutSnapshot) return;
    this.warnedAboutSnapshot = true;
    console.warn("[owl-plan-usage] Could not parse a stored plan usage snapshot.");
  }
}
