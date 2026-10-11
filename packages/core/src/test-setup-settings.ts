import {
  DEFAULT_TEST_SETUP_SETTINGS,
  TEST_SETUP_SETTINGS_KEY,
  readTestSetupSettings,
  type TestSetupSettings,
} from "../../shared/dist/test-setup-settings.js";
import type { SettingsReader } from "./owner-language";

/** The stored test setup settings; missing or invalid values fall back to the defaults. A failed read never blocks a test run. */
export function testSetupSettings(reader: SettingsReader): TestSetupSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", TEST_SETUP_SETTINGS_KEY);
    if (!row) return DEFAULT_TEST_SETUP_SETTINGS;
    return readTestSetupSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read the test setup settings; using defaults.", error);
    return DEFAULT_TEST_SETUP_SETTINGS;
  }
}
