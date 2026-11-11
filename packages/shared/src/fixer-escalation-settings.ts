import { exactKeysValidator, isRecord, SettingsValidationError } from "./settings-validation.js";

export const FIXER_ESCALATION_SETTINGS_KEY = "fixer_escalation";
const KEYS = ["after_review_rejections"] as const;
export const FIXER_ESCALATION_MIN = 1;
export const FIXER_ESCALATION_MAX = 100;

export interface FixerEscalationSettings {
  /** Review rejections of a Worker Task after which the Fixer takes the next fix. Integer 1..100. */
  readonly after_review_rejections: number;
}

export const DEFAULT_FIXER_ESCALATION_SETTINGS: FixerEscalationSettings = { after_review_rejections: 2 };

export class FixerEscalationSettingsValidationError extends SettingsValidationError {
  public override name = "FixerEscalationSettingsValidationError";
}

function checkRejections(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < FIXER_ESCALATION_MIN || value > FIXER_ESCALATION_MAX) {
    throw new FixerEscalationSettingsValidationError(`after_review_rejections must be an integer from ${FIXER_ESCALATION_MIN} to ${FIXER_ESCALATION_MAX}.`, "after_review_rejections", { kind: "integer_range", min: FIXER_ESCALATION_MIN, max: FIXER_ESCALATION_MAX });
  }
  return value;
}

/** For PUT: exactly the one key, with a valid value. Throws FixerEscalationSettingsValidationError. */
export const validateFixerEscalationSettings = exactKeysValidator<FixerEscalationSettings>({
  keys: KEYS,
  check: (_key, value) => checkRejections(value),
  error: FixerEscalationSettingsValidationError,
});

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
