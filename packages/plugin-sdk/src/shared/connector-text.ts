import type { OwlLanguage } from "./language";

/**
 * What connectors write back to the Owner in chat, in both Owner languages,
 * so Slack and Discord replies read the same way.
 */
export interface ConnectorText {
  /** "（Work abc123）" appended to a line about a Work. */
  readonly workSuffix: (shortWorkId: string) => string;
  readonly workCompletedLine: (label: string) => string;
  readonly workCancelledLine: (label: string) => string;
  readonly workPausedLine: (label: string) => string;
  readonly workReopenedLine: (label: string) => string;
  readonly providerPausedLine: (label: string, time: string) => string;
  readonly providerPausedUnknownLine: (label: string, time: string) => string;
  readonly providerPausedAgainLine: (label: string, time: string) => string;
  readonly providerResumedLine: (label: string) => string;
  readonly workCompletedTitle: string;
  readonly workCancelledTitle: string;
  readonly workPausedTitle: string;
  readonly workReopenedTitle: string;
  readonly workCompletedDescription: (label: string) => string;
  readonly workCancelledDescription: (label: string) => string;
  readonly workPausedDescription: (label: string) => string;
  readonly workReopenedDescription: (label: string) => string;
  /** "理由: ..." appended to a work.paused / work.reopened notice when the Owner gave a reason. */
  readonly reasonLine: (reason: string) => string;
  readonly workProblemTitle: string;
  readonly workProblemLine: (message: string) => string;
  readonly systemAlertTitle: string;
  readonly systemAlertLine: (message: string) => string;
  readonly remediation: (text: string) => string;
  readonly answerAccepted: (shortDecisionId: string) => string;
  readonly answeredWith: (label: string) => string;
  /** Shown when a retried or duplicate answer (e.g. a second button click) finds the Decision already settled, instead of an error. */
  readonly alreadyAnswered: (label: string) => string;
  readonly decisionGone: string;
  /** decision.resolved notification: an already-open Decision (posted elsewhere, e.g. the web UI) got its answer. */
  readonly decisionResolvedLine: (shortDecisionId: string, answer: string) => string;
  readonly decisionResolvedTitle: string;
  /** decision.cancelled notification: the Decision closed without being answered. */
  readonly decisionCancelledLine: (shortDecisionId: string, reasonLabel: string) => string;
  readonly decisionCancelledTitle: string;
  readonly decisionCancelledReasonWorkCancelled: string;
  readonly decisionCancelledReasonTaskSuperseded: string;
  readonly fileReceived: (name: string, size: string, knownFormat: boolean) => string;
  readonly executableNotRun: string;
  readonly fileFailed: (name: string, reason: string, checkScope: boolean) => string;
  readonly notificationSubject: (sequence: number, type: string, shortDecisionId: string | null) => string;
  readonly notificationFailed: (subject: string, detail: string) => string;
  readonly nextActions: string;
}

const TEXT: Readonly<Record<OwlLanguage, ConnectorText>> = {
  ja: {
    workSuffix: (id) => `（Work ${id}）`,
    workCompletedLine: (label) => `完了しました: ${label}`,
    workCancelledLine: (label) => `中止されました: ${label}`,
    workPausedLine: (label) => `一時停止しました: ${label}`,
    workReopenedLine: (label) => `再オープンしました: ${label}`,
    providerPausedLine: (label, time) => `⏸ ${label}が利用上限に達したため、${label}を使う処理を止めています。${time}ごろ再開します。`,
    providerPausedUnknownLine: (label, time) => `⏸ ${label}が利用上限に達したため、${label}を使う処理を止めています。解除時刻が分からないため、${time}ごろに再開を試します。`,
    providerPausedAgainLine: (label, time) => `⏸ ${label}はまだ利用上限のままです。次は${time}ごろに再開を試します。`,
    providerResumedLine: (label) => `▶ ${label}の利用上限が解除されたため、処理を再開しました。`,
    workCompletedTitle: "完了しました",
    workCancelledTitle: "中止されました",
    workPausedTitle: "一時停止しました",
    workReopenedTitle: "再オープンしました",
    workCompletedDescription: (label) => `${label}が完了しました。`,
    workCancelledDescription: (label) => `${label}が中止されました。`,
    workPausedDescription: (label) => `${label}を一時停止しました。`,
    workReopenedDescription: (label) => `${label}を再オープンしました。`,
    reasonLine: (reason) => `理由: ${reason}`,
    workProblemTitle: "問題が発生",
    workProblemLine: (message) => `問題が発生: ${message}`,
    systemAlertTitle: "⚠ システム通知",
    systemAlertLine: (message) => `⚠ システム通知: ${message}`,
    remediation: (text) => `対処: ${text}`,
    answerAccepted: (id) => `回答を受け付けました（ID ${id}）。`,
    answeredWith: (label) => `✓ 「${label}」で回答しました。`,
    alreadyAnswered: (label) => `「${label}」で回答済みです。`,
    decisionGone: "このDecisionはすでに解決済みか、見つかりません。",
    decisionResolvedLine: (id, answer) => `✓ Decision（ID ${id}）が解決しました: ${answer}`,
    decisionResolvedTitle: "解決しました",
    decisionCancelledLine: (id, reasonLabel) => `Decision（ID ${id}）は取り消されました（${reasonLabel}）。`,
    decisionCancelledTitle: "取り消されました",
    decisionCancelledReasonWorkCancelled: "Workが中止されたため",
    decisionCancelledReasonTaskSuperseded: "対象のTaskが置き換えられたため",
    fileReceived: (name, size, knownFormat) => knownFormat
      ? `ファイルを受け取りました: ${name}（${size}）`
      : `ファイルを受け取りました: ${name}（${size}）— この形式はAIが中身を読めません。パスだけ渡します`,
    executableNotRun: "⚠ 実行ファイルのため実行はしません。",
    fileFailed: (name, reason, checkScope) => `⚠ ファイルを取り込めませんでした: ${name}（${reason}）${checkScope ? " Slack アプリの files:read スコープを確かめてください。" : ""}`,
    notificationSubject: (sequence, type, decisionId) => `イベント #${sequence} ${type}${decisionId ? `, Decision ${decisionId}` : ""}`,
    notificationFailed: (subject, detail) => `⚠ 通知を送信できませんでした（${subject}）。${detail}`,
    nextActions: "次のアクション案:",
  },
  en: {
    workSuffix: (id) => ` (Work ${id})`,
    workCompletedLine: (label) => `Completed: ${label}`,
    workCancelledLine: (label) => `Cancelled: ${label}`,
    workPausedLine: (label) => `Paused: ${label}`,
    workReopenedLine: (label) => `Reopened: ${label}`,
    providerPausedLine: (label, time) => `⏸ ${label} hit its usage limit. Work that uses ${label} is on hold until about ${time}.`,
    providerPausedUnknownLine: (label, time) => `⏸ ${label} hit its usage limit. The reset time is unknown; Owl will try again around ${time}.`,
    providerPausedAgainLine: (label, time) => `⏸ ${label} is still at its usage limit. Owl will try again around ${time}.`,
    providerResumedLine: (label) => `▶ ${label}'s usage limit has reset. Work has resumed.`,
    workCompletedTitle: "Completed",
    workCancelledTitle: "Cancelled",
    workPausedTitle: "Paused",
    workReopenedTitle: "Reopened",
    workCompletedDescription: (label) => `${label} is complete.`,
    workCancelledDescription: (label) => `${label} was cancelled.`,
    workPausedDescription: (label) => `${label} was paused.`,
    workReopenedDescription: (label) => `${label} was reopened.`,
    reasonLine: (reason) => `Reason: ${reason}`,
    workProblemTitle: "Problem",
    workProblemLine: (message) => `Problem: ${message}`,
    systemAlertTitle: "⚠ System notice",
    systemAlertLine: (message) => `⚠ System notice: ${message}`,
    remediation: (text) => `What to do: ${text}`,
    answerAccepted: (id) => `Answer received (ID ${id}).`,
    answeredWith: (label) => `✓ Answered "${label}".`,
    alreadyAnswered: (label) => `Already answered "${label}".`,
    decisionGone: "This Decision was already resolved or cannot be found.",
    decisionResolvedLine: (id, answer) => `✓ Decision (ID ${id}) was resolved: ${answer}`,
    decisionResolvedTitle: "Resolved",
    decisionCancelledLine: (id, reasonLabel) => `Decision (ID ${id}) was cancelled (${reasonLabel}).`,
    decisionCancelledTitle: "Cancelled",
    decisionCancelledReasonWorkCancelled: "the Work was cancelled",
    decisionCancelledReasonTaskSuperseded: "the Task it was blocking was superseded",
    fileReceived: (name, size, knownFormat) => knownFormat
      ? `File received: ${name} (${size})`
      : `File received: ${name} (${size}) — the AI cannot read this format, so only its path is passed on.`,
    executableNotRun: "⚠ This is an executable, so it will not be run.",
    fileFailed: (name, reason, checkScope) => `⚠ Could not import the file: ${name} (${reason})${checkScope ? " Check that the Slack app has the files:read scope." : ""}`,
    notificationSubject: (sequence, type, decisionId) => `event #${sequence} ${type}${decisionId ? `, Decision ${decisionId}` : ""}`,
    notificationFailed: (subject, detail) => `⚠ Could not send a notification (${subject}). ${detail}`,
    nextActions: "Suggested next actions:",
  },
};

export function connectorText(language: OwlLanguage): ConnectorText {
  return TEXT[language];
}
