import {
  DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS,
  PROJECT_INVESTIGATION_OUTPUT_SETTINGS_KEY,
  readProjectInvestigationOutputSettings,
  type ProjectInvestigationOutputSettings,
} from "../../shared/dist/project-investigation-settings.js";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingReadSpec } from "./settings-store";

export const PROJECT_INVESTIGATION_SETTING: SettingReadSpec<ProjectInvestigationOutputSettings> = {
  key: PROJECT_INVESTIGATION_OUTPUT_SETTINGS_KEY,
  defaults: DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS,
  read: readProjectInvestigationOutputSettings,
  readFailure: "Could not read project investigation output settings; using defaults.",
};

/** The stored output limits for Project investigations; missing or invalid values fall back to the defaults. A failed read never blocks an investigation. */
export function projectInvestigationOutputSettings(reader: SettingsReader): ProjectInvestigationOutputSettings {
  return readSetting(reader, PROJECT_INVESTIGATION_SETTING);
}
