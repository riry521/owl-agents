export const DEPENDENCY_SUMMARY_SETTINGS_KEY = "dependency_summary";

export interface DependencySummarySettings {
  /** Longest work_done summary (characters) a Worker receives per dependency Task. */
  readonly max_chars: number;
}

export const DEFAULT_DEPENDENCY_SUMMARY_SETTINGS: DependencySummarySettings = { max_chars: 600 };

export class DependencySummarySettingsValidationError extends Error {
  public constructor(message: string, public readonly field: "max_chars" | "payload") {
    super(message);
    this.name = "DependencySummarySettingsValidationError";
  }
}

const MAX_CHARS_LIMIT = 100_000;

const isValidMaxChars = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CHARS_LIMIT;

/** For PUT: exactly max_chars, an integer in 1..100000. */
export function validateDependencySummarySettings(value: unknown): DependencySummarySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DependencySummarySettingsValidationError("Settings must be an object.", "payload");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "max_chars") {
    throw new DependencySummarySettingsValidationError("Settings must contain exactly max_chars.", "payload");
  }
  const maxChars = (value as Record<string, unknown>).max_chars;
  if (!isValidMaxChars(maxChars)) {
    throw new DependencySummarySettingsValidationError(`max_chars must be an integer from 1 to ${MAX_CHARS_LIMIT}.`, "max_chars");
  }
  return { max_chars: maxChars };
}

/** For reads: an invalid or missing value falls back to the default and calls warn. */
export function readDependencySummarySettings(value: unknown, warn?: (message: string) => void): DependencySummarySettings {
  const maxChars = typeof value === "object" && value !== null ? (value as Record<string, unknown>).max_chars : undefined;
  if (isValidMaxChars(maxChars)) return { max_chars: maxChars };
  warn?.("Invalid dependency summary max_chars; using default.");
  return DEFAULT_DEPENDENCY_SUMMARY_SETTINGS;
}
