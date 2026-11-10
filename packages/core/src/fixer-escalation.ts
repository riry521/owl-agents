import {
  DEFAULT_FIXER_ESCALATION_SETTINGS,
  FIXER_ESCALATION_SETTINGS_KEY,
  readFixerEscalationSettings,
  validateFixerEscalationSettings,
  type FixerEscalationSettings,
} from "../../shared/dist/fixer-escalation-settings.js";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingSpec } from "./settings-store";

export const FIXER_ESCALATION_SETTING: SettingSpec<FixerEscalationSettings> = {
  key: FIXER_ESCALATION_SETTINGS_KEY,
  defaults: DEFAULT_FIXER_ESCALATION_SETTINGS,
  read: readFixerEscalationSettings,
  warnPrefix: "fixer_escalation: ",
  readFailure: "Could not read fixer_escalation; using defaults",
  validate: validateFixerEscalationSettings,
  event: { type: "settings.fixer_escalation_updated", idempotencyPrefix: "settings-fixer-escalation" },
};

/** The stored Fixer escalation setting; missing or invalid values fall back to the default. A failed read never blocks a transition. */
export function fixerEscalation(reader: SettingsReader): FixerEscalationSettings {
  return readSetting(reader, FIXER_ESCALATION_SETTING);
}
