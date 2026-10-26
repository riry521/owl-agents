export const PROGRESS_GUARD_SETTINGS_KEY = "progress_guard";

export interface ProgressGuardSettings {
  /** Consecutive "no progress" results of one Task before Core stops and asks the Owner. */
  readonly no_progress_limit: number;
  /** Seconds between evaluations of a prerequisite wait's conditions. */
  readonly prerequisite_check_interval_seconds: number;
  /** Hours a Task may wait for its prerequisite before Core asks the Owner. */
  readonly prerequisite_max_wait_hours: number;
  /** Merge the base branch into the Work branch when a prerequisite wait is released. */
  readonly prerequisite_sync_base: boolean;
  /** Times a Worker may report a pending process (a wait, not a failure) before the report counts as a plain partial; 0 turns the wait off. */
  readonly process_wait_max_count: number;
  /** Hours a Task may wait for a process its Worker started before Core asks the Owner. */
  readonly process_wait_max_hours: number;
  /** Times one Task lineage may send a Worker-reported external blocker to the Manager before Core asks the Owner. */
  readonly external_blocker_limit: number;
  /** Times one Task lineage may end a Worker run with a plain partial report (no wait, blocker or replan request) before Core asks the Owner. */
  readonly partial_limit: number;
  /** Seconds Core waits for the explanation of a waiting Decision before it notifies with the plain text. */
  readonly decision_explanation_timeout_seconds: number;
  /** Times Core asks for a rewrite of a Decision explanation that failed a check before it stores the fixed-form explanation. */
  readonly decision_explanation_rewrites_max: number;
  /** Manager calls Core makes for one plan or replan that is rejected for a missing field or a format error, before it asks the Owner. */
  readonly plan_rejection_attempts_max: number;
}

export const DEFAULT_PROGRESS_GUARD_SETTINGS: ProgressGuardSettings = {
  no_progress_limit: 3,
  prerequisite_check_interval_seconds: 60,
  prerequisite_max_wait_hours: 72,
  prerequisite_sync_base: true,
  process_wait_max_count: 3,
  process_wait_max_hours: 6,
  external_blocker_limit: 2,
  partial_limit: 3,
  decision_explanation_timeout_seconds: 300,
  decision_explanation_rewrites_max: 2,
  plan_rejection_attempts_max: 3,
};
export const PROGRESS_GUARD_RANGES = {
  no_progress_limit: { min: 1, max: 100 },
  prerequisite_check_interval_seconds: { min: 10, max: 86400 },
  prerequisite_max_wait_hours: { min: 1, max: 8760 },
  process_wait_max_count: { min: 0, max: 20 },
  process_wait_max_hours: { min: 1, max: 72 },
  external_blocker_limit: { min: 0, max: 20 },
  partial_limit: { min: 1, max: 20 },
  decision_explanation_timeout_seconds: { min: 30, max: 1800 },
  decision_explanation_rewrites_max: { min: 0, max: 5 },
  plan_rejection_attempts_max: { min: 1, max: 10 },
} as const;

export class ProgressGuardSettingsValidationError extends Error {
  public constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "ProgressGuardSettingsValidationError";
  }
}

const KEYS = Object.keys(DEFAULT_PROGRESS_GUARD_SETTINGS) as (keyof ProgressGuardSettings)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkValue(key: keyof ProgressGuardSettings, value: unknown): number | boolean {
  if (key === "prerequisite_sync_base") {
    if (typeof value !== "boolean") throw new ProgressGuardSettingsValidationError(`${key} must be true or false.`, key);
    return value;
  }
  const { min, max } = PROGRESS_GUARD_RANGES[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ProgressGuardSettingsValidationError(`${key} must be an integer from ${min} to ${max}.`, key);
  }
  return value;
}

/** For PUT: exactly the known keys, every value valid. Throws ProgressGuardSettingsValidationError. */
export function validateProgressGuardSettings(value: unknown): ProgressGuardSettings {
  if (!isRecord(value)) throw new ProgressGuardSettingsValidationError("Settings must be an object.", "payload");
  const own = Reflect.ownKeys(value);
  if (own.length !== KEYS.length || !KEYS.every((key) => own.includes(key))) {
    throw new ProgressGuardSettingsValidationError(`Settings must contain exactly ${KEYS.join(", ")}.`, "payload");
  }
  return Object.fromEntries(KEYS.map((key) => [key, checkValue(key, value[key])])) as unknown as ProgressGuardSettings;
}

/** For reads: per-key fallback to the default, calling warn for each fallback. */
export function readProgressGuardSettings(value: unknown, warn?: (message: string) => void): ProgressGuardSettings {
  if (!isRecord(value)) {
    warn?.("Stored progress guard settings are not an object; using defaults.");
    return DEFAULT_PROGRESS_GUARD_SETTINGS;
  }
  const entries = KEYS.map((key) => {
    try {
      // Keys added after a value was saved (e.g. only no_progress_limit) read as the default, silently.
      if (!Object.hasOwn(value, key)) return [key, DEFAULT_PROGRESS_GUARD_SETTINGS[key]];
      return [key, checkValue(key, value[key])];
    } catch {
      warn?.(`Invalid progress guard setting ${key}; using default.`);
      return [key, DEFAULT_PROGRESS_GUARD_SETTINGS[key]];
    }
  });
  return Object.fromEntries(entries) as unknown as ProgressGuardSettings;
}
