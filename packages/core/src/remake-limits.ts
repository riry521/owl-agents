import {
  DEFAULT_REMAKE_LIMIT_SETTINGS,
  REMAKE_LIMIT_SETTINGS_KEY,
  readRemakeLimitSettings,
  type RemakeLimitSettings,
} from "../../shared/dist/remake-limit-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored remake limits; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function remakeLimits(reader: SettingsReader): RemakeLimitSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", REMAKE_LIMIT_SETTINGS_KEY);
    if (!row) return DEFAULT_REMAKE_LIMIT_SETTINGS;
    return readRemakeLimitSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] remake_limits: ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read remake_limits; using defaults", error);
    return DEFAULT_REMAKE_LIMIT_SETTINGS;
  }
}
