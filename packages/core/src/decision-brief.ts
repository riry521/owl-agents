import { OUTPUT_FORMAT_INVALID_ERROR_KEY, isReportFormatInvalidErrorKey, REPORT_RESUBMIT_OPTION_KEY, REVIEW_RERUN_OPTION_KEY, type DesignBlockCauseKind, type DesignBlockedReport } from "@owl/shared";
import { DEFAULT_TEST_RUN_SETTINGS } from "../../shared/dist/test-run-settings.js";
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
  /** Structured cause of a design stop, stored beside the text (decisions.design_block_json). */
  readonly design_block?: { readonly cause_kind: DesignBlockCauseKind; readonly repeated_findings: readonly { readonly summary: string; readonly times: number }[] } | null;
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
    workIntegrationFailed: {
      reason: "全タスクを統合したWorkブランチがProjectの検証に通らず、Managerによる修正でも直らなかったため、Workが止まりました。",
      question: "Managerにもう一度、失敗した検査を直すタスクを追加させますか？ それともこのWorkを中止しますか？",
      currentState: "個々のタスクは検証に合格していますが、統合した結果がProjectの検証に失敗しています。Workは完了になっていません。",
      noCommand: "失敗したコマンドは記録されていません。",
      failed: (command: string, output: string) => `失敗した検証コマンド: ${command}\n出力末尾:\n${output}`,
      noOutput: "出力はありませんでした。",
      retry: {
        label: "Managerに直させる",
        description: "Managerが失敗した検査を通すタスクを追加し、Workを再開します。下の欄に直し方を書くと、その指示もManagerに渡ります。",
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
      autoResolveTried: (rounds: number) => `Managerによる自動解消を${rounds}回試しましたが、コンフリクトは解消されませんでした。`,
      verification: (id: string, command: string, output: string) => `失敗した検証コマンド${id ? ` (${id})` : ""}: ${command}\n出力末尾:\n${output}`,
      dirtyIntegration: (path: string, files: string) => `統合用worktreeに未コミットの変更があります。\nworktree: ${path || "不明"}\n変更のあるファイル:\n${files}`,
      overlapBase: (path: string, files: string) => `ベースブランチのチェックアウトに、今回の統合で変わるファイルの未コミット変更があります。\nフォルダ: ${path || "不明"}\n重なったファイル:\n${files}`,
      overlapFix: "重なったファイルの変更をコミットするか退避（または破棄）してから再試行してください。重ならない未コミット変更は問題ありません。",
      dirtyFix: (path: string) => `次のいずれかを行ってから再試行してください。(1) Workの成果物であれば、Workブランチ（統合用worktree ${path || ""}）にコミットする。(2) ツールの出力であれば、そのファイルを復元または削除する、もしくはリポジトリの.gitignoreに追加する。`,
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
      question: "停止中の処理を続きから動かしますか？",
      tickFailedState: "Owlの内部エラーで、Workの自動実行が止まっています。タスクの作業内容はそのまま残っています。",
      haltedState: "Workは判断待ちで止まっています。タスクの作業内容はそのまま残っています。",
      tried: "自動での復旧はできませんでした。",
      retry: {
        label: "再開する",
        description: "Workの自動実行を再開します。原因が残っていると、また止まります。タスクがすべて終わっている場合は、Managerが下の欄の指示も踏まえて計画を立て直します。",
      },
    },
    taskStopped: {
      workerReport: (result: string, workDone: string) => `Worker の報告（${result}）: ${workDone}`,
      verificationNote: (note: string) => `報告の検証: ${note}`,
      failedCommand: (command: string, detail: string) => `失敗した検証コマンド: ${command}${detail ? `\n${detail}` : ""}`,
      failedTest: (test: string, message: string) => `失敗したテスト: ${test}${message ? `\n${message}` : ""}`,
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
    reportFormat: {
      reason: (title: string) => `タスク「${title}」の作業は終わっていますが、最終報告の書式がスキーマに合わず受け取れませんでした（報告の書式違反）。`,
      question: (title: string) => `タスク「${title}」の報告だけを出し直させますか？`,
      currentState: "作業の変更はworktreeに残っています。最終報告だけが受け取れていません。",
      resubmit: {
        label: "報告だけ出し直す",
        description: "作業はやり直さず、同じセッションを再開して報告だけをスキーマどおりに出し直させます。",
      },
    },
    reviewFormat: {
      reason: (title: string) => `タスク「${title}」の Reviewer の判定が書式に合わず、出し直しても受け取れませんでした（判定の書式違反）。`,
      question: (title: string) => `タスク「${title}」の Reviewer をもう一度実行しますか？`,
      currentState: "Worker の作業は変更されていません。Reviewer の判定だけが受け取れていません。",
      rerun: {
        label: "Reviewer だけやり直す",
        description: "Worker の作業はやり直さず、Reviewer だけをもう一度実行して判定を出させます。",
      },
    },
    replanFailed: {
      reason: "Managerが、タスクの失敗を解決する計画を立てられませんでした。",
      taskQuestion: "失敗したタスクをもう一度実行しますか？",
      workQuestion: "Managerにもう一度計画を立て直させますか？",
      taskState: "失敗したタスクは判断待ちで止まっています。",
      workState: "Workは判断待ちで止まっています。",
      noDetail: "詳細は記録されていません。",
      autoConflictReason: (files: string) => `Managerが計画を立て直せなかったため、Workの統合コンフリクトを自動で解消できませんでした。コンフリクトしたファイル: ${files}`,
      noFiles: "記録なし",
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
    workIntegrationFailed: {
      reason: "The Work branch with every Task merged fails the Project verification and the Manager's repairs did not fix it, so the Work stopped.",
      question: "Have the Manager add Tasks that fix the failing check once more, or cancel this Work?",
      currentState: "Each Task passed its own verification, but the merged result fails the Project verification. The Work is not completed.",
      noCommand: "The failing command was not recorded.",
      failed: (command: string, output: string) => `Failing verification command: ${command}\nEnd of output:\n${output}`,
      noOutput: "There was no output.",
      retry: {
        label: "Let the Manager fix it",
        description: "The Manager adds Tasks that make the failing check pass and resumes the Work. Anything you write below is passed to the Manager as well.",
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
      autoResolveTried: (rounds: number) => `Automatic conflict resolution by the Manager was already tried ${rounds === 2 ? "twice" : `${rounds} times`}, and the conflict remains.`,
      verification: (id: string, command: string, output: string) => `Failed verification command${id ? ` (${id})` : ""}: ${command}\nOutput tail:\n${output}`,
      dirtyIntegration: (path: string, files: string) => `The integration worktree has uncommitted changes.\nWorktree: ${path || "unknown"}\nFiles with changes:\n${files}`,
      overlapBase: (path: string, files: string) => `The base branch checkout has uncommitted changes to files this merge also changes.\nFolder: ${path || "unknown"}\nOverlapping files:\n${files}`,
      overlapFix: "Commit, stash or discard changes to the overlapping files, then retry. Uncommitted changes to other files are fine.",
      dirtyFix: (path: string) => `Do one of the following, then retry. (1) If the files belong to the Work, commit them on the Work branch (integration worktree ${path || ""}). (2) If they are tool output, restore or delete them, or add them to the repository's .gitignore.`,
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
    taskStopped: {
      workerReport: (result: string, workDone: string) => `Worker report (${result}): ${workDone}`,
      verificationNote: (note: string) => `Report verification: ${note}`,
      failedCommand: (command: string, detail: string) => `Failed verification command: ${command}${detail ? `\n${detail}` : ""}`,
      failedTest: (test: string, message: string) => `Failed test: ${test}${message ? `\n${message}` : ""}`,
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
    reportFormat: {
      reason: (title: string) => `The Task "${title}" finished its work, but its final report did not match the schema and could not be accepted (report format violation).`,
      question: (title: string) => `Have the Task "${title}" resubmit only its report?`,
      currentState: "The changes remain in the worktree. Only the final report was not accepted.",
      resubmit: {
        label: "Resubmit the report only",
        description: "Does not redo the work: resumes the same session and has it return the report again in the required schema.",
      },
    },
    reviewFormat: {
      reason: (title: string) => `The Reviewer's verdict for the Task "${title}" did not match the required format, even after resubmission (verdict format violation).`,
      question: (title: string) => `Run the Reviewer for the Task "${title}" again?`,
      currentState: "The Worker's work is unchanged. Only the Reviewer's verdict was not accepted.",
      rerun: {
        label: "Run only the Reviewer again",
        description: "Does not redo the Worker's work: runs only the Reviewer again to produce a verdict.",
      },
    },
    replanFailed: {
      reason: "The Manager could not make a plan that resolves the failed Tasks.",
      taskQuestion: "Run the failed Tasks again?",
      workQuestion: "Have the Manager replan again?",
      taskState: "The failed Tasks are stopped, waiting for your decision.",
      workState: "The Work is stopped, waiting for your decision.",
      noDetail: "No details were recorded.",
      autoConflictReason: (files: string) => `Automatic resolution of the Work merge conflict failed because the Manager could not replan. Conflicting files: ${files}`,
      noFiles: "not recorded",
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

/** Keeps the end of a long text, where a command prints its failure. */
function tailChars(value: string): string {
  const limit = DEFAULT_TEST_RUN_SETTINGS.brief_message_chars;
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

function headChars(value: string): string {
  const limit = DEFAULT_TEST_RUN_SETTINGS.brief_message_chars;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why a Task stopped, in the Worker's and the verifier's own words: the
 * summary of a partial/failed report and the failed verification commands
 * with the end of their output. Empty when the payload carries neither.
 */
function taskStopLines(payload: JsonObject, language: OwnerLanguage): string[] {
  const t = TEXT[language].taskStopped;
  const lines: string[] = [];
  const report = isObject(payload.report) ? payload.report : null;
  const reported = report === null ? null : text(report.result);
  const workDone = report === null ? null : text(report.work_done);
  if (reported !== null && workDone !== null) lines.push(t.workerReport(reported, headChars(workDone)));
  const reportVerification = report !== null && isObject(report.verification) ? report.verification : null;
  const note = reportVerification === null ? null : text(reportVerification.method);
  if (note !== null) lines.push(t.verificationNote(headChars(note)));
  const verification = isObject(payload.verification) ? payload.verification : null;
  const commands = verification !== null && Array.isArray(verification.commands) ? verification.commands : [];
  let explained = false;
  for (const command of commands) {
    if (!isObject(command) || command.passed !== false) continue;
    const argv = Array.isArray(command.argv) ? command.argv.filter((part): part is string => typeof part === "string").join(" ") : "";
    const output = `${text(command.stdout) ?? ""}${text(command.stderr) ?? ""}`.trim();
    // A Core test run's detail is only its run id; its failures are in test_run.
    const detail = command.command_id === "policy:test" ? "" : (text(command.detail) ?? "");
    const shown = output || detail;
    if (shown === "" && command.command_id === "policy:test") continue;
    lines.push(t.failedCommand(argv || text(command.command_id) || "?", tailChars(shown)));
    explained = true;
  }
  const testRun = verification !== null && isObject(verification.test_run) ? verification.test_run : null;
  const failures = testRun !== null && isObject(testRun.failures) && Array.isArray(testRun.failures.failures) ? testRun.failures.failures : [];
  for (const failure of failures) {
    if (!isObject(failure)) continue;
    lines.push(t.failedTest(`${text(failure.file) ?? "?"}${typeof failure.line === "number" ? `:${failure.line}` : ""} ${text(failure.name) ?? ""}`.trim(), tailChars(text(failure.message) ?? "")));
    explained = true;
  }
  const error = verification === null ? null : text(verification.error);
  if (!explained && error !== null) lines.push(t.failedCommand(text(verification?.source) ?? "?", tailChars(error)));
  return lines;
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
  if (payload.kind === "work_integration_verification_failed") {
    const t = TEXT[language].workIntegrationFailed;
    const command = Array.isArray(payload.command) ? payload.command.filter((part): part is string => typeof part === "string").join(" ") : "";
    return {
      reason: t.reason,
      question: t.question,
      current_state: t.currentState,
      tried: command ? t.failed(command, text(payload.output_tail) ?? t.noOutput) : (text(payload.message) ?? t.noCommand),
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
    const dirtyFiles = Array.isArray(payload.dirty_files)
      ? payload.dirty_files.filter((path): path is string => typeof path === "string" && path.trim().length > 0).join("\n")
      : "";
    const integrationWorktree = text(payload.integration_worktree) ?? "";
    const dirty = dirtyFiles.length > 0;
    const overlapFiles = Array.isArray(payload.overlap_files)
      ? payload.overlap_files.filter((path): path is string => typeof path === "string" && path.trim().length > 0).join("\n")
      : "";
    const overlap = overlapFiles.length > 0;
    const detail = overlap
      ? t.overlapBase(text(payload.base_worktree) ?? "", overlapFiles)
      : dirty
      ? t.dirtyIntegration(integrationWorktree, dirtyFiles)
      : mergeKind === "conflict" && conflictFiles.length > 0
      ? t.conflictFiles(conflictFiles)
      : mergeKind === "verification_failed"
        ? t.verification(commandId, command || t.noCommand, outputTail)
        : mergeKind === "base_moved"
          ? t.baseMoved(expected, actual)
          : text(payload.merge_message) ?? text(payload.message) ?? t.noCause;
    const conflict = mergeKind === "conflict";
    const autoRounds = conflict && typeof payload.auto_resolve_attempts === "number" && payload.auto_resolve_attempts > 0
      ? payload.auto_resolve_attempts
      : 0;
    return {
      reason: [t.reason, text(payload.message), detail, autoRounds > 0 ? t.autoResolveTried(autoRounds) : ""].filter(Boolean).join("\n"),
      question: conflict ? t.conflictQuestion : t.question,
      current_state: t.currentState,
      tried: overlap ? t.overlapFix : dirty ? t.dirtyFix(integrationWorktree) : text(payload.remediation) ?? t.noCause,
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
  const canResubmit = isReportFormatInvalidErrorKey(errorKey) && text(payload.provider_session_id) !== null;
  if (canResubmit) {
    const r = TEXT[language].reportFormat;
    return {
      reason: [r.reason(taskTitle), text(payload.reason)].filter(Boolean).join("\n"),
      question: r.question(taskTitle),
      current_state: r.currentState,
      tried: t.errorKey(errorKey),
      options: [option(REPORT_RESUBMIT_OPTION_KEY, r.resubmit), option("retry", t.retry), cancelWorkOption(language)],
      recommended: REPORT_RESUBMIT_OPTION_KEY,
    };
  }
  if (errorKey === OUTPUT_FORMAT_INVALID_ERROR_KEY && payload.role === "reviewer") {
    const r = TEXT[language].reviewFormat;
    return {
      reason: [r.reason(taskTitle), text(payload.reason)].filter(Boolean).join("\n"),
      question: r.question(taskTitle),
      current_state: r.currentState,
      tried: t.errorKey(errorKey),
      options: [option(REVIEW_RERUN_OPTION_KEY, r.rerun), cancelWorkOption(language)],
      recommended: REVIEW_RERUN_OPTION_KEY,
    };
  }
  return {
    reason: [t.reason(taskTitle), text(payload.reason), ...taskStopLines(payload, language)].filter(Boolean).join("\n"),
    question: t.question(taskTitle),
    current_state: t.currentState,
    tried: errorKey ? t.errorKey(errorKey) : t.noErrorKey,
    options: [option("retry", t.retry), cancelWorkOption(language)],
    recommended: null,
  };
}

/** Why a Task reached the Owner: its Reviewer attempts across plans are used up. */
export function reviewBudgetReason(budget: { readonly attempts: number; readonly limit: number }, language: OwnerLanguage): string {
  return language === "ja"
    ? `Reviewer の通算 ${budget.attempts}/${budget.limit} 回を使い切りました。計画を変えても合格に届いていません。`
    : `Used ${budget.attempts}/${budget.limit} Reviewer attempts across plans without a pass.`;
}

export type RemakeLimitReason =
  | "lineage_review_attempts"
  | "lineage_worker_runs"
  | "non_functional_remakes"
  | "base_sync_lineage_review_attempts"
  | "base_sync_lineage_worker_runs";

export interface RemakeLimitBriefInput {
  readonly taskTitle: string;
  readonly reason: RemakeLimitReason;
  readonly usage: {
    readonly generations: number;
    readonly main_generations: number;
    readonly review_attempts: number;
    readonly worker_runs: number;
    readonly base_sync_generations: number;
    readonly base_sync_review_attempts: number;
    readonly base_sync_worker_runs: number;
    readonly non_functional_streak: number;
    readonly last_streak_paths: readonly string[];
    readonly history: readonly {
      readonly title: string;
      readonly generation: number;
      readonly review_attempts: number;
      readonly worker_runs: number;
      readonly base_sync_generations: number;
      readonly base_sync_review_attempts: number;
      readonly base_sync_worker_runs: number;
      readonly kind: "original" | "neutral" | "functional" | "non_functional" | "unmeasured";
    }[];
  };
  readonly settings: {
    readonly lineage_review_attempts: number;
    readonly lineage_worker_runs: number;
    readonly non_functional_remakes: number;
    readonly base_sync_lineage_review_attempts: number;
    readonly base_sync_lineage_worker_runs: number;
  };
}

const REMAKE_TEXT = {
  ja: {
    stopped: (title: string) => `「${title}」の作り直しが上限に達したため、Core が新しい Task を作らずに止めました。`,
    lineage_review_attempts: (x: number, limit: number, g: number) => `Reviewer の判定が系統通算 ${x}/${limit} 回に達しました（${g} 世代）。`,
    lineage_worker_runs: (x: number, limit: number, g: number) => `Worker の起動が系統通算 ${x}/${limit} 回に達しました（${g} 世代）。`,
    non_functional_remakes: (x: number, limit: number, paths: string) => `機能コードを変えない作り直しが ${x}/${limit} 回続きました。変えたのは検証パスだけです: ${paths}`,
    base_sync_lineage_review_attempts: (x: number, limit: number, g: number) => `ベースブランチの取り込みだけを行う作り直しで、Reviewer の判定が系統通算 ${x}/${limit} 回に達しました（取り込み専用 ${g} 世代）。`,
    base_sync_lineage_worker_runs: (x: number, limit: number, g: number) => `ベースブランチの取り込みだけを行う作り直しで、Worker の起動が系統通算 ${x}/${limit} 回に達しました（取り込み専用 ${g} 世代）。`,
    baseSyncTotals: (u: RemakeLimitBriefInput["usage"], s: RemakeLimitBriefInput["settings"]) =>
      `取り込み専用の通算（別枠）: Reviewer 判定 ${u.base_sync_review_attempts}/${s.base_sync_lineage_review_attempts}、Worker 起動 ${u.base_sync_worker_runs}/${s.base_sync_lineage_worker_runs}（${u.base_sync_generations} 世代）`,
    historyBaseSync: (n: number, reviews: number, runs: number) => ` / うち取り込み専用 ${n} 世代: Reviewer 判定 ${reviews} 回 / Worker 起動 ${runs} 回`,
    mainPrefix: (g: number) => `本題の通算（${g} 世代）: `,
    totalsPrefix: "通算: ",
    totals: (u: RemakeLimitBriefInput["usage"], s: RemakeLimitBriefInput["settings"]) =>
      `Reviewer 判定 ${u.review_attempts}/${s.lineage_review_attempts}、Worker 起動 ${u.worker_runs}/${s.lineage_worker_runs}、機能コードを変えない作り直し 連続 ${u.non_functional_streak}/${s.non_functional_remakes}`,
    question: (title: string) => `「${title}」をどうしますか。`,
    currentState: "作り直しを止めて Owner の判断を待っています。上限は設定 remake_limits で変えられます。",
    noHistory: "系統の履歴はありません。",
    historyLine: (g: number, title: string, reviews: number, runs: number, kind: string) => `第${g}世代「${title}」: Reviewer 判定 ${reviews} 回 / Worker 起動 ${runs} 回 / ${kind}`,
    kinds: { functional: "機能コードを変更", non_functional: "検証パスだけを変更", other: "判定外" },
    retry: { label: "もう一度実行する", description: "この Task をもう一度実行する（自由記述は Worker への指示になります）" },
  },
  en: {
    stopped: (title: string) => `Core stopped the remakes of "${title}" without creating a new Task because a limit was reached.`,
    lineage_review_attempts: (x: number, limit: number, g: number) => `Reviewer verdicts across the lineage reached ${x}/${limit} (${g} generations).`,
    lineage_worker_runs: (x: number, limit: number, g: number) => `Worker launches across the lineage reached ${x}/${limit} (${g} generations).`,
    non_functional_remakes: (x: number, limit: number, paths: string) => `${x}/${limit} consecutive remakes changed no functional code. Only verification paths changed: ${paths}`,
    base_sync_lineage_review_attempts: (x: number, limit: number, g: number) => `Reviewer verdicts on remakes that only merge the base branch reached ${x}/${limit} across the lineage (${g} base-sync-only generations).`,
    base_sync_lineage_worker_runs: (x: number, limit: number, g: number) => `Worker launches on remakes that only merge the base branch reached ${x}/${limit} across the lineage (${g} base-sync-only generations).`,
    baseSyncTotals: (u: RemakeLimitBriefInput["usage"], s: RemakeLimitBriefInput["settings"]) =>
      `Base-sync-only totals (separate limit): Reviewer verdicts ${u.base_sync_review_attempts}/${s.base_sync_lineage_review_attempts}, Worker launches ${u.base_sync_worker_runs}/${s.base_sync_lineage_worker_runs} (${u.base_sync_generations} generations)`,
    historyBaseSync: (n: number, reviews: number, runs: number) => ` / of which ${n} base-sync-only generations: ${reviews} Reviewer verdicts / ${runs} Worker launches`,
    mainPrefix: (g: number) => `Main work totals (${g} generations): `,
    totalsPrefix: "Totals: ",
    totals: (u: RemakeLimitBriefInput["usage"], s: RemakeLimitBriefInput["settings"]) =>
      `Reviewer verdicts ${u.review_attempts}/${s.lineage_review_attempts}, Worker launches ${u.worker_runs}/${s.lineage_worker_runs}, consecutive non-functional remakes ${u.non_functional_streak}/${s.non_functional_remakes}`,
    question: (title: string) => `What should happen to "${title}"?`,
    currentState: "Remaking is stopped and waiting for the Owner. The limits can be changed in the remake_limits setting.",
    noHistory: "No lineage history.",
    historyLine: (g: number, title: string, reviews: number, runs: number, kind: string) => `Generation ${g} "${title}": ${reviews} Reviewer verdicts / ${runs} Worker launches / ${kind}`,
    kinds: { functional: "functional code changed", non_functional: "verification paths only", other: "not classified" },
    retry: { label: "Run it again", description: "Run this Task again (free text becomes instructions for the Worker)." },
  },
} as const;

/** The Decision Core opens instead of another remake when a lineage-wide limit is reached. */
export function remakeLimitBrief(input: RemakeLimitBriefInput, language: OwnerLanguage): DecisionBrief {
  const t = REMAKE_TEXT[language];
  const { usage, settings } = input;
  const baseSyncShown = usage.base_sync_generations > 0 || input.reason.startsWith("base_sync_");
  const detail =
    input.reason === "lineage_review_attempts"
      ? t.lineage_review_attempts(usage.review_attempts, settings.lineage_review_attempts, usage.main_generations)
      : input.reason === "lineage_worker_runs"
        ? t.lineage_worker_runs(usage.worker_runs, settings.lineage_worker_runs, usage.main_generations)
        : input.reason === "base_sync_lineage_review_attempts"
          ? t.base_sync_lineage_review_attempts(usage.base_sync_review_attempts, settings.base_sync_lineage_review_attempts, usage.base_sync_generations)
          : input.reason === "base_sync_lineage_worker_runs"
            ? t.base_sync_lineage_worker_runs(usage.base_sync_worker_runs, settings.base_sync_lineage_worker_runs, usage.base_sync_generations)
            : t.non_functional_remakes(usage.non_functional_streak, settings.non_functional_remakes, usage.last_streak_paths.join(", "));
  const kindText = (kind: RemakeLimitBriefInput["usage"]["history"][number]["kind"]): string =>
    kind === "functional" ? t.kinds.functional : kind === "non_functional" ? t.kinds.non_functional : t.kinds.other;
  const tried =
    usage.history.length === 0
      ? t.noHistory
      : usage.history.map((line) => t.historyLine(line.generation, line.title, line.review_attempts, line.worker_runs, kindText(line.kind)) + (line.base_sync_generations > 0 ? t.historyBaseSync(line.base_sync_generations, line.base_sync_review_attempts, line.base_sync_worker_runs) : "")).join("\n");
  return {
    reason: [t.stopped(input.taskTitle), detail, (baseSyncShown ? t.mainPrefix(usage.main_generations) : t.totalsPrefix) + t.totals(usage, settings), ...(baseSyncShown ? [t.baseSyncTotals(usage, settings)] : [])].join("\n"),
    question: t.question(input.taskTitle),
    current_state: t.currentState,
    tried,
    options: [option("retry", t.retry), cancelWorkOption(language)],
    recommended: null,
  };
}

export interface DesignBlockedBriefInput {
  readonly taskTitle: string;
  readonly trigger: "lead_review_rejections" | "designer";
  readonly rejections: number | null;
  readonly limit: number | null;
  readonly report: DesignBlockedReport | null;
  /** The `problem` of each finding in the latest rejection; used when the Designer gave no report. */
  readonly latestFindings: readonly string[];
}

const DESIGN_BLOCK_TEXT = {
  ja: {
    byRejections: (title: string, x: number | null, limit: number | null) => `「${title}」は上位の Designer に格上げした後も Reviewer に系統で ${x ?? "?"}/${limit ?? "?"} 回差し戻されたため、Core が設計の作り直しを止めました。`,
    byDesigner: (title: string) => `「${title}」の Designer が「設計できない」と報告しました。`,
    cause: (label: string, cause: string) => `原因の種類: ${label}\n${cause}`,
    noReport: "Designer の報告を受け取れなかったため、原因の種類は判定されていません。",
    question: (title: string) => `「${title}」の設計をどう進めますか。`,
    currentState: "設計の作り直しを止め、Work は判断待ちです。答えると Manager が回答をもとに計画を組み直して再開します。上限は設定 remake_limits.lead_review_rejections で変えられます。",
    finding: (summary: string, times: number) => `・${summary}（${times} 回）`,
    noRepeated: "繰り返されている指摘はありません。",
    noFindings: "最新の差し戻しの指摘はありません。",
    replan: { label: "計画を組み直す", description: "Manager が回答をもとに計画を組み直して再開します。" },
    causes: { wrong_premise: "前提が違う", policy_conflict: "方針に矛盾", ambiguous_criteria: "条件があいまい", simple_defect: "単純な不備" },
  },
  en: {
    byRejections: (title: string, x: number | null, limit: number | null) => `Core stopped remaking the design of "${title}": after it was escalated to the Lead Designer, the Reviewer rejected it ${x ?? "?"}/${limit ?? "?"} times across the lineage.`,
    byDesigner: (title: string) => `The Designer of "${title}" reported that the design cannot be produced.`,
    cause: (label: string, cause: string) => `Cause: ${label}\n${cause}`,
    noReport: "The Designer's report was not received, so the cause was not classified.",
    question: (title: string) => `How should the design of "${title}" proceed?`,
    currentState: "Remaking the design is stopped and the Work waits for judgement. Once answered, the Manager replans from the answer and resumes. The limit can be changed in remake_limits.lead_review_rejections.",
    finding: (summary: string, times: number) => `- ${summary} (${times} times)`,
    noRepeated: "No Reviewer point was repeated.",
    noFindings: "The latest rejection listed no findings.",
    replan: { label: "Replan", description: "The Manager replans from the answer and resumes." },
    causes: { wrong_premise: "Wrong premise", policy_conflict: "Conflicts with policy", ambiguous_criteria: "Ambiguous criteria", simple_defect: "Simple defect" },
  },
} as const;

/** The Decision Core opens when a design Task stops without a remake. Core only copies the Designer's structured report and adds fixed wording. */
export function designBlockedBrief(input: DesignBlockedBriefInput, language: OwnerLanguage): DecisionBrief {
  const t = DESIGN_BLOCK_TEXT[language];
  const { report } = input;
  const head = input.trigger === "lead_review_rejections" ? t.byRejections(input.taskTitle, input.rejections, input.limit) : t.byDesigner(input.taskTitle);
  const tried = report
    ? report.repeated_findings.length === 0
      ? t.noRepeated
      : report.repeated_findings.map((finding) => t.finding(finding.summary, finding.times)).join("\n")
    : input.latestFindings.length === 0
      ? t.noFindings
      : input.latestFindings.map((problem) => `${language === "ja" ? "・" : "- "}${problem}`).join("\n");
  return {
    reason: [head, report ? t.cause(t.causes[report.cause_kind], report.cause) : t.noReport].join("\n"),
    question: report ? report.question : t.question(input.taskTitle),
    current_state: t.currentState,
    tried,
    options: [
      ...(report ? report.options.map((choice, index) => option(`option_${index + 1}`, choice)) : [option("replan", t.replan)]),
      cancelWorkOption(language),
    ],
    recommended: report && report.recommended_option !== null ? `option_${report.recommended_option + 1}` : null,
    design_block: report ? { cause_kind: report.cause_kind, repeated_findings: report.repeated_findings } : null,
  };
}

export interface NoProgressBriefInput {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly count: number;
  readonly limit: number;
  /** Where Core stopped: before a Manager replan or before a Worker launch. */
  readonly gate: "manager" | "worker";
  /** Newest first: the last results that did not move the Task forward (question or reason). */
  readonly recent: readonly string[];
}

const NO_PROGRESS_TEXT = {
  ja: {
    reason: (i: NoProgressBriefInput) =>
      `Task「${i.taskTitle}」（${i.taskId}）は、進まない結果が連続 ${i.count} 回（上限 ${i.limit}）になったため、${i.gate === "manager" ? "Manager の再計画前" : "Worker の起動前"}に止めました。`,
    question: (title: string) => `「${title}」をどう進めますか。回答の文は次の実行で Worker に渡されます。`,
    currentState: "この Work は Owner の判断を待っています。上限は設定 progress_guard.no_progress_limit で変えられます。",
    none: "記録された結果はありません。",
    retry: { label: "もう一度実行する", description: "この Task をもう一度実行する。回数は 0 に戻り、自由記述は Worker への指示になります。" },
  },
  en: {
    reason: (i: NoProgressBriefInput) =>
      `Task "${i.taskTitle}" (${i.taskId}) produced ${i.count} consecutive results without progress (limit ${i.limit}), so Core stopped it before ${i.gate === "manager" ? "the Manager replan" : "the Worker launch"}.`,
    question: (title: string) => `How should "${title}" proceed? Your answer is passed to the Worker on the next run.`,
    currentState: "This Work is waiting for the Owner. The limit can be changed in the progress_guard.no_progress_limit setting.",
    none: "No recorded results.",
    retry: { label: "Run it again", description: "Run this Task again. The count returns to 0 and free text becomes instructions for the Worker." },
  },
} as const;

/** The Decision opened when a Task reaches the consecutive no-progress limit. */
export function noProgressLimitBrief(input: NoProgressBriefInput, language: OwnerLanguage): DecisionBrief {
  const t = NO_PROGRESS_TEXT[language];
  const clip = (value: string): string => (value.length > 300 ? `${value.slice(0, 300)}…` : value);
  return {
    reason: t.reason(input),
    question: t.question(input.taskTitle),
    current_state: t.currentState,
    tried: input.recent.length === 0 ? t.none : input.recent.map((line, index) => `${index + 1}. ${clip(line)}`).join("\n"),
    options: [option("retry", t.retry), cancelWorkOption(language)],
    recommended: null,
  };
}

export interface PrerequisiteExpiredBriefInput {
  readonly taskTitle: string;
  readonly kind: "deadline" | "unreachable" | "sync_conflict" | "wait_count" | "owner";
  readonly detail: string;
  /** The wait's reason and its conditions' descriptions. */
  readonly reason: string;
  readonly conditions: readonly string[];
  /** Tells owner waits of Tasks with the same title apart. */
  readonly taskId?: string;
}

const PREREQUISITE_EXPIRED_TEXT = {
  ja: {
    reason: (i: PrerequisiteExpiredBriefInput) =>
      `Task「${i.taskTitle}」の前提待ちを${{ deadline: "最大待ち時間を超えたため", unreachable: "条件が満たせなくなったため", sync_conflict: "ベースブランチの取り込みで競合したため", wait_count: "長い処理を待つ回数の上限に達したため", owner: "Owner の判断が必要なため" }[i.kind]}止めました。`,
    question: (title: string) => `「${title}」をどう進めますか。回答の文は次の実行で Worker に渡されます。`,
    currentState: "この Work は Owner の判断を待っています。",
    waitingFor: "待っていた内容",
    detail: "詳細",
    retry: { label: "もう一度実行する", description: "待ちを外して Task を実行する。回数は 0 に戻り、自由記述は Worker への指示になります。" },
  },
  en: {
    reason: (i: PrerequisiteExpiredBriefInput) =>
      `The prerequisite wait of Task "${i.taskTitle}" was stopped ${{ deadline: "because it passed its maximum wait time", unreachable: "because a condition can no longer be met", sync_conflict: "because merging the base branch conflicted", wait_count: "because the number of waits for a long process reached its limit", owner: "because it needs the Owner's decision" }[i.kind]}.`,
    question: (title: string) => `How should "${title}" proceed? Your answer is passed to the Worker on the next run.`,
    currentState: "This Work is waiting for the Owner.",
    waitingFor: "Waiting for",
    detail: "Detail",
    retry: { label: "Run it again", description: "Drop the wait and run the Task. The count returns to 0 and free text becomes instructions for the Worker." },
  },
} as const;

/** The Decision opened when a prerequisite wait expires, becomes unreachable or cannot sync the base branch. */
export function prerequisiteExpiredBrief(input: PrerequisiteExpiredBriefInput, language: OwnerLanguage): DecisionBrief {
  const t = PREREQUISITE_EXPIRED_TEXT[language];
  return {
    // An owner wait carries the wait's own reason and conditions, per Task, so it is neither merged nor lost.
    reason: input.kind === "owner"
      ? [t.reason(input), input.reason, ...input.conditions, input.taskId].filter((part) => part !== undefined && part !== "").join(" / ")
      : t.reason(input),
    question: t.question(input.taskTitle),
    current_state: t.currentState,
    tried: [`${t.waitingFor}: ${input.reason}`, ...input.conditions.map((line) => `- ${line}`), `${t.detail}: ${input.detail}`].join("\n"),
    options: [option("retry", t.retry), cancelWorkOption(language)],
    recommended: null,
  };
}

/** The Decision opened when a Manager replan fails or leaves a failure unresolved. */
export function managerReplanFailureBrief(
  scope: "task" | "work",
  detail: string,
  language: OwnerLanguage,
  ownerAnswer?: string,
  finalMissing?: unknown,
  autoConflictFiles?: readonly string[],
): DecisionBrief {
  const t = TEXT[language].replanFailed;
  const onTasks = scope === "task";
  const answer = ownerAnswer === undefined ? null : text(ownerAnswer);
  // When the replan followed an incomplete final check, what it judged
  // missing stays visible to the Owner.
  const missing = finalMissing === undefined ? null : formatMissingList(finalMissing, language);
  return {
    reason: autoConflictFiles === undefined
      ? t.reason
      : t.autoConflictReason(autoConflictFiles.length > 0 ? autoConflictFiles.join(", ") : t.noFiles),
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
