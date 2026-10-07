import {
  DEFAULT_PLAN_QUALITY_SETTINGS,
  PLAN_QUALITY_SETTINGS_KEY,
  readPlanQualitySettings,
  type PlanQualitySettings,
} from "../../shared/dist/plan-quality-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored plan quality settings; missing or invalid values fall back to the defaults. A failed read never blocks planning. */
export function planQualitySettings(reader: SettingsReader): PlanQualitySettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", PLAN_QUALITY_SETTINGS_KEY);
    if (!row) return DEFAULT_PLAN_QUALITY_SETTINGS;
    return readPlanQualitySettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read plan quality settings; using defaults.", error);
    return DEFAULT_PLAN_QUALITY_SETTINGS;
  }
}
