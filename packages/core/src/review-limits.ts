import {
  DEFAULT_REVIEW_LIMIT_SETTINGS,
  REVIEW_LIMIT_SETTINGS_KEY,
  readReviewLimitSettings,
  type ReviewLimitSettings,
} from "../../shared/dist/review-limit-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored review limits; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function reviewLimits(reader: SettingsReader): ReviewLimitSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", REVIEW_LIMIT_SETTINGS_KEY);
    if (!row) return DEFAULT_REVIEW_LIMIT_SETTINGS;
    return readReviewLimitSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read review limits; using defaults.", error);
    return DEFAULT_REVIEW_LIMIT_SETTINGS;
  }
}
