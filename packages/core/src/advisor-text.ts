import type { OwnerLanguage } from "@owl/shared";

/**
 * Owl's own messages in the Advisor conversation (not the Advisor's reply).
 * They follow the Owner language (owner-language.ts).
 */
export interface AdvisorText {
  readonly replyFailed: string;
  readonly emptyReply: string;
  readonly turnFailed: string;
  readonly rateLimited: (timing: "reset" | "retry" | "unknown", time: string | null) => string;
  readonly createIncomplete: string;
  readonly createBadProject: string;
  readonly unknownCause: string;
  readonly created: (title: string, route: "Worker" | "Manager", workId: string) => string;
  readonly createdNotStarted: (title: string, workId: string, detail: string) => string;
  readonly createFailed: (detail: string) => string;
  readonly createdRecovered: (title: string, workId: string) => string;
  readonly dirtyWorkspace: (path: string) => string;
  readonly attachmentQuarantined: (filename: string) => string;
}

export const ADVISOR_TEXT: Record<OwnerLanguage, AdvisorText> = {
  ja: {
    replyFailed: "⚠ Advisorの応答に失敗しました。",
    emptyReply: "（Advisorから空の応答が返されました。もう一度送信してください）",
    turnFailed: "AdvisorのProvider/Harness処理に失敗しました。設定とログを確認してください。",
    rateLimited: (timing, time) => {
      const schedule = timing === "reset" && time !== null
        ? `${time}ごろ解除される見込みです。`
        : timing === "retry" && time !== null
          ? `次回の試行は${time}ごろの予定です。`
          : "解除時刻は未定です。";
      return `AdvisorのProvider利用上限に達しました。${schedule}同じ依頼の自動再送は行いません。解除後にもう一度送信してください。`;
    },
    createIncomplete: "⚠ Workの起票に失敗しました。AdvisorのWork内容が不足しているため、タイトル・概要・規模を確認して再依頼してください。",
    createBadProject: "⚠ Workの起票に失敗しました。プロジェクト指定を確認して再依頼してください。",
    unknownCause: "原因を確認できませんでした。",
    created: (title, route, workId) => `✓ Work「${title}」を起票し、${route}へ渡しました（ID: ${workId}）。`,
    createdNotStarted: (title, workId, detail) => `⚠ Work「${title}」は起票しました（ID: ${workId}）が、開始できませんでした。${detail}`,
    createFailed: (detail) => `⚠ Workの起票に失敗しました。${detail}`,
    createdRecovered: (title, workId) => `✓ Work「${title}」は前回の試行で起票済みだったため、開始しました（ID: ${workId}）。`,
    dirtyWorkspace: (path) => `Advisor の作業用 worktree に未コミット、またはベースブランチ未統合の変更があります。変更は保持されており、自動では統合されません。\n${path}`,
    attachmentQuarantined: (filename) => `⚠ ${filename} は隔離されました。Advisorには渡していません。`,
  },
  en: {
    replyFailed: "⚠ The Advisor could not reply.",
    emptyReply: "(The Advisor returned an empty reply. Please send the message again.)",
    turnFailed: "The Advisor Provider/Harness failed. Check the settings and logs.",
    rateLimited: (timing, time) => {
      const schedule = timing === "reset" && time !== null
        ? `It is expected to reset around ${time}.`
        : timing === "retry" && time !== null
          ? `The next attempt is scheduled around ${time}.`
          : "The reset time is unknown.";
      return `The Advisor has reached its Provider usage limit. ${schedule} This request will not be retried automatically. Please send it again after the limit resets.`;
    },
    createIncomplete: "⚠ Could not create the Work: the Advisor's Work details were incomplete. Check the title, summary, and size, then ask again.",
    createBadProject: "⚠ Could not create the Work: check the Project and ask again.",
    unknownCause: "The cause could not be determined.",
    created: (title, route, workId) => `✓ Created Work "${title}" and handed it to the ${route} (ID: ${workId}).`,
    createdNotStarted: (title, workId, detail) => `⚠ Created Work "${title}" (ID: ${workId}) but could not start it. ${detail}`,
    createFailed: (detail) => `⚠ Could not create the Work. ${detail}`,
    createdRecovered: (title, workId) => `✓ Work "${title}" was already created by an earlier attempt; started it now (ID: ${workId}).`,
    dirtyWorkspace: (path) => `The Advisor's worktree has uncommitted changes, or changes not merged into the base branch. They are kept and will not be merged automatically.\n${path}`,
    attachmentQuarantined: (filename) => `⚠ ${filename} was quarantined and was not handed to the Advisor.`,
  },
};

/** Formats the Provider reset, or the next scheduled attempt if no reset was reported. */
export function formatAdvisorRateLimitReply(
  language: OwnerLanguage,
  resetsAt: string | null | undefined,
  nextAttemptAt: string | null | undefined,
): string {
  const resetDate = parseTimestamp(resetsAt);
  const nextAttemptDate = resetDate === null ? parseTimestamp(nextAttemptAt) : null;
  const date = resetDate ?? nextAttemptDate;
  const timing = resetDate !== null ? "reset" : nextAttemptDate !== null ? "retry" : "unknown";
  const formattedTime = date === null
    ? null
    : new Intl.DateTimeFormat(language === "ja" ? "ja-JP" : "en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date);
  return ADVISOR_TEXT[language].rateLimited(timing, formattedTime);
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value);
}
