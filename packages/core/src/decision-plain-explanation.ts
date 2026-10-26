import { findInternalTerms, findManagerWorkRequests, type DecisionExplanationRequest } from "../../shared/dist/decision-explanation.js";

export interface PlainExplanation {
  readonly summary: string;
  readonly next_steps: string;
}

const TEXT = {
  ja: {
    summary: "処理が止まりました。原因を自動で説明できなかったため、判断待ちの内容をそのまま示します。",
    nextSteps: "下の選択肢から選んでください。どれにも当てはまらないときは、回答欄に一言書くと、Managerがそれに従って直します。",
  },
  en: {
    summary: "The work stopped, and the cause could not be explained automatically. The Decision's own text is shown as it is.",
    nextSteps: "Pick one of the choices below. If none fits, write a word in the answer field and the Manager will follow it.",
  },
} as const;

const BARE_SNAKE_CASE = /(`[^`]*`)|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu;
const LINES_MAX = 3;
const ENGLISH_PHRASE = /\b[A-Za-z]+(?:[ ,][A-Za-z]+){2,}\b/u;
const DIAGNOSTIC = /\b(?:validation|invalid|schema|unknown (?:property|field|key)|must (?:be|have|not)|not allowed|expected|failed|error|exception|rephrase)\b/iu;

/** An English diagnostic (the Manager's validation messages): a line with an English phrase outside backticks (ja), or with a diagnostic word (any language). */
const isDiagnostic = (line: string, language: "ja" | "en") => {
  const text = line.replace(/`[^`]*`/gu, "");
  return DIAGNOSTIC.test(text) || (language === "ja" && ENGLISH_PHRASE.test(text));
};

/** An Owner's own name (a layout, a file) is shown in code form; Owl's own names stay flagged even then. */
const codeFormat = (line: string) => line.replace(BARE_SNAKE_CASE, (match, code: string | undefined) => code ?? `\`${match}\``);

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).flatMap((item) => (typeof item === "string" ? item.split("\n") : []));

/**
 * The explanation Core writes when the model's cannot be stored, from the Task's latest report and the Decision's own texts.
 * A line stays only when it has no internal term and is not an English diagnostic (the Manager's validation messages are English).
 */
export function plainDecisionExplanation(request: Pick<DecisionExplanationRequest, "language" | "decision" | "reports" | "forbidden_terms">): PlainExplanation {
  const usable = (lines: readonly string[]): string[] => [...new Set(
    lines.map((line) => codeFormat(line.trim())).filter((line) =>
      line !== "" && findInternalTerms(line, request.forbidden_terms).length === 0 && findManagerWorkRequests(line).length === 0 && !isDiagnostic(line, request.language)),
  )].slice(0, LINES_MAX);
  const report = request.reports.at(-1) as Record<string, unknown> | undefined;
  const issues = Array.isArray(report?.remaining_issues) ? (report.remaining_issues as Record<string, unknown>[]).flatMap((entry) => strings(entry?.issue)) : [];
  const blocker = (report?.external_blocker ?? null) as Record<string, unknown> | null;
  const causes = usable([...issues, ...strings(blocker?.summary), ...request.decision.reason.split("\n"), ...request.decision.tried.split("\n")]);
  const choices = usable([...strings(report?.question_for_manager), ...strings(request.decision.question)]);
  const text = TEXT[request.language];
  return {
    summary: causes.length > 0 ? causes.join("\n") : text.summary,
    next_steps: [...choices, text.nextSteps].join("\n"),
  };
}
