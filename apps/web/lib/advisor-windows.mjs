// Advisor ページの窓の選び方。純関数。
// DEFAULT_WINDOW_KEY は shared の GENERAL_WINDOW_KEY と同じ値（テストで確かめる）。
export const DEFAULT_WINDOW_KEY = "general";

/** ?window= の値を一覧にある鍵へ解決する。一覧に無い鍵はジェネラリストにし、found を false にする。 */
export function resolveWindowKey(param, windows) {
  if (!param || param === DEFAULT_WINDOW_KEY) return { key: DEFAULT_WINDOW_KEY, found: true };
  if (windows.some((window) => window.key === param)) return { key: param, found: true };
  return { key: DEFAULT_WINDOW_KEY, found: false };
}

export function windowHref(key) {
  return key === DEFAULT_WINDOW_KEY ? "/advisor" : `/advisor?window=${encodeURIComponent(key)}`;
}

/** Slack・Discord から来た Owner の発言の送り手の名前に付ける文言のキー。それ以外は null。 */
export function viaLabelKey(source) {
  return source === "slack" || source === "discord" ? `advisorWindows.via.${source}` : null;
}

// 手順の文言の数。i18n の advisorWindows.setup.<provider>.<kind>Step1.. と対応する（テストで確かめる）。
export const SETUP_STEP_COUNTS = {
  slack: { permission: 5, botNotMember: 2 },
  discord: { permission: 3, botNotMember: 2 },
};

const ERROR_KEYS = {
  integration_not_running: "notRunning",
  integration_rate_limited: "rateLimited",
  window_channel_exists: "windowChannelExists",
  channel_in_use: "channelInUse",
  channel_already_bound: "channelAlreadyBound",
  channel_binding_not_found: "bindingNotFound",
  validation_error: "invalidName",
  channel_name_taken: "nameTaken",
  channel_not_found: "channelNotFound",
  integration_not_authorized: "notAuthorized",
  integration_provider_error: "providerError",
};

/**
 * チャンネル管理の API のエラーを、画面に出す i18n のキーと差し込む値に直す。
 * steps は設定方法の手順のキー（権限が足りないときと Bot がチャンネルにいないときだけ）。
 */
export function channelErrorMessage(code, details, provider) {
  const base = `advisorWindows.setup.${provider}`;
  const steps = (kind) => Array.from({ length: SETUP_STEP_COUNTS[provider][kind] }, (_, i) => `${base}.${kind}Step${i + 1}`);
  const known = Object.hasOwn(SETUP_STEP_COUNTS, provider);
  if (known && code === "integration_permission_missing") {
    const needed = Array.isArray(details?.needed) ? details.needed.join(", ") : "";
    return { key: `${base}.permission`, steps: steps("permission"), values: { needed, seconds: "" } };
  }
  if (known && code === "channel_bot_not_member") {
    return { key: `${base}.botNotMember`, steps: steps("botNotMember"), values: { needed: "", seconds: "" } };
  }
  const retry = details?.retry_after_seconds;
  const values = { needed: "", seconds: String(typeof retry === "number" ? retry : "") };
  const name = Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : "generic";
  return { key: `advisorWindows.channelError.${name}`, steps: [], values };
}
