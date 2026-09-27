import type { RateLimitInfo } from "@owl/shared";

export type RateLimitHarness = "claude" | "codex";

export type RateLimitResetInput =
  | { readonly kind: "event"; readonly event: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "retry_after"; readonly value: string | number };

export interface RateLimitParseOptions {
  readonly harness?: RateLimitHarness | null;
  readonly timeZone?: string;
}

export type EventResetParser = (event: unknown, now: Date) => Date | null;
export interface TextResetParser {
  readonly name: string;
  parse(text: string, now: Date, timeZone: string): Date | null;
}

const DAY_MS = 24 * 60 * 60_000;
const MAX_RESET_AHEAD_MS = 8 * DAY_MS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericDate(value: unknown): Date | null {
  if (typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Number(value))) {
    value = Number(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) > 1e12 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return new Date(milliseconds);
  }
  return null;
}

function normalized(date: Date | null, now: Date): Date | null {
  if (date === null || Number.isNaN(date.getTime())) return null;
  if (date.getTime() <= now.getTime()) return new Date(now.getTime() + 60_000);
  if (date.getTime() > now.getTime() + MAX_RESET_AHEAD_MS) return null;
  return date;
}

function claudeEventReset(event: unknown): Date | null {
  if (!isRecord(event)) return null;
  const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : null;
  if (info === null || info.status !== "rejected") return null;
  const direct = numericDate(info.resetsAt);
  if (direct !== null) return direct;
  const windows = isRecord(info.unifiedWindows) ? Object.values(info.unifiedWindows) : [];
  const resets = windows
    .filter(isRecord)
    .map((window) => numericDate(window.resetsAt))
    .filter((date): date is Date => date !== null)
    .sort((left, right) => right.getTime() - left.getTime());
  return resets[0] ?? null;
}

function codexEventReset(event: unknown, now: Date): Date | null {
  const candidates: { date: Date; used: number | null }[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (!isRecord(value) || depth > 7 || seen.has(value)) return;
    seen.add(value);
    const used = typeof value.used_percent === "number" ? value.used_percent : null;
    for (const key of ["resets_at", "resetsAt"]) {
      const date = numericDate(value[key]);
      if (date !== null) candidates.push({ date, used });
    }
    for (const key of ["resets_in_seconds", "resetsInSeconds"]) {
      const seconds = value[key];
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
        candidates.push({ date: new Date(now.getTime() + seconds * 1000), used });
      }
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  };
  visit(event, 0);
  const saturated = candidates.filter((candidate) => candidate.used !== null && candidate.used >= 100);
  const pool = saturated.length > 0 ? saturated : candidates;
  return pool.sort((left, right) => right.date.getTime() - left.date.getTime())[0]?.date ?? null;
}

function parseUsageEpoch(text: string): Date | null {
  const match = text.match(/usage\s+limit\s+reached\s*\|\s*(\d{10,13})/iu);
  return match ? numericDate(match[1]) : null;
}

function localParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } | null {
  try {
    const fields = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: string): number => Number(fields.find((field) => field.type === type)?.value);
    const result = { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute") };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

function localDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  let instant = Date.UTC(year, month - 1, day, hour, minute);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = localParts(new Date(instant), timeZone);
      if (parts === null) return null;
      const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
      const delta = Date.UTC(year, month - 1, day, hour, minute) - represented;
      if (delta === 0) break;
      instant += delta;
    }
  } catch {
    return null;
  }
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const actual = localParts(date, timeZone);
  return actual !== null
    && actual.year === year
    && actual.month === month
    && actual.day === day
    && actual.hour === hour
    && actual.minute === minute
    ? date
    : null;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function to24Hour(hour: number, suffix: string | undefined): number | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > (suffix ? 12 : 23)) return null;
  if (!suffix) return hour;
  if (hour === 0) return null;
  const upper = suffix.toUpperCase();
  return (hour % 12) + (upper === "PM" ? 12 : 0);
}

function parseLocalClock(text: string, now: Date, defaultTimeZone: string): Date | null {
  const zone = text.match(/\(([^)]+)\)\s*$/u)?.[1]?.trim() || defaultTimeZone;
  const source = text.replace(/\s*\([^)]+\)\s*$/u, "");
  const nowLocal = localParts(now, zone);
  if (nowLocal === null) return null;
  const monthPattern = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
  const weekday = "(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\\.?[,]?\\s*)?";
  const monthDate = new RegExp(
    `(?:${weekday})(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s*(?:(\\d{4})[,]?\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*(AM|PM)`,
    "iu",
  ).exec(source);
  if (monthDate) {
    const month = MONTHS[monthDate[1].toLowerCase()];
    const day = Number(monthDate[2]);
    const year = monthDate[3] === undefined ? nowLocal.year : Number(monthDate[3]);
    const hour = to24Hour(Number(monthDate[4]), monthDate[6]);
    const minute = Number(monthDate[5] ?? 0);
    if (month === undefined || hour === null || day < 1 || day > 31 || minute > 59) return null;
    let date = localDateTime(year, month, day, hour, minute, zone);
    if (date === null) return null;
    if (monthDate[3] === undefined && date.getTime() <= now.getTime()) {
      date = localDateTime(year + 1, month, day, hour, minute, zone);
    }
    return date;
  }

  const clock = /(?:resets|try\s+again\s+at)\s+(?:on\s+)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\b/iu.exec(source);
  if (!clock) return null;
  const hour = to24Hour(Number(clock[1]), clock[3]);
  const minute = Number(clock[2] ?? 0);
  if (hour === null || minute > 59) return null;
  let date = localDateTime(nowLocal.year, nowLocal.month, nowLocal.day, hour, minute, zone);
  if (date !== null && date.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day + 1));
    date = localDateTime(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute, zone);
  }
  return date;
}

function parseRelativeWait(text: string, now: Date): Date | null {
  const marker = /try\s+again\s+in\s+(.+?)(?:[.!\n]|$)/iu.exec(text);
  if (!marker) return null;
  const units = /(?:^|\s)(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/giu;
  let seconds = 0;
  let match: RegExpExecArray | null;
  while ((match = units.exec(marker[1])) !== null) {
    const unit = match[2].toLowerCase();
    const amount = Number(match[1]);
    const multiplier = unit === "s" || unit.startsWith("sec") ? 1
      : unit === "m" || unit.startsWith("min") ? 60
        : unit === "h" || unit.startsWith("hr") || unit.startsWith("hour") ? 3600
          : 86400;
    seconds += amount * multiplier;
  }
  return seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null;
}

const claudeTextParsers: readonly TextResetParser[] = [
  { name: "usage-limit-epoch", parse: (text) => parseUsageEpoch(text) },
  { name: "resets-clock", parse: parseLocalClock },
];

const codexTextParsers: readonly TextResetParser[] = [
  { name: "try-again-relative", parse: parseRelativeWait },
  { name: "try-again-at", parse: parseLocalClock },
  { name: "usage-limit-epoch", parse: (text) => parseUsageEpoch(text) },
];

const genericTextParsers: readonly TextResetParser[] = [
  { name: "usage-limit-epoch", parse: (text) => parseUsageEpoch(text) },
];

export const RATE_LIMIT_EVENT_PARSERS: Readonly<Record<RateLimitHarness, readonly EventResetParser[]>> = {
  claude: [(event) => claudeEventReset(event)],
  codex: [(event, now) => codexEventReset(event, now)],
};

export const RATE_LIMIT_TEXT_PARSERS: Readonly<Record<RateLimitHarness | "generic", readonly TextResetParser[]>> = {
  claude: claudeTextParsers,
  codex: codexTextParsers,
  generic: genericTextParsers,
};

export function rateLimitHarness(harnessOrAdapter: string): RateLimitHarness | null {
  const normalized = harnessOrAdapter.trim().toLowerCase();
  if (normalized === "claude" || normalized === "anthropic" || normalized.startsWith("claude-cli/")) return "claude";
  if (normalized === "codex" || normalized === "openai" || normalized === "openai/codex" || normalized.startsWith("codex-cli/")) return "codex";
  return null;
}

function parseRetryAfter(value: string | number, now: Date): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return new Date(now.getTime() + value * 1000);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return new Date(now.getTime() + Number(trimmed) * 1000);
  return numericDate(trimmed);
}

/** Reads one piece of evidence. Never throws; returns a normalized Date or null. */
export function parseRateLimitReset(input: RateLimitResetInput, now: Date, options: RateLimitParseOptions = {}): Date | null {
  try {
    let result: Date | null = null;
    if (input.kind === "retry_after") {
      result = parseRetryAfter(input.value, now);
    } else if (input.kind === "event") {
      const harness = options.harness;
      const parsers = harness ? RATE_LIMIT_EVENT_PARSERS[harness] : [];
      for (const parser of parsers) {
        result = parser(input.event, now);
        if (result !== null) break;
      }
    } else {
      const harness = options.harness;
      const parsers = [
        ...(harness ? RATE_LIMIT_TEXT_PARSERS[harness] : []),
        ...RATE_LIMIT_TEXT_PARSERS.generic,
      ];
      const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      for (const parser of parsers) {
        result = parser.parse(input.text, now, timeZone);
        if (result !== null) break;
      }
    }
    return normalized(result, now);
  } catch {
    return null;
  }
}

/** Picks evidence by event, text, retry-after priority; newer evidence wins within a kind. */
export function resolveRateLimitReset(
  inputs: readonly RateLimitResetInput[],
  now: Date,
  options: RateLimitParseOptions = {},
): RateLimitInfo {
  for (const kind of ["event", "text", "retry_after"] as const) {
    for (let index = inputs.length - 1; index >= 0; index -= 1) {
      const input = inputs[index];
      if (input?.kind !== kind) continue;
      const date = parseRateLimitReset(input, now, options);
      if (date !== null) return { resets_at: date.toISOString(), source: kind };
    }
  }
  return { resets_at: null, source: null };
}

/** Extracts structured reset evidence from a Claude one-shot result wrapper. */
export function claudeRateLimitEvidence(wrapper: Record<string, unknown>): RateLimitResetInput[] {
  const evidence: RateLimitResetInput[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (!isRecord(value) || depth > 7 || seen.has(value)) return;
    seen.add(value);
    if (value.type === "rate_limit_event" || isRecord(value.rate_limit_info)) {
      evidence.push({ kind: "event", event: value });
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  };
  visit(wrapper, 0);
  return evidence;
}

/** Extracts reset snapshots and structured usage-limit errors from Codex JSONL. */
export function codexRateLimitEvidence(rawJsonl: string): RateLimitResetInput[] {
  const evidence: RateLimitResetInput[] = [];
  const seen = new Set<object>();
  const visitRetryAfter = (value: unknown, depth: number): void => {
    if (!isRecord(value) || depth > 7 || seen.has(value)) return;
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (key.toLowerCase().replace(/_/gu, "-") === "retry-after" && (typeof nested === "string" || typeof nested === "number")) {
        evidence.push({ kind: "retry_after", value: nested });
      } else {
        visitRetryAfter(nested, depth + 1);
      }
    }
  };
  for (const rawLine of rawJsonl.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    visitRetryAfter(event, 0);
    const hasResetSnapshot = isRecord(event.rate_limits) || isRecord(event.rateLimits);
    const error = isRecord(event.error) ? event.error : isRecord(event.turn) && isRecord(event.turn.error) ? event.turn.error : null;
    const code = isRecord(error?.codexErrorInfo)
      ? error.codexErrorInfo.kind ?? error.codexErrorInfo.type ?? error.codexErrorInfo.code
      : null;
    if (hasResetSnapshot || code === "usageLimitExceeded") evidence.push({ kind: "event", event });
  }
  const textRetryAfter = /\bretry-after\s*:\s*([^\r\n]+)/giu;
  let retryMatch: RegExpExecArray | null;
  while ((retryMatch = textRetryAfter.exec(rawJsonl)) !== null) {
    evidence.push({ kind: "retry_after", value: retryMatch[1].trim() });
  }
  return evidence;
}
