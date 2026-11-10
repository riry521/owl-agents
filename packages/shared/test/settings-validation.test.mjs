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
