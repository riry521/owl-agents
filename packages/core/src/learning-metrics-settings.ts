import {
  DEFAULT_LEARNING_METRICS_SETTINGS,
  LEARNING_METRICS_SETTINGS_KEY,
  readLearningMetricsSettings,
  type LearningMetricsSettings,
} from "@owl/shared/learning-metrics-settings";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingReadSpec } from "./settings-store";

export const LEARNING_METRICS_SETTING: SettingReadSpec<LearningMetricsSettings> = {
  key: LEARNING_METRICS_SETTINGS_KEY,
  defaults: DEFAULT_LEARNING_METRICS_SETTINGS,
  read: readLearningMetricsSettings,
  warnPrefix: "learning_metrics: ",
  readFailure: "Could not read learning_metrics; using defaults",
};

/** The stored learning metrics settings; missing or invalid values fall back to the defaults. A failed read never blocks Work completion. */
export function learningMetrics(reader: SettingsReader): LearningMetricsSettings {
  return readSetting(reader, LEARNING_METRICS_SETTING);
}
