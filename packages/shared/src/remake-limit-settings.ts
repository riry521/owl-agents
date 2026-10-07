import { globToRegExp } from "./glob.js";

export const REMAKE_LIMIT_SETTINGS_KEY = "remake_limits";
export const TASK_TYPES_FOR_REMAKE = ["research", "design", "code", "config", "doc", "test"] as const;

export interface RemakeLimitSettings {
  /** Valid Reviewer verdicts (pass + fail) across a lineage. Integer 1..1000. */
  readonly lineage_review_attempts: number;
  /** Worker/Designer launches that ran to an end across a lineage. Integer 1..1000. */
  readonly lineage_worker_runs: number;
  /** Consecutive remakes that changed only verification paths. Integer 1..100. */
  readonly non_functional_remakes: number;
  /** Valid Reviewer verdicts across a lineage's base-sync-only generations (counted apart from lineage_review_attempts). Integer 1..1000. */
  readonly base_sync_lineage_review_attempts: number;
  /** Worker/Designer launches that ran to an end in a lineage's base-sync-only generations. Integer 1..1000. */
  readonly base_sync_lineage_worker_runs: number;
  /** Reviewer rejections of Lead Designer output across a lineage before Core stops remaking the design. Integer 1..100. */
  readonly lead_review_rejections: number;
  /** Globs (repo-relative, `/` separated) that count as tests/verification scripts. */
  readonly verification_paths: readonly string[];
  /** Task types whose remakes are checked for non-functional changes. */
  readonly checked_task_types: readonly string[];
}

export const DEFAULT_REMAKE_LIMIT_SETTINGS: RemakeLimitSettings = {
  lineage_review_attempts: 9,
  lineage_worker_runs: 10,
  non_functional_remakes: 2,
  base_sync_lineage_review_attempts: 9,
  base_sync_lineage_worker_runs: 10,
  lead_review_rejections: 1,
  verification_paths: [
    "**/tests/**", "**/test/**", "**/__tests__/**",
    "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.py",
    "**/fixtures/**", "**/*.snap",
    "scripts/verify*", "scripts/**/verify*",
  ],
  checked_task_types: ["code", "config"],
};

export class RemakeLimitSettingsValidationError extends Error {
  public constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "RemakeLimitSettingsValidationError";
  }
}

const KEYS = ["lineage_review_attempts", "lineage_worker_runs", "non_functional_remakes", "base_sync_lineage_review_attempts", "base_sync_lineage_worker_runs", "lead_review_rejections", "verification_paths", "checked_task_types"] as const;
export const REMAKE_LIMIT_SETTINGS_KEYS: readonly string[] = KEYS;
const MAX_GLOBS = 200;
const MAX_GLOB_LENGTH = 500;
const INTEGER_RANGES = { lineage_review_attempts: 1000, lineage_worker_runs: 1000, non_functional_remakes: 100, base_sync_lineage_review_attempts: 1000, base_sync_lineage_worker_runs: 1000, lead_review_rejections: 100 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string, message: string): never {
  throw new RemakeLimitSettingsValidationError(message, field);
}

function checkInteger(key: keyof typeof INTEGER_RANGES, value: unknown): number {
  const max = INTEGER_RANGES[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) fail(key, `${key} must be an integer from 1 to ${max}.`);
  return value;
}

function checkVerificationPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GLOBS) fail("verification_paths", `verification_paths must be an array of 1 to ${MAX_GLOBS} globs.`);
  return value.map((glob) => {
    if (typeof glob !== "string" || glob.length === 0 || glob.length > MAX_GLOB_LENGTH) fail("verification_paths", `verification_paths must contain non-empty globs of at most ${MAX_GLOB_LENGTH} characters.`);
    try {
      globToRegExp(glob);
    } catch {
      fail("verification_paths", `verification_paths contains an invalid glob: ${glob}`);
    }
    return glob;
  });
}

function checkTaskTypes(value: unknown): string[] {
  const known: readonly unknown[] = TASK_TYPES_FOR_REMAKE;
  if (!Array.isArray(value) || value.some((type) => !known.includes(type)) || new Set(value).size !== value.length) {
    fail("checked_task_types", `checked_task_types must be a list of distinct task types from ${TASK_TYPES_FOR_REMAKE.join(", ")}.`);
  }
  return [...value] as string[];
}

function checkKey(key: (typeof KEYS)[number], value: unknown): number | string[] {
  if (key === "verification_paths") return checkVerificationPaths(value);
  if (key === "checked_task_types") return checkTaskTypes(value);
  return checkInteger(key, value);
}

/** For PUT: exactly the keys, every value valid. Throws RemakeLimitSettingsValidationError. */
export function validateRemakeLimitSettings(value: unknown): RemakeLimitSettings {
  if (!isRecord(value)) fail("payload", "Settings must be an object.");
  const own = Reflect.ownKeys(value);
  if (own.length !== KEYS.length || !KEYS.every((key) => own.includes(key))) fail("payload", `Settings must contain exactly ${KEYS.join(", ")}.`);
  return Object.fromEntries(KEYS.map((key) => [key, checkKey(key, value[key])])) as unknown as RemakeLimitSettings;
}

/** For reads: per-key fallback to the default, calling warn for each fallback. */
export function readRemakeLimitSettings(value: unknown, warn?: (message: string) => void): RemakeLimitSettings {
  if (!isRecord(value)) {
    warn?.("Stored remake limits are not an object; using defaults.");
    return DEFAULT_REMAKE_LIMIT_SETTINGS;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!(KEYS as readonly unknown[]).includes(key)) warn?.(`Unknown remake limit ${String(key)}; ignoring.`);
  }
  const entries = KEYS.map((key) => {
    try {
      if (!Object.hasOwn(value, key)) return [key, DEFAULT_REMAKE_LIMIT_SETTINGS[key]];
      return [key, checkKey(key, value[key])];
    } catch {
      warn?.(`Invalid remake limit ${key}; using default.`);
      return [key, DEFAULT_REMAKE_LIMIT_SETTINGS[key]];
    }
  });
  return Object.fromEntries(entries) as unknown as RemakeLimitSettings;
}
