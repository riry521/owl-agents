/**
 * Text form of a Decision, shared by every connector so a notification always
 * reads the same way: why it stopped, then what the Owner can do (the options
 * and what each one does), followed by the records.
 *
 * Headings follow the Owner's language, which Core puts on the
 * decision.opened payload as `language` ("ja" | "en"; absent means "ja").
 */

import { decisionContextLines } from "./decision-sections";
import type { OwlLanguage } from "./language";

export type DecisionLanguage = OwlLanguage;

const TEXT: Readonly<Record<DecisionLanguage, {
  readonly title: string;
  readonly recommended: string;
  readonly reason: string;
  readonly how: string;
  readonly currentState: string;
  readonly tried: string;
  readonly autoRecovery: string;
  readonly details: string;
  readonly cause: string;
}>> = {
  ja: {
    title: "判断が必要です",
    recommended: "（おすすめ）",
    reason: "ネックになっている部分",
    how: "選択肢",
    currentState: "今の状態",
    tried: "これまでの経緯",
    autoRecovery: "自動で試したこと",
    details: "詳しい記録",
    cause: "原因",
  },
  en: {
    title: "Decision needed",
    recommended: " (recommended)",
    reason: "The bottleneck",
    how: "Options",
    currentState: "Current state",
    tried: "What happened so far",
    autoRecovery: "Tried automatically",
    details: "Details",
    cause: "Cause",
  },
};

/** The language a decision.opened payload (or Decision DTO) asks for. */
export function decisionLanguage(payload: Record<string, unknown>): DecisionLanguage {
  return payload.language === "en" ? "en" : "ja";
}

/** The notification title for a Decision ("判断が必要です" / "Decision needed"). */
export function decisionTitle(payload: Record<string, unknown>): string {
  return TEXT[decisionLanguage(payload)].title;
}

/** Display names of `explanation.cause_kind`; plugin-sdk does not depend on @owl/shared, so keys are plain strings. */
const DECISION_CAUSE_TEXT: Readonly<Record<DecisionLanguage, Readonly<Record<string, string>>>> = {
  ja: { work: "作業の問題", criteria: "条件の問題", external: "外の問題" },
  en: { work: "A problem in the work", criteria: "A problem in the criteria", external: "A problem outside the Task" },
};

/** "<summary>（原因: <kind>）" from a decision.opened payload's `explanation`; null when absent or malformed. */
export function formatDecisionExplanation(payload: Record<string, unknown>): string | null {
  const explanation = payload.explanation;
  if (!explanation || typeof explanation !== "object") return null;
  const record = explanation as Record<string, unknown>;
  const summary = text(record.summary);
  const kind = text(record.cause_kind);
  const language = decisionLanguage(payload);
  if (!summary || !kind || !Object.hasOwn(DECISION_CAUSE_TEXT[language], kind)) return null;
  const cause = `${TEXT[language].cause}: ${DECISION_CAUSE_TEXT[language][kind]}`;
  return language === "ja" ? `${summary}（${cause}）` : `${summary} (${cause})`;
}

/** `explanation.next_steps` of a decision.opened payload; null when absent (old events, no explanation). */
export function formatDecisionNextSteps(payload: Record<string, unknown>): string | null {
  const explanation = payload.explanation;
  if (!explanation || typeof explanation !== "object") return null;
  return text((explanation as Record<string, unknown>).next_steps);
}

export interface DecisionHeadings {
  readonly reason: string;
  readonly how: string;
  readonly currentState: string;
  readonly tried: string;
  readonly autoRecovery: string;
  readonly details: string;
}

/** Headings shared by detailed Decision notifications. */
export function decisionHeadings(language: DecisionLanguage): DecisionHeadings {
  const { reason, how, currentState, tried, autoRecovery, details } = TEXT[language];
  return { reason, how, currentState, tried, autoRecovery, details };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The one-sentence description of an option: the explanation's note for it,
 * except for the options the explanation itself added (`fix_N`), which keep
 * their own description. Falls back to the description when there is no note.
 */
export function decisionOptionDescription(payload: Record<string, unknown>, option: Record<string, unknown>): string | null {
  const description = text(option.description);
  const explanation = payload.explanation;
  const notes = explanation && typeof explanation === "object" ? (explanation as Record<string, unknown>).option_notes : null;
  const key = typeof option.key === "string" ? option.key : null;
  if (key === null || key.startsWith("fix_") || !Array.isArray(notes)) return description;
  for (const note of notes) {
    if (note && typeof note === "object" && (note as Record<string, unknown>).key === key) {
      return text((note as Record<string, unknown>).note) ?? description;
    }
  }
  return description;
}

/** reason / current_state / tried lines of a payload with repeats and bare ids removed. */
export function decisionPayloadContextLines(payload: Record<string, unknown>) {
  return decisionContextLines({
    reason: text(payload.reason) ?? "",
    current_state: text(payload.current_state) ?? "",
    tried: text(payload.tried) ?? "",
  });
}

function optionLines(payload: Record<string, unknown>, recommended: string | null, mark: string): string[] {
  const options = payload.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option, index) => {
    if (!option || typeof option !== "object") return [];
    const record = option as Record<string, unknown>;
    const label = text(record.label);
    if (!label) return [];
    const suffix = record.key === recommended ? mark : "";
    const description = decisionOptionDescription(payload, record);
    return [`${String.fromCharCode(65 + index)}. ${label}${suffix}${description ? ` — ${description}` : ""}`];
  });
}

function joinParts(parts: ReadonlyArray<string | null>, separator: string): string | null {
  return parts.filter((part): part is string => part !== null && part !== "").join(separator) || null;
}

/**
 * The template body of a decision.opened payload (or a Decision DTO): why it
 * stopped, what the Owner can do, then the records. Connectors add their own
 * header and answer hint.
 */
export function formatDecisionText(payload: Record<string, unknown>): string {
  const t = TEXT[decisionLanguage(payload)];
  const explanation = formatDecisionExplanation(payload);
  const lines = decisionPayloadContextLines(payload);
  const optionsBody = optionLines(payload, text(payload.recommended), t.recommended).join("\n");
  const sections: Array<[string, string | null]> = explanation
    ? [
      [t.reason, explanation],
      [t.how, joinParts([formatDecisionNextSteps(payload), optionsBody], "\n\n")],
      [t.details, joinParts([...lines.reason, ...lines.current_state, ...lines.tried], "\n")],
    ]
    : [
      [t.reason, joinParts(lines.reason, "\n")],
      [t.how, joinParts([text(payload.question), optionsBody], "\n\n")],
      [t.currentState, joinParts(lines.current_state, "\n")],
      [t.tried, joinParts(lines.tried, "\n")],
    ];
  return sections
    .filter((section): section is [string, string] => section[1] !== null)
    .map(([heading, body]) => `■ ${heading}\n${body}`)
    .join("\n\n");
}
