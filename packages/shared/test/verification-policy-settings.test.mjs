import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VERIFICATION_POLICY_SETTINGS, readVerificationPolicySettings } from "../dist/verification-policy-settings.js";

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
