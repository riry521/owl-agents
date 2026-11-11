import {
  DEFAULT_PROGRESS_GUARD_SETTINGS,
  PROGRESS_GUARD_SETTINGS_KEY,
  readProgressGuardSettings,
  validateProgressGuardSettings,
  type ProgressGuardSettings,
} from "@owl/shared/progress-guard-settings";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingSpec } from "./settings-store";

export const PROGRESS_GUARD_SETTING: SettingSpec<ProgressGuardSettings> = {
  key: PROGRESS_GUARD_SETTINGS_KEY,
  defaults: DEFAULT_PROGRESS_GUARD_SETTINGS,
  read: readProgressGuardSettings,
  warnPrefix: "progress_guard: ",
  readFailure: "Could not read progress_guard; using defaults",
  validate: validateProgressGuardSettings,
  event: { type: "settings.progress_guard_updated", idempotencyPrefix: "settings-progress-guard" },
};

/** The stored progress guard settings; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function progressGuard(reader: SettingsReader): ProgressGuardSettings {
  return readSetting(reader, PROGRESS_GUARD_SETTING);
}
