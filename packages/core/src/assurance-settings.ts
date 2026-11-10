import {
  DEFAULT_REVIEW_ROUTING_SETTINGS,
  REVIEW_ROUTING_SETTINGS_KEY,
  readReviewRoutingSettings,
  validateReviewRoutingSettings,
  type ReviewRoutingSettings,
} from "../../shared/dist/review-routing-settings.js";
import {
  DEFAULT_WORK_VERIFICATION_SETTINGS,
  WORK_VERIFICATION_SETTINGS_KEY,
  readWorkVerificationSettings,
  type WorkVerificationSettings,
} from "../../shared/dist/work-verification-settings.js";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingReadSpec, type SettingSpec } from "./settings-store";

export const WORK_VERIFICATION_SETTING: SettingReadSpec<WorkVerificationSettings> = {
  key: WORK_VERIFICATION_SETTINGS_KEY,
  defaults: DEFAULT_WORK_VERIFICATION_SETTINGS,
  read: readWorkVerificationSettings,
  readFailure: "Could not read work verification settings; using defaults.",
};

export const REVIEW_ROUTING_SETTING: SettingSpec<ReviewRoutingSettings> = {
  key: REVIEW_ROUTING_SETTINGS_KEY,
  defaults: DEFAULT_REVIEW_ROUTING_SETTINGS,
  read: readReviewRoutingSettings,
  readFailure: "Could not read review routing settings; using defaults.",
  validate: validateReviewRoutingSettings,
  event: { type: "settings.review_routing_updated", idempotencyPrefix: "settings-review-routing" },
};

/** The stored Work verification settings; missing or invalid values fall back to the defaults. */
export function workVerification(reader: SettingsReader): WorkVerificationSettings {
  return readSetting(reader, WORK_VERIFICATION_SETTING);
}

/** The stored review routing settings; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function reviewRouting(reader: SettingsReader): ReviewRoutingSettings {
  return readSetting(reader, REVIEW_ROUTING_SETTING);
}
