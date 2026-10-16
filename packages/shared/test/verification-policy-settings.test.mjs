import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VERIFICATION_POLICY_SETTINGS,
  readVerificationPolicySettings,
  validateVerificationPolicyPatch,
  VerificationPolicySettingsValidationError,
} from "../dist/verification-policy-settings.js";

test("a heading_pattern without capture group 1 falls back to the default with a warning", () => {
  const warnings = [];
  const settings = readVerificationPolicySettings({ doc: { heading_pattern: "^#+ .*$" } }, (message) => warnings.push(message));
  assert.equal(settings.doc.heading_pattern, DEFAULT_VERIFICATION_POLICY_SETTINGS.doc.heading_pattern);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /heading_pattern/u);
});

test("a heading_pattern that does not compile falls back to the default with a warning", () => {
  const warnings = [];
  const settings = readVerificationPolicySettings({ doc: { heading_pattern: "^(#+" } }, (message) => warnings.push(message));
  assert.equal(settings.doc.heading_pattern, DEFAULT_VERIFICATION_POLICY_SETTINGS.doc.heading_pattern);
  assert.equal(warnings.length, 1);
});

test("a heading_pattern with capture group 1 is kept, even when it cannot match an empty line", () => {
  const warnings = [];
  for (const pattern of ["^Title: (.*)$", "^(?:==)\\s+(\\S.*)$", "^(a)|(b)$"]) {
    const settings = readVerificationPolicySettings({ doc: { heading_pattern: pattern } }, (message) => warnings.push(message));
    assert.equal(settings.doc.heading_pattern, pattern);
  }
  assert.deepEqual(warnings, []);
});

test("the default heading_pattern has capture group 1", () => {
  const warnings = [];
  readVerificationPolicySettings({ doc: { heading_pattern: DEFAULT_VERIFICATION_POLICY_SETTINGS.doc.heading_pattern } }, (message) => warnings.push(message));
  assert.deepEqual(warnings, []);
});

test("verification policy patches validate known partial settings and copy the input", () => {
  const patch = { config: { skip_patterns: [], checkers: [{ pattern: "**/*.toml", argv: ["taplo", "check", "{file}"] }] } };
  const result = validateVerificationPolicyPatch(patch);
  assert.deepEqual(result, patch);
  assert.notEqual(result.config, patch.config);
  assert.notEqual(result.config.checkers, patch.config.checkers);
  patch.config.skip_patterns.push("changed");
  assert.deepEqual(result.config.skip_patterns, []);
  assert.deepEqual(validateVerificationPolicyPatch({ limits: { timeout_seconds: 30 } }), { limits: { timeout_seconds: 30 } });
});

test("verification policy patches reject empty, unknown, and non-object structures", () => {
  for (const patch of [
    {},
    { doc: {} },
    { unknown: { value: true } },
    { doc: { unknown: true } },
    null,
    [],
    "config",
    1,
    Object.create({ config: { skip_patterns: [] } }),
  ]) {
    assert.throws(() => validateVerificationPolicyPatch(patch), VerificationPolicySettingsValidationError);
  }
});

test("verification policy patches reject invalid values and unknown command keys", () => {
  const invalidPatches = [
    { config: null },
    { config: [] },
    { config: "invalid" },
    { config: { checkers: [{ pattern: "*.toml", argv: ["node\0"] }] } },
    { config: { checkers: [{ pattern: "*.toml", argv: ["node"], extra: true }] } },
    { limits: { timeout_seconds: "30" } },
    { limits: { max_read_bytes: Number.MAX_SAFE_INTEGER + 1 } },
    { doc: { heading_pattern: "^#+ .*$" } },
    { doc: { file_patterns: [""] } },
    { code: { run_test_runners: "false" } },
    { limits: { env_allowlist: ["BAD\0NAME"] } },
    { config: { skip_patterns: ["bad\0pattern"] }, doc: { section_match: "invalid" } },
  ];
  for (const patch of invalidPatches) {
    assert.throws(() => validateVerificationPolicyPatch(patch), VerificationPolicySettingsValidationError);
  }
});

test("verification policy patches reject sparse string, command, and argv arrays with validation errors", () => {
  const sparseFilePatterns = Array(1);
  const sparseRunners = Array(1);
  const sparseArgv = ["node", , "--check"];
  const missingFirstArgv = Array(1);
  for (const patch of [
    { doc: { file_patterns: sparseFilePatterns } },
    { test: { runners: sparseRunners } },
    { test: { runners: [{ pattern: "*.js", argv: sparseArgv }] } },
    { test: { runners: [{ pattern: "*.js", argv: missingFirstArgv }] } },
  ]) {
    assert.throws(() => validateVerificationPolicyPatch(patch), VerificationPolicySettingsValidationError);
  }
});

test("invalid stored values still recover on read but are rejected in patches", () => {
  const stored = { limits: { timeout_seconds: "30" } };
  const recovered = readVerificationPolicySettings(stored);
  assert.equal(recovered.limits.timeout_seconds, DEFAULT_VERIFICATION_POLICY_SETTINGS.limits.timeout_seconds);
  assert.throws(() => validateVerificationPolicyPatch(stored), VerificationPolicySettingsValidationError);
});
