/**
 * Text form of a Decision, shared by every connector so a notification always
 * reads the same way: why it stopped, what the Owner decides, and what each
 * option does (the Decision template of packages/core/src/decision-brief.ts),
 * followed by where things stand and what was already found.
 *
 * Headings follow the Owner's language, which Core puts on the
 * decision.opened payload as `language` ("ja" | "en"; absent means "ja").
 */

import type { OwlLanguage } from "./language";

export type DecisionLanguage = OwlLanguage;

const TEXT: Readonly<Record<DecisionLanguage, {
  readonly title: string;
  readonly recommended: string;
  readonly reason: string;
  readonly question: string;
  readonly options: string;
  readonly currentState: string;
  readonly tried: string;
  readonly autoRecovery: string;
  readonly details: string;
  readonly cause: string;
}>> = {
  ja: {
    title: "判断が必要です",
    recommended: "（おすすめ）",
    reason: "なぜ止まったか",
    question: "判断してほしいこと",
    options: "選択肢と、選ぶとどうなるか",
    currentState: "今の状態",
    tried: "これまでの経緯",
    autoRecovery: "自動で試したこと",
    details: "詳しい記録",
    cause: "原因",
  },
  en: {
    title: "Decision needed",
    recommended: " (recommended)",
    reason: "Why it stopped",
    question: "What to decide",
    options: "Options and what each one does",
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

export interface DecisionHeadings {
  readonly reason: string;
  readonly question: string;
  readonly options: string;
  readonly currentState: string;
  readonly tried: string;
  readonly autoRecovery: string;
  readonly details: string;
}

/** Headings shared by detailed Decision notifications. */
export function decisionHeadings(language: DecisionLanguage): DecisionHeadings {
  const { reason, question, options, currentState, tried, autoRecovery, details } = TEXT[language];
  return { reason, question, options, currentState, tried, autoRecovery, details };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionLines(options: unknown, recommended: string | null, mark: string): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option, index) => {
    if (!option || typeof option !== "object") return [];
    const record = option as Record<string, unknown>;
    const label = text(record.label);
    if (!label) return [];
    const suffix = record.key === recommended ? mark : "";
    const description = text(record.description);
    return [`${String.fromCharCode(65 + index)}. ${label}${suffix}${description ? ` — ${description}` : ""}`];
  });
}

/**
 * The template body of a decision.opened payload (or a Decision DTO), one
 * section per template field. Connectors add their own header and answer hint.
 */
export function formatDecisionText(payload: Record<string, unknown>): string {
  const t = TEXT[decisionLanguage(payload)];
  const explanation = formatDecisionExplanation(payload);
  const optionsBody = optionLines(payload.options, text(payload.recommended), t.recommended).join("\n") || null;
  const sections: Array<[string, string | null]> = explanation
    ? [
      [t.reason, explanation],
      [t.question, text(payload.question)],
      [t.options, optionsBody],
      [t.details, [text(payload.reason), text(payload.current_state), text(payload.tried)].filter(Boolean).join("\n") || null],
    ]
    : [
      [t.reason, text(payload.reason)],
      [t.question, text(payload.question)],
      [t.options, optionsBody],
      [t.currentState, text(payload.current_state)],
      [t.tried, text(payload.tried)],
    ];
  return sections
    .filter((section): section is [string, string] => section[1] !== null)
    .map(([heading, body]) => `■ ${heading}\n${body}`)
    .join("\n\n");
}
