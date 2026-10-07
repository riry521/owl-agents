import type { PlanUsageSnapshot, PlanUsageWindow } from "./plan-usage.js";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(record: RecordValue, snake: string, camel: string): unknown {
  return record[snake] !== undefined ? record[snake] : record[camel];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function epochIso(value: unknown): string | null {
  try {
    let milliseconds: number;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      const digits = String(value).length;
      if (digits <= 10) milliseconds = value * 1000;
      else if (digits === 13) milliseconds = value;
      else return null;
    } else if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) return null;
      milliseconds = parsed;
    } else {
      return null;
    }
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

/** Finds a rate-limits object in one parsed JSON record (fixed paths only, no deep search). */
export function findCodexRateLimits(record: unknown): unknown | null {
  if (!isRecord(record)) return null;
  const candidates: unknown[] = [
    record.rate_limits,
    record.rateLimits,
    isRecord(record.payload) ? record.payload.rate_limits : null,
    isRecord(record.msg) ? record.msg.rate_limits : null,
    isRecord(record.params) ? record.params.rateLimits : null,
  ];
  return candidates.find(isRecord) ?? null;
}

/** rate_limits / rateLimits object → snapshot. null when no window is readable. */
export function codexRateLimitsObservation(
  rateLimits: unknown,
  observedAt: Date,
  origin: "codex_live" | "codex_session_log",
): PlanUsageSnapshot | null {
  try {
    if (!isRecord(rateLimits) || !(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) return null;
    const observed_at = observedAt.toISOString();
    const windows: PlanUsageWindow[] = [];

    for (const id of ["primary", "secondary"] as const) {
      const raw = rateLimits[id];
      if (!isRecord(raw)) continue;

      const rawUsed = finiteNumber(pick(raw, "used_percent", "usedPercent"));
      const used_percent = rawUsed !== null && rawUsed >= 0 && rawUsed <= 100
        ? Math.round(rawUsed * 10) / 10
        : null;
      const rawMinutes = finiteNumber(pick(raw, "window_minutes", "windowDurationMins"));
      const window_minutes = rawMinutes !== null && Number.isSafeInteger(rawMinutes) && rawMinutes > 0
        ? rawMinutes
        : null;

      const rawReset = pick(raw, "resets_at", "resetsAt");
      let resets_at = epochIso(rawReset);
      if (resets_at === null) {
        const relative = finiteNumber(pick(raw, "resets_in_seconds", "resetsInSeconds"));
        if (relative !== null) resets_at = epochIso(observedAt.getTime() + relative * 1000);
      }

      if (used_percent === null && window_minutes === null && resets_at === null) continue;
      const kind = window_minutes === 300 ? "five_hour" : window_minutes === 10080 ? "weekly" : "other";
      windows.push({
        id,
        kind,
        used_percent,
        resets_at,
        window_minutes,
        state: used_percent !== null && used_percent >= 100 ? "limited" : null,
        label: kind === "other" ? (window_minutes === null ? id : `${window_minutes}m`) : null,
      });
    }

    if (windows.length === 0) return null;
    const rawPlanType = rateLimits.plan_type ?? rateLimits.planType;
    const plan_type = typeof rawPlanType === "string" && /^[a-z0-9_-]{1,32}$/i.test(rawPlanType)
      ? rawPlanType
      : null;
    return { harness: "codex", origin, windows, plan_type, observed_at };
  } catch {
    return null;
  }
}

/** Latest snapshot in a JSONL text (codex exec --json stdout). origin "codex_live". */
export function codexRateLimitsFromJsonl(text: string, observedAt: Date): PlanUsageSnapshot | null {
  try {
    if (typeof text !== "string") return null;
    const lines = text.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes("ate_limits") && !line.includes("rateLimits")) continue;
      try {
        const rateLimits = findCodexRateLimits(JSON.parse(line) as unknown);
        if (rateLimits === null) continue;
        const snapshot = codexRateLimitsObservation(rateLimits, observedAt, "codex_live");
        if (snapshot !== null) return snapshot;
      } catch {
        // A malformed event does not invalidate the rest of the output.
      }
    }
    return null;
  } catch {
    return null;
  }
}
