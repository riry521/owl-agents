import type { AgentFailureClass, OwnerLanguage, RateLimitInfo } from "@owl/shared";

import { AgentRuntimeError } from "./errors";
import { rateLimitHarness, resolveRateLimitReset, type RateLimitResetInput } from "./rate-limit";

/** How a provider process ended, as observed by Owl rather than read from its output. */
export type ProviderFailureKind =
  | "timeout"
  | "cancelled"
  | "output_too_large"
  | "spawn_error"
  | "exit"
  | "harness_error";

export interface ProviderFailureCause {
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly kind?: ProviderFailureKind;
  /** Set when Owl stopped the process: "wall" for the run time limit, "idle" for the no-output limit. */
  readonly timeout_kind?: "wall" | "idle";
  /** HTTP status the harness reported for its API failure (Claude `api_error_status`). */
  readonly harness_status?: number;
  /** Error type or subtype the harness reported for its API failure. */
  readonly harness_code?: string;
  readonly error_code?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: unknown;
  readonly rate_limit_evidence?: readonly RateLimitResetInput[];
}

export interface ProviderFailureClassification {
  readonly failure_class: AgentFailureClass;
  readonly error_key: string;
  readonly retry_allowed: boolean;
  readonly message: string;
  readonly rate_limit?: RateLimitInfo;
}

interface ProviderErrorContext {
  readonly kind?: ProviderFailureKind;
  readonly timeoutKind?: "wall" | "idle";
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly status?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly rateLimitInfo?: RateLimitInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "";
}

function providerLabel(harness: string): string {
  const normalized = harness.trim().toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "Claude";
  if (normalized.includes("codex") || normalized.includes("openai")) return "Codex";
  if (normalized.length === 0) return "Provider";
  return harness.trim();
}

function statusFrom(text: string, context: ProviderErrorContext): number | null {
  if (typeof context.status === "number" && Number.isInteger(context.status)) return context.status;
  const match = text.match(/\bHTTP\s+(\d{3})\b/iu) ?? text.match(/\b(status|code)[=: ]+(\d{3})\b/iu);
  if (!match) return null;
  const value = Number(match[match.length - 1]);
  return Number.isInteger(value) ? value : null;
}

function isAuthenticationFailure(text: string, status: number | null): boolean {
  return status === 401 || /authentication_error|authentication failed|unauthorized|invalid (?:api[-_ ]?key|token)|access token.*revoked|token.*expired|login required|not authenticated/iu.test(text);
}

function isPermissionFailure(text: string, status: number | null): boolean {
  return status === 403 || /permission denied|permission_denied|forbidden|not allowed|access denied/iu.test(text);
}

function isRateLimitFailure(text: string, status: number | null): boolean {
  return status === 429 || /rate[ _-]?limit|too many requests|usage[ _-]?limit|limit reached|hit your [^\n]*?\blimit\b|usageLimitExceeded|\b429\b/iu.test(text);
}

function isOverloadedFailure(text: string, status: number | null): boolean {
  return status === 529 || /serverOverloaded|overloaded|\b529\b/iu.test(text);
}

function isInsufficientQuotaFailure(text: string): boolean {
  return /insufficient[_ -]?quota/iu.test(text);
}

function isNetworkFailure(text: string): boolean {
  return /network|connection refused|connection reset|econnreset|enotfound|etimedout|socket|dns|fetch failed|connect(?:ion)? timeout|\b502\b|\b503\b|\b504\b/iu.test(text);
}

function isTimeoutFailure(text: string): boolean {
  return /timeout|timed out|deadline exceeded|provider_timeout/iu.test(text);
}

function isConfigurationFailure(text: string, status: number | null): boolean {
  return status === 404 || /provider_config|executable|command not found|enoent|no such file|missing .*?(?:model|credential|key|token|configuration)|(?:model|endpoint).{0,30}(?:not found|does not exist)|unknown model|adapter_not_in_allowlist|absolute_.*path_required/iu.test(text);
}

function isProtocolFailure(text: string): boolean {
  return /report_invalid|invalid (?:json|response|output|protocol)|unexpected end of input/iu.test(text);
}

function isRequestFailure(text: string, status: number | null): boolean {
  return status === 400 || /invalid_request|bad request|unsupported parameter|unsupported model/iu.test(text);
}

function isServiceFailure(text: string, status: number | null): boolean {
  return (status !== null && status >= 500) || /internal server error|service unavailable|server_error/iu.test(text);
}

function isProcessControlFailure(text: string): boolean {
  return /output (?:exceeded|too large)|cancel(?:led|ed)|provider_output_too_large|provider_cancelled/iu.test(text);
}

function isArgumentSizeFailure(text: string): boolean {
  return /\be2big\b|argument list too long|argument list.*too (?:large|long)/iu.test(text);
}

type LabelText = (label: string) => string;
type StatusLabelText = (label: string, statusText: string) => string;

function formatResetTime(iso: string, language: OwnerLanguage): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(language === "ja" ? "ja-JP" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

interface ProviderErrorText {
  status: (status: number) => string;
  argumentSize: LabelText;
  auth: StatusLabelText;
  permission: StatusLabelText;
  rateLimit: (label: string, statusText: string, resetsAt: string | null) => string;
  overloaded: LabelText;
  timeout: LabelText;
  idle: LabelText;
  network: StatusLabelText;
  configuration: LabelText;
  protocol: LabelText;
  request: StatusLabelText;
  service: StatusLabelText;
  processControl: LabelText;
  signal: (signal: string) => string;
  exitCode: (code: number) => string;
  unknownExit: string;
  other: (label: string, statusText: string, exitText: string) => string;
  configInvalid: (reason: string) => string;
  providerUnknown: (reason: string) => string;
  reportInvalid: (reason: string) => string;
  planInvalid: (reason: string) => string;
  reviewInvalid: (reason: string) => string;
  fallback: string;
}

// Owner-facing, so it follows the language Core put on the request.
const PROVIDER_ERROR_TEXT: Record<OwnerLanguage, ProviderErrorText> = {
  ja: {
    status: (status) => `（HTTP ${status}）`,
    argumentSize: (label) => `${label}への入力がOSのコマンドサイズ上限を超え、Harnessを起動できませんでした。プロンプトとExecutor出力のサイズを確認してください。`,
    auth: (label, statusText) => `${label}の認証に失敗しました${statusText}。CLI/APIキーの認証情報を更新してから、Owlを再起動してください。`,
    permission: (label, statusText) => `${label}の権限が拒否されました${statusText}。利用アカウントの権限、モデルへのアクセス権、ワークスペース権限を確認してください。`,
    rateLimit: (label, statusText, resetsAt) => resetsAt === null
      ? label + "の利用上限に達しました" + statusText + "（解除時刻は不明）。"
      : label + "の利用上限に達しました" + statusText + "。" + formatResetTime(resetsAt, "ja") + "ごろ解除される見込みです。",
    overloaded: (label) => label + "が混み合っています。しばらくして自動で再試行します。",
    timeout: (label) => `${label}の応答がタイムアウトしました。ネットワークとモデルの状態を確認し、必要ならタイムアウト設定を見直してください。`,
    idle: (label) => `${label}が長時間進捗を出さなかったため停止しました。ネットワークとProviderの状態を確認してください。長い無出力が想定される作業ではOWL_PROVIDER_IDLE_TIMEOUT_MSを見直してください。`,
    network: (label, statusText) => `${label}へ接続できませんでした${statusText}。ネットワーク、エンドポイント、プロキシ設定を確認してください。`,
    configuration: (label) => `${label}の実行設定が不正です。Harnessの実行ファイル、モデル、環境変数、作業ディレクトリを確認してください。`,
    protocol: (label) => `${label}の応答をOwlのプロトコルとして解釈できませんでした。Harnessの出力形式とバージョンを確認してください。`,
    request: (label, statusText) => `${label}へのリクエストが拒否されました${statusText}。モデル名、リクエスト形式、Providerのエンドポイント設定を確認してください。`,
    service: (label, statusText) => `${label}側で処理に失敗しました${statusText}。Providerの稼働状況を確認してから再試行してください。`,
    processControl: (label) => `${label}の実行が中断されました（出力上限超過またはキャンセル）。入力サイズ、出力サイズ、停止要求を確認してください。`,
    signal: (signal) => `シグナル ${signal}`,
    exitCode: (code) => `終了コード ${code}`,
    unknownExit: "原因不明の終了",
    other: (label, statusText, exitText) => `${label}が処理に失敗しました${statusText}（${exitText}）。Harnessの設定と認証を確認してください。`,
    configInvalid: (reason) => `Providerの設定が不正です（${reason}）。実行ファイル、モデル、環境変数、作業ディレクトリを確認してください。`,
    providerUnknown: (reason) => `Providerが見つかりません（${reason}）。Provider設定と利用可能なHarnessを確認してください。`,
    reportInvalid: (reason) => `Providerの応答がOwlのレポート契約に一致しません（${reason}）。Harnessの出力形式とバージョンを確認してください。`,
    planInvalid: (reason) => `Managerの応答がOwlの計画契約に一致しません（${reason}）。Manager用Harnessの出力形式を確認してください。`,
    reviewInvalid: (reason) => `Reviewerの応答がOwlのレビュー契約に一致しません（${reason}）。Reviewer用Harnessの出力形式を確認してください。`,
    fallback: "Agent処理に失敗しました。設定とログを確認してください。",
  },
  en: {
    status: (status) => ` (HTTP ${status})`,
    argumentSize: (label) => `The input to ${label} exceeded the OS command size limit, so the Harness could not start. Check the size of the prompt and the Executor output.`,
    auth: (label, statusText) => `${label} authentication failed${statusText}. Refresh the CLI or API key credentials, then restart Owl.`,
    permission: (label, statusText) => `${label} denied permission${statusText}. Check the account permissions, model access, and workspace permissions.`,
    rateLimit: (label, statusText, resetsAt) => resetsAt === null
      ? label + " hit its usage limit" + statusText + " (reset time unknown)."
      : label + " hit its usage limit" + statusText + ". It should reset around " + formatResetTime(resetsAt, "en") + ".",
    overloaded: (label) => label + " is overloaded. Owl will retry shortly.",
    timeout: (label) => `${label} timed out. Check the network and the model status, and review the timeout settings if needed.`,
    idle: (label) => `${label} was stopped after producing no progress for too long. Check the network and the Provider status; for work that is expected to stay silent longer, review OWL_PROVIDER_IDLE_TIMEOUT_MS.`,
    network: (label, statusText) => `Could not connect to ${label}${statusText}. Check the network, endpoint, and proxy settings.`,
    configuration: (label) => `${label} run settings are invalid. Check the Harness executable, model, environment variables, and working directory.`,
    protocol: (label) => `${label} output could not be read as the Owl protocol. Check the Harness output format and version.`,
    request: (label, statusText) => `${label} rejected the request${statusText}. Check the model name, request format, and Provider endpoint settings.`,
    service: (label, statusText) => `${label} failed on its side${statusText}. Check the Provider status and retry.`,
    processControl: (label) => `${label} was interrupted (output limit exceeded or cancelled). Check the input size, output size, and stop requests.`,
    signal: (signal) => `signal ${signal}`,
    exitCode: (code) => `exit code ${code}`,
    unknownExit: "exited for an unknown reason",
    other: (label, statusText, exitText) => `${label} failed${statusText} (${exitText}). Check the Harness settings and authentication.`,
    configInvalid: (reason) => `The Provider settings are invalid (${reason}). Check the executable, model, environment variables, and working directory.`,
    providerUnknown: (reason) => `The Provider was not found (${reason}). Check the Provider settings and the available Harnesses.`,
    reportInvalid: (reason) => `The Provider output does not match Owl's report contract (${reason}). Check the Harness output format and version.`,
    planInvalid: (reason) => `The Manager output does not match Owl's plan contract (${reason}). Check the output format of the Manager Harness.`,
    reviewInvalid: (reason) => `The Reviewer output does not match Owl's review contract (${reason}). Check the output format of the Reviewer Harness.`,
    fallback: "The agent failed. Check the settings and logs.",
  },
};

/**
 * Convert provider output into a user-facing diagnosis without copying raw
 * stderr/stdout. Provider responses frequently contain access tokens, request
 * headers, or account identifiers, so raw text never appears in user-facing
 * messages. Raw output is not persisted by default; only when a role's output
 * breaks its contract does the runner keep a redacted tail of stdout/stderr
 * in the agent-output log (see output-log.ts) and reference its path.
 */
export function formatProviderError(
  harness: string,
  error: unknown,
  context: ProviderErrorContext = {},
  language: OwnerLanguage = "ja",
): string {
  const label = providerLabel(harness);
  const text = [
    errorText(error),
    context.stderr ?? "",
    context.stdout ?? "",
  ].join("\n");
  const status = statusFrom(text, context);
  const t = PROVIDER_ERROR_TEXT[language];
  const statusText = status === null ? "" : t.status(status);

  if (context.kind === "timeout") return context.timeoutKind === "idle" ? t.idle(label) : t.timeout(label);
  if (context.kind === "cancelled" || context.kind === "output_too_large") return t.processControl(label);
  if (isArgumentSizeFailure(text)) return t.argumentSize(label);
  if (context.rateLimitInfo !== undefined) {
    return t.rateLimit(label, statusText, context.rateLimitInfo.resets_at);
  }
  if (isAuthenticationFailure(text, status)) return t.auth(label, statusText);
  if (isPermissionFailure(text, status)) return t.permission(label, statusText);
  if (isOverloadedFailure(text, status)) return t.overloaded(label);
  if (isRateLimitFailure(text, status)) return t.rateLimit(label, statusText, null);
  if (isTimeoutFailure(text)) return t.timeout(label);
  if (isNetworkFailure(text)) return t.network(label, statusText);
  if (isConfigurationFailure(text, status)) return t.configuration(label);
  if (isProtocolFailure(text)) return t.protocol(label);
  if (isRequestFailure(text, status)) return t.request(label, statusText);
  if (isServiceFailure(text, status)) return t.service(label, statusText);
  if (isProcessControlFailure(text)) return t.processControl(label);

  const exitText = context.signal !== undefined && context.signal !== null
    ? t.signal(context.signal)
    : context.exitCode !== undefined && context.exitCode !== null
      ? t.exitCode(context.exitCode)
      : t.unknownExit;
  return t.other(label, statusText, exitText);
}

/** Only the end of stderr is searched: the start is usually the harness banner and progress. */
const CLASSIFIED_STDERR_CHARS = 4_096;

interface FailureVerdict {
  readonly failure_class: AgentFailureClass;
  readonly retry_allowed: boolean;
  readonly key: string;
}

const deterministic = (key: string): FailureVerdict => ({ failure_class: "deterministic", retry_allowed: false, key });
const transient = (key: string): FailureVerdict => ({ failure_class: "transient", retry_allowed: true, key });
const rateLimited = (): FailureVerdict => ({ failure_class: "rate_limited", retry_allowed: true, key: "rate_limited" });

function exitDescriptor(cause: ProviderFailureCause): string {
  if (cause.kind === "harness_error") {
    return cause.harness_status === undefined ? "harness_error" : `harness_error:${cause.harness_status}`;
  }
  return cause.signal !== null ? `signal:${cause.signal}` : `exit:${cause.exit_code ?? "unknown"}`;
}

function hasStructuredRateLimitSignal(cause: ProviderFailureCause): boolean {
  if (/usageLimitExceeded|usage[_ -]?limit[_ -]?exceeded/iu.test(cause.harness_code ?? "")) return true;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (!isRecord(value) || depth > 7 || seen.has(value)) return false;
    seen.add(value);
    const info = isRecord(value.rate_limit_info) ? value.rate_limit_info : null;
    if (value.type === "rate_limit_event" && info?.status === "rejected") return true;
    if (info?.status === "rejected") return true;
    const codexInfo = isRecord(value.codexErrorInfo) ? value.codexErrorInfo : null;
    if (codexInfo?.kind === "usageLimitExceeded" || codexInfo?.type === "usageLimitExceeded" || codexInfo?.code === "usageLimitExceeded") return true;
    if (value.kind === "usageLimitExceeded" || value.type === "usageLimitExceeded" || value.code === "usageLimitExceeded") return true;
    return Object.values(value).some((nested) => visit(nested, depth + 1));
  };
  return (cause.rate_limit_evidence ?? []).some((evidence) => evidence.kind === "event" && visit(evidence.event, 0));
}

/** Decides from what Owl observed and what the harness reported as structured data. */
function structuredVerdict(cause: ProviderFailureCause): FailureVerdict | null {
  if (cause.error_code === "E2BIG") return deterministic("argument_list_too_long");
  if (cause.kind === "timeout") return transient(`timeout:${cause.timeout_kind ?? "wall"}`);
  if (cause.kind === "cancelled") return deterministic("cancelled");
  if (cause.kind === "output_too_large") return deterministic("output_too_large");
  if (cause.kind === "spawn_error") return deterministic("spawn_error");
  if (isInsufficientQuotaFailure([cause.harness_code ?? "", errorText(cause.error), cause.stderr ?? ""].join("\n"))) {
    return deterministic(exitDescriptor(cause));
  }
  if (isOverloadedFailure(cause.harness_code ?? "", cause.harness_status ?? null)) return transient(exitDescriptor(cause));
  const status = cause.harness_status;
  if (status !== undefined) {
    if (status === 401 || status === 403) return deterministic(exitDescriptor(cause));
    if (status === 429) return rateLimited();
    if (status === 408 || status >= 500) return transient(exitDescriptor(cause));
    if (status === 400 || status === 404 || status === 422) return deterministic(exitDescriptor(cause));
  }
  if (hasStructuredRateLimitSignal(cause)) return rateLimited();
  if (cause.signal !== null && cause.signal !== "SIGKILL" && cause.signal !== "SIGTERM") {
    return deterministic(exitDescriptor(cause));
  }
  return null;
}

/**
 * Text the pattern fallback may read: the end of stderr and the error
 * message. stdout is never read, because it carries the model's own answer
 * and a word such as "socket" or "parse" in it says nothing about the failure.
 */
function classifiedText(cause: ProviderFailureCause): string {
  const stderr = cause.stderr ?? "";
  return [stderr.slice(-CLASSIFIED_STDERR_CHARS), cause.harness_code ?? "", errorText(cause.error)].join("\n");
}

function fallbackVerdict(cause: ProviderFailureCause, text: string): FailureVerdict {
  if (isArgumentSizeFailure(text)) return deterministic("argument_list_too_long");
  if (isInsufficientQuotaFailure(text)) return deterministic(exitDescriptor(cause));
  const status = statusFrom(text, { status: cause.harness_status ?? null });
  if (isOverloadedFailure(text, status)) return transient(exitDescriptor(cause));
  if (isRateLimitFailure(text, status)) return rateLimited();
  const isTransient = isNetworkFailure(text) || isTimeoutFailure(text);
  const retryDisallowed = isAuthenticationFailure(text, status)
    || isPermissionFailure(text, status)
    || isConfigurationFailure(text, status)
    || isProtocolFailure(text);
  return {
    failure_class: isTransient ? "transient" : "deterministic",
    retry_allowed: isTransient && !retryDisallowed,
    key: exitDescriptor(cause),
  };
}

function retryAfterEvidence(text: string): RateLimitResetInput[] {
  const inputs: RateLimitResetInput[] = [];
  const pattern = /\bretry-after\s*:\s*([^\r\n]+)/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    inputs.push({ kind: "retry_after", value: match[1].trim() });
  }
  return inputs;
}

/**
 * Classification order: argument size, then how Owl saw the process end
 * (timeout, cancel, output limit, spawn failure), then the HTTP status the
 * harness reported, then an unexpected signal. Only a failure none of these
 * explain falls back to patterns in the end of stderr and the error message.
 */
export function classifyProviderFailure(
  harness: string,
  cause: ProviderFailureCause,
  language: OwnerLanguage = "ja",
  now: Date = new Date(),
): ProviderFailureClassification {
  const text = classifiedText(cause);
  const verdict = structuredVerdict(cause) ?? fallbackVerdict(cause, text);
  const rateLimit = verdict.failure_class === "rate_limited"
    ? resolveRateLimitReset([
        ...(cause.rate_limit_evidence ?? []),
        { kind: "text", text },
        ...retryAfterEvidence(text),
      ], now, { harness: rateLimitHarness(harness) })
    : undefined;
  return {
    failure_class: verdict.failure_class,
    error_key: `provider_failed:${verdict.key}`,
    retry_allowed: verdict.retry_allowed,
    ...(rateLimit !== undefined ? { rate_limit: rateLimit } : {}),
    message: formatProviderError(harness, text, {
      ...(cause.kind ? { kind: cause.kind } : {}),
      ...(cause.timeout_kind ? { timeoutKind: cause.timeout_kind } : {}),
      exitCode: cause.exit_code,
      signal: cause.signal,
      status: cause.harness_status ?? null,
      ...(rateLimit !== undefined ? { rateLimitInfo: rateLimit } : {}),
    }, language),
  };
}

const PROVIDER_FAILURE_KINDS: Readonly<Record<string, ProviderFailureKind>> = {
  provider_timeout: "timeout",
  provider_cancelled: "cancelled",
  provider_output_too_large: "output_too_large",
  spawn_call_failed: "spawn_error",
  child_process_error: "spawn_error",
  stdin_close_failed: "spawn_error",
  guard_token_unavailable: "spawn_error",
  provider_reported_error: "harness_error",
  provider_rate_limited: "harness_error",
};

function failureKind(reason: string): ProviderFailureKind | undefined {
  if (reason.startsWith("provider_exit:")) return "exit";
  return PROVIDER_FAILURE_KINDS[reason];
}

function rateLimitEvidenceFrom(value: unknown): readonly RateLimitResetInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const evidence = value.filter((item): item is RateLimitResetInput => {
    if (!isRecord(item)) return false;
    if (item.kind === "event") return Object.prototype.hasOwnProperty.call(item, "event");
    if (item.kind === "text") return typeof item.text === "string";
    return item.kind === "retry_after" && (typeof item.value === "string" || typeof item.value === "number");
  });
  return evidence.length > 0 ? evidence : undefined;
}

/**
 * The classifiable cause of a thrown provider_failed AgentRuntimeError, or
 * null for any other error, which callers must let propagate rather than
 * misclassify. The failure kind comes from the error's reason; the rest from
 * the cause the provider or protocol layer attached.
 */
export function providerFailureCause(error: unknown): ProviderFailureCause | null {
  if (!(error instanceof AgentRuntimeError) || error.code !== "provider_failed") {
    return null;
  }
  const kind = failureKind(error.reason);
  const cause = (error as { readonly cause?: unknown }).cause;
  if (!isRecord(cause) || cause instanceof Error) {
    return {
      exit_code: null,
      signal: null,
      ...(kind ? { kind } : {}),
      ...(isRecord(cause) && typeof cause.code === "string" ? { error_code: cause.code } : {}),
      error: cause ?? error.reason,
    };
  }
  const rateLimitEvidence = rateLimitEvidenceFrom(cause.rate_limit_evidence);
  return {
    exit_code: typeof cause.exit_code === "number" ? cause.exit_code : null,
    signal: typeof cause.signal === "string" ? cause.signal : null,
    ...(kind ? { kind } : {}),
    ...(cause.timeout_kind === "wall" || cause.timeout_kind === "idle" ? { timeout_kind: cause.timeout_kind } : {}),
    ...(typeof cause.harness_status === "number" && Number.isInteger(cause.harness_status) ? { harness_status: cause.harness_status } : {}),
    ...(typeof cause.harness_code === "string" ? { harness_code: cause.harness_code } : {}),
    ...(typeof cause.code === "string" ? { error_code: cause.code } : {}),
    ...(rateLimitEvidence !== undefined ? { rate_limit_evidence: rateLimitEvidence } : {}),
    ...(typeof cause.stdout === "string" ? { stdout: cause.stdout } : {}),
    ...(typeof cause.stderr === "string" ? { stderr: cause.stderr } : {}),
    ...(cause.error !== undefined ? { error: cause.error } : {}),
  };
}

/** Safe display text for errors that escaped a role/runtime boundary. */
export function formatRuntimeError(error: unknown, fallback?: string, language: OwnerLanguage = "ja"): string {
  const t = PROVIDER_ERROR_TEXT[language];
  if (error instanceof AgentRuntimeError) {
    const cause = providerFailureCause(error);
    if (cause !== null) {
      return classifyProviderFailure("Provider", cause, language).message;
    }
    if (error.code === "provider_config_invalid") {
      return t.configInvalid(error.reason);
    }
    if (error.code === "provider_unknown") {
      return t.providerUnknown(error.reason);
    }
    if (error.code === "report_invalid") {
      return t.reportInvalid(error.reason);
    }
    if (error.code === "manager_plan_invalid") {
      return t.planInvalid(error.reason);
    }
    if (error.code === "review_invalid") {
      return t.reviewInvalid(error.reason);
    }
    return error.message;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback ?? t.fallback;
}
