import { randomUUID } from "node:crypto";
import type { OwnerLanguage } from "@owl/shared/owner-language";
import { cliLanguage } from "./cli-language.js";
import { coreReasonMessage } from "./messages/core-reasons/index.js";
import { isMessageRef, lookupMessage, type MessageRef } from "./messages/define.js";

export type ApiErrorCode =
  | "core_not_ready"
  | "curation_failed"
  | "validation_error"
  | "advisor_window_not_found"
  | "window_channel_exists"
  | "channel_in_use"
  | "channel_already_bound"
  | "channel_binding_not_found"
  | "owner_user_id_missing"
  | "invite_not_supported"
  | "channel_name_taken"
  | "channel_bot_not_member"
  | "channel_not_found"
  | "integration_permission_missing"
  | "integration_not_authorized"
  | "integration_rate_limited"
  | "integration_provider_error"
  | "integration_not_running"
  | "verification_policy_storage_invalid"
  | "knowledge_target_invalid"
  | "knowledge_storage_busy"
  | "knowledge_move_failed"
  | "invalid_query"
  | "invalid_state_transition"
  | "invalid_state"
  | "work_not_archived"
  | "work_has_active_agents"
  | "work_has_open_decisions"
  | "work_reopen_required"
  | "work_cancelled"
  | "version_conflict"
  | "idempotency_conflict"
  | "provider_pause_not_found"
  | "project_not_found"
  | "work_project_already_set"
  | "prerequisite_work_not_found"
  | "prerequisite_cycle"
  | "project_has_running_works"
  | "project_deletion_impact_changed"
  | "model_preset_not_found"
  | "project_path_conflict"
  | "test_setup_unavailable"
  | "conversation_not_found"
  | "work_not_found"
  | "backlog_item_not_found"
  | "skill_not_found"
  | "skill_file_not_found"
  | "skill_revision_not_found"
  | "skill_proposal_not_found"
  | "task_not_found"
  | "design_document_not_found"
  | "design_mock_not_found"
  | "design_mock_write_failed"
  | "markdown_path_denied"
  | "markdown_not_found"
  | "markdown_not_integrated"
  | "markdown_too_large"
  | "markdown_unreadable"
  | "owner_file_denied"
  | "owner_file_not_found"
  | "decision_not_found"
  | "decision_already_resolved"
  | "agent_run_not_found"
  | "agent_scope_denied"
  | "unauthorized"
  | "advisor_action_required"
  | "window_scope_mismatch"
  | "advisor_session_not_found"
  | "advisor_workspace_unavailable"
  | "forbidden"
  | "unsupported_media_type"
  | "not_found"
  | "contract_invalid"
  | "static_assets_missing"
  | "provider_version_mismatch"
  | "dependency_unavailable"
  | "worktree_cleanup_failed"
  | "guard_unparseable"
  | "upload_too_large"
  | "upload_checksum_mismatch"
  | "upload_quota_exceeded"
  | "action_rejected"
  | "action_id_conflict"
  | "write_paths_invalid"
  | "timeout_out_of_range"
  | "parent_not_active"
  | "too_many_children"
  | "child_not_found"
  | "connector_account_not_found"
  | "inbound_account_provider_mismatch"
  | "invalid_rules"
  | "invalid_out_dir"
  | "invalid_plan_dir"
  | "vault_changed_since_dry_run"
  | "plan_changed_after_approval"
  | "plan_incomplete"
  | "preview_invalid"
  | "already_migrated"
  | "verify_required"
  | "backup_not_found"
  | "backup_exists"
  | "plan_not_found"
  | "storage_unavailable"
  | "classification_unavailable"
  | "classification_failed"
  | "apply_interrupted"
  | "backup_failed"
  | "server_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown>;
  /** Set when the error was thrown with a message-table key; errorBody picks the Owner's language from it. */
  readonly messageRef?: MessageRef;

  // A MessageRef is the normal argument. `message` stays in the signature as a plain string
  // because Core errors and files not yet moved to the tables still pass one; it is shown as is.
  // Error.message of a ref is the text in the process language (logs, CLI output); the HTTP body uses the Owner language.
  constructor(
    status: number,
    code: ApiErrorCode,
    message: string | MessageRef,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(isMessageRef(message) ? renderMessage(message, cliLanguage()) : message, options);
    if (isMessageRef(message)) this.messageRef = message;
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CliError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliError";
    this.exitCode = exitCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ContractValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContractValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function newReferenceId(): string {
  return randomUUID();
}

export function humanUnexpectedMessage(language: OwnerLanguage = "ja"): string {
  return language === "ja"
    ? "サーバーで処理できない状態が発生しました。要求を完了できませんでした。ログの参照IDを確認してください。"
    : "The server could not complete the request. Check the logs using the reference ID.";
}

/** Texts for an error code whose `details.reason` changes what the Owner should be told; keyed `code:reason`. */
const HTTP_ERROR_REASON_TEXT: Record<string, { ja: string; en: string }> = {
  "owner_file_denied:permission_denied": { ja: "権限がないため開けません。", en: "This file or folder cannot be read because of its permissions." },
};

const HTTP_ERROR_TEXT: Partial<Record<ApiErrorCode, { ja: string; en: string }>> = {
  core_not_ready: { ja: "Owl の準備がまだできていません。しばらくしてからもう一度試してください。", en: "Owl is not ready yet. Try again shortly." },
  invalid_state_transition: { ja: "この操作は、今の状態では使えません。", en: "This action is not available in the current state." },
  invalid_state: { ja: "この操作は、今の状態では使えません。", en: "This action is not available in the current state." },
  work_not_archived: { ja: "続ける前に、Work をアーカイブしてください。", en: "Archive the Work before continuing." },
  work_has_active_agents: { ja: "この Work には、動作中のエージェントが残っています。", en: "The Work still has active agents." },
  work_has_open_decisions: { ja: "続ける前に、未解決の Decision を解決してください。", en: "Resolve the open Decisions before continuing." },
  work_reopen_required: { ja: "この Work は完了しています。指示を送るには再開してください。", en: "This Work is completed. Reopen it to send an instruction." },
  work_cancelled: { ja: "この Work はキャンセルされているため、指示を送れません。", en: "This Work was cancelled and cannot take instructions." },
  version_conflict: { ja: "版が変わっています。再読み込みして、もう一度試してください。", en: "The version has changed. Refresh and try again." },
  idempotency_conflict: { ja: "この idempotency key は、別の内容で使われています。新しい key を使ってください。", en: "This idempotency key was used with different content. Use a new key." },
  project_not_found: { ja: "Project が見つかりません。", en: "The Project was not found." },
  work_project_already_set: { ja: "この Work は、すでに Project に属しています。", en: "The Work already belongs to a Project." },
  project_has_running_works: { ja: "この Project には、実行中の Work か動作中のエージェントがあります。", en: "The Project has running Works or active Agents." },
  project_deletion_impact_changed: { ja: "確認したあとで、Project の Work が変わりました。", en: "The Project's Works changed after confirmation." },
  model_preset_not_found: { ja: "モデルプリセットが見つかりません。", en: "The model preset was not found." },
  project_path_conflict: { ja: "このフォルダは、すでに Project として登録されています。", en: "This folder is already registered as a Project." },
  test_setup_unavailable: { ja: "テスト環境の調査を始められませんでした。", en: "The test setup investigation could not be started." },
  conversation_not_found: { ja: "会話が見つかりません。", en: "The conversation was not found." },
  work_not_found: { ja: "Work が見つかりません。", en: "The Work was not found." },
  backlog_item_not_found: { ja: "backlog の項目が見つかりません。", en: "The backlog item was not found." },
  skill_not_found: { ja: "スキルが見つかりません。", en: "The skill was not found." },
  skill_file_not_found: { ja: "スキルのファイルが見つかりません。", en: "The skill file was not found." },
  skill_revision_not_found: { ja: "スキルの版が見つかりません。", en: "The skill revision was not found." },
  skill_proposal_not_found: { ja: "スキルの提案が見つかりません。", en: "The skill proposal was not found." },
  task_not_found: { ja: "Task が見つかりません。", en: "The task was not found." },
  design_document_not_found: { ja: "設計書が見つかりません。", en: "The design document was not found." },
  design_mock_not_found: { ja: "画面のモックが見つかりません。", en: "The design mock was not found." },
  design_mock_write_failed: { ja: "画面のモックを書き込めませんでした。", en: "The design mock could not be written." },
  markdown_path_denied: { ja: "この Markdown ファイルは、ビューアーが読める範囲の外にあります。", en: "The Markdown file is outside what the viewer may read." },
  markdown_not_found: { ja: "Markdown ファイルが見つかりません。", en: "The Markdown file was not found." },
  markdown_not_integrated: { ja: "この Markdown ファイルは、まだ Work のブランチにも基準のブランチにもありません。", en: "The Markdown file is not in the Work branch or the base branch yet." },
  markdown_too_large: { ja: "Markdown ファイルが大きすぎて表示できません。", en: "The Markdown file is too large to show." },
  markdown_unreadable: { ja: "Markdown ファイルを読めませんでした。", en: "The Markdown file could not be read." },
  owner_file_denied: { ja: "このパスは、Owner が開けるフォルダの外にあります。", en: "This path is outside the folders the Owner may open." },
  owner_file_not_found: { ja: "ファイルまたはフォルダが見つかりません。", en: "The file or folder was not found." },
  decision_not_found: { ja: "Decision が見つかりません。", en: "The Decision was not found." },
  decision_already_resolved: { ja: "この Decision は、すでに解決されています。", en: "The Decision has already been resolved." },
  agent_run_not_found: { ja: "エージェントの実行が見つかりません。", en: "The agent run was not found." },
  agent_scope_denied: { ja: "このエージェントは、この資源にアクセスできません。", en: "The agent is not allowed to access this resource." },
  unauthorized: { ja: "認証が必要か、認証情報が正しくありません。", en: "Authentication is required or the credentials are invalid." },
  forbidden: { ja: "このリクエストは許可されていません。", en: "This request is not allowed." },
  unsupported_media_type: { ja: "リクエスト本文は application/json で送ってください。", en: "Send the request body as application/json." },
  not_found: { ja: "指定された項目が見つかりません。", en: "The requested resource was not found." },
  contract_invalid: { ja: "契約が正しくありません。渡したデータを確認してください。", en: "The contract is invalid. Check the supplied data." },
  static_assets_missing: { ja: "Web の配信ファイルがありません。ビルドしてから、もう一度試してください。", en: "The web assets are missing. Build the project and try again." },
  provider_version_mismatch: { ja: "この Provider の版には対応していません。", en: "The Provider version is not supported." },
  dependency_unavailable: { ja: "必要な依存先が使えません。サーバーの設定とログを確認してください。", en: "A required dependency is unavailable. Check the server configuration and logs." },
  worktree_cleanup_failed: { ja: "Worktree を片付けられませんでした。ログを確認してください。", en: "The Worktree could not be cleaned up. Check the logs." },
  guard_unparseable: { ja: "ガードがリクエストを安全に解釈できませんでした。", en: "The guard could not safely parse the request." },
  upload_too_large: { ja: "アップロードが、許可されたサイズを超えています。", en: "The upload exceeds the allowed size." },
  upload_checksum_mismatch: { ja: "アップロードのチェックサムが一致しません。", en: "The upload checksum does not match." },
  upload_quota_exceeded: { ja: "アップロードの上限を超えています。", en: "The upload quota has been exceeded." },
  action_rejected: { ja: "操作は受け付けられませんでした。", en: "The action was rejected." },
  action_id_conflict: { ja: "この操作 ID は、すでに使われています。", en: "The action ID is already in use." },
  prerequisite_work_not_found: { ja: "前提の Work が見つかりません。", en: "The prerequisite Work was not found." },
  prerequisite_cycle: { ja: "この前提を足すと、Work が互いを待つ形になります。", en: "These prerequisites would make Works wait on each other." },
  provider_pause_not_found: { ja: "Provider の一時停止が見つかりません。", en: "The Provider pause was not found." },
  write_paths_invalid: { ja: "書き込みを許す範囲の指定が正しくありません。", en: "The write paths are invalid." },
  timeout_out_of_range: { ja: "タイムアウトの値が許される範囲の外です。", en: "The timeout is outside the allowed range." },
  parent_not_active: { ja: "親のエージェントが動作中ではありません。", en: "The parent agent is not active." },
  too_many_children: { ja: "子のエージェントが上限を超えています。", en: "Too many child agents." },
  child_not_found: { ja: "子のエージェントが見つかりません。", en: "The child agent was not found." },
  connector_account_not_found: { ja: "コネクタのアカウントが見つかりません。", en: "The connector account was not found." },
  inbound_account_provider_mismatch: { ja: "受信したアカウントの Provider が一致しません。", en: "The inbound account does not match the Provider." },
  knowledge_target_invalid: { ja: "ナレッジの保存先に使えません。", en: "The knowledge storage target is not usable." },
  knowledge_storage_busy: { ja: "ナレッジの保存先は、ほかの操作で使われています。", en: "The knowledge storage is busy." },
  knowledge_move_failed: { ja: "ナレッジの保存先を移せませんでした。元のデータと設定は変わっていません。", en: "Moving the knowledge storage failed. The original data and setting are unchanged." },
  channel_name_taken: { ja: "このチャンネル名は、すでに使われています。", en: "The channel name is already taken." },
  channel_not_found: { ja: "チャンネルが見つかりません。", en: "The channel was not found." },
  channel_bot_not_member: { ja: "Bot がこのチャンネルに入っていません。", en: "The bot is not a member of the channel." },
  integration_permission_missing: { ja: "連携に必要な権限が足りません。", en: "The integration is missing a required permission." },
  integration_not_authorized: { ja: "連携の認証が通りません。", en: "The integration is not authorized." },
  integration_rate_limited: { ja: "連携先の呼び出し回数の上限に達しました。しばらくしてからもう一度試してください。", en: "The integration provider rate-limited the request. Try again shortly." },
  integration_provider_error: { ja: "連携先でエラーが起きました。", en: "The integration provider returned an error." },
  verification_policy_storage_invalid: { ja: "保存済みの検証ポリシーを読み取れません。保存値を確かめてから、もう一度更新してください。", en: "The saved verification policy could not be read. Check the saved value and update it again." },
  curation_failed: { ja: "整理の実行に失敗しました。", en: "The curation run failed." },
  server_error: { ja: "サーバーでリクエストを完了できませんでした。ログの参照 ID を確認してください。", en: "The server could not complete the request. Check the logs using the reference ID." },
};

export function coreText(language: OwnerLanguage, ja: string, en: string): string {
  return language === "ja" ? ja : en;
}

// Server throw sites give a key of a message table (apps/server/src/messages/<domain>.ts, made with defineMessages)
// and the values for its {placeholders}. The table row holds the ja and en text; this is the one place that picks between them.
// To move a file to the tables: add messages/<domain>.ts with its own defineMessages("<domain>", …) (one file per domain, so
// parallel changes do not touch the same file) and throw `new ApiError(status, code, M.name({ value }))`.
export function renderMessage(ref: MessageRef, language: OwnerLanguage): string {
  const entry = lookupMessage(ref.key);
  if (entry === undefined) return ref.key;
  const fill = (text: string): string =>
    text.replace(/\{(\w+)\}/gu, (whole, name: string) => (ref.params !== undefined && Object.hasOwn(ref.params, name) ? String(ref.params[name]) : whole));
  return coreText(language, fill(entry.ja), fill(entry.en));
}

const HAS_JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

// Codes whose generic text would hide which field is wrong; without a key or a reason code their own text is kept.
const FIELD_MESSAGE_CODES: ReadonlySet<string> = new Set(["validation_error", "invalid_query"]);

/** Owner-language sentence for a Core error that carries `details.reason = { code, values }`, or undefined. */
function coreReasonText(details: Record<string, unknown>, language: OwnerLanguage): string | undefined {
  const reason = details.reason;
  if (typeof reason !== "object" || reason === null) return undefined;
  const { code, values } = reason as { code?: unknown; values?: unknown };
  return typeof code === "string" ? coreReasonMessage(language, code, values) : undefined;
}

/**
 * The one place that picks the language of an error message. Throw sites and
 * Core do not know the Owner language: they give a message-table key or a
 * reason code, and the tables turn them into the Owner's language.
 */
function localizedMessage(error: Pick<ApiError, "code" | "message" | "details" | "messageRef">, language: OwnerLanguage): string {
  if (error.messageRef !== undefined) return renderMessage(error.messageRef, language);
  const reasonText = coreReasonText(error.details, language);
  if (reasonText !== undefined) return reasonText;
  if (HAS_JAPANESE.test(error.message) === (language === "ja")) return error.message;
  // Why not wrap the text in a sentence of the other language: the reply would mix two languages.
  // Texts left without a key or a reason code are moved to the tables by later Tasks.
  if (FIELD_MESSAGE_CODES.has(error.code)) return error.message;
  const reasonKey = typeof error.details.reason === "string" ? `${error.code}:${error.details.reason}` : undefined;
  const text = reasonKey !== undefined && Object.hasOwn(HTTP_ERROR_REASON_TEXT, reasonKey) ? HTTP_ERROR_REASON_TEXT[reasonKey] : undefined;
  if (text !== undefined) return coreText(language, text.ja, text.en);
  const generic = Object.hasOwn(HTTP_ERROR_TEXT, error.code) ? HTTP_ERROR_TEXT[error.code] : undefined;
  return generic === undefined ? error.message : coreText(language, generic.ja, generic.en);
}

/**
 * Words the message-table refs inside details (such as a hint's texts) in the Owner language.
 * Only refs to registered keys count, so a detail that merely has a `key` field stays as is.
 */
function localizedDetail(value: unknown, language: OwnerLanguage): unknown {
  if (Array.isArray(value)) return value.map((item) => localizedDetail(item, language));
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  // Why not walk every object: class instances (Date and the like) must reach JSON.stringify untouched.
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (isMessageRef(value) && lookupMessage(value.key) !== undefined) return renderMessage(value, language);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, localizedDetail(item, language)]));
}

export function errorBody(
  requestId: string,
  error: Pick<ApiError, "code" | "message" | "details" | "messageRef">,
  language: OwnerLanguage = "ja",
): { request_id: string; error: { code: string; message: string; details: Record<string, unknown> } } {
  return {
    request_id: requestId,
    error: { code: error.code, message: localizedMessage(error, language), details: localizedDetail(error.details, language) as Record<string, unknown> },
  };
}
