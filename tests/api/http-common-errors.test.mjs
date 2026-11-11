import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, errorBody } from "../../apps/server/dist/errors.js";
import { commandEnvelope, exactKeys, parseLimit, pathId, stringField } from "../../apps/server/dist/http-common.js";

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected ApiError");
}

function expectApiError(fn, status, code, details) {
  const error = thrown(fn);
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  if (details !== undefined) assert.deepEqual(error.details, details);
  for (const language of ["ja", "en"]) {
    const body = errorBody("request", error, language).error;
    assert.equal(body.code, code);
    assert.deepEqual(body.details, error.details);
    assert.equal(typeof body.message, "string");
    assert.ok(body.message.length > 0);
  }
}

test("exactKeys reports missing and extra field names", () => {
  expectApiError(() => exactKeys({ a: 1, c: 3 }, ["a", "b"], "x", ["d"]), 400, "validation_error", { missing: ["b"], extra: ["c"] });
  exactKeys({ a: 1, d: 2 }, ["a"], "x", ["d"]);
});

test("stringField rejects wrong type and length", () => {
  expectApiError(() => stringField(1, "name", 1, 5), 400, "validation_error");
  expectApiError(() => stringField("", "name", 1, 5), 400, "validation_error");
  expectApiError(() => stringField("abcdef", "name", 1, 5), 400, "validation_error");
  assert.equal(stringField("abc", "name", 1, 5), "abc");
});

test("pathId rejects undecodable and non-ULID ids", () => {
  expectApiError(() => pathId("%E0%A4%A", "id"), 400, "validation_error");
  expectApiError(() => pathId("not-a-ulid", "id"), 400, "validation_error");
  assert.equal(pathId("01M758Z122QBTXQ01V8FZ03314", "id"), "01M758Z122QBTXQ01V8FZ03314");
});

test("parseLimit rejects non-numeric and out-of-range values with invalid_query", () => {
  for (const value of ["abc", "-1", "0", "201", "1.5"]) {
    expectApiError(() => parseLimit(value, 50), 400, "invalid_query");
  }
  assert.equal(parseLimit(null, 50), 50);
  assert.equal(parseLimit("200", 50), 200);
});

test("commandEnvelope rejects malformed envelopes", () => {
  const ok = { request_id: "r", idempotency_key: "k", expected_version: 0, payload: {} };
  expectApiError(() => commandEnvelope(null), 400, "validation_error");
  expectApiError(() => commandEnvelope({ ...ok, extra: 1 }), 400, "validation_error", { missing: [], extra: ["extra"] });
  expectApiError(() => commandEnvelope({ ...ok, request_id: "" }), 400, "validation_error");
  expectApiError(() => commandEnvelope({ ...ok, expected_version: -1 }), 400, "validation_error");
  expectApiError(() => commandEnvelope({ ...ok, payload: [] }), 400, "validation_error");
  assert.equal(commandEnvelope(ok).expected_version, 0);
});

test("errorBody message follows the language while code stays the same", () => {
  const japanese = /[ぁ-んァ-ヶ一-龠]/;
  const cases = [
    () => stringField(1, "name", 1, 5),
    () => pathId("not-a-ulid", "id"),
    () => commandEnvelope(null),
  ];
  for (const fn of cases) {
    const error = thrown(fn);
    const ja = errorBody("request", error, "ja").error;
    const en = errorBody("request", error, "en").error;
    assert.match(ja.message, japanese);
    assert.doesNotMatch(en.message, japanese);
    assert.equal(ja.code, en.code);
  }
});
