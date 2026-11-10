import {
  DEFAULT_TEST_SETUP_SETTINGS,
  TEST_SETUP_SETTINGS_KEY,
  readTestSetupSettings,
  type TestSetupSettings,
} from "../../shared/dist/test-setup-settings.js";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingReadSpec } from "./settings-store";

export const TEST_SETUP_SETTING: SettingReadSpec<TestSetupSettings> = {
  key: TEST_SETUP_SETTINGS_KEY,
  defaults: DEFAULT_TEST_SETUP_SETTINGS,
  read: readTestSetupSettings,
  readFailure: "Could not read the test setup settings; using defaults.",
};

/** The stored test setup settings; missing or invalid values fall back to the defaults. A failed read never blocks a test run. */
export function testSetupSettings(reader: SettingsReader): TestSetupSettings {
  return readSetting(reader, TEST_SETUP_SETTING);
}
