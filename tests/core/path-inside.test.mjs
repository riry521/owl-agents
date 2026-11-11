import assert from "node:assert/strict";
import test from "node:test";
import { isPathInside } from "../../packages/core/dist/path-inside.js";

test("the folder itself is inside only when includeSelf is true", () => {
  assert.equal(isPathInside("/a/b", "/a/b", true), true);
  assert.equal(isPathInside("/a/b", "/a/b", false), false);
});

test("a child is inside", () => {
  assert.equal(isPathInside("/a/b", "/a/b/c", false), true);
  assert.equal(isPathInside("/a/b", "/a/b/c", true), true);
});

test("a sibling whose name starts with .. is not mistaken for outside", () => {
  assert.equal(isPathInside("/a/b", "/a/b/..foo", false), true);
});

test("a parent or sibling is outside", () => {
  assert.equal(isPathInside("/a/b", "/a", true), false);
  assert.equal(isPathInside("/a/b", "/a/x", true), false);
  assert.equal(isPathInside("/a/b", "/a/b/../x", true), false);
});

test("an absolute relative path (different drive-like root) is outside", () => {
  assert.equal(isPathInside("/a/b", "/", true), false);
});
