import { exactKeysValidator, keyedReader, SettingsValidationError } from "./settings-validation.js";

export const REVIEWER_FIX_SETTINGS_KEY = "reviewer_fix";
export const REVIEWER_FIX_SETTINGS_KEYS = ["max_changed_lines", "max_changed_files"] as const;
export const REVIEWER_FIX_MAX_CHANGED_LINES_MIN = 0;
export const REVIEWER_FIX_MAX_CHANGED_LINES_MAX = 1000;
export const REVIEWER_FIX_MAX_CHANGED_FILES_MIN = 0;
export const REVIEWER_FIX_MAX_CHANGED_FILES_MAX = 100;

export interface ReviewerFixSettings {
  /** Largest diff (added + deleted lines) the Reviewer may fix itself. Integer 0..1000; 0 turns Reviewer fixes off. */
  readonly max_changed_lines: number;
  /** Largest number of files the Reviewer may fix itself. Integer 0..100; 0 turns Reviewer fixes off. */
  readonly max_changed_files: number;
}

export const DEFAULT_REVIEWER_FIX_SETTINGS: ReviewerFixSettings = { max_changed_lines: 30, max_changed_files: 3 };

export class ReviewerFixSettingsValidationError extends SettingsValidationError {
  public override name = "ReviewerFixSettingsValidationError";
}

const BOUNDS = {
  max_changed_lines: { min: REVIEWER_FIX_MAX_CHANGED_LINES_MIN, max: REVIEWER_FIX_MAX_CHANGED_LINES_MAX },
  max_changed_files: { min: REVIEWER_FIX_MAX_CHANGED_FILES_MIN, max: REVIEWER_FIX_MAX_CHANGED_FILES_MAX },
} as const;

function check(key: keyof ReviewerFixSettings, value: unknown): number {
  const { min, max } = BOUNDS[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ReviewerFixSettingsValidationError(`${key} must be an integer from ${min} to ${max}.`, key, { kind: "integer_range", min, max });
  }
  return value;
}

/** For PUT: exactly the two keys, each valid. Throws ReviewerFixSettingsValidationError. */
export const validateReviewerFixSettings = exactKeysValidator<ReviewerFixSettings>({
  keys: REVIEWER_FIX_SETTINGS_KEYS,
  check,
  error: ReviewerFixSettingsValidationError,
});

/** For reads: a missing key is its default without a warning; an invalid one falls back with a warning. */
export const readReviewerFixSettings = keyedReader<ReviewerFixSettings>({
  keys: REVIEWER_FIX_SETTINGS_KEYS,
  defaults: DEFAULT_REVIEWER_FIX_SETTINGS,
  check,
  notObject: "Stored reviewer_fix is not an object; using defaults.",
  invalid: (key) => `Invalid ${key}; using default.`,
});
