export const LEARNING_METRICS_SETTINGS_KEY = "learning_metrics";

export interface LearningMetricsSettings {
  /** Turns the rule proposals made from Runtime metrics off. */
  readonly enabled: boolean;
  /** Reviewed Tasks of one type needed before its first review pass rate can make a proposal. */
  readonly min_tasks: number;
  /** A Task type whose first review pass rate is below this (0 to 1) makes a proposal. */
  readonly first_review_pass_rate_below: number;
  /** How many Task and Work IDs a proposal's rationale lists before it only states the total. */
  readonly rationale_max_ids: number;
}

export const DEFAULT_LEARNING_METRICS_SETTINGS: LearningMetricsSettings = {
  enabled: true,
  min_tasks: 10,
  first_review_pass_rate_below: 0.3,
  rationale_max_ids: 20,
};

export const LEARNING_METRICS_RANGES = {
  min_tasks: { min: 1, max: 10000 },
  first_review_pass_rate_below: { min: 0, max: 1 },
  rationale_max_ids: { min: 1, max: 1000 },
} as const;

export class LearningMetricsSettingsValidationError extends Error {
  public constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "LearningMetricsSettingsValidationError";
  }
}

const KEYS = Object.keys(DEFAULT_LEARNING_METRICS_SETTINGS) as (keyof LearningMetricsSettings)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkValue(key: keyof LearningMetricsSettings, value: unknown): number | boolean {
  if (key === "enabled") {
    if (typeof value !== "boolean") throw new LearningMetricsSettingsValidationError(`${key} must be true or false.`, key);
    return value;
  }
  const { min, max } = LEARNING_METRICS_RANGES[key];
  const integerOnly = key === "min_tasks" || key === "rationale_max_ids";
  if (typeof value !== "number" || !Number.isFinite(value) || (integerOnly && !Number.isInteger(value)) || value < min || value > max) {
    throw new LearningMetricsSettingsValidationError(`${key} must be ${integerOnly ? "an integer" : "a number"} from ${min} to ${max}.`, key);
  }
  return value;
}

/** For PUT: exactly the known keys, every value valid. Throws LearningMetricsSettingsValidationError. */
export function validateLearningMetricsSettings(value: unknown): LearningMetricsSettings {
  if (!isRecord(value)) throw new LearningMetricsSettingsValidationError("Settings must be an object.", "payload");
  const own = Reflect.ownKeys(value);
  if (own.length !== KEYS.length || !KEYS.every((key) => own.includes(key))) {
    throw new LearningMetricsSettingsValidationError(`Settings must contain exactly ${KEYS.join(", ")}.`, "payload");
  }
  return Object.fromEntries(KEYS.map((key) => [key, checkValue(key, value[key])])) as unknown as LearningMetricsSettings;
}

/** For reads: per-key fallback to the default, calling warn for each fallback. */
export function readLearningMetricsSettings(value: unknown, warn?: (message: string) => void): LearningMetricsSettings {
  if (!isRecord(value)) {
    warn?.("Stored learning metrics settings are not an object; using defaults.");
    return DEFAULT_LEARNING_METRICS_SETTINGS;
  }
  const entries = KEYS.map((key) => {
    try {
      if (!Object.hasOwn(value, key)) return [key, DEFAULT_LEARNING_METRICS_SETTINGS[key]];
      return [key, checkValue(key, value[key])];
    } catch {
      warn?.(`Invalid learning metrics setting ${key}; using default.`);
      return [key, DEFAULT_LEARNING_METRICS_SETTINGS[key]];
    }
  });
  return Object.fromEntries(entries) as unknown as LearningMetricsSettings;
}
