import type { OwlEvent } from "../types";
import { asOwlLanguage, type OwlLanguage } from "./language";
import { createDecisionButtonId } from "./decision-button";
import { decisionHeadings, decisionLanguage, decisionTitle } from "./decision-text";
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
export const FALLBACK_MAX = 200;
export const DETAIL_MAX = 3800;

type CardStyleKey = Exclude<NotificationCardEvent, "system.alert"> | "system.alert.work" | "system.alert.system";

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
      workProblem: "問題が発生", systemNotice: "システム通知",
    },
    fieldReason: "理由", fieldRemediation: "対処", fieldAnswer: "回答", emptyAnswer: "（回答なし）",
    noQuestion: "（質問文がありません）", moreOptions: (count) => `…ほか${count}件`,
    recommendedLegend: "★ はおすすめの選択肢です。", detailTitle: "詳細", howToAnswer: "回答方法",
    threadReplySupplement: "詳細が投稿されたこのスレッドへの返信も回答として扱われます。",
    replyMessageSupplement: "この詳細メッセージに直接返信して回答することもできます。",
    guideFreeText: "選択肢にない内容で答えることもできます。",
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
      workProblem: "Problem", systemNotice: "System notice",
    },
    fieldReason: "Reason", fieldRemediation: "What to do", fieldAnswer: "Answer", emptyAnswer: "(no answer)",
    noQuestion: "(No question provided)", moreOptions: (count) => `…and ${count} more`,
    recommendedLegend: "★ marks the recommended option.", detailTitle: "Details", howToAnswer: "How to answer",
    threadReplySupplement: "A reply in this thread also counts as your answer.",
    replyMessageSupplement: "You can also answer by replying directly to this detail message.",
    guideFreeText: "You can also answer with something that is not one of the options.",
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
    return [{
      index,
      key,
      label,
      description: text(record.description),
      recommended: recommended !== null && key === recommended,
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
  const reason = text(payload.reason);
  const currentState = text(payload.current_state);
  const tried = text(payload.tried);
  if (reason) sections.push({ heading: headings.reason, body: reason });
  if (input.question.source === "question" && input.question.shortened && input.question.full) {
    sections.push({ heading: headings.question, body: input.question.full });
  }
  if (options.length > 0) {
    const optionLines = options.map((option) =>
      `• ${option.label}${option.recommended ? " ★" : ""}${option.description ? ` — ${option.description}` : ""}`);
    if (options.some((option) => option.recommended)) optionLines.push(t.recommendedLegend);
    sections.push({ heading: headings.options, body: optionLines.join("\n") });
  }
  if (currentState) sections.push({ heading: headings.currentState, body: currentState });
  if (tried) sections.push({ heading: headings.tried, body: tried });
  const guide = formatDecisionAnswerGuide({
    decisionId: input.decisionId,
    language: input.language,
    hasButtons: input.hasButtons,
    hasOptions: options.length > 0,
    allowFreeText: typeof payload.allow_free_text === "boolean" ? payload.allow_free_text : null,
    replyStyle: input.replyStyle,
  });
  return fitDetail(sections, guide, DETAIL_MAX, t.howToAnswer);
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
  if (parts.length === 0) return null;
  return language === "ja" ? parts.join("・") : parts.join(" · ");
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
  const body = joinLines(workTitle, `❓ ${question.line}${optionList ? `\n\n${optionList}` : ""}`) ?? "";
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
  return makeCard("decision.opened", language, CARD_STYLES["decision.opened"], decisionTitle(payload), truncateText(body, BODY_MAX), [], footer, withWorkTitle(workTitle, question.line), {
    actions,
    threadDetail: truncateText(threadDetail, DETAIL_MAX),
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
  const clockTime = validTime ? formatClockTime(timestamp, language) : t.unknownTime;
  const time = validTime ? ctx.formatTime(timestamp) : t.unknownTime;
  const body = payload.repeat
    ? t.providerPausedAgain(label, time)
    : payload.resume_source === "reported"
      ? t.providerPaused(label, time)
      : t.providerPausedUnknown(label, time);
  const fallbackTime = validTime ? formatClockTime(timestamp, language) : null;
  return makeCard("provider.paused", language, CARD_STYLES["provider.paused"], t.titles.providerPaused, body, [], null,
    t.providerPausedSubject(label, fallbackTime));
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
  return makeCard("system.alert", language, CARD_STYLES[workScoped ? "system.alert.work" : "system.alert.system"],
    workScoped ? t.titles.workProblem : t.titles.systemNotice, truncateText(joinLines(workTitle, message) ?? "", BODY_MAX), fields,
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

function fitDetail(sections: Array<{ heading: string; body: string }>, guide: string, max: number, guideTitle: string): string {
  const render = (section: { heading: string; body: string }): string => `**${section.heading}**\n${section.body}`;
  const guideBlock = guideTitle && !guide.startsWith(`${guideTitle}:`)
    ? render({ heading: guideTitle, body: guide })
    : guide;
  const budget = max - guideBlock.length - 2;
  const kept = [...sections];
  const total = (): number => kept.reduce((length, section, index) => length + render(section).length + (index > 0 ? 2 : 0), 0);
  while (kept.length > 0 && total() > budget) {
    const last = kept[kept.length - 1]!;
    const overflow = total() - budget;
    const room = last.body.length - overflow;
    if (room >= 20) kept[kept.length - 1] = { ...last, body: truncateText(last.body, room) };
    else kept.pop();
  }
  return [...kept.map(render), guideBlock].join("\n\n");
}
