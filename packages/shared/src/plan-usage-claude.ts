import type {
  PlanUsageSnapshot,
  PlanUsageWindow,
  PlanUsageWindowKind,
  PlanUsageWindowState,
} from "./plan-usage.js";

const kindByKey = new Map<string, PlanUsageWindowKind>([
  ["five_hour", "five_hour"],
  ["seven_day", "weekly"],
  ["seven_day_opus", "weekly_opus"],
  ["seven_day_sonnet", "weekly_sonnet"],
  ["seven_day_oauth_apps", "weekly_oauth_apps"],
]);
const sortOrder = new Map<PlanUsageWindowKind, number>([
  ["five_hour", 0], ["weekly", 1], ["weekly_opus", 2], ["weekly_sonnet", 3], ["weekly_oauth_apps", 4], ["other", 5],
]);
const keyPattern = /^[a-z0-9_]{1,64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isoDate(value: unknown): string | null {
  try {
    let time: number;
    if (typeof value === "number" && Number.isFinite(value)) {
      time = Math.abs(value) < 1e12 ? value * 1000 : value;
    } else if (typeof value === "string") {
      time = Date.parse(value);
    } else {
      return null;
    }
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  } catch {
    return null;
  }
}

function observedIso(value: Date): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const bounded = Math.max(0, Math.min(100, value));
  return Math.round(bounded * 10) / 10;
}

function eventPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return percent(value <= 1 ? value * 100 : value);
}

function minutes(kind: PlanUsageWindowKind): number | null {
  if (kind === "five_hour") return 300;
  if (kind === "weekly" || kind === "weekly_opus" || kind === "weekly_sonnet" || kind === "weekly_oauth_apps") return 10080;
  return null;
}

function sortWindows(windows: PlanUsageWindow[]): PlanUsageWindow[] {
  return windows.sort((left, right) => {
    const kindDiff = (sortOrder.get(left.kind) ?? 5) - (sortOrder.get(right.kind) ?? 5);
    if (kindDiff) return kindDiff;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function makeWindow(
  id: string,
  usedPercent: number | null,
  resetsAt: string | null,
  state: PlanUsageWindowState | null,
): PlanUsageWindow {
  const kind = claudeWindowKind(id);
  return {
    id,
    kind,
    used_percent: usedPercent,
    resets_at: resetsAt,
    window_minutes: minutes(kind),
    state,
    label: kind === "other" ? id : null,
  };
}

function snapshot(
  origin: PlanUsageSnapshot["origin"],
  windows: PlanUsageWindow[],
  observedAt: string,
  planType: string | null,
): PlanUsageSnapshot | null {
  if (windows.length === 0) return null;
  return { harness: "claude", origin, windows: sortWindows(windows).slice(0, 12), plan_type: planType, observed_at: observedAt };
}

/** Parses a 200 body of GET /api/oauth/usage. null when no window could be read. */
export function parseClaudeUsageResponse(body: unknown, observedAt: Date, planType: string | null): PlanUsageSnapshot | null {
  try {
    const input = record(body);
    const observed = observedIso(observedAt);
    if (!input || !observed) return null;
    const windows: PlanUsageWindow[] = [];
    for (const key of Object.keys(input)) {
      if (!keyPattern.test(key)) continue;
      const value = record(input[key]);
      if (!value || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)) continue;
      windows.push(makeWindow(key, percent(value.utilization), isoDate(value.resets_at), null));
    }
    const safePlanType = typeof planType === "string" && /^[a-z0-9_-]{1,32}$/i.test(planType) ? planType : null;
    return snapshot("claude_usage_api", windows, observed, safePlanType);
  } catch {
    return null;
  }
}

/** One stream-json rate_limit_event → snapshot (origin "claude_rate_limit_event"). null when unreadable. */
export function claudeRateLimitEventObservation(event: unknown, observedAt: Date): PlanUsageSnapshot | null {
  try {
    const info = record(record(event)?.rate_limit_info);
    const observed = observedIso(observedAt);
    if (!info || !observed) return null;
    const states = new Map<string, PlanUsageWindowState>([
      ["allowed", "normal"], ["allowed_warning", "warning"], ["rejected", "limited"],
    ]);
    const state = typeof info.status === "string" ? states.get(info.status) ?? null : null;
    const windows = new Map<string, PlanUsageWindow>();
    const id = info.rateLimitType;
    if (typeof id === "string" && keyPattern.test(id)) {
      const mainPercent = eventPercent(info.utilization);
      const mainReset = typeof info.resetsAt === "number" ? isoDate(info.resetsAt * 1000) : null;
      if (mainPercent !== null || mainReset !== null || state !== null) {
        windows.set(id, makeWindow(id, mainPercent, mainReset, state));
      }
    }

    const unified = record(info.unifiedWindows);
    if (unified) {
      for (const key of Object.keys(unified)) {
        if (!keyPattern.test(key)) continue;
        const value = record(unified[key]);
        if (!value) continue;
        const usedPercent = eventPercent(value.utilization);
        const resetsAt = typeof value.resetsAt === "number" ? isoDate(value.resetsAt * 1000) : null;
        if (usedPercent === null && resetsAt === null) continue;
        const prior = windows.get(key);
        const parsed = makeWindow(key, usedPercent, resetsAt, null);
        windows.set(key, prior ? {
          ...prior,
          used_percent: prior.used_percent ?? parsed.used_percent,
          resets_at: prior.resets_at ?? parsed.resets_at,
          state: prior.state ?? parsed.state,
        } : parsed);
      }
    }
    return snapshot("claude_rate_limit_event", [...windows.values()], observed, null);
  } catch {
    return null;
  }
}

/** Kind of a Claude window key. Uses a Map (no plain-object lookup of untrusted keys). */
export function claudeWindowKind(key: string): PlanUsageWindowKind {
  return kindByKey.get(key) ?? "other";
}
