import {
  DEFAULT_LEARNING_METRICS_SETTINGS,
  LEARNING_METRICS_SETTINGS_KEY,
  readLearningMetricsSettings,
  type LearningMetricsSettings,
} from "../../shared/dist/learning-metrics-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored learning metrics settings; missing or invalid values fall back to the defaults. A failed read never blocks Work completion. */
export function learningMetrics(reader: SettingsReader): LearningMetricsSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", LEARNING_METRICS_SETTINGS_KEY);
    if (!row) return DEFAULT_LEARNING_METRICS_SETTINGS;
    return readLearningMetricsSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] learning_metrics: ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read learning_metrics; using defaults", error);
    return DEFAULT_LEARNING_METRICS_SETTINGS;
  }
}
