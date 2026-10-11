import { createUlid } from "../../db/dist/index.js";
import type { CurationKind } from "./curation-runs";
import type { OwnerLanguage } from "@owl/shared";

/** Report arrays whose first entries are worth naming in the summary, per kind. */
const MAIN_ITEM_ARRAYS: Record<CurationKind, readonly string[]> = {
  librarian: ["actions_taken", "actions_needing_approval", "pages"],
  skill_curation: ["state_changes", "awaiting_approval"],
  rule_curation: ["awaiting_approval"],
};

/** Record keys tried in order when naming a single entry of a report array. */
const LABEL_KEYS = ["path", "skill", "target", "text", "id", "kind"] as const;

const MAX_MAIN_ITEMS = 3;

const RULE_READ_ONLY_SENTENCE: Record<OwnerLanguage, string> = {
  ja: "ルールは書き換えていません。変更には承認が必要です。",
  en: "Rules were not changed. Changes need approval.",
};

const NO_CHANGES: Record<OwnerLanguage, string> = { ja: "変更なし", en: "no changes" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short human label for one report entry, or null when the entry has no usable field. */
function itemLabel(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim().length > 0 ? entry.trim() : null;
  if (!isRecord(entry)) return null;
  for (const key of LABEL_KEYS) {
    const value = entry[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** "(a, b ほか2件)" for the first `MAX_MAIN_ITEMS` labels of an array, or null when nothing is nameable. */
function describeItems(entries: readonly unknown[], language: OwnerLanguage): string | null {
  const labels = entries.map(itemLabel).filter((label): label is string => label !== null);
  if (labels.length === 0) return null;
  const shown = labels.slice(0, MAX_MAIN_ITEMS);
  const rest = entries.length - shown.length;
  return `(${shown.join(", ")}${rest > 0 ? (language === "ja" ? ` ほか${rest}件` : ` and ${rest} more`) : ""})`;
}

/**
 * Counts every top-level array in a curation report, names the main items of
 * the arrays that matter for the kind, and writes both into one summary line.
 * The same string is stored on the curation run and shown to the Advisor's
 * operator, so it must never throw, whatever shape the report has.
 */
export function summarizeCurationReport(
  kind: CurationKind,
  report: unknown,
  runId: string,
  language: OwnerLanguage = "ja",
): { summary: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const parts: string[] = [];
  const source = isRecord(report) ? report : {};

  for (const [key, value] of Object.entries(source)) {
    if (!Array.isArray(value)) continue;
    counts[key] = value.length;
    const described = MAIN_ITEM_ARRAYS[kind]?.includes(key) ? describeItems(value, language) : null;
    parts.push(`${key}=${value.length}${described ? ` ${described}` : ""}`);
  }

  const lines = [`${kind} run ${runId}: ${parts.length ? parts.join(", ") : NO_CHANGES[language]}`];
  if (typeof source.skipped === "string") lines.push(`skipped: ${source.skipped}`);
  if (kind === "rule_curation") lines.push(RULE_READ_ONLY_SENTENCE[language]);
  return { summary: lines.join("\n"), counts };
}

/**
 * Why a librarian report must be recorded as failed, or null when it is fine.
 * A report with `skipped` (retag running, storage unavailable) is not a failure: it is a deliberate
 * non-run that the next slot retries, and failing it would alert the Owner on every transient skip.
 * Only the librarian is judged; the other kinds have no `pages`/`remaining` contract.
 */
export function curationReportFailure(kind: CurationKind, report: unknown, language: OwnerLanguage = "ja"): string | null {
  if (kind !== "librarian" || !isRecord(report)) return null;
  if (typeof report.error === "string" && report.error.length > 0) return report.error;
  if (typeof report.skipped === "string") return null;
  const remaining = typeof report.remaining === "number" ? report.remaining : 0;
  if (!Array.isArray(report.pages) || report.pages.length > 0 || remaining <= 0) return null;
  const rejected = Array.isArray(report.rejected) ? report.rejected.length : 0;
  return language === "ja"
    ? `整理できたページが0件で、残りが${remaining}件あります（rejected ${rejected}件）`
    : `No pages were organized and ${remaining} items remain (${rejected} rejected)`;
}

/** Report arrays that mean "this kind changed something", per kind. Rule curation never rewrites rules, so its only news is proposals awaiting approval. */
const CHANGE_ARRAYS: Record<CurationKind, readonly string[]> = {
  librarian: ["actions_taken", "merged", "pages"],
  skill_curation: ["state_changes", "applied", "trials_ended"],
  rule_curation: ["awaiting_approval"],
};

const NOTICE_TEXT: Record<OwnerLanguage, {
  changed: Record<CurationKind, string>;
  failed: Record<CurationKind, string>;
  pendingRules: (count: number) => string;
  ruleAdded: string;
}> = {
  ja: {
    changed: { librarian: "ナレッジを整理しました", skill_curation: "スキルを整理しました", rule_curation: "" },
    failed: { librarian: "ナレッジ整理に失敗しました", skill_curation: "スキル整理に失敗しました", rule_curation: "ルール整理に失敗しました" },
    pendingRules: (count) => `承認待ちのルール提案があります（${count}件）`,
    ruleAdded: "ルールを追加しました",
  },
  en: {
    changed: { librarian: "Knowledge was organized", skill_curation: "Skills were organized", rule_curation: "" },
    failed: { librarian: "Knowledge curation failed", skill_curation: "Skill curation failed", rule_curation: "Rule curation failed" },
    pendingRules: (count) => `Rule proposals are awaiting approval (${count})`,
    ruleAdded: "A rule was added",
  },
};

/** The notice for an approved rule proposal that was written to the rule files. */
export function ruleAddedNotice(language: OwnerLanguage = "ja"): CurationNotice {
  return { severity: "info", message: NOTICE_TEXT[language].ruleAdded };
}

export interface CurationNotice {
  severity: "info" | "warning";
  message: string;
}

/** The write-lane request that records a notice as a plain system.alert (kind curation_notice), pushed over the websocket. */
export function curationNoticeWrite(notice: CurationNotice) {
  const eventId = createUlid();
  return {
    mutateState: () => null,
    event: {
      id: eventId,
      idempotencyKey: `curation_notice:${eventId}`,
      type: "system.alert",
      payload: { kind: "curation_notice", schema_version: "1.0.0", severity: notice.severity, message: notice.message, cause: null },
    },
    outbox: [{ provider: "websocket" as const }],
  };
}

/** One finished curation; `run` is null when the run could not even be recorded. */
export interface CurationNoticeEntry {
  kind: CurationKind;
  run: { status: string; counts: Record<string, number> } | null;
}

/**
 * Plain-language lines for the runs that finished together: one line per kind that failed or changed
 * something, nothing for a kind that changed nothing. Null when there is nothing to tell. Never names
 * a run id, error text or path: the Owner opens the screen for details.
 */
export function buildCurationNotice(entries: readonly CurationNoticeEntry[], language: OwnerLanguage = "ja"): CurationNotice | null {
  const text = NOTICE_TEXT[language];
  const lines: string[] = [];
  let failed = false;
  for (const { kind, run } of entries) {
    if (!run || run.status !== "succeeded") {
      failed = true;
      lines.push(text.failed[kind]);
      continue;
    }
    const changes = CHANGE_ARRAYS[kind].reduce((sum, key) => sum + (run.counts[key] ?? 0), 0);
    if (changes === 0) continue;
    lines.push(kind === "rule_curation" ? text.pendingRules(changes) : text.changed[kind]);
  }
  return lines.length === 0 ? null : { severity: failed ? "warning" : "info", message: lines.join("\n") };
}
