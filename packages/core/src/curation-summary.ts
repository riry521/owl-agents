import type { CurationKind } from "./curation-runs";
import type { OwnerLanguage } from "@owl/shared";

/** Report arrays whose first entries are worth naming in the summary, per kind. */
const MAIN_ITEM_ARRAYS: Record<CurationKind, readonly string[]> = {
  librarian: ["actions_taken", "actions_needing_approval"],
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
  if (kind === "rule_curation") lines.push(RULE_READ_ONLY_SENTENCE[language]);
  return { summary: lines.join("\n"), counts };
}
