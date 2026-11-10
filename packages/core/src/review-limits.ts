import {
  DEFAULT_REVIEW_LIMIT_SETTINGS,
  REVIEW_LIMIT_SETTINGS_KEY,
  readReviewLimitSettings,
  validateReviewLimitSettings,
  type ReviewLimitSettings,
} from "../../shared/dist/review-limit-settings.js";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingSpec } from "./settings-store";

export const REVIEW_LIMIT_SETTING: SettingSpec<ReviewLimitSettings> = {
  key: REVIEW_LIMIT_SETTINGS_KEY,
  defaults: DEFAULT_REVIEW_LIMIT_SETTINGS,
  read: readReviewLimitSettings,
  readFailure: "Could not read review limits; using defaults.",
  validate: validateReviewLimitSettings,
  event: { type: "settings.review_limits_updated", idempotencyPrefix: "settings-review-limits" },
};

/** The stored review limits; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function reviewLimits(reader: SettingsReader): ReviewLimitSettings {
  return readSetting(reader, REVIEW_LIMIT_SETTING);
}
