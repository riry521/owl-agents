export const WORK_VERIFICATION_SETTINGS_KEY = "work_verification";

export interface WorkVerificationSettings {
  /** Run the Project's verification plan on the Work branch before the Final Manager. */
  readonly enabled: boolean;
  /** Manager replans one failing Work branch may get before the Owner is asked. */
  readonly max_manager_repairs: number;
}

export const DEFAULT_WORK_VERIFICATION_SETTINGS: WorkVerificationSettings = { enabled: true, max_manager_repairs: 2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** For reads: invalid or missing values fall back to the defaults, per key, and call warn. */
export function readWorkVerificationSettings(value: unknown, warn?: (message: string) => void): WorkVerificationSettings {
  const settings = isRecord(value) ? value : {};
  let enabled = settings.enabled;
  if (typeof enabled !== "boolean") {
    warn?.("Invalid work verification enabled; using default.");
    enabled = DEFAULT_WORK_VERIFICATION_SETTINGS.enabled;
  }
  let repairs = settings.max_manager_repairs;
  if (typeof repairs !== "number" || !Number.isInteger(repairs) || repairs < 0 || repairs > 10) {
    warn?.("Invalid work verification max_manager_repairs; using default.");
    repairs = DEFAULT_WORK_VERIFICATION_SETTINGS.max_manager_repairs;
  }
  return { enabled: enabled as boolean, max_manager_repairs: repairs as number };
}
