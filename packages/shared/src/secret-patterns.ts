/**
 * The one place that defines which strings count as secrets. Each caller picks its own rule set because its
 * output format and coverage are part of its contract (stored pages reject, logs mask, research text counts).
 */

/** A pattern and the replacement string handed to String.replace. */
export type RedactRule = readonly [RegExp, string];

/** Applies the rules in order. */
export function redactWithRules(text: string, rules: readonly RedactRule[]): string {
  return rules.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text);
}

// --- Memory pages: detect by name, mask as `[secret:<name>]` ---

const PAGE_SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["sk-", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/u],
  ["xox[bp]-", /xox[bp]-[A-Za-z0-9-]{10,}/u],
  ["ghp_", /ghp_[A-Za-z0-9]{20,}/u],
  ["AKIA", /AKIA[0-9A-Z]{16}/u],
];
/** Names of the secret shapes found in `text` (never the secret itself). */
export function findSecretPatterns(text: string): readonly string[] {
  return PAGE_SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
/** Copies a JSON value with every secret shape in its strings (object keys too) replaced by `[secret:<name>]`, using the patterns findSecretPatterns names. */
export function maskSecrets(value: unknown): unknown {
  const maskText = (text: string): string => PAGE_SECRET_PATTERNS.reduce((t, [name, pattern]) => t.replace(new RegExp(pattern.source, `${pattern.flags}g`), `[secret:${name}]`), text);
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskText(k), maskSecrets(v)]));
  return value;
}

// --- Provider output and error text: mask as `[redacted]` ---

/** Advisor/provider output. The advisor excerpt hides the matches of these same patterns. */
export const ADVISOR_REDACT_RULES: readonly RedactRule[] = [
  [/(bearer\s+|authorization\s*[:=]\s*|api[-_ ]?key\s*[:=]\s*|access[_ -]?token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;"]+/giu, "$1[redacted]"],
  [/\b(?:sk|xoxb|xoxp|xapp|ghp|gho|github_pat)[-_][A-Za-z0-9_-]+\b/gu, "[redacted]"],
];

/** Core's user-visible error text. */
export const ERROR_DISPLAY_REDACT_RULES: readonly RedactRule[] = [
  [/(bearer\s+|authorization\s*[:=]\s*(?:bearer\s+)?|api[-_ ]?key\s*[:=]\s*|access[_ -]?token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]"],
  [/\b(?:sk|xoxb|xapp|ghp|github_pat)-[A-Za-z0-9_-]+\b/gu, "[redacted]"],
];

// --- Git and post-merge command output: mask as `[REDACTED]` / `***` ---

/** Credentials embedded in a remote URL. */
export const GIT_CREDENTIAL_RULES: readonly RedactRule[] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1***@"],
  [/\b(x-access-token|oauth2|gitlab-ci-token):[^@\s/]+@/giu, "$1:***@"],
];

const SECRET_NAME = "[\\w-]*(?:key|token|secret|password|passwd|credential)[\\w-]*";
const SECRET_VALUE = "(\"[^\"]*\"|'[^']*'|[^\\s\"']+)";
/** A command-line flag whose next argument is a secret. */
export const SECRET_FLAG = new RegExp(`^--?${SECRET_NAME}$`, "iu");

/** Post-merge command output: URL credentials, Authorization/Bearer/Basic values, NAME=value / NAME: value and `--flag value`. */
export const POST_MERGE_REDACT_RULES: readonly RedactRule[] = [
  ...GIT_CREDENTIAL_RULES,
  [/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"']+/giu, "$1[REDACTED]"],
  [/\b(bearer|basic)\s+[\w.~+/=-]{6,}/giu, "$1 [REDACTED]"],
  [new RegExp(`(${SECRET_NAME}\\s*[=:]\\s*)${SECRET_VALUE}`, "giu"), "$1[REDACTED]"],
  [new RegExp(`(\\s--?${SECRET_NAME}\\s+)${SECRET_VALUE}`, "giu"), "$1[REDACTED]"],
];

// --- Research text: mask as `[REDACTED]`, counting what was hidden ---

/** One research redaction: `lengthOf` gives the hidden characters when they differ from the whole match. */
export interface ResearchRedaction {
  readonly pattern: RegExp;
  readonly replacement: string | ((...args: string[]) => string);
  readonly lengthOf?: (...args: string[]) => number;
}

export const RESEARCH_REDACTIONS: readonly ResearchRedaction[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, replacement: "[REDACTED]" },
  { pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/giu, replacement: "[REDACTED]" },
  { pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]+/giu, replacement: "[REDACTED]" },
  { pattern: /\/\/([^/@\s:]+):([^/@\s]*)@/gu, replacement: "//[REDACTED]@", lengthOf: (match) => Math.max(0, match.length - 3) },
  {
    pattern: /(["']?)(\b(?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd)\b)\1(\s*[:=]\s*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(?:Bearer\s+)?([^\s"',;]+))/giu,
    replacement: (_match, quote, key, separator) => `${quote}${key}${quote}${separator}[REDACTED]`,
    lengthOf: (_match, _quote, _key, _separator, doubleValue, singleValue, bareValue) => (doubleValue ?? singleValue ?? bareValue ?? "").length,
  },
  { pattern: /\bBearer\s+([A-Za-z0-9._~+/-]+=*)/giu, replacement: "Bearer [REDACTED]", lengthOf: (_match, token) => token.length },
  { pattern: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|(?:sk|rk)_live_[A-Za-z0-9]{12,}|gh[porus]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9._-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|npm_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,})\b/gu, replacement: "[REDACTED]" },
];
