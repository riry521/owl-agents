import { isIP } from "node:net";

import { extractWebResearchCapture, type WebResearchCapture, type WebResearchLink } from "@owl/shared";

export type ResearchTargetVerdict =
  | { readonly ok: true; readonly normalized_url: string | null; readonly research_key: string }
  | { readonly ok: false; readonly reason: "invalid_url" | "credential_url" | "private_host" | "auth_page" };

const CREDENTIAL_QUERY_NAMES = new Set([
  "token", "access_token", "id_token", "refresh_token", "api_key", "apikey", "key", "secret", "client_secret",
  "password", "passwd", "pwd", "auth", "signature", "sig", "x-amz-signature", "x-amz-credential",
  "x-amz-security-token", "code", "state", "session", "sessionid", "sid", "jwt",
]);
const AUTH_PATH_SEGMENTS = new Set(["login", "signin", "sign-in", "sign_in", "logout", "oauth", "oauth2", "sso", "saml", "authorize", "auth", "callback"]);

export function normalizeResearchUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.protocol === "http:") url.protocol = "https:";
    url.hash = "";
    const parameters = [...url.searchParams.entries()]
      .filter(([key]) => !isTrackingParameter(key))
      .sort(([keyA, valueA], [keyB, valueB]) => compareText(keyA, keyB) || compareText(valueA, valueB));
    url.search = "";
    for (const [key, value] of parameters) url.searchParams.append(key, value);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeResearchQuery(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function isPrivateResearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || /\.(?:local|internal|lan|home\.arpa|intranet)$/u.test(host)) return true;
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) === 6) return isPrivateIpv6(host);
  return !host.includes(".");
}

export function isAuthResearchUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const firstLabel = hostname.split(".")[0];
  if (["login", "signin", "sso", "auth", "accounts"].some((prefix) => firstLabel === prefix)) return true;
  if ([".okta.com", ".auth0.com", ".onelogin.com"].some((suffix) => hostname.endsWith(suffix))) return true;
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeSegment(segment).toLowerCase());
  return segments.some((segment) => AUTH_PATH_SEGMENTS.has(segment));
}

export function looksLikeLoginPage(content: string): boolean {
  const beginning = content.slice(0, 5_000);
  // Use the same shared detector as WebFetch extraction for direct filter callers.
  if (extractWebResearchCapture("WebFetch", { url: "https://example.test/" }, content)?.auth_form_detected === true) return true;
  if (/(?:please\s+(?:sign[ -]?in|log[ -]?in|login)|(?:sign[ -]?in|log[ -]?in|login)\s+(?:with\s+(?:your\s+)?password|to\s+(?:continue|access|proceed)|required)|authentication\s+required|ログインしてください|ログインして続行|サインインしてください|サインインして続行)/iu.test(beginning)) return true;

  const labels = /^[ \t]*(sign[ -]?in|log[ -]?in|login|password|ログイン|サインイン|パスワード)[ \t]*$/gimu;
  let previous: { readonly label: string; readonly index: number } | undefined;
  for (const match of beginning.matchAll(labels)) {
    const label = match[1]?.toLowerCase() ?? "";
    const loginLabel = /^(?:sign[ -]?in|log[ -]?in|login|ログイン|サインイン)$/u.test(label);
    const passwordLabel = /^(?:password|パスワード)$/u.test(label);
    if (previous && match.index - previous.index <= 160) {
      const previousLogin = /^(?:sign[ -]?in|log[ -]?in|login|ログイン|サインイン)$/u.test(previous.label);
      const previousPassword = /^(?:password|パスワード)$/u.test(previous.label);
      if (loginLabel && previousPassword || passwordLabel && previousLogin) return true;
    }
    if (loginLabel || passwordLabel) previous = { label, index: match.index };
  }
  return false;
}

export function classifyResearchTarget(capture: WebResearchCapture): ResearchTargetVerdict {
  if (capture.has_auth_headers === true || capture.auth_form_detected === true || hasAuthInput(capture)) return { ok: false, reason: "auth_page" };
  if (capture.tool === "WebSearch") {
    const query = typeof capture.query === "string" ? redactResearchText(capture.query).text : "";
    const normalizedQuery = normalizeResearchQuery(query);
    return normalizedQuery
      ? { ok: true, normalized_url: null, research_key: `search:${normalizedQuery}` }
      : { ok: false, reason: "invalid_url" };
  }
  if (capture.tool !== "WebFetch" || typeof capture.url !== "string") return { ok: false, reason: "invalid_url" };

  let url: URL;
  try {
    url = new URL(capture.url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "invalid_url" };
  if (url.username || url.password || hasCredentialQuery(url)) return { ok: false, reason: "credential_url" };
  if (isPrivateResearchHost(url.hostname)) return { ok: false, reason: "private_host" };
  if (isAuthResearchUrl(url) || looksLikeLoginPage(capture.content)) return { ok: false, reason: "auth_page" };
  const normalizedUrl = normalizeResearchUrl(capture.url);
  return normalizedUrl
    ? { ok: true, normalized_url: normalizedUrl, research_key: `url:${normalizedUrl}` }
    : { ok: false, reason: "invalid_url" };
}

export function redactResearchText(text: string): { readonly text: string; readonly redactions: number; readonly redacted_chars: number } {
  let redactions = 0;
  let redactedChars = 0;
  let result = text;
  const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string), lengthOf?: (...args: string[]) => number): void => {
    result = result.replace(pattern, (...args: string[]) => {
      redactions += 1;
      redactedChars += lengthOf ? lengthOf(...args) : args[0].length;
      return typeof replacement === "string" ? replacement : replacement(...args);
    });
  };

  replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED]");
  replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/giu, "[REDACTED]");
  replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]+/giu, "[REDACTED]");
  replace(/\/\/([^/@\s:]+):([^/@\s]*)@/gu, "//[REDACTED]@", (match) => Math.max(0, match.length - 3));
  replace(
    /(["']?)(\b(?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd)\b)\1(\s*[:=]\s*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(?:Bearer\s+)?([^\s"',;]+))/giu,
    (_match, quote, key, separator) => `${quote}${key}${quote}${separator}[REDACTED]`,
    (_match, _quote, _key, _separator, doubleValue, singleValue, bareValue) => (doubleValue ?? singleValue ?? bareValue ?? "").length,
  );
  replace(/\bBearer\s+([A-Za-z0-9._~+/-]+=*)/giu, "Bearer [REDACTED]", (_match, token) => token.length);
  replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|(?:sk|rk)_live_[A-Za-z0-9]{12,}|gh[porus]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9._-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|npm_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,})\b/gu, "[REDACTED]");
  return { text: result, redactions, redacted_chars: redactedChars };
}

export function filterResearchLinks(links: readonly WebResearchLink[]): WebResearchLink[] {
  const filtered: WebResearchLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (!link || typeof link.url !== "string" || typeof link.title !== "string") continue;
    const verdict = classifyResearchTarget({
      tool: "WebFetch", url: link.url, query: null, prompt: null, title: link.title,
      content: "", links: [], http_status: null, is_error: false,
    });
    if (!verdict.ok || !verdict.normalized_url || seen.has(verdict.normalized_url)) continue;
    seen.add(verdict.normalized_url);
    filtered.push({ title: redactResearchText(link.title).text, url: redactResearchText(verdict.normalized_url).text });
  }
  return filtered;
}

function isTrackingParameter(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || ["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "yclid", "igshid", "_hsenc", "_hsmi", "ref_src"].includes(lower);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasCredentialQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) if (CREDENTIAL_QUERY_NAMES.has(key.toLowerCase())) return true;
  return false;
}

function decodeSegment(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIpv6(address: string): boolean {
  const words = expandIpv6(address);
  if (!words) return false;
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const embeddedIpv4 = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    return isPrivateIpv4(embeddedIpv4);
  }
  return false;
}

function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = value.slice(lastColon + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, lastColon)}:${high}:${low}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((part) => Number.parseInt(part, 16)) : [];
  if (left.concat(right).some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  const zeros = 8 - left.length - right.length;
  if (halves.length === 1 && zeros !== 0 || halves.length === 2 && zeros < 1) return null;
  return [...left, ...Array(Math.max(0, zeros)).fill(0), ...right];
}

function hasAuthInput(capture: WebResearchCapture): boolean {
  const value = capture as WebResearchCapture & { readonly tool_input?: unknown };
  if (!value.tool_input || typeof value.tool_input !== "object") return false;
  const input = value.tool_input as Record<string, unknown>;
  for (const field of ["headers", "cookies"]) {
    const entries = input[field];
    if (!entries || typeof entries !== "object") continue;
    for (const key of Object.keys(entries)) {
      if (["cookie", "authorization", "proxy-authorization"].includes(key.toLowerCase()) || field === "cookies") return true;
    }
  }
  return false;
}
