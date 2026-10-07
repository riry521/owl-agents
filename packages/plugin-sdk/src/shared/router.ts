import type { DecisionLanguage } from "./decision-text";
import type { OwlLanguage } from "./language";

export interface PendingDecision {
  readonly id: string;
  readonly options: readonly { key: string; label: string }[];
  readonly allow_free_text: boolean;
  readonly reason?: string | null;
  readonly question?: string | null;
  readonly state_version?: number;
}

export type RoutedIntent<TFile> =
  | { kind: "conversation"; text: string; files?: readonly TFile[] }
  | { kind: "status_query" }
  | { kind: "decision_answer"; decisionId: string; answer: string; optionKey: string | null; optionLabel: string | null }
  | { kind: "file_upload"; files: readonly TFile[]; text?: string }
  /** An explicit answer that could not be routed; reply with `text`. */
  | { kind: "decision_clarification"; text: string };

export interface RoutedMessage<TFile> {
  readonly text: string;
  readonly files?: readonly TFile[];
  readonly attachments?: readonly TFile[];
  /** Decision whose notification this message replies to (thread/reply). */
  readonly replyToDecisionId?: string | null;
}

const DEFAULT_STATUS_KEYWORDS = [
  "進捗", "状況", "どうなってる", "止まってる", "ステータス",
  "status", "progress", "what's happening", "how's it going",
];

export function classifyIntent<TFile>(
  message: RoutedMessage<TFile>,
  pendingDecisions: PendingDecision[],
  statusKeywords: readonly string[] = DEFAULT_STATUS_KEYWORDS,
  language: OwlLanguage = "ja",
): RoutedIntent<TFile> {
  const text = message.text.trim();
  const files = message.files ?? message.attachments ?? [];

  // A reply to a Decision notification (Slack thread / Discord reply) targets
  // that Decision; replying there is itself the explicit opt-in to answer.
  if (message.replyToDecisionId) {
    return matchThreadReply(text, message.replyToDecisionId, pendingDecisions, language) as RoutedIntent<TFile>;
  }

  if (files.length > 0) {
    if (!text) {
      return { kind: "file_upload", files };
    }
    const subIntent = classifyTextOnly(text, pendingDecisions, statusKeywords, language);
    if (subIntent.kind === "status_query") {
      return { kind: "file_upload", files, text };
    }
    if (subIntent.kind === "decision_answer" || subIntent.kind === "decision_clarification") {
      return subIntent;
    }
    return { kind: "conversation", text, files };
  }

  return classifyTextOnly(text, pendingDecisions, statusKeywords, language);
}

function classifyTextOnly(
  text: string,
  pendingDecisions: PendingDecision[],
  statusKeywords: readonly string[],
  language: OwlLanguage,
): RoutedIntent<never> {
  const match = matchDecisionAnswer(text, pendingDecisions, language);
  if (match) return match;

  if (isStatusQuery(text, statusKeywords)) {
    return { kind: "status_query" };
  }

  return { kind: "conversation", text };
}

/**
 * Explicit answer prefix. A Decision is only ever answered through one of
 * three explicit mechanisms — the notification's button, a reply to the
 * notification itself, or this command — never by a bare message that
 * happens to match an option's key or label; that would collide with
 * ordinary conversation (e.g. an option labelled "はい"). `回答 <short-id>:
 * <内容>` (or `answer <short-id>:`) names the Decision by the last 6
 * characters of its id, as shown in the notification, so it works while
 * several Decisions are open; the id may be omitted only when exactly one
 * Decision is open.
 */
const ANSWER_PREFIX = /^(?:回答|answer)(?:\s+([0-9a-z]{6}))?\s*[:：]\s*/iu;

const SHORT_ID_LENGTH = 6;

/** The short Decision id shown in notifications and accepted by `回答 <id>:`. */
export function decisionShortId(decisionId: string): string {
  return decisionId.slice(-SHORT_ID_LENGTH).toUpperCase();
}

/**
 * The three ways a Decision notification can be answered, in the Owner's
 * language. Every Decision notice shows this, unconditionally — it is the
 * only place the three mechanisms are documented, since there is no longer
 * any implicit way to answer.
 */
export function answerGuideHint(
  decisionId: string | null | undefined,
  language: DecisionLanguage = "ja",
  hasButtons = false,
): string {
  const hasId = typeof decisionId === "string" && decisionId.length > 0;
  const id = hasId ? decisionShortId(decisionId) : "<ID>";
  if (language === "en") {
    return hasButtons
      ? `You can answer with the buttons above, by replying to this notification, or by sending "answer ${id}: your answer" in the conversation channel.`
      : `You can answer by replying to this notification, or by sending "answer ${id}: your answer" in the conversation channel.`;
  }
  return hasButtons
    ? `回答方法: 上のボタン、この通知への返信、または会話チャンネルで「回答 ${id}: 内容」のいずれかで回答できます。`
    : `回答方法: この通知への返信、または会話チャンネルで「回答 ${id}: 内容」で回答できます。`;
}

export interface ParsedAnswerPrefix {
  /** Upper-cased short Decision id when the prefix named one. */
  readonly shortId: string | null;
  readonly body: string;
}

/** Parse an explicit answer prefix, or return null when the text has none. */
export function parseAnswerPrefix(text: string): ParsedAnswerPrefix | null {
  const trimmed = text.trim();
  const match = trimmed.match(ANSWER_PREFIX);
  if (!match) return null;
  const shortId = match[1];
  return { shortId: shortId ? shortId.toUpperCase() : null, body: trimmed.slice(match[0].length).trim() };
}

/** Strip an explicit answer prefix, or return null when the text has none. */
export function stripAnswerPrefix(text: string): string | null {
  return parseAnswerPrefix(text)?.body ?? null;
}

export function matchDecisionAnswer(
  text: string,
  decisions: PendingDecision[],
  language: OwlLanguage = "ja",
): RoutedIntent<never> | null {
  const t = ROUTER_TEXT[language];
  const explicit = parseAnswerPrefix(text);
  // No explicit "回答[ id]:" / "answer[ id]:" prefix: this is ordinary
  // conversation, even if it happens to match an option's key or label word
  // for word (e.g. an option labelled "はい"). A reply to the notification
  // itself is a separate, equally explicit opt-in handled by matchThreadReply.
  if (explicit === null) return null;
  const candidate = explicit.body;

  if (explicit.shortId) {
    if (candidate.length === 0) return clarify(t.emptyAnswer);
    const targets = decisions.filter((decision) => decisionShortId(decision.id) === explicit.shortId);
    if (targets.length !== 1) {
      return clarify(targets.length === 0
        ? `${t.unknownId(explicit.shortId)}${describeOpenDecisions(decisions, language)}`
        : t.ambiguousId(explicit.shortId));
    }
    return answerDecision(targets[0], candidate) ?? clarify(optionOnlyMessage(targets[0], language));
  }

  // No id: the bare prefix ("回答: ..." / "answer: ...") must resolve to
  // exactly one Decision, either by naming one of its options or because
  // only one Decision is open.
  if (candidate.length === 0) return clarify(t.emptyAnswer);
  const normalized = candidate.toLowerCase();
  const optionMatches = decisions.flatMap((decision) => {
    const option = findOption(decision, normalized);
    return option ? [{ decision, option }] : [];
  });
  if (optionMatches.length === 1) {
    return {
      kind: "decision_answer",
      decisionId: optionMatches[0].decision.id,
      answer: optionMatches[0].option.label,
      optionKey: optionMatches[0].option.key,
      optionLabel: optionMatches[0].option.label,
    };
  }
  if (optionMatches.length > 1) {
    return clarify(`${t.ambiguousOption(candidate)}${describeOpenDecisions(optionMatches.map((match) => match.decision), language)}`);
  }

  if (decisions.length === 0) return clarify(t.noOpenDecisions);
  if (decisions.length > 1) {
    return clarify(`${t.whichDecision(decisions.length)}${describeOpenDecisions(decisions, language)}`);
  }
  return answerDecision(decisions[0], candidate) ?? clarify(optionOnlyMessage(decisions[0], language));
}

/** Route a reply to a specific Decision's notification. */
function matchThreadReply(
  text: string,
  decisionId: string,
  decisions: PendingDecision[],
  language: OwlLanguage,
): RoutedIntent<never> {
  const t = ROUTER_TEXT[language];
  const decision = decisions.find((candidate) => candidate.id === decisionId);
  if (!decision) return clarify(t.decisionGone);
  const explicit = parseAnswerPrefix(text);
  const candidate = explicit?.body ?? text.trim();
  if (candidate.length === 0) return clarify(t.emptyAnswer);
  return answerDecision(decision, candidate) ?? clarify(optionOnlyMessage(decision, language));
}

function answerDecision(decision: PendingDecision, candidate: string): RoutedIntent<never> | null {
  if (candidate.length === 0) return null;
  const option = findOption(decision, candidate.toLowerCase());
  if (option) {
    return { kind: "decision_answer", decisionId: decision.id, answer: option.label, optionKey: option.key, optionLabel: option.label };
  }
  if (!decision.allow_free_text) return null;
  return { kind: "decision_answer", decisionId: decision.id, answer: candidate, optionKey: null, optionLabel: null };
}

function findOption(decision: PendingDecision, normalized: string): { key: string; label: string } | undefined {
  return decision.options.find((option) =>
    typeof option.key === "string"
    && typeof option.label === "string"
    && (normalized === option.key.toLowerCase() || normalized === option.label.toLowerCase()));
}

/** The replies the router writes when it cannot route an answer, in both Owner languages. */
const ROUTER_TEXT: Readonly<Record<OwlLanguage, {
  readonly emptyAnswer: string;
  readonly decisionGone: string;
  readonly noOpenDecisions: string;
  readonly unknownId: (shortId: string) => string;
  readonly ambiguousId: (shortId: string) => string;
  readonly ambiguousOption: (answer: string) => string;
  readonly whichDecision: (count: number) => string;
  readonly optionOnly: (shortId: string, labels: readonly string[]) => string;
  readonly openDecisions: string;
  readonly more: (count: number) => string;
}>> = {
  ja: {
    emptyAnswer: "回答内容が空です。",
    decisionGone: "このDecisionはすでに解決済みか、見つかりません。",
    noOpenDecisions: "回答待ちの判断はありません。",
    unknownId: (id) => `ID ${id} の判断待ちは見つかりません。`,
    ambiguousId: (id) => `ID ${id} に一致する判断待ちが複数あります。Web画面から回答してください。`,
    ambiguousOption: (answer) => `「${answer}」を選択肢に持つ判断待ちが複数あります。`,
    whichDecision: (count) => `回答待ちの判断が${count}件あります。どの判断への回答か「回答 <ID>: 内容」の形式で指定してください。`,
    optionOnly: (id, labels) => labels.length > 0
      ? `ID ${id} の判断は選択肢でのみ回答できます: ${labels.join(" / ")}`
      : `ID ${id} の判断は自由記述で回答できません。Web画面から回答してください。`,
    openDecisions: "回答待ちの判断:",
    more: (count) => `…ほか${count}件`,
  },
  en: {
    emptyAnswer: "The answer is empty.",
    decisionGone: "This Decision was already resolved or cannot be found.",
    noOpenDecisions: "No Decision is waiting for an answer.",
    unknownId: (id) => `No open Decision has ID ${id}.`,
    ambiguousId: (id) => `Several open Decisions match ID ${id}. Please answer in the Web UI.`,
    ambiguousOption: (answer) => `Several open Decisions offer "${answer}" as an option.`,
    whichDecision: (count) => `${count} Decisions are waiting for an answer. Say which one with "answer <ID>: your answer".`,
    optionOnly: (id, labels) => labels.length > 0
      ? `Decision ${id} only accepts one of its options: ${labels.join(" / ")}`
      : `Decision ${id} does not accept a free-text answer. Please answer in the Web UI.`,
    openDecisions: "Decisions waiting for an answer:",
    more: (count) => `…and ${count} more`,
  },
};

function clarify(text: string): RoutedIntent<never> {
  return { kind: "decision_clarification", text };
}

function optionOnlyMessage(decision: PendingDecision, language: OwlLanguage): string {
  const labels = decision.options.map((option) => option.label).filter((label) => typeof label === "string");
  return ROUTER_TEXT[language].optionOnly(decisionShortId(decision.id), labels);
}

const MAX_LISTED_DECISIONS = 10;

function describeOpenDecisions(decisions: readonly PendingDecision[], language: OwlLanguage): string {
  if (decisions.length === 0) return "";
  const lines = decisions.slice(0, MAX_LISTED_DECISIONS).map((decision) => {
    const summary = typeof decision.reason === "string" && decision.reason.trim().length > 0
      ? decision.reason.trim()
      : typeof decision.question === "string" && decision.question.trim().length > 0
        ? decision.question.trim()
        : "";
    const short = summary.length > 60 ? `${summary.slice(0, 59)}…` : summary;
    return `• ${decisionShortId(decision.id)}${short ? `: ${short}` : ""}`;
  });
  const t = ROUTER_TEXT[language];
  if (decisions.length > MAX_LISTED_DECISIONS) lines.push(t.more(decisions.length - MAX_LISTED_DECISIONS));
  return `\n${t.openDecisions}\n${lines.join("\n")}`;
}

export function isStatusQuery(text: string, keywords: readonly string[]): boolean {
  const normalized = text.toLowerCase().replace(/[？?！!。.、,\s]+/g, " ").trim();
  if (normalized.length > 50) return false;
  const hasActionWord = /直して|足して|作って|変えて|消して|追加|削除|修正|実装|\b(?:fix|add|make|change|remove|delete|implement|create)\b/.test(normalized);
  if (hasActionWord) return false;
  return keywords.some((kw) => normalized.includes(kw.toLowerCase()));
}
