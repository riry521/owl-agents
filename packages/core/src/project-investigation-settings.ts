import {
  DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS,
  PROJECT_INVESTIGATION_OUTPUT_SETTINGS_KEY,
  readProjectInvestigationOutputSettings,
  type ProjectInvestigationOutputSettings,
} from "../../shared/dist/project-investigation-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored output limits for Project investigations; missing or invalid values fall back to the defaults. A failed read never blocks an investigation. */
export function projectInvestigationOutputSettings(reader: SettingsReader): ProjectInvestigationOutputSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", PROJECT_INVESTIGATION_OUTPUT_SETTINGS_KEY);
    if (!row) return DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS;
    return readProjectInvestigationOutputSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read project investigation output settings; using defaults.", error);
    return DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS;
  }
}
