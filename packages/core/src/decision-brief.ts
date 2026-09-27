import { validationError } from "./errors";
import { formatMissingList } from "./final-verdict";
import type { OwnerLanguage } from "./owner-language";
import type { JsonObject } from "./types";

/**
 * The template every Decision follows, so the Owner can answer without
 * reading logs:
 *
 * - reason: what happened and why the Work or Task stopped.
 * - question: the one thing the Owner is asked to decide.
 * - options[].description: what happens when that option is chosen.
 * - current_state / tried: the surrounding facts (where things stand, what
 *   was already tried or found).
 *
 * Every issuer (Core, Manager, Advisor) fills the same fields, and
 * openDecisionInTransaction rejects a Decision that leaves one empty. The
 * Decisions Core writes itself are worded in the Owner language
 * (owner-language.ts); the wording of both languages lives in TEXT below.
 */
export interface DecisionOptionBrief extends JsonObject {
  readonly key: string;
  readonly label: string;
  readonly description: string;
}

export interface DecisionBrief {
  readonly reason: string;
  readonly question: string;
  readonly current_state: string;
  readonly tried: string;
  readonly options: readonly DecisionOptionBrief[];
  readonly recommended: string | null;
}

/** Option key whose answer cancels the Work (see isDecisionCancelAnswer). */
export const DECISION_CANCEL_OPTION_KEY = "cancel";

/** Option key of a merge-conflict Decision that asks the Manager to resolve the conflict. */
export const RESOLVE_CONFLICT_OPTION_KEY = "resolve_conflict";

/** Throw unless the Decision fills every field of the template. */
export function assertDecisionBrief(brief: {
  readonly reason: string;
  readonly question: string;
  readonly current_state: string;
  readonly tried: string;
  readonly options: readonly JsonObject[];
  readonly recommended: string | null;
  readonly allow_free_text: boolean;
}): void {
  for (const field of ["reason", "question", "current_state", "tried"] as const) {
    if (typeof brief[field] !== "string" || brief[field].trim().length === 0) {
      throw validationError(`A Decision requires ${field}.`, { field });
    }
  }
  const keys = new Set<string>();
  for (const option of brief.options) {
    for (const field of ["key", "label", "description"] as const) {
      const value = option[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw validationError(`Every Decision option requires ${field}.`, { field: `options.${field}` });
      }
    }
    if (keys.has(option.key as string)) {
      throw validationError("Decision option keys must be unique.", { field: "options.key" });
    }
    keys.add(option.key as string);
  }
  if (brief.options.length === 0 && !brief.allow_free_text) {
    throw validationError("A Decision needs options or a free-text answer.", { field: "options" });
  }
  if (brief.recommended !== null && !keys.has(brief.recommended)) {
    throw validationError("The recommended option must be one of the options.", { field: "recommended" });
  }
}

interface OptionText {
  readonly label: string;
  readonly description: string;
}

/** Every sentence Core writes into a Decision, per Owner language. */
const TEXT = {
  ja: {
    cancelWork: {
      label: "Workを中止する",
      description: "Workをキャンセルします。ここまでの変更はWorkブランチに残りますが、完了にはなりません。",
    },
    finalIncomplete: {
      reason: "最終チェックで「まだ完了していない」と判定され、Workが止まりました。",
      verdict: (summary: string) => `判定の内容: ${summary}`,
      question: "足りない部分を追加のタスクで直しますか？ それともこのWorkを中止しますか？",
      currentState: "タスクはすべて終わっていますが、Workは完了になっていません。ここまでの変更はWorkブランチに残っています。",
      missing: (list: string) => `足りないと判定された点:\n${list}`,
      noMissing: "足りない点の一覧は報告されていません。",
      retry: {
        label: "追加タスクで直す",
        description: "Managerが足りない点を直すタスクを追加し、Workを再開します。下の欄に直し方を書くと、その指示もManagerに渡ります。",
      },
    },
    finalFailed: {
      reason: "最終チェックを実行できず、Workが止まりました。「未完了」と判定されたわけではありません。",
      question: "最終チェックに失敗しました。もう一度実行しますか？",
      currentState: "タスクはすべて終わっていますが、最終チェックの結果が得られていないため、Workは完了になっていません。ここまでの変更はWorkブランチに残っています。",
      noCause: "失敗の原因は記録されていません。",
      retry: {
        label: "最終チェックをやり直す",
        description: "Workを再開し、最終チェックをもう一度実行します。計画は立て直しません。",
      },
    },
    workMergeFailed: {
      reason: "Projectのベースブランチへの統合に失敗したため、Workは完了になっていません。",
      question: "マージを再試行しますか？ それともこのWorkを中止しますか？",
      currentState: "最終チェックは完了しましたが、Projectへの統合に失敗したためWorkは判断待ちです。Workブランチの変更は残っています。",
      noCause: "マージ失敗の詳細は記録されていません。",
      noCommand: "コマンドは記録されていません。",
      noOutput: "出力はありませんでした。",
      conflictFiles: (files: string) => `コンフリクトしたファイル:\n${files}`,
      verification: (id: string, command: string, output: string) => `失敗した検証コマンド${id ? ` (${id})` : ""}: ${command}\n出力末尾:\n${output}`,
      baseMoved: (expected: string, actual: string) => `検証中にベースブランチが移動しました。期待値: ${expected || "不明"} / 実際: ${actual || "不明"}`,
      retry: {
        label: "マージを再試行する",
        description: "Workを再開し、最終チェック後にProjectへのマージをもう一度実行します。計画は立て直しません。",
      },
      conflictQuestion: "コンフリクトをManagerに解消させますか？ マージを再試行しますか？ それともこのWorkを中止しますか？",
      resolveConflict: {
        label: "Managerにコンフリクトを解消させる",
        description: "Workを再開し、Managerが最新のベースブランチをWorkブランチに取り込んでコンフリクトしたファイルを解消するTaskを追加します。完了後にもう一度マージします。",
      },
    },
    workHalted: {
      reason: "OwlがWorkの状態を安全に確認できず、Workを止めました。",
      question: "Workの自動実行を再開しますか？",
      tickFailedState: "Owlの内部エラーで、Workの自動実行が止まっています。タスクの作業内容はそのまま残っています。",
      haltedState: "Workは判断待ちで止まっています。タスクの作業内容はそのまま残っています。",
      tried: "自動での復旧はできませんでした。",
      retry: {
        label: "再開する",
        description: "Workの自動実行を再開します。原因が残っていると、また止まります。タスクがすべて終わっている場合は、Managerが下の欄の指示も踏まえて計画を立て直します。",
      },
    },
    taskFailed: {
      reason: (title: string) => `タスク「${title}」が、自動ではやり直せないエラーで止まりました。`,
      question: (title: string) => `タスク「${title}」をもう一度実行しますか？`,
      currentState: "このタスクと、その結果を待つタスクは止まっています。",
      errorKey: (key: string) => `エラーの種類: ${key}`,
      noErrorKey: "エラーの種類は記録されていません。",
      retry: {
        label: "もう一度実行する",
        description: "同じタスクを最初から実行し直します。認証切れなどの原因があれば、先に直してから選んでください。",
      },
    },
    replanFailed: {
      reason: (detail: string) => `Managerが、タスクの失敗を解決する計画を立てられませんでした。\n${detail}`,
      taskQuestion: "失敗したタスクをもう一度実行しますか？",
      workQuestion: "Managerにもう一度計画を立て直させますか？",
      taskState: "失敗したタスクは判断待ちで止まっています。",
      workState: "Workは判断待ちで止まっています。",
      noDetail: "詳細は記録されていません。",
      ownerAnswer: (answer: string) => `あなたの回答: ${answer}`,
      taskRetry: { label: "もう一度実行する", description: "失敗したタスクを同じ内容でもう一度実行します。" },
      workRetry: {
        label: "計画を立て直す",
        description: "Workを再開し、Managerがもう一度計画を立て直します。下の欄に指示を書くと、それもManagerに渡ります。",
      },
    },
  },
  en: {
    cancelWork: {
      label: "Cancel the Work",
      description: "Cancels the Work. The changes so far stay on the Work branch, but the Work is not completed.",
    },
    finalIncomplete: {
      reason: "The final check judged the Work not yet complete, so the Work stopped.",
      verdict: (summary: string) => `Verdict: ${summary}`,
      question: "Add Tasks to fix what is missing, or cancel this Work?",
      currentState: "Every Task has finished, but the Work is not completed. The changes so far are on the Work branch.",
      missing: (list: string) => `What was judged missing:\n${list}`,
      noMissing: "No list of missing points was reported.",
      retry: {
        label: "Fix with more Tasks",
        description: "The Manager adds Tasks that fix the missing points and resumes the Work. Anything you write below is passed to the Manager as well.",
      },
    },
    finalFailed: {
      reason: "The final check could not be run, so the Work stopped. The Work was not judged incomplete.",
      question: "The final check failed. Retry it?",
      currentState: "Every Task has finished, but the Work is not completed because the final check returned no result. The changes so far are on the Work branch.",
      noCause: "No cause was recorded.",
      retry: {
        label: "Retry the final check",
        description: "Resumes the Work and runs the final check again. The plan is not changed.",
      },
    },
    workMergeFailed: {
      reason: "The Work was not completed because it could not be merged into the Project base branch.",
      question: "Retry the merge, or cancel this Work?",
      currentState: "The final check passed, but the Project merge failed. The Work is waiting for your decision, and its branch still has the changes.",
      noCause: "No merge failure details were recorded.",
      noCommand: "No command was recorded.",
      noOutput: "There was no command output.",
      conflictFiles: (files: string) => `Conflicting files:\n${files}`,
      verification: (id: string, command: string, output: string) => `Failed verification command${id ? ` (${id})` : ""}: ${command}\nOutput tail:\n${output}`,
      baseMoved: (expected: string, actual: string) => `The base branch moved during verification. Expected: ${expected || "unknown"} / actual: ${actual || "unknown"}`,
      retry: {
        label: "Retry the merge",
        description: "Resumes the Work and runs the final check and Project merge again. The plan is not changed.",
      },
      conflictQuestion: "Have the Manager resolve the conflict, retry the merge, or cancel this Work?",
      resolveConflict: {
        label: "Have the Manager resolve the conflict",
        description: "Resumes the Work, and the Manager adds a Task that merges the latest base branch into the Work branch and resolves the conflicting files. The merge runs again when it is done.",
      },
    },
    workHalted: {
      reason: "Owl could not safely confirm the state of the Work and stopped it.",
      question: "Resume running the Work automatically?",
      tickFailedState: "An internal Owl error stopped the Work from running automatically. The work done by its Tasks is kept.",
      haltedState: "The Work is stopped, waiting for your decision. The work done by its Tasks is kept.",
      tried: "Automatic recovery was not possible.",
      retry: {
        label: "Resume",
        description: "Resumes running the Work automatically. If the cause remains, it stops again. When every Task has finished, the Manager replans, taking what you write below into account.",
      },
    },
    taskFailed: {
      reason: (title: string) => `The Task "${title}" stopped with an error Owl must not retry on its own.`,
      question: (title: string) => `Run the Task "${title}" again?`,
      currentState: "This Task and the Tasks waiting for its result are stopped.",
      errorKey: (key: string) => `Error kind: ${key}`,
      noErrorKey: "No error kind was recorded.",
      retry: {
        label: "Run again",
        description: "Runs the same Task again from the start. If the cause is something like an expired login, fix it before choosing this.",
      },
    },
    replanFailed: {
      reason: (detail: string) => `The Manager could not make a plan that resolves the failed Tasks.\n${detail}`,
      taskQuestion: "Run the failed Tasks again?",
      workQuestion: "Have the Manager replan again?",
      taskState: "The failed Tasks are stopped, waiting for your decision.",
      workState: "The Work is stopped, waiting for your decision.",
      noDetail: "No details were recorded.",
      ownerAnswer: (answer: string) => `Owner's answer: ${answer}`,
      taskRetry: { label: "Run again", description: "Runs the failed Tasks again with the same content." },
      workRetry: {
        label: "Replan",
        description: "Resumes the Work and the Manager replans. Anything you write below is passed to the Manager as well.",
      },
    },
  },
} as const;

function option(key: string, textOf: OptionText): DecisionOptionBrief {
  return { key, label: textOf.label, description: textOf.description };
}

function cancelWorkOption(language: OwnerLanguage): DecisionOptionBrief {
  return option(DECISION_CANCEL_OPTION_KEY, TEXT[language].cancelWork);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The Decision Core opens when a Work halts on its own (system.alert, or a
 * resume that could not be reconciled). A "retry" answer resumes the Work;
 * when every Task is already finished and some failed, or the final check
 * judged the Work incomplete, Core hands the answer to the Manager as a
 * replan (Core.answerDecision). After final_manager_failed a "retry" only
 * runs the final check again.
 */
export function coreWorkDecisionBrief(payload: JsonObject, language: OwnerLanguage): DecisionBrief {
  if (payload.kind === "final_manager_incomplete") {
    const t = TEXT[language].finalIncomplete;
    const summary = text(payload.summary);
    const missing = formatMissingList(payload.missing, language);
    return {
      reason: [t.reason, summary ? t.verdict(summary) : null].filter(Boolean).join("\n"),
      question: t.question,
      current_state: t.currentState,
      tried: missing ? t.missing(missing) : t.noMissing,
      options: [option("retry", t.retry), cancelWorkOption(language)],
      recommended: "retry",
    };
  }
  if (payload.kind === "final_manager_failed") {
    const t = TEXT[language].finalFailed;
    return {
      reason: t.reason,
      question: t.question,
      current_state: t.currentState,
      tried: text(payload.failure) ?? text(payload.message) ?? t.noCause,
      options: [option("retry", t.retry), cancelWorkOption(language)],
      recommended: "retry",
    };
  }
  if (payload.kind === "work_merge_failed") {
    const t = TEXT[language].workMergeFailed;
    const mergeKind = text(payload.merge_kind);
    const conflictFiles = Array.isArray(payload.conflicting_files)
      ? payload.conflicting_files.filter((path): path is string => typeof path === "string" && path.trim().length > 0).join("\n")
      : "";
    const commandId = text(payload.command_id) ?? "";
    const command = Array.isArray(payload.command)
      ? payload.command.filter((part): part is string => typeof part === "string").join(" ")
      : "";
    const outputTail = text(payload.output_tail) ?? t.noOutput;
    const expected = text(payload.expected_base_commit) ?? "";
    const actual = text(payload.actual_base_commit) ?? "";
    const detail = mergeKind === "conflict" && conflictFiles.length > 0
      ? t.conflictFiles(conflictFiles)
      : mergeKind === "verification_failed"
        ? t.verification(commandId, command || t.noCommand, outputTail)
        : mergeKind === "base_moved"
          ? t.baseMoved(expected, actual)
          : text(payload.merge_message) ?? text(payload.message) ?? t.noCause;
    const conflict = mergeKind === "conflict";
    return {
      reason: [t.reason, text(payload.message), detail].filter(Boolean).join("\n"),
      question: conflict ? t.conflictQuestion : t.question,
      current_state: t.currentState,
      tried: text(payload.remediation) ?? t.noCause,
      options: conflict
        ? [option(RESOLVE_CONFLICT_OPTION_KEY, t.resolveConflict), option("retry", t.retry), cancelWorkOption(language)]
        : [option("retry", t.retry), cancelWorkOption(language)],
      recommended: conflict ? RESOLVE_CONFLICT_OPTION_KEY : "retry",
    };
  }
  const t = TEXT[language].workHalted;
  return {
    reason: text(payload.reason) ?? text(payload.message) ?? t.reason,
    question: t.question,
    current_state: payload.kind === "workflow_tick_failed" ? t.tickFailedState : t.haltedState,
    tried: text(payload.failure) ?? text(payload.remediation) ?? t.tried,
    options: [option("retry", t.retry), cancelWorkOption(language)],
    recommended: null,
  };
}

/**
 * The Decision Core opens when a Task fails in a way it must not retry on
 * its own (retry_allowed=false). A "retry" answer runs the Task again.
 */
export function coreTaskDecisionBrief(taskTitle: string, payload: JsonObject, language: OwnerLanguage): DecisionBrief {
  const t = TEXT[language].taskFailed;
  const errorKey = text(payload.error_key);
  return {
    reason: [t.reason(taskTitle), text(payload.reason)].filter(Boolean).join("\n"),
    question: t.question(taskTitle),
    current_state: t.currentState,
    tried: errorKey ? t.errorKey(errorKey) : t.noErrorKey,
    options: [option("retry", t.retry), cancelWorkOption(language)],
    recommended: null,
  };
}

/** The Decision opened when a Manager replan fails or leaves a failure unresolved. */
export function managerReplanFailureBrief(
  scope: "task" | "work",
  reason: string,
  detail: string,
  language: OwnerLanguage,
  ownerAnswer?: string,
  finalMissing?: unknown,
): DecisionBrief {
  const t = TEXT[language].replanFailed;
  const onTasks = scope === "task";
  const answer = ownerAnswer === undefined ? null : text(ownerAnswer);
  // When the replan followed an incomplete final check, what it judged
  // missing stays visible to the Owner.
  const missing = finalMissing === undefined ? null : formatMissingList(finalMissing, language);
  return {
    reason: t.reason(reason),
    question: onTasks ? t.taskQuestion : t.workQuestion,
    current_state: onTasks ? t.taskState : t.workState,
    // The Owner's answer that led to this replan, so the next Decision shows
    // what was asked and why it could not be done.
    tried: [
      text(detail) ?? t.noDetail,
      missing ? TEXT[language].finalIncomplete.missing(missing) : null,
      answer === null ? null : t.ownerAnswer(answer),
    ].filter((line): line is string => line !== null).join("\n"),
    options: [option("retry", onTasks ? t.taskRetry : t.workRetry), cancelWorkOption(language)],
    recommended: null,
  };
}
