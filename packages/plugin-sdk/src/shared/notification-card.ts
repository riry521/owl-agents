import type { OwlEvent } from "../types";
import { asOwlLanguage, type OwlLanguage } from "./language";
import { createDecisionButtonId } from "./decision-button";
import {
  decisionHeadings,
  decisionLanguage,
  decisionOptionDescription,
  decisionPayloadContextLines,
  decisionTitle,
  formatDecisionExplanation,
  formatDecisionNextSteps,
} from "./decision-text";
import { answerGuideHint, decisionShortId } from "./router";

/** Events that can be represented by the shared notification card model. */
export const NOTIFICATION_CARD_EVENTS = [
  "work.completed",
  "work.cancelled",
  "work.paused",
  "work.reopened",
  "decision.opened",
  "decision.resolved",
  "decision.cancelled",
  "provider.paused",
  "provider.resumed",
  "system.alert",
] as const;

export type NotificationCardEvent = typeof NOTIFICATION_CARD_EVENTS[number];

export type CardColor = string;

export interface CardField {
  readonly label: string;
  readonly value: string;
}

export interface CardAction {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly optionIndex: number;
  readonly recommended: boolean;
}

export interface NotificationCard {
  readonly eventType: NotificationCardEvent;
  readonly language: OwlLanguage;
  readonly emoji: string;
  readonly title: string;
  readonly color: CardColor;
  readonly body: string | null;
  readonly fields: readonly CardField[];
  readonly footer: string | null;
  readonly fallbackText: string;
  readonly actions: readonly CardAction[];
  readonly threadDetail: string | null;
  readonly question: string | null;
}

export interface CardRenderContext {
  readonly language: OwlLanguage;
  readonly formatTime: (epochMs: number) => string;
  readonly replyStyle: "thread" | "reply";
}

export interface DecisionClosedContext {
  readonly language: OwlLanguage;
  readonly question: string | null;
}

export interface DecisionQuestion {
  readonly line: string;
  readonly source: "question" | "reason" | "none";
  readonly shortened: boolean;
  readonly full: string | null;
}

export interface DecisionOptionView {
  readonly index: number;
  readonly key: string | null;
  readonly label: string;
  readonly description: string | null;
  readonly recommended: boolean;
  readonly criteriaRewrites: ReadonlyArray<{ readonly before: string; readonly after: string }>;
}

export interface DecisionAnswerGuideInput {
  readonly decisionId: string | null;
  readonly language: OwlLanguage;
  readonly hasButtons: boolean;
  readonly hasOptions: boolean;
  readonly allowFreeText: boolean | null;
  readonly replyStyle: "thread" | "reply";
}

export interface DecisionDetailInput {
  readonly language: OwlLanguage;
  readonly replyStyle: "thread" | "reply";
  readonly question: DecisionQuestion;
  readonly hasButtons: boolean;
  readonly decisionId: string | null;
}

export interface WorkCompletionStats {
  readonly taskCount: number | null;
  readonly durationMs: number | null;
}

export const QUESTION_MAX = 150;
export const OPTION_LABEL_MAX = 100;
export const BUTTON_LABEL_MAX = 75;
export const MAX_CARD_ACTIONS = 25;
export const BODY_MAX = 2900;
export const FIELD_VALUE_MAX = 1000;
const AUTO_RECOVERY_FIELD_MAX = 200;
export const FALLBACK_MAX = 200;

type CardStyleKey = Exclude<NotificationCardEvent, "system.alert"> | "system.alert.work" | "system.alert.system" | "system.alert.notice";

const CARD_STYLES: Readonly<Record<CardStyleKey, { readonly emoji: string; readonly color: CardColor }>> = {
  "work.completed": { emoji: "✅", color: "#4CAF50" },
  "work.cancelled": { emoji: "🛑", color: "#9E9E9E" },
  "work.paused": { emoji: "⏸️", color: "#FFB300" },
  "work.reopened": { emoji: "🔄", color: "#2196F3" },
  "decision.opened": { emoji: "✋", color: "#F5A623" },
  "decision.resolved": { emoji: "☑️", color: "#4CAF50" },
  "decision.cancelled": { emoji: "🚫", color: "#9E9E9E" },
  "provider.paused": { emoji: "⏳", color: "#FFB300" },
  "provider.resumed": { emoji: "▶️", color: "#4CAF50" },
  "system.alert.work": { emoji: "🚨", color: "#F44336" },
  "system.alert.system": { emoji: "⚠️", color: "#FF9800" },
  "system.alert.notice": { emoji: "📝", color: "#607D8B" },
};

export const DETAIL_COLOR: CardColor = "#607D8B";

export interface NotificationCardText {
  readonly titles: {
    readonly workCompleted: string;
    readonly workCancelled: string;
    readonly workPaused: string;
    readonly workReopened: string;
    readonly decisionOpened: string;
    readonly decisionResolved: string;
    readonly decisionCancelled: string;
    readonly providerPaused: string;
    readonly providerResumed: string;
    readonly workProblem: string;
    readonly systemNotice: string;
    readonly curationNotice: string;
  };
  readonly fieldReason: string;
  readonly fieldRemediation: string;
  readonly fieldAnswer: string;
  readonly emptyAnswer: string;
  readonly noQuestion: string;
  readonly moreOptions: (count: number) => string;
  readonly recommendedLegend: string;
  readonly detailTitle: string;
  readonly howToAnswer: string;
  readonly threadReplySupplement: string;
  readonly replyMessageSupplement: string;
  readonly guideFreeText: string;
  readonly guideOptionsOnly: string;
  readonly unknownTime: string;
  readonly providerPaused: (label: string, time: string) => string;
  readonly providerPausedUnknown: (label: string, time: string) => string;
  readonly providerPausedAgain: (label: string, time: string) => string;
  readonly providerResumed: (label: string) => string;
  readonly providerPausedSubject: (label: string, time: string | null) => string;
  readonly decisionCancelledReasonWorkCancelled: string;
  readonly decisionCancelledReasonTaskSuperseded: string;
}

export const CARD_TEXT: Readonly<Record<OwlLanguage, NotificationCardText>> = {
  ja: {
    titles: {
      workCompleted: "完了しました", workCancelled: "中止されました", workPaused: "一時停止しました", workReopened: "再オープンしました",
      decisionOpened: "判断が必要です", decisionResolved: "解決しました", decisionCancelled: "取り消されました",
      providerPaused: "利用上限で停止中", providerResumed: "処理を再開しました",
      workProblem: "問題が発生", systemNotice: "システム通知", curationNotice: "整理のお知らせ",
    },
    fieldReason: "理由", fieldRemediation: "対処", fieldAnswer: "回答", emptyAnswer: "（回答なし）",
    noQuestion: "（質問文がありません）", moreOptions: (count) => `…ほか${count}件`,
    recommendedLegend: "★ はおすすめの選択肢です。", detailTitle: "詳細", howToAnswer: "回答方法",
    threadReplySupplement: "詳細が投稿されたこのスレッドへの返信も回答として扱われます。",
    replyMessageSupplement: "この詳細メッセージに直接返信して回答することもできます。",
    guideFreeText: "選択肢にない内容は、回答欄に一言書けば Manager が直します。",
    guideOptionsOnly: "返信で答えるときは、選択肢の名前をそのまま書いてください。",
    unknownTime: "時刻不明",
    providerPaused: (label, time) => `${label}が利用上限に達したため、${label}を使う処理を止めています。${time}ごろ再開します。`,
    providerPausedUnknown: (label, time) => `${label}が利用上限に達したため、${label}を使う処理を止めています。解除時刻が分からないため、${time}ごろに再開を試します。`,
    providerPausedAgain: (label, time) => `${label}はまだ利用上限のままです。次は${time}ごろに再開を試します。`,
    providerResumed: (label) => `${label}の利用上限が解除されたため、処理を再開しました。`,
    providerPausedSubject: (label, time) => time ? `${label}（次回 ${time}ごろ）` : label,
    decisionCancelledReasonWorkCancelled: "Workが中止されたため",
    decisionCancelledReasonTaskSuperseded: "対象のTaskが置き換えられたため",
  },
  en: {
    titles: {
      workCompleted: "Completed", workCancelled: "Cancelled", workPaused: "Paused", workReopened: "Reopened",
      decisionOpened: "Decision needed", decisionResolved: "Resolved", decisionCancelled: "Cancelled",
      providerPaused: "Paused at usage limit", providerResumed: "Resumed",
      workProblem: "Problem", systemNotice: "System notice", curationNotice: "Curation notice",
    },
    fieldReason: "Reason", fieldRemediation: "What to do", fieldAnswer: "Answer", emptyAnswer: "(no answer)",
    noQuestion: "(No question provided)", moreOptions: (count) => `…and ${count} more`,
    recommendedLegend: "★ marks the recommended option.", detailTitle: "Details", howToAnswer: "How to answer",
    threadReplySupplement: "A reply in this thread also counts as your answer.",
    replyMessageSupplement: "You can also answer by replying directly to this detail message.",
    guideFreeText: "For anything not in the options, write a word in the answer field and the Manager will fix it.",
    guideOptionsOnly: "When you answer by reply, write the option name exactly as shown.",
    unknownTime: "unknown time",
    providerPaused: (label, time) => `${label} hit its usage limit. Work that uses ${label} is on hold until about ${time}.`,
    providerPausedUnknown: (label, time) => `${label} hit its usage limit. The reset time is unknown; Owl will try again around ${time}.`,
    providerPausedAgain: (label, time) => `${label} is still at its usage limit. Owl will try again around ${time}.`,
    providerResumed: (label) => `${label}'s usage limit has reset. Work has resumed.`,
    providerPausedSubject: (label, time) => time ? `${label} (next try ~${time})` : label,
    decisionCancelledReasonWorkCancelled: "the Work was cancelled",
    decisionCancelledReasonTaskSuperseded: "the Task it was blocking was superseded",
  },
};

export function isNotificationCardEvent(eventType: string, payload?: Record<string, unknown>): eventType is NotificationCardEvent {
  if (!(NOTIFICATION_CARD_EVENTS as readonly string[]).includes(eventType)) return false;
  return eventType !== "system.alert" || text(payload?.message) !== null;
}

export function buildNotificationCard(event: OwlEvent, ctx: CardRenderContext): NotificationCard | null {
  const payload = event.payload;
  if (!isNotificationCardEvent(event.type, payload)) return null;
  switch (event.type) {
    case "work.completed":
    case "work.cancelled":
    case "work.paused":
    case "work.reopened":
      return buildWorkCard(event, ctx.language);
    case "decision.opened":
      return buildDecisionOpenedCard(event, ctx);
    case "decision.resolved":
    case "decision.cancelled":
      return buildDecisionClosedCard(event, { language: ctx.language, question: null });
    case "provider.paused":
      return buildProviderPausedCard(event, ctx);
    case "provider.resumed":
      return buildProviderResumedCard(event, ctx.language);
    case "system.alert":
      return buildSystemAlertCard(event, ctx.language);
    default:
      return null;
  }
}

export function buildDecisionClosedCard(event: OwlEvent, ctx: DecisionClosedContext): NotificationCard | null {
  if (event.type !== "decision.resolved" && event.type !== "decision.cancelled") return null;
  const payload = event.payload;
  const language = asOwlLanguage(ctx.language);
  const t = CARD_TEXT[language];
  const resolved = event.type === "decision.resolved";
  const style = CARD_STYLES[event.type];
  const answer = text(payload.answer) ?? t.emptyAnswer;
  const reason = payload.reason === "work_cancelled"
    ? t.decisionCancelledReasonWorkCancelled
    : t.decisionCancelledReasonTaskSuperseded;
  const subject = resolved ? answer : reason;
  const workId = eventWorkId(event);
  const decisionId = text(payload.decision_id);
  const footer = [
    workId ? shortWork(workId) : null,
    decisionId ? `ID ${decisionShortId(decisionId)}` : null,
  ].filter((part): part is string => part !== null).join(" · ") || null;
  const workTitle = eventWorkTitle(event);
  return makeCard(
    event.type,
    language,
    style,
    resolved ? t.titles.decisionResolved : t.titles.decisionCancelled,
    joinLines(workTitle, ctx.question ? `❓ ${ctx.question}` : null),
    [{ label: resolved ? t.fieldAnswer : t.fieldReason, value: truncateText(subject, FIELD_VALUE_MAX) }],
    footer,
    withWorkTitle(workTitle, subject),
  );
}

export function decisionQuestion(payload: Record<string, unknown>, language?: OwlLanguage): DecisionQuestion {
  const lang = language ?? decisionLanguage(payload);
  const question = text(payload.question);
  const reason = text(payload.reason);
  const source = question ? "question" : reason ? "reason" : "none";
  const full = source === "question" ? question : source === "reason" ? reason : null;
  if (!full) return { line: CARD_TEXT[lang].noQuestion, source, shortened: false, full: null };
  const firstLine = full.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const line = truncateText(firstLine.replace(/\s+/gu, " "), QUESTION_MAX);
  return { line, source, shortened: line !== full, full };
}

export function decisionOptionViews(payload: Record<string, unknown>): DecisionOptionView[] {
  if (!Array.isArray(payload.options)) return [];
  const recommended = text(payload.recommended);
  return payload.options.flatMap((option, index) => {
    if (!option || typeof option !== "object") return [];
    const record = option as Record<string, unknown>;
    const label = text(record.label);
    if (!label) return [];
    const key = typeof record.key === "string" && record.key.length > 0 ? record.key : null;
    const criteriaRewrites = Array.isArray(record.criteria_rewrites)
      ? record.criteria_rewrites.flatMap((rewrite) => {
        const r = rewrite && typeof rewrite === "object" ? rewrite as Record<string, unknown> : {};
        const before = text(r.before);
        const after = text(r.after);
        return before && after ? [{ before, after }] : [];
      })
      : [];
    return [{
      index,
      key,
      label,
      description: decisionOptionDescription(payload, record),
      recommended: recommended !== null && key === recommended,
      criteriaRewrites,
    }];
  });
}

export function formatDecisionOptionList(options: readonly DecisionOptionView[], language: OwlLanguage): string {
  const t = CARD_TEXT[language];
  const shown = options.slice(0, MAX_CARD_ACTIONS).map((option) =>
    `• ${truncateText(option.label, OPTION_LABEL_MAX)}${option.recommended ? " ★" : ""}`);
  if (options.length > MAX_CARD_ACTIONS) shown.push(t.moreOptions(options.length - MAX_CARD_ACTIONS));
  return shown.join("\n");
}

export function formatDecisionAnswerGuide(input: DecisionAnswerGuideInput): string {
  const t = CARD_TEXT[input.language];
  const lines = [
    answerGuideHint(input.decisionId, input.language, input.hasButtons),
    input.replyStyle === "thread" ? t.threadReplySupplement : t.replyMessageSupplement,
  ];
  if (input.allowFreeText === true) lines.push(t.guideFreeText);
  else if (input.allowFreeText === false && input.hasOptions) lines.push(t.guideOptionsOnly);
  return lines.join("\n");
}

export function formatDecisionThreadDetail(payload: Record<string, unknown>, input: DecisionDetailInput): string {
  const t = CARD_TEXT[input.language];
  const headings = decisionHeadings(input.language);
  const options = decisionOptionViews(payload);
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = decisionPayloadContextLines(payload);
  const explanation = formatDecisionExplanation(payload);
  const optionLines = options.map((option) =>
    [`• ${option.label}${option.recommended ? " ★" : ""}${option.description ? ` — ${option.description}` : ""}`,
      ...option.criteriaRewrites.map((rewrite) => `  ${rewrite.before} → ${rewrite.after}`)].join("\n"));
  if (options.some((option) => option.recommended)) optionLines.push(t.recommendedLegend);
  const add = (heading: string, parts: ReadonlyArray<string | null>, separator = "\n") => {
    const body = parts.filter((part): part is string => part !== null && part !== "").join(separator);
    if (body) sections.push({ heading, body });
  };
  if (explanation) {
    add(headings.reason, [explanation]);
    add(headings.how, [formatDecisionNextSteps(payload), optionLines.join("\n")], "\n\n");
    add(headings.details, [...lines.reason, ...lines.current_state, ...lines.tried]);
  } else {
    add(headings.reason, lines.reason);
    add(headings.how, [
      input.question.source === "question" && input.question.shortened ? input.question.full : null,
      optionLines.join("\n"),
    ], "\n\n");
    add(headings.currentState, lines.current_state);
    add(headings.tried, lines.tried);
  }
  const guide = formatDecisionAnswerGuide({
    decisionId: input.decisionId,
    language: input.language,
    hasButtons: input.hasButtons,
    hasOptions: options.length > 0,
    allowFreeText: typeof payload.allow_free_text === "boolean" ? payload.allow_free_text : null,
    replyStyle: input.replyStyle,
  });
  return joinDetail(sections, guide, t.howToAnswer);
}

export function workCompletionStats(payload: Record<string, unknown>): WorkCompletionStats {
  const taskCount = Number.isSafeInteger(payload.task_count) && (payload.task_count as number) >= 0
    ? payload.task_count as number
    : null;
  let durationMs: number | null = null;
  if (typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms) && payload.duration_ms >= 0) {
    durationMs = Math.floor(payload.duration_ms);
  } else if (typeof payload.started_at === "string" && typeof payload.completed_at === "string") {
    const startedAt = Date.parse(payload.started_at);
    const completedAt = Date.parse(payload.completed_at);
    if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt) {
      durationMs = completedAt - startedAt;
    }
  }
  return { taskCount, durationMs };
}

export function formatDuration(durationMs: number, language: OwlLanguage): string {
  const duration = Math.max(0, Math.floor(Number.isFinite(durationMs) ? durationMs : 0));
  if (duration < 60_000) return language === "ja" ? "1分未満" : "<1m";
  const minutes = Math.floor(duration / 60_000);
  if (duration < 3_600_000) return language === "ja" ? `${minutes}分` : `${minutes}m`;
  const hours = Math.floor(duration / 3_600_000);
  if (duration < 86_400_000) {
    const remainingMinutes = minutes % 60;
    return language === "ja"
      ? `${hours}時間${remainingMinutes > 0 ? `${remainingMinutes}分` : ""}`
      : `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
  }
  const days = Math.floor(duration / 86_400_000);
  const remainingHours = Math.floor(duration / 3_600_000) % 24;
  return language === "ja"
    ? `${days}日${remainingHours > 0 ? `${remainingHours}時間` : ""}`
    : `${days}d${remainingHours > 0 ? ` ${remainingHours}h` : ""}`;
}

export function formatWorkCompletionSummary(payload: Record<string, unknown>, language: OwlLanguage): string | null {
  const { taskCount, durationMs } = workCompletionStats(payload);
  const parts: string[] = [];
  if (taskCount !== null) {
    parts.push(language === "ja" ? `Task ${taskCount}件` : `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`);
  }
  if (durationMs !== null) {
    const duration = formatDuration(durationMs, language);
    parts.push(language === "ja" ? `所要 ${duration}` : taskCount === null ? `Took ${duration}` : duration);
  }
  const relaxed = Array.isArray(payload.criteria_relaxations) ? payload.criteria_relaxations.length : 0;
  const relaxedLine = relaxed === 0 ? null
    : language === "ja" ? `緩めた受け入れ条件: ${relaxed} 件。Work の画面で見られます。` : `Relaxed acceptance criteria: ${relaxed}. See the Work screen.`;
  const lines = [...(parts.length === 0 ? [] : [language === "ja" ? parts.join("・") : parts.join(" · ")]), ...(relaxedLine ? [relaxedLine] : []), ...goalShortfallLines(payload, language)];
  return lines.length === 0 ? null : lines.join("\n");
}

/** The goals not met: the count line first, so a body cut by BODY_MAX still keeps it; goals met later are counted on one more line. */
function goalShortfallLines(payload: Record<string, unknown>, language: OwlLanguage): string[] {
  const entries = (Array.isArray(payload.goal_shortfalls) ? payload.goal_shortfalls : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).text === "string");
  const unmet = entries.filter((entry) => entry.resolution === null || entry.resolution === undefined);
  const met = entries.length - unmet.length;
  const ja = language === "ja";
  const lines: string[] = [];
  if (unmet.length > 0) {
    lines.push(ja ? `達成しなかった目標: ${unmet.length} 件。Work の画面でも見られます。` : `Goals not met: ${unmet.length}. See the Work screen.`);
    for (const entry of unmet) {
      const title = text(entry.task_title);
      const reason = text(entry.reason) ?? "";
      lines.push(`- ${title ? `${title}: ` : ""}${entry.text}${ja ? `（${reason}）` : ` (${reason})`}`);
    }
  }
  if (met > 0) lines.push(ja ? `あとで満たした目標: ${met} 件（根拠は Work の画面）` : `Goals met later: ${met} (evidence on the Work screen).`);
  return lines;
}

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max - 1);
  const code = value.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/gu, "$1")
    .replace(/\*\*|__|`/gu, "")
    .replace(/[\r\n\s]+/gu, " ")
    .trim();
}

export function formatClockTime(epochMs: number, language: OwlLanguage): string {
  return new Intl.DateTimeFormat(language === "ja" ? "ja-JP" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(epochMs);
}

function buildWorkCard(event: OwlEvent, language: OwlLanguage): NotificationCard {
  const payload = event.payload;
  const workId = eventWorkId(event);
  const title = eventWorkTitle(event);
  const label = title ?? (workId ? shortWork(workId) : "Work");
  const languageText = CARD_TEXT[language];
  const style = CARD_STYLES[event.type as Exclude<NotificationCardEvent, "system.alert">];
  let body = title ? "" : label;
  let fields: CardField[] = [];
  switch (event.type) {
    case "work.completed": {
      const summary = formatWorkCompletionSummary(payload, language);
      if (summary) body += `${body ? "\n" : ""}${summary}`;
      break;
    }
    case "work.paused":
    case "work.reopened": {
      const reason = text(payload.reason);
      if (reason) fields = [{ label: languageText.fieldReason, value: truncateText(reason, FIELD_VALUE_MAX) }];
      break;
    }
  }
  const cardTitle = event.type === "work.completed" ? languageText.titles.workCompleted
    : event.type === "work.cancelled" ? languageText.titles.workCancelled
      : event.type === "work.paused" ? languageText.titles.workPaused
        : languageText.titles.workReopened;
  const footer = workId ? shortWork(workId) : null;
  return makeCard(event.type as NotificationCardEvent, language, style,
    title ? truncateText(`${cardTitle}: ${title}`, QUESTION_MAX) : cardTitle,
    body ? truncateText(body, BODY_MAX) : null, fields, footer, title ? "" : label);
}

function buildDecisionOpenedCard(event: OwlEvent, ctx: CardRenderContext): NotificationCard {
  const payload = event.payload;
  const language = decisionLanguage(payload);
  const t = CARD_TEXT[language];
  const question = decisionQuestion(payload, language);
  const options = decisionOptionViews(payload);
  const optionList = formatDecisionOptionList(options, language);
  const workTitle = eventWorkTitle(event);
  const explanation = formatDecisionExplanation(payload);
  const nextSteps = formatDecisionNextSteps(payload);
  const lead = explanation ? `💡 ${explanation}${nextSteps ? `\n👉 ${nextSteps}` : ""}` : `❓ ${question.line}`;
  const body = joinLines(workTitle, `${lead}${optionList ? `\n\n${optionList}` : ""}`) ?? "";
  const decisionId = text(payload.decision_id);
  const targetId = decisionId ?? event.event_id;
  const actions = options.slice(0, MAX_CARD_ACTIONS).flatMap((option): CardAction[] => {
    if (option.key === null) return [];
    const id = createDecisionButtonId(targetId, option.index);
    return id ? [{
      id,
      label: truncateText(`${option.recommended ? "★ " : ""}${option.label}`, BUTTON_LABEL_MAX),
      value: option.key,
      optionIndex: option.index,
      recommended: option.recommended,
    }] : [];
  });
  const workId = eventWorkId(event);
  const footer = [workId ? shortWork(workId) : null, decisionId ? `ID ${decisionShortId(decisionId)}` : null]
    .filter((part): part is string => part !== null).join(" · ") || null;
  const threadDetail = formatDecisionThreadDetail(payload, {
    language,
    replyStyle: ctx.replyStyle,
    question,
    hasButtons: actions.length > 0,
    decisionId,
  });
  // Without an explanation the question line says what to decide; why Core
  // stopped (for example the no-progress limit) only lives in `reason`, so the
  // card carries it too. With one, the summary already says it.
  const reason = explanation ? null : decisionPayloadContextLines(payload).reason.join("\n") || null;
  const autoRecovery = text(payload.auto_recovery_summary);
  const fields = [
    ...(reason && reason !== question.full ? [{ label: t.fieldReason, value: truncateText(reason, FIELD_VALUE_MAX) }] : []),
    ...(autoRecovery ? [{ label: decisionHeadings(language).autoRecovery, value: truncateText(autoRecovery, AUTO_RECOVERY_FIELD_MAX) }] : []),
  ];
  return makeCard("decision.opened", language, CARD_STYLES["decision.opened"], decisionTitle(payload), truncateText(body, BODY_MAX), fields, footer, withWorkTitle(workTitle, question.line), {
    actions,
    threadDetail,
    question: question.source === "none" ? null : question.line,
  });
}

function buildProviderPausedCard(event: OwlEvent, ctx: CardRenderContext): NotificationCard {
  const payload = event.payload;
  const language = ctx.language;
  const t = CARD_TEXT[language];
  const label = text(payload.provider_label) ?? text(payload.provider) ?? "Provider";
  const resumeAt = text(payload.resume_at);
  const timestamp = resumeAt === null ? Number.NaN : Date.parse(resumeAt);
  const validTime = Number.isFinite(timestamp);
  const time = validTime ? ctx.formatTime(timestamp) : t.unknownTime;
  const body = payload.repeat
    ? t.providerPausedAgain(label, time)
    : payload.resume_source === "reported"
      ? t.providerPaused(label, time)
      : t.providerPausedUnknown(label, time);
  return makeCard("provider.paused", language, CARD_STYLES["provider.paused"], t.titles.providerPaused, body, [], null,
    t.providerPausedSubject(label, validTime ? formatClockTime(timestamp, language) : null));
}

function buildProviderResumedCard(event: OwlEvent, language: OwlLanguage): NotificationCard {
  const payload = event.payload;
  const t = CARD_TEXT[language];
  const label = text(payload.provider_label) ?? text(payload.provider) ?? "Provider";
  return makeCard("provider.resumed", language, CARD_STYLES["provider.resumed"], t.titles.providerResumed,
    t.providerResumed(label), [], null, label);
}

function buildSystemAlertCard(event: OwlEvent, language: OwlLanguage): NotificationCard {
  const payload = event.payload;
  const workId = eventWorkId(event);
  const workScoped = workId !== null;
  const t = CARD_TEXT[language];
  const message = text(payload.message) ?? "";
  const remediation = text(payload.remediation);
  const workTitle = workScoped ? eventWorkTitle(event) : null;
  const fields = remediation ? [{ label: t.fieldRemediation, value: truncateText(remediation, FIELD_VALUE_MAX) }] : [];
  const notice = !workScoped && payload.kind === "curation_notice";
  const noticeInfo = notice && payload.severity === "info";
  const styleKey = workScoped ? "system.alert.work" : noticeInfo ? "system.alert.notice" : "system.alert.system";
  const title = workScoped ? t.titles.workProblem : noticeInfo ? t.titles.curationNotice : t.titles.systemNotice;
  return makeCard("system.alert", language, CARD_STYLES[styleKey],
    title, truncateText(joinLines(workTitle, message) ?? "", BODY_MAX), fields,
    workId ? shortWork(workId) : null, withWorkTitle(workTitle, message.split(/\r?\n/u)[0] ?? ""));
}

function makeCard(
  eventType: NotificationCardEvent,
  language: OwlLanguage,
  style: { readonly emoji: string; readonly color: CardColor },
  title: string,
  body: string | null,
  fields: readonly CardField[],
  footer: string | null,
  subject: string,
  extra: Partial<Pick<NotificationCard, "actions" | "threadDetail" | "question">> = {},
): NotificationCard {
  const fallbackText = truncateText(`${style.emoji} ${toPlainText(title)}${subject ? `: ${toPlainText(subject)}` : ""}`, FALLBACK_MAX);
  return {
    eventType,
    language,
    emoji: style.emoji,
    title,
    color: style.color,
    body: body === null ? null : truncateText(body, BODY_MAX),
    fields: fields.map((field) => ({ ...field, value: truncateText(field.value, FIELD_VALUE_MAX) })),
    footer,
    fallbackText,
    actions: extra.actions ?? [],
    threadDetail: extra.threadDetail ?? null,
    question: extra.question ?? null,
  };
}

function eventWorkId(event: OwlEvent): string | null {
  return text(event.payload.work_id) ?? text(event.work_id);
}

/** Work title: work.* reads work_title then title; decision.* and system.alert read work_title only. */
function eventWorkTitle(event: OwlEvent): string | null {
  const payload = event.payload;
  return text(payload.work_title) ?? (event.type.startsWith("work.") ? text(payload.title) : null);
}

function joinLines(first: string | null, rest: string | null): string | null {
  return first && rest ? `${first}\n${rest}` : first ?? rest;
}

function withWorkTitle(workTitle: string | null, subject: string): string {
  return workTitle ? `${workTitle}: ${subject}` : subject;
}

function shortWork(workId: string): string {
  return `Work ${workId.slice(-6)}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Never trims: postSlackMessage splits long text across messages, and a
// trimmed detail would hide options and what choosing each one does.
function joinDetail(sections: Array<{ heading: string; body: string }>, guide: string, guideTitle: string): string {
  const render = (section: { heading: string; body: string }): string => `**${section.heading}**\n${section.body}`;
  const guideBlock = guideTitle && !guide.startsWith(`${guideTitle}:`)
    ? render({ heading: guideTitle, body: guide })
    : guide;
  return [...sections.map(render), guideBlock].join("\n\n");
}
