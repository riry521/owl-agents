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
  readonly windowProjectMismatch: (windowProject: string, requestedProject: string) => string;
  readonly handoffDone: (targetName: string, channels: readonly string[]) => string;
  readonly handoffMessage: (fromName: string, summary: string) => string;
  readonly handoffNoProject: string;
  readonly handoffSameWindow: string;
  readonly handoffInvalid: string;
  readonly generalWindowName: string;
  readonly unknownCause: string;
  readonly createdDraft: (title: string, workId: string) => string;
  readonly created: (title: string, route: "Worker" | "Manager", workId: string) => string;
  readonly createdWaiting: (title: string, workId: string) => string;
  readonly createdNotStarted: (title: string, workId: string, detail: string) => string;
  readonly createFailed: (detail: string) => string;
  readonly createdRecovered: (title: string, workId: string) => string;
  readonly curationSucceeded: (summary: string) => string;
  readonly curationFailed: (kind: string, detail: string) => string;
  readonly curationStarted: (kind: string, runId: string, alreadyRunning: boolean) => string;
  readonly instructionSent: (ref: string) => string;
  readonly instructionSentReopened: (ref: string) => string;
  readonly workUpdated: (ref: string, fields: readonly ("title" | "summary")[], replanQueued: boolean) => string;
  readonly workUnchanged: (ref: string) => string;
  readonly workPaused: (ref: string) => string;
  readonly workResumed: (ref: string) => string;
  readonly workRetried: (ref: string) => string;
  readonly workCancelledNotice: (ref: string) => string;
  readonly workDeletedNotice: (ref: string) => string;
  readonly workMovedToProject: (ref: string, projectName: string, displayNumber: number) => string;
  readonly workProjectAlreadySet: (ref: string) => string;
  readonly projectNotFoundForMove: (projectId: string) => string;
  readonly workBusyForMove: (ref: string) => string;
  readonly workFixPendingForMove: (ref: string, taskIds: readonly string[]) => string;
  readonly workActionIncomplete: (action: string) => string;
  readonly actionsMalformed: string;
  readonly followupPending: string;
  readonly followupLabel: string;
  readonly followupHeldChanged: (action: string) => string;
  readonly followupHeldUnknown: (action: string) => string;
  readonly followupHeldOther: (action: string) => string;
  readonly followupHeldRecorded: (action: string) => string;
  readonly followupHeldNotRecorded: (action: string) => string;
  readonly followupStopped: string;
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
  readonly callApiDone: (method: string, path: string, status: number, summary: string) => string;
  readonly callApiFailed: (method: string, path: string, status: number, summary: string) => string;
  readonly callApiUnknown: (method: string, path: string) => string;
  readonly callApiNotRecorded: (method: string, path: string) => string;
  readonly callApiAlreadyHandled: (method: string, path: string, outcome: string, status: number | null) => string;
  readonly callApiRejected: (reason: string) => string;
  readonly callApiUnavailable: string;
  readonly sendFileIncomplete: (reason: string) => string;
  readonly sendFileUnsupportedChannel: (name: string) => string;
  readonly sendFileRejected: (name: string, reason: string) => string;
  readonly sendFileReason: {
    readonly outside: string; readonly symlinkEscape: string; readonly secret: string;
    readonly notFound: string; readonly notAFile: string; readonly unreadable: string; readonly noFolder: string;
    readonly changed: string;
    readonly tooLarge: (size: string, limit: string, channel: string) => string;
  };
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
    delete_work: "削除",
    move_work_to_project: "Project への移動",
  },
  en: {
    send_work_instruction: "sending the instruction",
    update_work: "update",
    pause_work: "pause",
    resume_work: "resume",
    cancel_work: "cancellation",
    delete_work: "deletion",
    move_work_to_project: "move to a Project",
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
    windowProjectMismatch: (windowProject, requestedProject) => `⚠ この窓は「${windowProject}」の専属です。「${requestedProject}」の話は handoff_to_window で「${requestedProject}」の窓に渡してください。`,
    handoffDone: (targetName, channels) => `「${targetName}」の窓に引き継ぎました。続きはそちらで話してください。${channels.length === 0 ? "" : `（${channels.join(" / ")}）`}`,
    handoffMessage: (fromName, summary) => `「${fromName}」の窓から引き継ぎました。\n\n${summary}`,
    handoffNoProject: "⚠ 引き継ぎ先のプロジェクトが見つかりません。",
    handoffSameWindow: "⚠ 同じ窓には引き継げません。",
    handoffInvalid: "⚠ 引き継ぎに失敗しました。引き継ぎ先と要点を確認して再依頼してください。",
    generalWindowName: "ジェネラリスト",
    unknownCause: "原因を確認できませんでした。",
    createdDraft: (title, workId) => `📝 Work「${title}」を下書きとして起票しました（ID: ${workId}）。まだ開始していません。開始は Work 詳細画面の開始ボタンから行ってください。`,
    created: (title, route, workId) => `✓ Work「${title}」を起票し、${route}へ渡しました（ID: ${workId}）。`,
    createdWaiting: (title, workId) => `⏳ Work「${title}」を起票しました（ID: ${workId}）。前提の Work がすべて完了したら自動で開始します。`,
    createdNotStarted: (title, workId, detail) => `⚠ Work「${title}」は起票しました（ID: ${workId}）が、開始できませんでした。${detail}`,
    createFailed: (detail) => `⚠ Workの起票に失敗しました。${detail}`,
    createdRecovered: (title, workId) => `✓ Work「${title}」は前回の試行で起票済みだったため、開始しました（ID: ${workId}）。`,
    curationSucceeded: (summary) => `✓ 整理を実行しました。\n${summary}`,
    curationFailed: (kind, detail) => `⚠ ${CURATION_KIND_LABEL.ja[kind] ?? kind}の整理に失敗しました。${detail}`,
    curationStarted: (kind, runId, alreadyRunning) => alreadyRunning
      ? `⏳ ${CURATION_KIND_LABEL.ja[kind] ?? kind}の整理はすでに実行中です（run id: ${runId}）。終わったら通知します。`
      : `⏳ ${CURATION_KIND_LABEL.ja[kind] ?? kind}の整理を開始しました（run id: ${runId}）。終わったら通知します。`,
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
    workDeletedNotice: (ref) => `✓ Work${ref}を削除しました。`,
    workMovedToProject: (ref, projectName, displayNumber) => `✓ Work${ref}をProject「${projectName}」へ移しました。移動後の番号は Work #${displayNumber} です。`,
    workProjectAlreadySet: (ref) => `⚠ Work${ref}はすでにProjectに属しているため、移していません。Project間の移動はできません。`,
    projectNotFoundForMove: (projectId) => `⚠ ID ${projectId} のProjectが見つからないため、Workを移していません。`,
    workBusyForMove: (ref) => `⚠ Work${ref}のAgentが動作中のため、移していません。Agentが止まってからもう一度依頼してください。`,
    workFixPendingForMove: (ref, taskIds) => `⚠ Work${ref}には修正待ちのTask（${taskIds.join("、")}）があるため、移していません。そのTaskが終わってからもう一度依頼してください。`,
    workActionIncomplete: (action) => `⚠ ${workActionLabel("ja", action)}を実行できませんでした。AdvisorのWork指定（work_idなど）が不足しているか形式が違います。Workは変更していません。`,
    actionsMalformed: "⚠ owl-actions の一部が不正で破棄されたため、そのアクション（Work 作成など）を実行できませんでした。",
    followupPending: "↻ うまくいかなかった操作があるので、Advisor が続けて確かめます。",
    followupLabel: "（自動のフォローアップ）",
    followupHeldChanged: (action) => `⏸ ${workActionLabel("ja", action)}は承認した内容と変わったので、実行していません。直した案でよければ、改めて承認してください。`,
    followupHeldUnknown: (action) => `⏸ ${workActionLabel("ja", action)}は前の結果がわからないので、自動では実行しません。状態を確かめてから、改めて頼んでください。`,
    followupHeldOther: (action) => `⏸ ${workActionLabel("ja", action)}は自動でやり直せる操作ではないので、実行していません。必要なら改めて頼んでください。`,
    followupHeldRecorded: (action) => `⏸ ${workActionLabel("ja", action)}は前の試みで実行を始めたので、もう一度は実行しません。結果は上の通知か今の状態で確かめてください。`,
    followupHeldNotRecorded: (action) => `⏸ ${workActionLabel("ja", action)}の実行の記録を書けなかったので、実行していません。必要なら改めて頼んでください。`,
    followupStopped: "⚠ 自動のやり直しは 1 回までなので、ここで止めました。上の理由を確かめて、続けるときは改めて頼んでください。",
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
    callApiDone: (method, path, status, summary) => `✓ Owl API を実行しました: ${method} ${path} → ${status}（${summary}）`,
    callApiFailed: (method, path, status, summary) => `⚠ Owl API の実行に失敗しました: ${method} ${path} → ${status}（${summary}）`,
    callApiUnknown: (method, path) => `⚠ Owl API の実行結果がわかりません: ${method} ${path}。自動ではやり直しません。GET で状態を確かめてから、必要なら改めて承認を取ってください。`,
    callApiNotRecorded: (method, path) => `⚠ 実行の記録を書けなかったため、Owl API を呼びませんでした: ${method} ${path}`,
    callApiAlreadyHandled: (method, path, outcome, status) => `✓ この呼び出しは前回の試行で処理済みです（${method} ${path}、結果: ${outcome}${status === null ? "" : ` ${status}`}）。`,
    callApiRejected: (reason) => `⚠ call_api を実行しませんでした: ${reason}`,
    callApiUnavailable: "⚠ この環境では Owl API を呼べないため、call_api を実行しませんでした。",
    sendFileIncomplete: (reason) => `⚠ send_file を実行しませんでした: ${reason}`,
    sendFileUnsupportedChannel: (name) => `⚠ ${name} は送っていません。ファイルの送信は Slack と Discord の会話でだけ使えます。`,
    sendFileRejected: (name, reason) => `⚠ ${name} は送っていません: ${reason}`,
    sendFileReason: {
      outside: "送信できるフォルダの外にあります",
      symlinkEscape: "リンク先が送信できるフォルダの外にあります",
      secret: "秘密情報のファイルとみなしました",
      notFound: "ファイルが見つかりません",
      notAFile: "通常のファイルではありません（フォルダなど）",
      unreadable: "ファイルを読めません",
      noFolder: "送信できるフォルダがありません。設定 advisor_send_file_dirs を確かめてください",
      changed: "確認しているあいだにファイルか途中のフォルダが変わりました。もう一度頼んでください",
      tooLarge: (size, limit, channel) => `${size} あり、${channel} の上限 ${limit} を超えています`,
    },
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
    windowProjectMismatch: (windowProject, requestedProject) => `⚠ This window is dedicated to "${windowProject}". Hand "${requestedProject}" over to the "${requestedProject}" window with handoff_to_window.`,
    handoffDone: (targetName, channels) => `Handed this over to the ${targetName} window. Please continue there.${channels.length === 0 ? "" : ` (${channels.join(" / ")})`}`,
    handoffMessage: (fromName, summary) => `Handed over from the "${fromName}" window.\n\n${summary}`,
    handoffNoProject: "⚠ The Project to hand over to was not found.",
    handoffSameWindow: "⚠ Cannot hand over to the same window.",
    handoffInvalid: "⚠ The handoff failed. Check the target and the summary, then ask again.",
    generalWindowName: "General",
    unknownCause: "The cause could not be determined.",
    createdDraft: (title, workId) => `📝 Created Work "${title}" as a draft (ID: ${workId}). It has not been started; start it from the Start button on the Work detail page.`,
    created: (title, route, workId) => `✓ Created Work "${title}" and handed it to the ${route} (ID: ${workId}).`,
    createdWaiting: (title, workId) => `⏳ Created Work "${title}" (ID: ${workId}). It starts automatically when all prerequisite Works are completed.`,
    createdNotStarted: (title, workId, detail) => `⚠ Created Work "${title}" (ID: ${workId}) but could not start it. ${detail}`,
    createFailed: (detail) => `⚠ Could not create the Work. ${detail}`,
    createdRecovered: (title, workId) => `✓ Work "${title}" was already created by an earlier attempt; started it now (ID: ${workId}).`,
    curationSucceeded: (summary) => `✓ Ran the tidy-up.\n${summary}`,
    curationFailed: (kind, detail) => `⚠ The ${CURATION_KIND_LABEL.en[kind] ?? kind} tidy-up failed. ${detail}`,
    curationStarted: (kind, runId, alreadyRunning) => alreadyRunning
      ? `⏳ The ${CURATION_KIND_LABEL.en[kind] ?? kind} tidy-up is already running (run id: ${runId}). You will be notified when it finishes.`
      : `⏳ Started the ${CURATION_KIND_LABEL.en[kind] ?? kind} tidy-up (run id: ${runId}). You will be notified when it finishes.`,
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
    workDeletedNotice: (ref) => `✓ Deleted Work ${ref}.`,
    workMovedToProject: (ref, projectName, displayNumber) => `✓ Moved Work ${ref} into the Project "${projectName}". Its number there is Work #${displayNumber}.`,
    workProjectAlreadySet: (ref) => `⚠ Work ${ref} already belongs to a Project, so it was not moved. Moving between Projects is not possible.`,
    projectNotFoundForMove: (projectId) => `⚠ No Project has the ID ${projectId}; the Work was not moved.`,
    workBusyForMove: (ref) => `⚠ Work ${ref} has running Agents, so it was not moved. Ask again after they stop.`,
    workFixPendingForMove: (ref, taskIds) => `⚠ Work ${ref} has Tasks waiting for a fix (${taskIds.join(", ")}), so it was not moved. Ask again after those Tasks finish.`,
    workActionIncomplete: (action) => `⚠ Could not run the ${workActionLabel("en", action)}: the Advisor's Work details (such as work_id) were missing or malformed. No Work was changed.`,
    actionsMalformed: "⚠ Part of the owl-actions was malformed and discarded, so that action (such as creating a Work) could not be run.",
    followupPending: "↻ Some actions did not work, so the Advisor will check them next.",
    followupLabel: "(Automatic follow-up)",
    followupHeldChanged: (action) => `⏸ The ${workActionLabel("en", action)} differs from what you approved, so it was not run. If the revised proposal is fine, approve it again.`,
    followupHeldUnknown: (action) => `⏸ The earlier result of the ${workActionLabel("en", action)} is unknown, so it will not run automatically. Check the state, then ask again.`,
    followupHeldOther: (action) => `⏸ The ${workActionLabel("en", action)} cannot be retried automatically, so it was not run. Ask again if you still need it.`,
    followupHeldRecorded: (action) => `⏸ The ${workActionLabel("en", action)} already started in an earlier attempt, so it will not run again. Check the notices above or the current state.`,
    followupHeldNotRecorded: (action) => `⏸ The ${workActionLabel("en", action)} was not run because its record could not be written. Ask again if you still need it.`,
    followupStopped: "⚠ Automatic retry happens only once, so it stops here. Check the reasons above and ask again to continue.",
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
    callApiDone: (method, path, status, summary) => `✓ Called the Owl API: ${method} ${path} → ${status} (${summary})`,
    callApiFailed: (method, path, status, summary) => `⚠ The Owl API call failed: ${method} ${path} → ${status} (${summary})`,
    callApiUnknown: (method, path) => `⚠ The result of the Owl API call is unknown: ${method} ${path}. It will not be retried automatically. Check the state with GET, then ask the operator to approve again if needed.`,
    callApiNotRecorded: (method, path) => `⚠ The call record could not be written, so the Owl API was not called: ${method} ${path}`,
    callApiAlreadyHandled: (method, path, outcome, status) => `✓ This call was already handled by an earlier attempt (${method} ${path}, outcome: ${outcome}${status === null ? "" : ` ${status}`}).`,
    callApiRejected: (reason) => `⚠ call_api was not run: ${reason}`,
    callApiUnavailable: "⚠ The Owl API cannot be called in this environment, so call_api was not run.",
    sendFileIncomplete: (reason) => `⚠ send_file was not run: ${reason}`,
    sendFileUnsupportedChannel: (name) => `⚠ ${name} was not sent. Sending files works only in Slack and Discord conversations.`,
    sendFileRejected: (name, reason) => `⚠ ${name} was not sent: ${reason}`,
    sendFileReason: {
      outside: "it is outside the send-file folders",
      symlinkEscape: "its link target is outside the send-file folders",
      secret: "it looks like a secret file",
      notFound: "the file does not exist",
      notAFile: "it is not a regular file (for example, a folder)",
      unreadable: "the file cannot be read",
      noFolder: "no send-file folder exists. Check advisor_send_file_dirs",
      changed: "the file or a folder on its path changed while it was checked. Ask again",
      tooLarge: (size, limit, channel) => `it is ${size}, over the ${channel} limit of ${limit}`,
    },
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
