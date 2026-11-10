import assert from "node:assert/strict";
import { test } from "node:test";

import {
  optionalCoreFeature,
  requireAdapterFeature,
  requireCoreFeature,
  requireMemoryFeature,
} from "../../apps/server/dist/core-feature.js";
import { ApiError } from "../../apps/server/dist/errors.js";

const error = { code: "dependency_unavailable", message: "no feature" };
const fn = () => 1;

function assert503(call, code, message) {
  assert.throws(call, (e) => e instanceof ApiError && e.status === 503 && e.code === code && e.message === message);
}

test("requireAdapterFeature は core だけを見て、core.core にあっても 503 にする", () => {
  const adapter = { a: fn, b: fn };
  assert.equal(requireAdapterFeature(adapter, ["a", "b"], error), adapter);
  assert503(() => requireAdapterFeature({ core: adapter }, ["a"], error), "dependency_unavailable", "no feature");
  assert503(() => requireAdapterFeature({ a: fn }, ["a", "b"], error), "dependency_unavailable", "no feature");
  assert503(() => requireAdapterFeature({ a: 1 }, ["a"], { code: "core_not_ready", message: "m" }), "core_not_ready", "m");
});

test("requireCoreFeature は core、core.core の順に見て、見つけた object 自身を返す", () => {
  const inner = { a: fn };
  const outer = { a: fn, core: inner };
  assert.equal(requireCoreFeature(outer, ["a"], error), outer);
  const wrapper = { core: inner };
  assert.equal(requireCoreFeature(wrapper, ["a"], error), inner);
  const self = { v: 7, a() { return this.v; } };
  assert.equal(requireCoreFeature(self, ["a"], error).a(), 7);
  assert503(() => requireCoreFeature({ core: {} }, ["a"], error), "dependency_unavailable", "no feature");
  assert503(() => requireCoreFeature(null, ["a"], error), "dependency_unavailable", "no feature");
});

test("optionalCoreFeature は無ければ null を返し、optional のキーは無くても通る", () => {
  assert.equal(optionalCoreFeature({}, ["a"]), null);
  const inner = { a: fn };
  assert.equal(optionalCoreFeature({ core: inner }, ["a"], ["b"]), inner);
  assert.equal(requireCoreFeature(inner, ["a"], error, ["b"]), inner);
});

test("requireMemoryFeature は core.memory、core.core.memory の順に見て、必須5メソッドを確かめる", () => {
  const full = () => ({ search: fn, expand: fn, recall: fn, health: fn, reindex: fn });
  const direct = full();
  const nested = full();
  assert.equal(requireMemoryFeature({ memory: direct, core: { memory: nested } }), direct);
  assert.equal(requireMemoryFeature({ core: { memory: nested } }), nested);
  assert.equal(requireMemoryFeature({ memory: { ...direct, extra: 1 } }).health, direct.health);
  const message = "The loaded Core does not support the memory API.";
  assert503(() => requireMemoryFeature({}), "dependency_unavailable", message);
  for (const key of Object.keys(direct)) {
    const partial = { ...direct };
    delete partial[key];
    assert503(() => requireMemoryFeature({ memory: partial }), "dependency_unavailable", message);
  }
});
