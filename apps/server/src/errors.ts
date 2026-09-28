import { randomUUID } from "node:crypto";
import type { OwnerLanguage } from "../../../packages/shared/dist/owner-language.js";

export type ApiErrorCode =
  | "core_not_ready"
  | "validation_error"
  | "invalid_query"
  | "invalid_state_transition"
  | "work_not_archived"
  | "work_has_active_agents"
  | "work_has_open_decisions"
  | "version_conflict"
  | "idempotency_conflict"
  | "project_not_found"
  | "project_has_running_works"
  | "project_deletion_impact_changed"
  | "model_preset_not_found"
  | "project_path_conflict"
  | "conversation_not_found"
  | "work_not_found"
  | "backlog_item_not_found"
  | "skill_not_found"
  | "skill_file_not_found"
  | "skill_revision_not_found"
  | "skill_proposal_not_found"
  | "task_not_found"
  | "design_document_not_found"
  | "decision_not_found"
  | "decision_already_resolved"
  | "agent_run_not_found"
  | "agent_scope_denied"
  | "unauthorized"
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
  | "server_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
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

const HTTP_ERROR_TEXT: Partial<Record<ApiErrorCode, string>> = {
  core_not_ready: "Owl is not ready yet. Try again shortly.",
  validation_error: "The request is invalid. Check the supplied fields and try again.",
  invalid_query: "The query is invalid. Check its parameters and try again.",
  invalid_state_transition: "This action is not available in the current state.",
  work_not_archived: "Archive the Work before continuing.",
  work_has_active_agents: "The Work still has active agents.",
  work_has_open_decisions: "Resolve the open Decisions before continuing.",
  version_conflict: "The version has changed. Refresh and try again.",
  idempotency_conflict: "This idempotency key was used with different content. Use a new key.",
  project_not_found: "The Project was not found.",
  project_has_running_works: "The Project has running Works or active Agents.",
  project_deletion_impact_changed: "The Project's Works changed after confirmation.",
  model_preset_not_found: "The model preset was not found.",
  project_path_conflict: "This folder is already registered as a Project.",
  conversation_not_found: "The conversation was not found.",
  work_not_found: "The Work was not found.",
  backlog_item_not_found: "The backlog item was not found.",
  skill_not_found: "The skill was not found.",
  skill_file_not_found: "The skill file was not found.",
  skill_revision_not_found: "The skill revision was not found.",
  skill_proposal_not_found: "The skill proposal was not found.",
  task_not_found: "The task was not found.",
  design_document_not_found: "The design document was not found.",
  decision_not_found: "The Decision was not found.",
  decision_already_resolved: "The Decision has already been resolved.",
  agent_run_not_found: "The agent run was not found.",
  agent_scope_denied: "The agent is not allowed to access this resource.",
  unauthorized: "Authentication is required or the credentials are invalid.",
  forbidden: "This request is not allowed.",
  unsupported_media_type: "Send the request body as application/json.",
  not_found: "The requested resource was not found.",
  contract_invalid: "The contract is invalid. Check the supplied data.",
  static_assets_missing: "The web assets are missing. Build the project and try again.",
  provider_version_mismatch: "The Provider version is not supported.",
  dependency_unavailable: "A required dependency is unavailable. Check the server configuration and logs.",
  worktree_cleanup_failed: "The Worktree could not be cleaned up. Check the logs.",
  guard_unparseable: "The guard could not safely parse the request.",
  upload_too_large: "The upload exceeds the allowed size.",
  upload_checksum_mismatch: "The upload checksum does not match.",
  upload_quota_exceeded: "The upload quota has been exceeded.",
  action_rejected: "The action was rejected.",
  action_id_conflict: "The action ID is already in use.",
  server_error: "The server could not complete the request. Check the logs using the reference ID.",
};

const HTTP_MESSAGE_TEXT: Readonly<Record<string, string>> = {
  "backendUrlを指定してください。カスタムProviderには接続先のhttpまたはhttpsのURLが必要です。": "Specify backendUrl. A custom provider needs an http or https URL to connect to.",
  "backendUrlはhttpまたはhttpsのURLを指定してください。": "backendUrl must be an http or https URL.",
  "フォルダは絶対パスで指定してください。": "Specify the folder as an absolute path.",
  "Project名は1〜200文字で指定してください。": "The Project name must be 1 to 200 characters.",
  "変更する項目（nameまたはcanonical_path）を1つ以上指定してください。": "Specify at least one field to change (name or canonical_path).",
  "このフォルダにはまだ作業履歴がありません。先にProjectの追加画面でGitを準備してから、もう一度変更してください。": "This folder has no Git history yet. Prepare Git from the Add project screen first, then change the folder again.",
  "指定されたProjectが見つかりません。Project一覧を再読み込みしてください。": "The Project was not found. Reload the Project list.",
  "指定されたProjectが見つかりません。 Project一覧を再読み込みしてください。": "The Project was not found. Reload the Project list.",
  "confirmed_work_countが不正です。0以上の整数を指定してください。": "confirmed_work_count is invalid. Specify an integer of 0 or more.",
  "フォルダが見つかりません。": "The folder was not found.",
  "フォルダではありません。": "This is not a folder.",
  "このフォルダを開く権限がありません。": "You do not have permission to open this folder.",
  "show_hiddenは0または1で指定してください。": "Set show_hidden to 0 or 1.",
  "共有フォルダはgitで追跡される場所には指定できません。.gitignoreで除外された場所かリポジトリの外を指定してください。": "The shared folder cannot be in a location tracked by git. Choose a git-ignored location or a folder outside the repository.",
  "別サイトからの状態変更requestは受け付けません。Owl Web UIから操作してください。": "Changes from another site are not allowed. Use the Owl Web UI.",
  "許可されていないOriginからの状態変更requestは受け付けません。Owl Web UIから操作してください。": "Changes from this Origin are not allowed. Use the Owl Web UI.",
  "リクエスト本文はContent-Type: application/jsonで送信してください。": "Send the request body with Content-Type: application/json.",
  "リクエスト本文のサイズが上限を超えています。入力を短くして再試行してください。": "The request body is too large. Shorten the input and try again.",
  "リクエスト本文が空です。契約どおりのJSONを送信してください。": "The request body is empty. Send JSON matching the contract.",
  "リクエスト本文をJSONとして解釈できません。JSON形式を確認して再試行してください。": "Could not parse the request body as JSON. Check its format and try again.",
  "リクエスト本文が許可されたuploadサイズを超えています。": "The request body exceeds the allowed upload size.",
  "リクエスト本文はJSON objectで指定してください。項目を確認して再試行してください。": "Send a JSON object as the request body. Check its fields and try again.",
  "expected_versionが不正です。0以上の整数を指定してください。": "Set expected_version to a nonnegative integer.",
  "payloadが不正です。JSON objectを指定してください。": "Set payload to a JSON object.",
  "同じidempotency_keyに異なる内容が指定されています。新しいkeyで再試行してください。": "This idempotency_key was used with different content. Retry with a new key.",
  "limitが不正です。1〜200の整数を指定してください。": "Set limit to an integer from 1 to 200.",
  "limitが不正です。1〜500の整数を指定してください。": "Set limit to an integer from 1 to 500.",
  "offsetが不正です。0以上の整数を指定してください。": "Set offset to a nonnegative integer.",
  "archivedが不正です。exclude、include、onlyのいずれかを指定してください。": "Set archived to exclude, include, or only.",
  "boolean queryが不正です。trueまたはfalseを指定してください。": "Set the boolean query parameter to true or false.",
  "外部接続には正しいAuthorization: Bearer <OWL_API_TOKEN>が必要です。local cookieは外部経路では使用できません。": "External access requires Authorization: Bearer <OWL_API_TOKEN>. Local cookies cannot be used externally.",
  "外部接続にはservice tokenが必要です。Bearer tokenを指定してください。": "External access requires a service token. Send a Bearer token.",
  "guard tokenが無効か失効しています。Agentを再実行してください。": "The guard token is invalid or expired. Rerun the agent.",
  "静的配信はGETで取得してください。HTTP methodを確認してください。": "Use GET for static assets. Check the HTTP method.",
  "指定された静的ファイルが見つかりません。URLを確認してください。": "The requested static file was not found. Check the URL.",
  "languageが不正です。\"ja\"または\"en\"を指定してください。": "Set language to \"ja\" or \"en\".",
};

export function errorBody(
  requestId: string,
  error: Pick<ApiError, "code" | "message" | "details">,
  language: OwnerLanguage = "ja",
): { request_id: string; error: { code: string; message: string; details: Record<string, unknown> } } {
  return {
    request_id: requestId,
    error: {
      code: error.code,
      message: language === "ja" || !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(error.message)
        ? error.message
        : HTTP_MESSAGE_TEXT[error.message] ?? HTTP_ERROR_TEXT[error.code] ?? error.message,
      details: error.details,
    },
  };
}
