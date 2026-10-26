export interface CodexErrorInfo {
  /** The error kind in camelCase ("usageLimitExceeded", "responseTooManyFailedAttempts"). */
  readonly code: string;
  /** httpStatusCode of the object form, when the harness reported one. */
  readonly httpStatus: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function camelCase(code: string): string {
  return code.replace(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase());
}

function statusOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const status = value.httpStatusCode ?? value.http_status_code;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/**
 * Reads Codex's error classification from a turn error or rollout record: the
 * string form ("usageLimitExceeded"), the record form ({ kind | type | code }),
 * the one-key object form ({ responseTooManyFailedAttempts: { httpStatusCode } })
 * and the snake_case spelling of rollout files (codex_error_info).
 */
export function codexErrorInfoOf(value: unknown): CodexErrorInfo | null {
  if (!isRecord(value)) return null;
  const info = value.codexErrorInfo ?? value.codex_error_info;
  if (typeof info === "string") return info.length > 0 ? { code: camelCase(info), httpStatus: null } : null;
  if (!isRecord(info)) return null;
  for (const key of ["kind", "type", "code"]) {
    const named = info[key];
    if (typeof named === "string" && named.length > 0) return { code: camelCase(named), httpStatus: statusOf(info) };
  }
  const keys = Object.keys(info);
  if (keys.length !== 1) return null;
  return { code: camelCase(keys[0]), httpStatus: statusOf(info[keys[0]]) };
}

/** True for the Codex code that means the account's usage limit is used up. */
export function isUsageLimitCode(code: unknown): boolean {
  return typeof code === "string" && /^usage[_ -]?limit[_ -]?exceeded$/iu.test(code);
}
