import {
  ADVISOR_WINDOW_SETTINGS_KEY,
  DEFAULT_ADVISOR_WINDOW_SETTINGS,
  readAdvisorWindowSettings,
  type AdvisorWindowSettings,
} from "../../shared/dist/advisor-window-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored Advisor window settings; a missing or invalid value gives the defaults. A failed read never blocks the Advisor. */
export function advisorWindowSettings(reader: SettingsReader): AdvisorWindowSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", ADVISOR_WINDOW_SETTINGS_KEY);
    if (!row) return DEFAULT_ADVISOR_WINDOW_SETTINGS;
    return readAdvisorWindowSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read the Advisor window settings; using the defaults.", error);
    return DEFAULT_ADVISOR_WINDOW_SETTINGS;
  }
}
