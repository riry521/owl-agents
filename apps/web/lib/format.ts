import type {
  AgentRun,
  AgentRunStatus,
  RFC3339,
  TaskState,
  ULID,
  WorkState,
} from '@/lib/types';
import type { Locale } from '@/lib/i18n';
import jaDict from '@/lib/i18n/ja.json';
import enDict from '@/lib/i18n/en.json';

export { asReportEnvelope } from '@/lib/work-detail-safety.mjs';

const dicts = { ja: jaDict, en: enDict } as const;

// ---- state labels ----------------------------------------------------------

/** Locale-aware Work state names. */
export function workStateLabels(locale: Locale): Record<WorkState, string> {
  return dicts[locale].format.workState as Record<WorkState, string>;
}

/** Locale-aware Task state names. */
export function taskStateLabels(locale: Locale): Record<TaskState, string> {
  return dicts[locale].format.taskState as Record<TaskState, string>;
}

/** Locale-aware Agent run status labels. */
export function agentStatusLabels(locale: Locale): Record<AgentRunStatus, string> {
  return dicts[locale].format.agentStatus as Record<AgentRunStatus, string>;
}

/** Return a displayable label for known or unexpected API enum values. */
export function safeEnumLabel(labels: unknown, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '—';
  if (labels === null || typeof labels !== 'object') return value;
  try {
    if (!Object.prototype.hasOwnProperty.call(labels, value)) return value;
    const label = (labels as Record<string, unknown>)[value];
    return typeof label === 'string' && label.length > 0 ? label : value;
  } catch {
    return value;
  }
}

/** Board section a Work belongs to (ordered, plus a distinct cancelled section). */
export type BoardSection = 'judgement' | 'running' | 'waiting' | 'done' | 'cancelled';

/** Locale-aware Board section labels. */
export function boardSectionLabels(locale: Locale): Record<BoardSection, string> {
  return dicts[locale].format.boardSection as Record<BoardSection, string>;
}

export function boardSectionOf(state: WorkState): BoardSection {
  switch (state) {
    case 'judgement_waiting':
      return 'judgement';
    case 'running':
      return 'running';
    case 'memo':
    case 'ready':
    case 'paused':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      // Keep an unexpected API state visible in the waiting section rather
      // than indexing the Board's groups with undefined and crashing render.
      return 'waiting';
  }
}

/** Return a valid positive Work display number, or null for legacy/invalid values. */
export function workDisplayNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// ---- role / agent labels ------------------------------------------------------

const ROLE_DISPLAY: Record<string, string> = {
  advisor: 'Advisor',
  manager: 'Manager',
  designer: 'Designer',
  lead_designer: 'Lead Designer',
  worker: 'Worker',
  reviewer: 'Reviewer',
  librarian: 'Librarian',
  curator: 'Curator',
};

export function roleDisplayName(role: string, locale: Locale = 'ja'): string {
  if (typeof role !== 'string' || role.length === 0) return '—';
  // Child runs (Hybrid executors / detected agent CLIs) read as "Subagent".
  if (role === 'executor') return dicts[locale].format.roleExecutor;
  return Object.prototype.hasOwnProperty.call(ROLE_DISPLAY, role) ? ROLE_DISPLAY[role] : role;
}

/**
 * - manager → plain "Manager" (no ordinal, no provider)
 * - other roles → locale-aware format with role name, ordinal, and provider.
 */
export function formatAgentLabel(run: AgentRun, ordinal: number, locale: Locale = 'ja'): string {
  if (run.role === 'manager') return roleDisplayName(run.role, locale);
  if (run.role === 'executor' && typeof run.label === 'string' && run.label.length > 0) {
    return dicts[locale].format.executorLabelFormat
      .replace('{{role}}', roleDisplayName(run.role, locale))
      .replace('{{label}}', run.label)
      .replace('{{provider}}', run.provider);
  }
  const template = dicts[locale].format.agentLabelFormat;
  return template
    .replace('{{role}}', roleDisplayName(run.role, locale))
    .replace('{{ordinal}}', String(ordinal))
    .replace('{{provider}}', run.provider);
}

/**
 * Per-role ordinal for each run, counted in creation order (run ids are
 * ULIDs) within each Work, so a run that has not started yet never shifts
 * the numbers of earlier runs. Runs without a Work share one group.
 */
export function runOrdinals(
  runs: AgentRun[],
  getWorkId?: (run: AgentRun) => string | null,
): Map<ULID, number> {
  const sorted = [...runs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counters = new Map<string | null, Map<string, number>>();
  const out = new Map<ULID, number>();
  for (const run of sorted) {
    const workId = getWorkId?.(run) ?? null;
    const workCounters = counters.get(workId) ?? new Map<string, number>();
    const n = (workCounters.get(run.role) ?? 0) + 1;
    workCounters.set(run.role, n);
    counters.set(workId, workCounters);
    out.set(run.id, n);
  }
  return out;
}

// ---- time ------------------------------------------------------------------

export function formatRelative(iso: RFC3339 | null, now: number, locale: Locale = 'ja'): string {
  if (typeof iso !== 'string' || iso.length === 0) return dicts[locale].format.dash;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return dicts[locale].format.dash;
  const diff = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diff < 60) return dicts[locale].format.justNow;
  const min = Math.floor(diff / 60);
  if (min < 60) return dicts[locale].format.minutesAgo.replace('{{count}}', String(min));
  const hour = Math.floor(min / 60);
  if (hour < 24) return dicts[locale].format.hoursAgo.replace('{{count}}', String(hour));
  return dicts[locale].format.daysAgo.replace('{{count}}', String(Math.floor(hour / 24)));
}

/** An absolute timestamp formatted for the locale (e.g. Rules' "loaded at" line). */
export function formatDateTime(iso: RFC3339 | null, locale: Locale = 'ja'): string {
  if (typeof iso !== 'string' || iso.length === 0) return dicts[locale].format.dash;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return dicts[locale].format.dash;
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

/** Seconds since the agent last produced output. */
export function silentSeconds(
  lastOutputAt: RFC3339 | null,
  startedAt: RFC3339 | null,
  now: number,
): number | null {
  const ref = lastOutputAt ?? startedAt;
  if (typeof ref !== 'string' || ref.length === 0) return null;
  const timestamp = Date.parse(ref);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / 1000));
}

// ---- report payload --------------------------------------------------------

// ---- client-side ids --------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Minimal client-side ULID generator (Crockford base32, time-high then
 * random-low), matching the server's `^[0-9A-HJKMNP-TV-Z]{26}$` pattern
 * (apps/server/src/ids.ts). Used only to mint a local id (e.g. the Advisor
 * MVP conversation id) when no server endpoint hands one out; the server
 * keeps no client-minted-id registry to collide with.
 */
export function newUlid(): string {
  let time = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = ULID_ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 32);
  }
  let randomPart = '';
  for (let i = 0; i < 16; i += 1) randomPart += ULID_ALPHABET[bytes[i] % 32];
  return `${timePart}${randomPart}`;
}
