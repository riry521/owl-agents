import {
  DEFAULT_DEPENDENCY_SUMMARY_SETTINGS,
  DEPENDENCY_SUMMARY_SETTINGS_KEY,
  readDependencySummarySettings,
  type DependencySummarySettings,
} from "../../shared/dist/dependency-summary-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored dependency summary length; a missing or invalid value gives the default. A failed read never blocks a Task. */
export function dependencySummarySettings(reader: SettingsReader): DependencySummarySettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", DEPENDENCY_SUMMARY_SETTINGS_KEY);
    if (!row) return DEFAULT_DEPENDENCY_SUMMARY_SETTINGS;
    return readDependencySummarySettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read the dependency summary setting; using the default.", error);
    return DEFAULT_DEPENDENCY_SUMMARY_SETTINGS;
  }
}
