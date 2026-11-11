import {
  DEFAULT_PLAN_QUALITY_SETTINGS,
  PLAN_QUALITY_SETTINGS_KEY,
  readPlanQualitySettings,
  validatePlanQualitySettings,
  type PlanQualitySettings,
} from "@owl/shared/plan-quality-settings";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingSpec } from "./settings-store";

export const PLAN_QUALITY_SETTING: SettingSpec<PlanQualitySettings> = {
  key: PLAN_QUALITY_SETTINGS_KEY,
  defaults: DEFAULT_PLAN_QUALITY_SETTINGS,
  read: readPlanQualitySettings,
  readFailure: "Could not read plan quality settings; using defaults.",
  validate: validatePlanQualitySettings,
  event: { type: "settings.plan_quality_updated", idempotencyPrefix: "settings-plan-quality" },
};

/** The stored plan quality settings; missing or invalid values fall back to the defaults. A failed read never blocks planning. */
export function planQualitySettings(reader: SettingsReader): PlanQualitySettings {
  return readSetting(reader, PLAN_QUALITY_SETTING);
}
