import assert from "node:assert/strict";
import { test } from "node:test";

import { testSetupSettings } from "../../packages/core/dist/test-setup-settings.js";
import { DEFAULT_TEST_SETUP_SETTINGS, TEST_SETUP_ROLES, readTestSetupSettings } from "../../packages/shared/dist/test-setup-settings.js";

const withWarnings = (value) => {
  const warnings = [];
  const settings = readTestSetupSettings(value, (message) => warnings.push(message));
  return { settings, warnings };
};

test("test setup settings: nothing stored gives the defaults without a warning", () => {
  const { settings, warnings } = withWarnings(undefined);
  assert.deepEqual(settings, DEFAULT_TEST_SETUP_SETTINGS);
  assert.deepEqual(warnings, []);
  assert.equal(settings.default_executables.python, DEFAULT_TEST_SETUP_SETTINGS.default_executables.python);
});

test("test setup settings: the role is worker or manager only", () => {
  assert.deepEqual([...TEST_SETUP_ROLES], ["worker", "manager"]);
  for (const role of TEST_SETUP_ROLES) assert.equal(withWarnings({ role }).settings.role, role);
  for (const role of ["reviewer", "designer", "", 3, null]) {
    const { settings, warnings } = withWarnings({ role });
    assert.equal(settings.role, DEFAULT_TEST_SETUP_SETTINGS.role);
    assert.equal(warnings.length, 1);
  }
});

test("test setup settings: valid values are kept, regular expressions must compile, broken keys fall back one by one", () => {
  const stored = { timeout_seconds: 120, default_executables: { python: "/opt/python" }, import_patterns: ["^use\\s"], environment: { exit_codes: [2], patterns: ["["] } };
  const { settings, warnings } = withWarnings(stored);
  assert.equal(settings.timeout_seconds, 120);
  assert.deepEqual(settings.default_executables, { python: "/opt/python" });
  assert.deepEqual(settings.import_patterns, ["^use\\s"]);
  assert.deepEqual(settings.environment.exit_codes, [2]);
  assert.deepEqual(settings.environment.patterns, DEFAULT_TEST_SETUP_SETTINGS.environment.patterns);
  assert.equal(warnings.length, 1);

  const broken = withWarnings({ import_patterns: ["("], timeout_seconds: 5, max_reinvestigations: "x", install: { always_outside: "no" } });
  assert.deepEqual(broken.settings.import_patterns, DEFAULT_TEST_SETUP_SETTINGS.import_patterns);
  assert.equal(broken.settings.timeout_seconds, DEFAULT_TEST_SETUP_SETTINGS.timeout_seconds);
  assert.equal(broken.settings.max_reinvestigations, DEFAULT_TEST_SETUP_SETTINGS.max_reinvestigations);
  assert.deepEqual(broken.settings.install, DEFAULT_TEST_SETUP_SETTINGS.install);
  assert.equal(broken.warnings.length, 4);
  assert.deepEqual(withWarnings("nonsense").settings, DEFAULT_TEST_SETUP_SETTINGS);
});

test("test setup settings: Core reads the settings row and falls back on a missing or broken one", () => {
  const readerOf = (value_json) => ({ get: () => (value_json === undefined ? undefined : { value_json }) });
  assert.deepEqual(testSetupSettings(readerOf(undefined)), DEFAULT_TEST_SETUP_SETTINGS);
  assert.equal(testSetupSettings(readerOf(JSON.stringify({ role: "manager" }))).role, "manager");
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(testSetupSettings(readerOf("{broken")), DEFAULT_TEST_SETUP_SETTINGS);
    assert.deepEqual(testSetupSettings({ get: () => { throw new Error("db down"); } }), DEFAULT_TEST_SETUP_SETTINGS);
  } finally {
    console.warn = originalWarn;
  }
});
