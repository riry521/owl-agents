import {
  ADVISOR_WINDOW_SETTINGS_KEY,
  DEFAULT_ADVISOR_WINDOW_SETTINGS,
  readAdvisorWindowSettings,
  validateAdvisorWindowSettings,
  type AdvisorWindowSettings,
} from "@owl/shared/advisor-window-settings";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingSpec } from "./settings-store";

export const ADVISOR_WINDOW_SETTING: SettingSpec<AdvisorWindowSettings> = {
  key: ADVISOR_WINDOW_SETTINGS_KEY,
  defaults: DEFAULT_ADVISOR_WINDOW_SETTINGS,
  read: readAdvisorWindowSettings,
  readFailure: "Could not read the Advisor window settings; using the defaults.",
  validate: validateAdvisorWindowSettings,
  event: { type: "settings.advisor_windows_updated", idempotencyPrefix: "settings-advisor-windows" },
};

/** The stored Advisor window settings; a missing or invalid value gives the defaults. A failed read never blocks the Advisor. */
export function advisorWindowSettings(reader: SettingsReader): AdvisorWindowSettings {
  return readSetting(reader, ADVISOR_WINDOW_SETTING);
}
