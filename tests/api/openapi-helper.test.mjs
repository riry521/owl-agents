import assert from "node:assert/strict";
import { test } from "node:test";

import { loadOpenApi, openApiOperations, schemaErrors, unsupportedKeywords } from "../helpers/openapi.mjs";

const doc = (schema, extra = {}) => ({ components: { schemas: { T: schema, ...extra } } });
const T = "#/components/schemas/T";
const ok = (schema, value, extra) => assert.deepEqual(schemaErrors(doc(schema, extra), value, T), [], JSON.stringify(schema));
const bad = (schema, value, extra) => assert.notDeepEqual(schemaErrors(doc(schema, extra), value, T), [], JSON.stringify(schema));

const cases = {
  type: [{ type: "integer" }, 1, 1.5],
  "type array": [{ type: ["string", "null"] }, null, 1],
  "type number": [{ type: "number" }, 1.5, "1"],
  "type object": [{ type: "object" }, {}, []],
  "type array kind": [{ type: "array" }, [], {}],
  enum: [{ enum: ["a", { b: 1 }] }, { b: 1 }, "c"],
  const: [{ const: [1] }, [1], [2]],
  required: [{ required: ["a"] }, { a: 1 }, {}],
  properties: [{ properties: { a: { type: "string" } } }, { a: "x" }, { a: 1 }],
  "additionalProperties false": [{ properties: { a: {} }, additionalProperties: false }, { a: 1 }, { a: 1, b: 2 }],
  "additionalProperties true": [{ type: "object", additionalProperties: true }, { z: 1 }, null],
  "additionalProperties schema": [{ additionalProperties: { type: "string" } }, { z: "x" }, { z: 1 }],
  minProperties: [{ minProperties: 1 }, { a: 1 }, {}],
  maxProperties: [{ maxProperties: 1 }, { a: 1 }, { a: 1, b: 2 }],
  items: [{ items: { type: "integer" } }, [1], ["x"]],
  minItems: [{ minItems: 2 }, [1, 2], [1]],
  maxItems: [{ maxItems: 1 }, [1], [1, 2]],
  uniqueItems: [{ uniqueItems: true }, [{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 1 }]],
  minimum: [{ minimum: 0 }, 0, -1],
  maximum: [{ maximum: 100 }, 100, 101],
  minLength: [{ minLength: 1 }, "a", ""],
  maxLength: [{ maxLength: 1 }, "😀", "ab"],
  pattern: [{ pattern: "^a+$" }, "aa", "b"],
  "format date-time": [{ format: "date-time" }, "2026-01-02T03:04:05Z", "2026-01-02"],
  allOf: [{ allOf: [{ type: "string" }, { minLength: 2 }] }, "ab", "a"],
  anyOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }, null, 1],
  oneOf: [{ oneOf: [{ type: "integer" }, { minimum: 0 }] }, -1, 1],
};

for (const [name, [schema, good, wrong]] of Object.entries(cases)) {
  test(`schemaErrors evaluates ${name}`, () => {
    ok(schema, good);
    bad(schema, wrong);
  });
}

test("schemaErrors resolves $ref and rejects unknown refs and cycles", () => {
  ok({ $ref: "#/components/schemas/U" }, "x", { U: { type: "string" } });
  bad({ $ref: "#/components/schemas/U" }, 1, { U: { type: "string" } });
  bad({ $ref: "#/components/schemas/Missing" }, 1);
  bad({ $ref: "other.json#/x" }, 1);
  bad({ $ref: "#/components/schemas/T" }, 1);
});

test("schemaErrors evaluates keywords written beside $ref", () => {
  const U = { U: { type: "integer" } };
  ok({ $ref: "#/components/schemas/U", minimum: 1 }, 1, U);
  bad({ $ref: "#/components/schemas/U", minimum: 1 }, 0, U);
  bad({ $ref: "#/components/schemas/U", properties: {} }, "x", U);
});

test("schemaErrors ignores annotations and rejects unknown keywords and formats", () => {
  ok({ type: "string", description: "d", title: "t", example: "e", default: "x", deprecated: true, "x-note": 1 }, "a");
  bad({ type: "string", nullable: true }, "a");
  bad({ format: "email" }, "a@example.com");
});

test("real Version and WorkState reject -1 and the empty string", () => {
  const openapi = loadOpenApi();
  assert.deepEqual(schemaErrors(openapi, 0, "#/components/schemas/Version"), []);
  assert.notDeepEqual(schemaErrors(openapi, -1, "#/components/schemas/Version"), []);
  assert.notDeepEqual(schemaErrors(openapi, "", "#/components/schemas/WorkState"), []);
});

test("unsupportedKeywords is empty for the schemas the response tests validate", () => {
  const openapi = loadOpenApi();
  const names = ["WorkView", "DecisionView", "BoardView", "LinkableWorks", "BacklogView", "TokensView", "SettingsView", "WorkDetail",
    "WorkDesignListResponse", "WorkDesignSummary", "WorkDesign", "Decision", "WebSocketServerFrame", "WorkSummary"];
  for (const name of names) assert.deepEqual(unsupportedKeywords(openapi, `#/components/schemas/${name}`), [], name);
  assert.deepEqual(unsupportedKeywords(doc({ properties: { a: { nullable: true } } }), T), ["T: nullable"]);
});

test("openApiOperations lists only HTTP method keys", () => {
  assert.deepEqual(openApiOperations({ paths: { "/a": { parameters: [], summary: "s", get: {}, head: {}, delete: {} } } }),
    [{ method: "GET", path: "/a" }, { method: "HEAD", path: "/a" }, { method: "DELETE", path: "/a" }]);
});
