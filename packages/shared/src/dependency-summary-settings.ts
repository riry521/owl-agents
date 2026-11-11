import { exactKeysValidator, SettingsValidationError } from "./settings-validation.js";

export const DEPENDENCY_SUMMARY_SETTINGS_KEY = "dependency_summary";

export interface DependencySummarySettings {
  /** Longest work_done summary (characters) a Worker receives per dependency Task. */
  readonly max_chars: number;
}

export const DEFAULT_DEPENDENCY_SUMMARY_SETTINGS: DependencySummarySettings = { max_chars: 600 };

export class DependencySummarySettingsValidationError extends SettingsValidationError<"max_chars" | "payload"> {
  public override name = "DependencySummarySettingsValidationError";
}

const MAX_CHARS_LIMIT = 100_000;

const isValidMaxChars = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CHARS_LIMIT;

/** For PUT: exactly max_chars, an integer in 1..100000. */
export const validateDependencySummarySettings = exactKeysValidator<DependencySummarySettings>({
  keys: ["max_chars"],
  check: (_key, value) => {
    if (!isValidMaxChars(value)) {
      throw new DependencySummarySettingsValidationError(`max_chars must be an integer from 1 to ${MAX_CHARS_LIMIT}.`, "max_chars", { kind: "integer_range", min: 1, max: MAX_CHARS_LIMIT });
    }
    return value;
  },
  error: DependencySummarySettingsValidationError,
});

/** For reads: an invalid or missing value falls back to the default and calls warn. */
export function readDependencySummarySettings(value: unknown, warn?: (message: string) => void): DependencySummarySettings {
  const maxChars = typeof value === "object" && value !== null ? (value as Record<string, unknown>).max_chars : undefined;
  if (isValidMaxChars(maxChars)) return { max_chars: maxChars };
  warn?.("Invalid dependency summary max_chars; using default.");
  return DEFAULT_DEPENDENCY_SUMMARY_SETTINGS;
}
