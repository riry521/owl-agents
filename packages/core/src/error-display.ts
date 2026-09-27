import type { OwnerLanguage } from "@owl/shared";

type Label = (label: string) => string;

interface RuntimeFailureText {
  auth: Label;
  permission: Label;
  rateLimit: Label;
  timeout: Label;
  idle: Label;
  network: Label;
  setup: Label;
  notFound: Label;
  protocol: Label;
  badRequest: Label;
  provider: Label;
  unknown: Label;
  other: (label: string, safe: string) => string;
}

// Owner-facing, so it follows the Owner language (owner-language.ts).
const RUNTIME_FAILURE_TEXT: Record<OwnerLanguage, RuntimeFailureText> = {
  ja: {
    auth: (label) => `${label} Providerの認証に失敗しました（HTTP 401）。CLI/APIキーの認証情報を更新してから再試行してください。`,
    permission: (label) => `${label} Providerの権限が拒否されました。アカウント、モデル、ワークスペースの権限を確認してください。`,
    rateLimit: (label) => `${label} Providerの利用制限に達しました。しばらく待ってから再試行してください。`,
    timeout: (label) => `${label} Providerの応答がタイムアウトしました。ネットワークとタイムアウト設定を確認してください。`,
    idle: (label) => `${label}が長時間進捗を出さなかったため停止しました。ネットワークとProviderの状態を確認してください。長い無出力が想定される作業ではOWL_PROVIDER_IDLE_TIMEOUT_MSを見直してください。`,
    network: (label) => `${label} Providerへ接続できませんでした。ネットワーク、エンドポイント、プロキシ設定を確認してください。`,
    setup: (label) => `${label} Providerの実行設定が不正です。実行ファイルのパス、モデル、環境変数、作業ディレクトリを確認してください。`,
    notFound: (label) => `${label} Providerのモデルまたはエンドポイントが見つかりません。Provider設定とモデル名を確認してください。`,
    protocol: (label) => `${label} Providerの応答をOwlのプロトコルとして解釈できませんでした。Harnessの出力形式とバージョンを確認してください。`,
    badRequest: (label) => `${label} Providerへのリクエストが拒否されました。モデル名、リクエスト形式、エンドポイント設定を確認してください。`,
    provider: (label) => `${label} Provider側で処理に失敗しました。Providerの稼働状況を確認してから再試行してください。`,
    unknown: (label) => `${label}処理で原因不明のエラーが発生しました。設定とログを確認してください。`,
    other: (label, safe) => `${label}処理でエラーが発生しました。原因: ${safe || "詳細不明"}`,
  },
  en: {
    auth: (label) => `${label} Provider authentication failed (HTTP 401). Refresh the CLI or API key credentials and retry.`,
    permission: (label) => `${label} Provider denied permission. Check the account, model, and workspace permissions.`,
    rateLimit: (label) => `${label} Provider rate limit reached. Wait a while and retry.`,
    timeout: (label) => `${label} Provider timed out. Check the network and the timeout settings.`,
    idle: (label) => `${label} was stopped after producing no progress for too long. Check the network and the Provider status; for work that is expected to stay silent longer, review OWL_PROVIDER_IDLE_TIMEOUT_MS.`,
    network: (label) => `Could not connect to the ${label} Provider. Check the network, endpoint, and proxy settings.`,
    setup: (label) => `${label} Provider run settings are invalid. Check the executable path, model, environment variables, and working directory.`,
    notFound: (label) => `${label} Provider model or endpoint was not found. Check the Provider settings and the model name.`,
    protocol: (label) => `${label} Provider output could not be read as the Owl protocol. Check the Harness output format and version.`,
    badRequest: (label) => `${label} Provider rejected the request. Check the model name, request format, and endpoint settings.`,
    provider: (label) => `${label} Provider failed on its side. Check the Provider status and retry.`,
    unknown: (label) => `${label} failed for an unknown reason. Check the settings and logs.`,
    other: (label, safe) => `${label} failed. Cause: ${safe || "unknown"}`,
  },
};

/**
 * Build safe, actionable text for an error that crosses the Core boundary.
 * Provider/Harness stderr is deliberately used only for classification; it is
 * never copied into a message because it can contain credentials or headers.
 */
export function formatRuntimeFailure(error: unknown, subject = "Agent", language: OwnerLanguage = "ja"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const rawCause = error instanceof Error && "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  const cause = typeof rawCause === "string"
    ? rawCause
    : rawCause instanceof Error
      ? rawCause.message
      : rawCause === undefined
        ? ""
        : (() => {
            try { return JSON.stringify(rawCause); } catch { return ""; }
          })();
  const text = `${message}\n${cause}`.trim();
  const label = subject.trim().length > 0 ? subject.trim() : "Agent";

  const t = RUNTIME_FAILURE_TEXT[language];

  // Owl's own marker for a process it stopped for silence outranks whatever
  // the Harness printed before it went quiet.
  if (/provider_idle_timeout/u.test(text)) return t.idle(label);
  // HTTP status codes only count as whole numbers: IDs such as ULIDs contain
  // digit runs ("…A5381…") that must not read as a Provider 5xx.
  if (/\b401\b|oauth|authentication|unauthorized|access token.*revoked|invalid api key/iu.test(text)) return t.auth(label);
  if (/\b403\b|permission denied|forbidden|access denied/iu.test(text)) return t.permission(label);
  if (/\b429\b|rate[ -]?limit|overloaded/iu.test(text)) return t.rateLimit(label);
  if (/timeout|timed out|deadline exceeded/iu.test(text)) return t.timeout(label);
  if (/network|connection|econnreset|enotfound|fetch failed/iu.test(text)) return t.network(label);
  if (/enoent|eacces|eperm|command not found|executable|not installed|not absolute|configuration is invalid/iu.test(text)) return t.setup(label);
  if (/\b404\b|model.*(?:not found|does not exist)|endpoint.*(?:not found|does not exist)|unknown model/iu.test(text)) return t.notFound(label);
  if (/invalid (?:json|response|output|protocol)|malformed|report_invalid|parse/iu.test(text)) return t.protocol(label);
  if (/\b400\b|invalid_request|bad request|unsupported (?:parameter|model)/iu.test(text)) return t.badRequest(label);
  if (/\b5\d\d\b|internal server error|service unavailable|server_error/iu.test(text)) return t.provider(label);
  if (text.length === 0) return t.unknown(label);

  const safe = message
    .replace(/(bearer\s+|authorization\s*[:=]\s*|api[-_ ]?key\s*[:=]\s*|access[_ -]?token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(?:sk|xoxb|xapp|ghp|github_pat)-[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .slice(0, 1_000);
  return t.other(label, safe);
}
