import { exactKeysValidator, SettingsValidationError } from "./settings-validation.js";

export const AUTO_RECOVERY_SETTINGS_KEY = "auto_recovery";
export const AUTO_RECOVERY_LIMIT_MIN = 0;
export const AUTO_RECOVERY_LIMIT_MAX = 10;

export interface AutoRecoverySettings {
  /** Automatic recoveries per reason before a Decision is opened. Integer 0..10; 0 turns them off. */
  readonly limit: number;
}

export const DEFAULT_AUTO_RECOVERY_SETTINGS: AutoRecoverySettings = { limit: 2 };

export class AutoRecoverySettingsValidationError extends SettingsValidationError {
  public override name = "AutoRecoverySettingsValidationError";
}

function checkLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < AUTO_RECOVERY_LIMIT_MIN || value > AUTO_RECOVERY_LIMIT_MAX) {
    throw new AutoRecoverySettingsValidationError(`limit must be an integer from ${AUTO_RECOVERY_LIMIT_MIN} to ${AUTO_RECOVERY_LIMIT_MAX}.`, "limit", { kind: "integer_range", min: AUTO_RECOVERY_LIMIT_MIN, max: AUTO_RECOVERY_LIMIT_MAX });
  }
  return value;
}

/** For PUT: exactly the one key, with a valid value. Throws AutoRecoverySettingsValidationError. */
export const validateAutoRecoverySettings = exactKeysValidator<AutoRecoverySettings>({
  keys: ["limit"],
  check: (_key, value) => checkLimit(value),
  error: AutoRecoverySettingsValidationError,
});

/** For reads: an invalid stored value falls back to the default and is reported in warnings. */
export function readAutoRecoverySettings(value: unknown): { readonly settings: AutoRecoverySettings; readonly warnings: readonly string[] } {
  try {
    return { settings: validateAutoRecoverySettings(value), warnings: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid value";
    return { settings: DEFAULT_AUTO_RECOVERY_SETTINGS, warnings: [`Stored auto_recovery is invalid (${reason}); using the default.`] };
  }
}
