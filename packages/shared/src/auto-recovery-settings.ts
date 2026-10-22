export const AUTO_RECOVERY_SETTINGS_KEY = "auto_recovery";
export const AUTO_RECOVERY_LIMIT_MIN = 0;
export const AUTO_RECOVERY_LIMIT_MAX = 10;

export interface AutoRecoverySettings {
  /** Automatic recoveries per reason before a Decision is opened. Integer 0..10; 0 turns them off. */
  readonly limit: number;
}

export const DEFAULT_AUTO_RECOVERY_SETTINGS: AutoRecoverySettings = { limit: 2 };

export class AutoRecoverySettingsValidationError extends Error {
  public constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "AutoRecoverySettingsValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < AUTO_RECOVERY_LIMIT_MIN || value > AUTO_RECOVERY_LIMIT_MAX) {
    throw new AutoRecoverySettingsValidationError(`limit must be an integer from ${AUTO_RECOVERY_LIMIT_MIN} to ${AUTO_RECOVERY_LIMIT_MAX}.`, "limit");
  }
  return value;
}

/** For PUT: exactly the one key, with a valid value. Throws AutoRecoverySettingsValidationError. */
export function validateAutoRecoverySettings(value: unknown): AutoRecoverySettings {
  if (!isRecord(value)) throw new AutoRecoverySettingsValidationError("Settings must be an object.", "payload");
  const own = Reflect.ownKeys(value);
  if (own.length !== 1 || own[0] !== "limit") {
    throw new AutoRecoverySettingsValidationError("Settings must contain exactly limit.", "payload");
  }
  return { limit: checkLimit(value.limit) };
}

/** For reads: an invalid stored value falls back to the default and is reported in warnings. */
export function readAutoRecoverySettings(value: unknown): { readonly settings: AutoRecoverySettings; readonly warnings: readonly string[] } {
  try {
    return { settings: validateAutoRecoverySettings(value), warnings: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid value";
    return { settings: DEFAULT_AUTO_RECOVERY_SETTINGS, warnings: [`Stored auto_recovery is invalid (${reason}); using the default.`] };
  }
}
