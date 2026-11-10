import { isRecord } from "./settings-validation.js";

export const WORK_VERIFICATION_SETTINGS_KEY = "work_verification";

export interface WorkVerificationSettings {
  /** Run the Project's verification plan on the Work branch before the Final Manager. */
  readonly enabled: boolean;
}

export const DEFAULT_WORK_VERIFICATION_SETTINGS: WorkVerificationSettings = { enabled: true };

/** For reads: invalid or missing values fall back to the defaults, per key, and call warn. */
export function readWorkVerificationSettings(value: unknown, warn?: (message: string) => void): WorkVerificationSettings {
  const settings = isRecord(value) ? value : {};
  let enabled = settings.enabled;
  if (typeof enabled !== "boolean") {
    warn?.("Invalid work verification enabled; using default.");
    enabled = DEFAULT_WORK_VERIFICATION_SETTINGS.enabled;
  }
  return { enabled: enabled as boolean };
}
