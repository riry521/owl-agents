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
  readonly curationSucceeded: (summary: string) => string;
  readonly curationFailed: (kind: string, detail: string) => string;
  readonly instructionSent: (ref: string) => string;
  readonly instructionSentReopened: (ref: string) => string;
  readonly workUpdated: (ref: string, fields: readonly ("title" | "summary")[], replanQueued: boolean) => string;
  readonly workUnchanged: (ref: string) => string;
  readonly workPaused: (ref: string) => string;
  readonly workResumed: (ref: string) => string;
  readonly workRetried: (ref: string) => string;
  readonly workCancelledNotice: (ref: string) => string;
  readonly workActionIncomplete: (action: string) => string;
  readonly workNotFound: (workId: string) => string;
  readonly instructionNotStarted: (ref: string) => string;
  readonly instructionCancelled: (ref: string) => string;
  readonly instructionReopenRequired: (ref: string) => string;
  readonly notAllowedInState: (action: string, ref: string, state: string) => string;
  readonly workActionConflict: (ref: string) => string;
  readonly workActionAlreadyApplied: (action: string, ref: string) => string;
  readonly workActionFailed: (action: string, ref: string, detail: string) => string;
  readonly dirtyWorkspace: (path: string) => string;
  readonly attachmentQuarantined: (filename: string) => string;
}

const CURATION_KIND_LABEL: Record<OwnerLanguage, Record<string, string>> = {
  ja: { librarian: "ナレッジ", skill_curation: "スキル", rule_curation: "ルール" },
  en: { librarian: "knowledge", skill_curation: "skill", rule_curation: "rule" },
};

const WORK_ACTION_LABEL: Record<OwnerLanguage, Record<string, string>> = {
  ja: {
    send_work_instruction: "指示の送信",
    update_work: "更新",
    pause_work: "一時停止",
    resume_work: "再開",
    cancel_work: "キャンセル",
  },
  en: {
    send_work_instruction: "sending the instruction",
    update_work: "update",
    pause_work: "pause",
    resume_work: "resume",
    cancel_work: "cancellation",
  },
};

const WORK_STATE_LABEL: Record<OwnerLanguage, Record<string, string>> = {
  ja: {
    memo: "メモ",
    ready: "開始前",
    running: "実行中",
    paused: "一時停止中",
    judgement_waiting: "判断待ち",
    completed: "完了",
    cancelled: "キャンセル済み",
  },
  en: {
    memo: "memo",
    ready: "not started",
    running: "running",
    paused: "paused",
    judgement_waiting: "waiting for a decision",
    completed: "completed",
    cancelled: "cancelled",
  },
};

function workActionLabel(language: OwnerLanguage, action: string): string {
  const labels = WORK_ACTION_LABEL[language];
  return Object.hasOwn(labels, action) ? labels[action]! : action;
}

function workStateLabel(language: OwnerLanguage, state: string): string {
  const labels = WORK_STATE_LABEL[language];
  return Object.hasOwn(labels, state) ? labels[state]! : state;
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
    curationSucceeded: (summary) => `✓ 整理を実行しました。\n${summary}`,
    curationFailed: (kind, detail) => `⚠ ${CURATION_KIND_LABEL.ja[kind] ?? kind}の整理に失敗しました。${detail}`,
    instructionSent: (ref) => `✓ Work${ref}に指示を送りました。Managerが計画に反映します。`,
    instructionSentReopened: (ref) => `✓ 完了済みのWork${ref}を再開し、指示を送りました。`,
    workUpdated: (ref, fields, replanQueued) => {
      const field = fields.includes("title") && fields.includes("summary")
        ? "タイトルと概要"
        : fields.includes("title") ? "タイトル" : "概要";
      return `✓ Work${ref}の${field}を更新しました。${replanQueued ? "Managerに計画の見直しを依頼しました。" : ""}`;
    },
    workUnchanged: (ref) => `Work${ref}のタイトルと概要は指定と同じだったため、変更していません。`,
    workPaused: (ref) => `✓ Work${ref}を一時停止しました。`,
    workResumed: (ref) => `✓ Work${ref}を再開しました。`,
    workRetried: (ref) => `✓ エラーで止まっていたWork${ref}に再試行を指示しました。`,
    workCancelledNotice: (ref) => `✓ Work${ref}をキャンセルしました。`,
    workActionIncomplete: (action) => `⚠ ${workActionLabel("ja", action)}を実行できませんでした。AdvisorのWork指定（work_idなど）が不足しているか形式が違います。Workは変更していません。`,
    workNotFound: (workId) => `⚠ ID ${workId} のWorkが見つからないため、何も変更していません。`,
    instructionNotStarted: (ref) => `⚠ Work${ref}はまだ開始されていないため、指示を送っていません。`,
    instructionCancelled: (ref) => `⚠ Work${ref}はキャンセル済みのため、指示を送っていません。続けるには新しいWorkを起票してください。`,
    instructionReopenRequired: (ref) => `⚠ Work${ref}は完了済みのため、指示を送っていません。再開して指示を送る場合は、再開してよいか確認のうえ、もう一度依頼してください。`,
    notAllowedInState: (action, ref, state) => `⚠ Work${ref}は現在「${workStateLabel("ja", state)}」のため、${workActionLabel("ja", action)}できません。Workは変更していません。`,
    workActionConflict: (ref) => `⚠ 操作中にWork${ref}の状態が変わったため、実行しませんでした。状態を確認してもう一度依頼してください。`,
    workActionAlreadyApplied: (action, ref) => `✓ Work${ref}の${workActionLabel("ja", action)}は前回の試行で実行済みです。`,
    workActionFailed: (action, ref, detail) => `⚠ Work${ref}の${workActionLabel("ja", action)}に失敗しました。${detail}`,
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
    curationSucceeded: (summary) => `✓ Ran the tidy-up.\n${summary}`,
    curationFailed: (kind, detail) => `⚠ The ${CURATION_KIND_LABEL.en[kind] ?? kind} tidy-up failed. ${detail}`,
    instructionSent: (ref) => `✓ Sent the instruction to Work ${ref}. The Manager will fold it into the plan.`,
    instructionSentReopened: (ref) => `✓ Reopened the completed Work ${ref} and sent the instruction.`,
    workUpdated: (ref, fields, replanQueued) => {
      const field = fields.includes("title") && fields.includes("summary")
        ? "title and summary"
        : fields.includes("title") ? "title" : "summary";
      return `✓ Updated the ${field} of Work ${ref}.${replanQueued ? " Asked the Manager to re-check the plan." : ""}`;
    },
    workUnchanged: (ref) => `Work ${ref} already had that title and summary; nothing was changed.`,
    workPaused: (ref) => `✓ Paused Work ${ref}.`,
    workResumed: (ref) => `✓ Resumed Work ${ref}.`,
    workRetried: (ref) => `✓ Told Work ${ref}, which had stopped on an error, to retry.`,
    workCancelledNotice: (ref) => `✓ Cancelled Work ${ref}.`,
    workActionIncomplete: (action) => `⚠ Could not run the ${workActionLabel("en", action)}: the Advisor's Work details (such as work_id) were missing or malformed. No Work was changed.`,
    workNotFound: (workId) => `⚠ No Work has the ID ${workId}; nothing was changed.`,
    instructionNotStarted: (ref) => `⚠ Work ${ref} has not started yet, so the instruction was not sent.`,
    instructionCancelled: (ref) => `⚠ Work ${ref} is cancelled, so the instruction was not sent. Create a new Work to continue.`,
    instructionReopenRequired: (ref) => `⚠ Work ${ref} is completed, so the instruction was not sent. To reopen it and send the instruction, confirm the reopen and ask again.`,
    notAllowedInState: (action, ref, state) => `⚠ Work ${ref} is ${workStateLabel("en", state)}, so the ${workActionLabel("en", action)} is not possible. The Work was not changed.`,
    workActionConflict: (ref) => `⚠ Work ${ref} changed while the operation ran, so it was not applied. Check its state and ask again.`,
    workActionAlreadyApplied: (action, ref) => `✓ The ${workActionLabel("en", action)} of Work ${ref} was already done by an earlier attempt.`,
    workActionFailed: (action, ref, detail) => `⚠ The ${workActionLabel("en", action)} of Work ${ref} failed. ${detail}`,
    dirtyWorkspace: (path) => `The Advisor's worktree has uncommitted changes, or changes not merged into the base branch. They are kept and will not be merged automatically.\n${path}`,
    attachmentQuarantined: (filename) => `⚠ ${filename} was quarantined and was not handed to the Advisor.`,
  },
};

/** Formats a stable reference to an existing Work for Advisor notices. */
export function workRef(language: OwnerLanguage, title: string, displayNumber: number | null, workId: string): string {
  if (language === "en") {
    return displayNumber === null
      ? `"${title}" (ID: ${workId})`
      : `"${title}" (#${displayNumber}, ID: ${workId})`;
  }
  return displayNumber === null
    ? `「${title}」（ID: ${workId}）`
    : `「${title}」（#${displayNumber}、ID: ${workId}）`;
}

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
