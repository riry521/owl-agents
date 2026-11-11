import {
  DEFAULT_DEPENDENCY_SUMMARY_SETTINGS,
  DEPENDENCY_SUMMARY_SETTINGS_KEY,
  readDependencySummarySettings,
  validateDependencySummarySettings,
  type DependencySummarySettings,
} from "@owl/shared/dependency-summary-settings";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingSpec } from "./settings-store";

export const DEPENDENCY_SUMMARY_SETTING: SettingSpec<DependencySummarySettings> = {
  key: DEPENDENCY_SUMMARY_SETTINGS_KEY,
  defaults: DEFAULT_DEPENDENCY_SUMMARY_SETTINGS,
  read: readDependencySummarySettings,
  readFailure: "Could not read the dependency summary setting; using the default.",
  validate: validateDependencySummarySettings,
  event: { type: "settings.dependency_summary_updated", idempotencyPrefix: "settings-dependency-summary" },
};

/** The stored dependency summary length; a missing or invalid value gives the default. A failed read never blocks a Task. */
export function dependencySummarySettings(reader: SettingsReader): DependencySummarySettings {
  return readSetting(reader, DEPENDENCY_SUMMARY_SETTING);
}
