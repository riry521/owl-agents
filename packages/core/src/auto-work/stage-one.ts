import { createHash } from "node:crypto";

import type { AutoWorkSignal, AutoWorkVerdict, EffectiveAutoWorkConfig, EffectiveAutoWorkRule } from "@owl/shared";
import { localDayKey } from "../librarian-scheduler.js";
import { normalizeBacklogProblem } from "../review-backlog.js";
import { findAutoWorkRule } from "./config.js";

/** What stage one reads from the database; the service answers from the reserving transaction. */
export interface StageOneFacts {
  /** A judging row, or a created row whose Work is still open, with the same key. */
  activeDuplicate(dedupeKey: string): { event_id: string; work_id: string | null } | null;
  /** The newest created row with the key; its Work stays traceable after the Work has finished. */
  lastCreated(dedupeKey: string): { created_at: string; work_id: string | null } | null;
  /** Rows with the key recorded at or after `since`; the signal being judged is not among them. */
  occurrencesSince(dedupeKey: string, since: string): number;
  createdToday(projectId: string, dayKey: string): number;
  createdTodayAll(dayKey: string): number;
  /** Lower-case logins that may open Works; null when they could not be resolved. */
  allowedGithubUsers(projectId: string): ReadonlySet<string> | null;
}

export type StageOneResult =
  | { readonly ok: true; readonly rule: EffectiveAutoWorkRule; readonly dedupe_key: string; readonly day_key: string }
  | {
    readonly ok: false;
    readonly verdict: Extract<AutoWorkVerdict, "disabled" | "unauthorized" | "no_rule" | "duplicate" | "below_threshold" | "daily_cap">;
    readonly reason: string;
    readonly rule: EffectiveAutoWorkRule | null;
    readonly dedupe_key: string;
    readonly day_key: string;
    readonly duplicate_of_work_id?: string | null;
    readonly duplicate_of_event_id?: string | null;
  };

const ISO_DATETIME = /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/gu;
const CLOCK_TIME = /\d{1,2}:\d{2}(:\d{2})?/gu;
const HEX_RUN = /[0-9a-f]{8,}/gu;
const LONG_DIGITS = /\d{4,}/gu;

/** Makes two lines that differ only in times, PIDs or hashes the same text. Three digits or fewer stay: status and exit codes are different cases. */
export function normalizeDedupeText(value: string): string {
  return normalizeBacklogProblem(value)
    .replace(ISO_DATETIME, "#")
    .replace(CLOCK_TIME, "#")
    .replace(HEX_RUN, "#")
    .replace(LONG_DIGITS, "#")
    .replace(/#+/gu, "#");
}

/** `id` material is used as is, so hashes and long numbers that differ stay different; only `text` is normalized. */
export function buildDedupeKey(projectId: string, signal: Pick<AutoWorkSignal, "source" | "dedupe">): string {
  const material = signal.dedupe.kind === "id" ? signal.dedupe.value : normalizeDedupeText(signal.dedupe.value);
  return createHash("sha256").update([projectId, signal.source, signal.dedupe.kind, material].join("\0")).digest("hex");
}

/** The day a moment counts for: the day starts at `dayStartTime` (HH:MM, local), so 03:00 with "04:00" is still yesterday. */
export function autoWorkDayKey(now: Date, dayStartTime: string): string {
  const [hour, minute] = dayStartTime.split(":").map(Number) as [number, number];
  return localDayKey(new Date(now.getTime() - (hour * 60 + minute) * 60_000));
}

/** The first reason to skip the signal, in the order of the design; ok when it goes on to the AI. */
export function evaluateStageOne(signal: AutoWorkSignal, config: EffectiveAutoWorkConfig, facts: StageOneFacts, now: Date): StageOneResult {
  const dedupeKey = buildDedupeKey(signal.project_id, signal);
  const dayKey = autoWorkDayKey(now, config.limits.day_start_time);
  const skip = (verdict: Exclude<StageOneResult, { ok: true }>["verdict"], reason: string, rule: EffectiveAutoWorkRule | null = null, extra: object = {}): StageOneResult =>
    ({ ok: false, verdict, reason, rule, dedupe_key: dedupeKey, day_key: dayKey, ...extra });

  if (!config.global_enabled.effective || !config.enabled.effective) return skip("disabled", "auto_work_disabled");
  if (signal.source === "github") {
    const github = signal.github;
    const allowed = facts.allowedGithubUsers(signal.project_id);
    const missingLabel = config.github.require_labels.some((label) => !github?.labels.includes(label));
    if (!github || github.author_is_bot || !allowed?.has(github.author.toLowerCase()) || missingLabel) return skip("unauthorized", "github_author_or_labels_not_allowed");
  }
  const rule = findAutoWorkRule(config.rules, signal.source, signal.kind);
  if (!rule) return skip("no_rule", "no_matching_rule");

  const active = facts.activeDuplicate(dedupeKey);
  if (active) return skip("duplicate", "same_signal_in_progress", rule, { duplicate_of_work_id: active.work_id, duplicate_of_event_id: active.work_id === null ? active.event_id : null });
  const lastCreated = facts.lastCreated(dedupeKey);
  if (lastCreated !== null && now.getTime() - Date.parse(lastCreated.created_at) < config.limits.cooldown_hours * 3_600_000) {
    return skip("duplicate", "within_cooldown", rule, { duplicate_of_work_id: lastCreated.work_id });
  }

  if (rule.window_minutes > 0) {
    const since = new Date(now.getTime() - rule.window_minutes * 60_000).toISOString();
    if (facts.occurrencesSince(dedupeKey, since) + 1 < rule.min_occurrences) return skip("below_threshold", "below_min_occurrences", rule);
  }
  if (facts.createdToday(signal.project_id, dayKey) >= config.limits.max_works_per_day || facts.createdTodayAll(dayKey) >= config.limits.max_works_per_day_all) {
    return skip("daily_cap", "daily_cap_reached", rule);
  }
  return { ok: true, rule, dedupe_key: dedupeKey, day_key: dayKey };
}
