export const FIXER_ESCALATION_SETTINGS_KEY = "fixer_escalation";
export const FIXER_ESCALATION_SETTINGS_KEYS: readonly string[] = ["after_review_rejections"];
export const FIXER_ESCALATION_MIN = 1;
export const FIXER_ESCALATION_MAX = 100;

export interface FixerEscalationSettings {
  /** Review rejections of a Worker Task after which the Fixer takes the next fix. Integer 1..100. */
  readonly after_review_rejections: number;
}

export const DEFAULT_FIXER_ESCALATION_SETTINGS: FixerEscalationSettings = { after_review_rejections: 2 };

export class FixerEscalationSettingsValidationError extends Error {
  public constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "FixerEscalationSettingsValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkRejections(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < FIXER_ESCALATION_MIN || value > FIXER_ESCALATION_MAX) {
    throw new FixerEscalationSettingsValidationError(`after_review_rejections must be an integer from ${FIXER_ESCALATION_MIN} to ${FIXER_ESCALATION_MAX}.`, "after_review_rejections");
  }
  return value;
}

/** For PUT: exactly the one key, with a valid value. Throws FixerEscalationSettingsValidationError. */
export function validateFixerEscalationSettings(value: unknown): FixerEscalationSettings {
  if (!isRecord(value)) throw new FixerEscalationSettingsValidationError("Settings must be an object.", "payload");
  const own = Reflect.ownKeys(value);
  if (own.length !== 1 || own[0] !== "after_review_rejections") {
    throw new FixerEscalationSettingsValidationError("Settings must contain exactly after_review_rejections.", "payload");
  }
  return { after_review_rejections: checkRejections(value.after_review_rejections) };
}

/** For reads: a missing value is the default without a warning; an invalid one falls back with a warning. */
export function readFixerEscalationSettings(value: unknown, warn?: (message: string) => void): FixerEscalationSettings {
  if (!isRecord(value)) {
    warn?.("Stored fixer escalation is not an object; using defaults.");
    return DEFAULT_FIXER_ESCALATION_SETTINGS;
  }
  if (!Object.hasOwn(value, "after_review_rejections")) return DEFAULT_FIXER_ESCALATION_SETTINGS;
  try {
    return { after_review_rejections: checkRejections(value.after_review_rejections) };
  } catch {
    warn?.("Invalid after_review_rejections; using default.");
    return DEFAULT_FIXER_ESCALATION_SETTINGS;
  }
}
