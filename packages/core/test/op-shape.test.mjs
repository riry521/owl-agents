import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findListKey, normalizeOp } from "../dist/op-shape.js";

const defs = { foo: { required: { a: "string" } }, bar: { required: { b: "string" }, optional: { c: "string" } } };

test("the component source names no concrete operation", () => {
  const src = readFileSync(new URL("../src/op-shape.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /merge|move|retire|dormant|reactivate|link|split|promote_common|restore|take_conversation|set_usage/u);
});

test("a wrapped operation becomes the flat one, with or without a matching op field", () => {
  assert.deepEqual(normalizeOp({ foo: { a: "x" } }, defs), { op: "foo", a: "x" });
  assert.deepEqual(normalizeOp({ op: "foo", foo: { a: "x" } }, defs), { op: "foo", a: "x" });
  assert.deepEqual(normalizeOp({ foo: { op: "foo", a: "x" } }, defs), { op: "foo", a: "x" });
  assert.deepEqual(normalizeOp({ op: "foo", a: "x" }, defs), { op: "foo", a: "x" });
});

test("case and spaces of the name are evened out in op and in the wrapper key", () => {
  assert.deepEqual(normalizeOp({ op: " Foo ", a: "x" }, defs), { op: "foo", a: "x" });
  assert.deepEqual(normalizeOp({ " BAR": { b: "y" } }, defs), { op: "bar", b: "y" });
});

test("what the table cannot settle stays unsettled", () => {
  for (const raw of [
    { foo: { a: "x" }, bar: { b: "y" } }, // two wrapper keys
    { baz: { a: "x" } }, // unknown name
    { op: "baz", a: "x" },
    { op: "bar", foo: { a: "x" } }, // outer op disagrees with the wrapper
    { foo: { op: "bar", a: "x" } }, // inner op disagrees with the wrapper
    { foo: "x" }, // wrapper without fields
    { op: 1, a: "x" },
    { toString: { a: "x" } }, // prototype key
    { op: "toString" },
    null, [], "foo",
  ]) assert.equal(normalizeOp(raw, defs), null, JSON.stringify(raw));
});

test("a list under another key is found only when it is the one key left over", () => {
  assert.equal(findListKey({ operations: [], note: "n" }, "operations", ["note"]), "operations");
  assert.equal(findListKey({ ops: [], note: "n" }, "operations", ["note"]), "ops");
  assert.equal(findListKey({ ops: [], acts: [] }, "operations", ["note"]), null);
  assert.equal(findListKey({ ops: "x" }, "operations", ["note"]), null);
});
