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
}>> = {
  ja: {
    title: "判断が必要です",
    recommended: "（おすすめ）",
    reason: "なぜ止まったか",
    question: "判断してほしいこと",
    options: "選択肢と、選ぶとどうなるか",
    currentState: "今の状態",
    tried: "これまでの経緯",
  },
  en: {
    title: "Decision needed",
    recommended: " (recommended)",
    reason: "Why it stopped",
    question: "What to decide",
    options: "Options and what each one does",
    currentState: "Current state",
    tried: "What happened so far",
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

export interface DecisionHeadings {
  readonly reason: string;
  readonly question: string;
  readonly options: string;
  readonly currentState: string;
  readonly tried: string;
}

/** Headings shared by detailed Decision notifications. */
export function decisionHeadings(language: DecisionLanguage): DecisionHeadings {
  const { reason, question, options, currentState, tried } = TEXT[language];
  return { reason, question, options, currentState, tried };
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
  const sections: Array<[string, string | null]> = [
    [t.reason, text(payload.reason)],
    [t.question, text(payload.question)],
    [t.options, optionLines(payload.options, text(payload.recommended), t.recommended).join("\n") || null],
    [t.currentState, text(payload.current_state)],
    [t.tried, text(payload.tried)],
  ];
  return sections
    .filter((section): section is [string, string] => section[1] !== null)
    .map(([heading, body]) => `■ ${heading}\n${body}`)
    .join("\n\n");
}
