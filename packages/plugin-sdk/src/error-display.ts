import type { OwlLanguage } from "./shared/language";

/**
 * Build safe, actionable text for a connector/Core or external-service
 * failure. Provider and platform errors can contain bearer tokens, bot
 * tokens, request headers, or account identifiers, so the raw message must
 * remain in private logs and never be posted back to a channel.
 */
export function formatIntegrationError(service: string, error: unknown, language: OwlLanguage = "ja"): string {
  const t = INTEGRATION_ERROR_TEXT[language];
  const label = service.trim().length > 0 ? service.trim() : t.fallbackService;
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/401|invalid[_ -]?auth|oauth|unauthorized|access token.*revoked|invalid (?:api[-_ ]?key|token)|token.*expired/iu.test(raw)) {
    return t.auth(label);
  }
  if (/403|permission denied|forbidden|access denied|not_in_channel|missing_scope|channel_not_found/iu.test(raw)) {
    return t.permission(label);
  }
  if (/429|rate[ -]?limit|too many requests|overloaded/iu.test(raw)) {
    return t.rateLimit(label);
  }
  if (/timeout|timed out|network|connection|econnreset|enotfound|fetch failed|socket/iu.test(raw)) {
    return t.network(label);
  }

  const safe = raw
    .replace(/(bearer\s+|authorization\s*[:=]\s*|api[-_ ]?key\s*[:=]\s*|access[_ -]?token\s*[:=]\s*|token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(?:xoxb|xapp|Bot|Bearer|sk|ghp|github_pat)[-_ ]?[A-Za-z0-9_.-]+\b/gu, "[redacted]")
    .slice(0, 500);
  return t.other(label, safe);
}

const INTEGRATION_ERROR_TEXT: Readonly<Record<OwlLanguage, {
  readonly fallbackService: string;
  readonly auth: (label: string) => string;
  readonly permission: (label: string) => string;
  readonly rateLimit: (label: string) => string;
  readonly network: (label: string) => string;
  readonly other: (label: string, cause: string) => string;
}>> = {
  ja: {
    fallbackService: "外部サービス",
    auth: (label) => `${label}の認証に失敗しました。トークンまたは接続設定を確認して再試行してください。`,
    permission: (label) => `${label}の権限または対象チャンネルへのアクセスが拒否されました。Botの参加状態、チャンネルID、権限を確認してください。`,
    rateLimit: (label) => `${label}の利用制限に達しました。しばらく待ってから再試行してください。`,
    network: (label) => `${label}へ接続できませんでした。ネットワークと接続先の状態を確認してください。`,
    other: (label, cause) => `${label}の処理に失敗しました。${cause ? `原因: ${cause}` : "設定とログを確認してください。"}`,
  },
  en: {
    fallbackService: "The external service",
    auth: (label) => `${label} authentication failed. Check the token or connection settings and try again.`,
    permission: (label) => `${label} denied the permission or access to the channel. Check that the bot has joined, the channel ID, and its permissions.`,
    rateLimit: (label) => `${label} rate limit reached. Wait a moment and try again.`,
    network: (label) => `Could not connect to ${label}. Check the network and the service status.`,
    other: (label, cause) => `${label} failed. ${cause ? `Cause: ${cause}` : "Check the settings and logs."}`,
  },
};
