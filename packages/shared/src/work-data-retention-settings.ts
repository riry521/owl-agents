import { keyedReader, SettingsValidationError } from "./settings-validation.js";

export const WORK_DATA_RETENTION_SETTINGS_KEY = "work_data_retention";

export interface WorkDataRetentionSettings {
  /** Clears rows nothing reads any more when a Work completes or is cancelled, and for finished Works at startup. */
  readonly enabled: boolean;
}

export const DEFAULT_WORK_DATA_RETENTION_SETTINGS: WorkDataRetentionSettings = { enabled: true };

export class WorkDataRetentionSettingsValidationError extends SettingsValidationError {
  public override name = "WorkDataRetentionSettingsValidationError";
}

const KEYS = Object.keys(DEFAULT_WORK_DATA_RETENTION_SETTINGS) as (keyof WorkDataRetentionSettings)[];

/** For reads: per-key fallback to the default, calling warn for each fallback. */
export const readWorkDataRetentionSettings = keyedReader<WorkDataRetentionSettings>({
  keys: KEYS,
  defaults: DEFAULT_WORK_DATA_RETENTION_SETTINGS,
  check: (key, value) => {
    if (typeof value !== "boolean") throw new WorkDataRetentionSettingsValidationError(`${key} must be true or false.`, key, { kind: "boolean" });
    return value;
  },
  notObject: "Stored work data retention settings are not an object; using defaults.",
  invalid: (key) => `Invalid work data retention setting ${key}; using default.`,
});
