import {
  DEFAULT_REMAKE_LIMIT_SETTINGS,
  REMAKE_LIMIT_SETTINGS_KEY,
  readRemakeLimitSettings,
  validateRemakeLimitSettings,
  type RemakeLimitSettings,
} from "../../shared/dist/remake-limit-settings.js";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingSpec } from "./settings-store";

export const REMAKE_LIMIT_SETTING: SettingSpec<RemakeLimitSettings> = {
  key: REMAKE_LIMIT_SETTINGS_KEY,
  defaults: DEFAULT_REMAKE_LIMIT_SETTINGS,
  read: readRemakeLimitSettings,
  warnPrefix: "remake_limits: ",
  readFailure: "Could not read remake_limits; using defaults",
  validate: validateRemakeLimitSettings,
  event: { type: "settings.remake_limits_updated", idempotencyPrefix: "settings-remake-limits" },
};

/** The stored remake limits; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function remakeLimits(reader: SettingsReader): RemakeLimitSettings {
  return readSetting(reader, REMAKE_LIMIT_SETTING);
}
