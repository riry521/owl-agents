import type { SettingsReader } from "./owner-language";
import { storedSettingJson } from "./settings-store";

export const FINAL_AUTO_CONTINUE_LIMIT_KEY = "final_auto_continue_limit";
export const DEFAULT_FINAL_AUTO_CONTINUES = 2;

/** Automatic continuations per Work after an incomplete final check with fixes; a missing or invalid value (integer 0..100) falls back to the default. */
export function finalAutoContinueLimit(reader: SettingsReader): number {
  try {
    const json = storedSettingJson(reader, FINAL_AUTO_CONTINUE_LIMIT_KEY);
    if (json === undefined) return DEFAULT_FINAL_AUTO_CONTINUES;
    const value = JSON.parse(json) as unknown;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_FINAL_AUTO_CONTINUES;
  } catch {
    return DEFAULT_FINAL_AUTO_CONTINUES;
  }
}
