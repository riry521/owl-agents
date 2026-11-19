import assert from "node:assert/strict";
import test from "node:test";
import { exactKeysValidator, isRecord, keyedReader, SettingsValidationError } from "../dist/settings-validation.js";

class SampleError extends SettingsValidationError {
  name = "SampleError";
}

test("isRecord accepts only plain objects", () => {
  assert.equal(isRecord({}), true);
  for (const value of [null, [], "text", 1, undefined]) assert.equal(isRecord(value), false);
});

test("a SettingsValidationError subclass keeps name, message and field", () => {
  const error = new SampleError("bad", "payload");
  assert.equal(error.name, "SampleError");
  assert.equal(error.message, "bad");
  assert.equal(error.field, "payload");
  assert.ok(error instanceof SampleError && error instanceof SettingsValidationError && error instanceof Error);
  assert.deepEqual(Object.keys(error), ["field", "name"]);
});

const check = (key, value) => {
  if (typeof value !== "number") throw new SampleError(`${key} must be a number.`, key);
  return value;
};

test("exactKeysValidator checks type, key set, then each value in key order", () => {
  const validate = exactKeysValidator({ keys: ["a", "b"], check, error: SampleError });
  assert.throws(() => validate(null), { name: "SampleError", message: "Settings must be an object.", field: "payload" });
  assert.throws(() => validate({ a: 1 }), { message: "Settings must contain exactly a, b.", field: "payload" });
  assert.throws(() => validate({ a: 1, b: 2, c: 3 }), { message: "Settings must contain exactly a, b." });
  assert.throws(() => validate({ a: "x", b: "y" }), { message: "a must be a number.", field: "a" });
  const result = validate({ b: 2, a: 1 });
  assert.deepEqual(Object.keys(result), ["a", "b"]);
  assert.deepEqual(result, { a: 1, b: 2 });
});

test("exactKeysValidator uses exactKeysMessage when given", () => {
  const validate = exactKeysValidator({ keys: ["a"], check, error: SampleError, exactKeysMessage: "custom" });
  assert.throws(() => validate({}), { message: "custom", field: "payload" });
});

const defaults = { a: 1, b: 2 };
const reader = (extra = {}) => keyedReader({
  keys: ["a", "b"], defaults, check,
  notObject: "not object", invalid: (key) => `invalid ${key}`, ...extra,
});

test("keyedReader returns the defaults object itself when the value is not an object", () => {
  const warnings = [];
  assert.equal(reader()("x", (message) => warnings.push(message)), defaults);
  assert.deepEqual(warnings, ["not object"]);
});

test("keyedReader falls back per key and always returns a new object for an object", () => {
  const warnings = [];
  const missing = reader()({}, (message) => warnings.push(message));
  assert.deepEqual(warnings, []);
  assert.notEqual(missing, defaults);
  assert.deepEqual(missing, defaults);
  const bad = reader()({ a: 5, b: "x" }, (message) => warnings.push(message));
  assert.deepEqual(bad, { a: 5, b: 2 });
  assert.deepEqual(warnings, ["invalid b"]);
});

test("keyedReader warns about unknown keys before invalid values", () => {
  const warnings = [];
  reader({ unknown: (key) => `unknown ${key}` })({ b: "x", z: 1 }, (message) => warnings.push(message));
  assert.deepEqual(warnings, ["unknown z", "invalid b"]);
  const silent = [];
  reader()({ z: 1 }, (message) => silent.push(message));
  assert.deepEqual(silent, []);
});

test("reviewer_fix accepts only two integers in range and falls back to the defaults on unreadable values", async () => {
  const { validateReviewerFixSettings, readReviewerFixSettings, DEFAULT_REVIEWER_FIX_SETTINGS, ReviewerFixSettingsValidationError } = await import("../dist/reviewer-fix-settings.js");
  assert.deepEqual(DEFAULT_REVIEWER_FIX_SETTINGS, { max_changed_lines: 30, max_changed_files: 3 });
  assert.deepEqual(validateReviewerFixSettings({ max_changed_lines: 0, max_changed_files: 100 }), { max_changed_lines: 0, max_changed_files: 100 });
  const bad = [
    [{ max_changed_lines: 1001, max_changed_files: 3 }, "max_changed_lines", 1000],
    [{ max_changed_lines: -1, max_changed_files: 3 }, "max_changed_lines", 1000],
    [{ max_changed_lines: 1.5, max_changed_files: 3 }, "max_changed_lines", 1000],
    [{ max_changed_lines: 30, max_changed_files: "3" }, "max_changed_files", 100],
    [{ max_changed_lines: 30, max_changed_files: 101 }, "max_changed_files", 100],
  ];
  for (const [value, field, max] of bad) {
    assert.throws(() => validateReviewerFixSettings(value), (error) => error instanceof ReviewerFixSettingsValidationError && error.field === field && error.condition.kind === "integer_range" && error.condition.min === 0 && error.condition.max === max);
  }
  for (const value of [{ max_changed_lines: 30 }, { max_changed_lines: 30, max_changed_files: 3, extra: 1 }, null]) {
    assert.throws(() => validateReviewerFixSettings(value), ReviewerFixSettingsValidationError);
  }
  assert.deepEqual(readReviewerFixSettings({ max_changed_lines: 5, max_changed_files: "x" }), { max_changed_lines: 5, max_changed_files: 3 });
  assert.equal(readReviewerFixSettings("nope"), DEFAULT_REVIEWER_FIX_SETTINGS);
});
