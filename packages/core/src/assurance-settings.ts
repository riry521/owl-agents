import {
  DEFAULT_REVIEW_ROUTING_SETTINGS,
  REVIEW_ROUTING_SETTINGS_KEY,
  readReviewRoutingSettings,
  type ReviewRoutingSettings,
} from "../../shared/dist/review-routing-settings.js";
import {
  DEFAULT_WORK_VERIFICATION_SETTINGS,
  WORK_VERIFICATION_SETTINGS_KEY,
  readWorkVerificationSettings,
  type WorkVerificationSettings,
} from "../../shared/dist/work-verification-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored Work verification settings; missing or invalid values fall back to the defaults. */
export function workVerification(reader: SettingsReader): WorkVerificationSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", WORK_VERIFICATION_SETTINGS_KEY);
    if (!row) return DEFAULT_WORK_VERIFICATION_SETTINGS;
    return readWorkVerificationSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read work verification settings; using defaults.", error);
    return DEFAULT_WORK_VERIFICATION_SETTINGS;
  }
}

/** The stored review routing settings; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function reviewRouting(reader: SettingsReader): ReviewRoutingSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", REVIEW_ROUTING_SETTINGS_KEY);
    if (!row) return DEFAULT_REVIEW_ROUTING_SETTINGS;
    return readReviewRoutingSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read review routing settings; using defaults.", error);
    return DEFAULT_REVIEW_ROUTING_SETTINGS;
  }
}
