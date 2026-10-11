import {
  DEFAULT_FIXER_ESCALATION_SETTINGS,
  FIXER_ESCALATION_SETTINGS_KEY,
  readFixerEscalationSettings,
  type FixerEscalationSettings,
} from "../../shared/dist/fixer-escalation-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored Fixer escalation setting; missing or invalid values fall back to the default. A failed read never blocks a transition. */
export function fixerEscalation(reader: SettingsReader): FixerEscalationSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", FIXER_ESCALATION_SETTINGS_KEY);
    if (!row) return DEFAULT_FIXER_ESCALATION_SETTINGS;
    return readFixerEscalationSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] fixer_escalation: ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read fixer_escalation; using defaults", error);
    return DEFAULT_FIXER_ESCALATION_SETTINGS;
  }
}
