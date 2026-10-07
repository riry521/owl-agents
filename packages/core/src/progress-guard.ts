import {
  DEFAULT_PROGRESS_GUARD_SETTINGS,
  PROGRESS_GUARD_SETTINGS_KEY,
  readProgressGuardSettings,
  type ProgressGuardSettings,
} from "../../shared/dist/progress-guard-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored progress guard settings; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function progressGuard(reader: SettingsReader): ProgressGuardSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", PROGRESS_GUARD_SETTINGS_KEY);
    if (!row) return DEFAULT_PROGRESS_GUARD_SETTINGS;
    return readProgressGuardSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] progress_guard: ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read progress_guard; using defaults", error);
    return DEFAULT_PROGRESS_GUARD_SETTINGS;
  }
}
