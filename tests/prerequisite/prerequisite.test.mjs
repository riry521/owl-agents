import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePrerequisiteSpec, validateWaitFor, PrerequisiteValidationError } from "../../packages/shared/dist/prerequisite.js";
import {
  DEFAULT_PROGRESS_GUARD_SETTINGS,
  PROGRESS_GUARD_RANGES,
  readProgressGuardSettings,
  validateProgressGuardSettings,
} from "../../packages/shared/dist/progress-guard-settings.js";

const cond = (over = {}) => ({ kind: "base_branch", target: "", paths: ["src/a.ts"], description: "a.ts lands on main", ...over });
const waitForSpec = (conditions) => ({ reason: "needs a.ts", conditions });
const rejects = (value, field) =>
  assert.throws(() => validateWaitFor(value), (e) => e instanceof PrerequisiteValidationError && (field === undefined || e.field.includes(field)));

test("wait_for accepts the four kinds", () => {
  const ok = waitForSpec([
    cond(),
    { kind: "task", target: "01ABC", paths: [], description: "t" },
    { kind: "work", target: "#51", paths: [], description: "w" },
    { kind: "owner", target: "", paths: [], description: "o" },
  ]);
  assert.deepEqual(validateWaitFor(ok), ok);
});

test("wait_for rejects unknown kind, missing target, bad paths and bad shapes", () => {
  rejects(waitForSpec([cond({ kind: "magic" })]), "kind");
  rejects(waitForSpec([{ kind: "task", target: "", paths: [], description: "t" }]), "target");
  rejects(waitForSpec([{ kind: "work", paths: [], description: "w" }]), "target");
  rejects(waitForSpec([{ kind: "owner", target: "x", paths: [], description: "o" }]), "target");
  rejects(waitForSpec([cond({ paths: ["../secret"] })]), "paths");
  rejects(waitForSpec([cond({ paths: ["a/../../b"] })]), "paths");
  rejects(waitForSpec([cond({ paths: ["/etc/passwd"] })]), "paths");
  rejects(waitForSpec([cond({ paths: ["C:\\x"] })]), "paths");
  rejects(waitForSpec([{ kind: "task", target: "T", paths: ["a"], description: "t" }]), "paths");
  rejects(waitForSpec([]), "conditions");
  rejects(waitForSpec(Array.from({ length: 11 }, () => cond())), "conditions");
  rejects(waitForSpec([cond({ paths: Array.from({ length: 51 }, (_, i) => `f${i}`) })]), "paths");
  rejects(waitForSpec([cond({ description: "" })]), "description");
  rejects({ reason: "x".repeat(2001), conditions: [cond()] }, "reason");
  rejects(null);
});

test("stored spec is validated: source, conditions and shape", () => {
  const spec = {
    reason: "r", source: "manager", base_head: null, deadline_at: "2026-01-01T00:00:00.000Z", replan_question: null,
    conditions: [{ kind: "task", task_id: "T", description: "d" }, { kind: "base_branch", paths: ["a"], description: "d" }, { kind: "owner", description: "d" }],
  };
  assert.deepEqual(validatePrerequisiteSpec(spec), spec);
  assert.throws(() => validatePrerequisiteSpec({ ...spec, source: "worker" }), PrerequisiteValidationError);
  assert.throws(() => validatePrerequisiteSpec({ ...spec, conditions: [{ kind: "nope", description: "d" }] }), PrerequisiteValidationError);
  assert.throws(() => validatePrerequisiteSpec({ ...spec, conditions: [{ kind: "task", description: "d" }] }), PrerequisiteValidationError);
  assert.throws(() => validatePrerequisiteSpec({ ...spec, conditions: [{ kind: "base_branch", paths: ["/abs"], description: "d" }] }), PrerequisiteValidationError);
});

test("progress guard defaults and per-key ranges", () => {
  assert.deepEqual(DEFAULT_PROGRESS_GUARD_SETTINGS, {
    no_progress_limit: 3, prerequisite_check_interval_seconds: 60, prerequisite_max_wait_hours: 72, prerequisite_sync_base: true,
    process_wait_max_count: 3, process_wait_max_hours: 6, external_blocker_limit: 2,
  });
  assert.deepEqual(PROGRESS_GUARD_RANGES.prerequisite_check_interval_seconds, { min: 10, max: 86400 });
  assert.deepEqual(PROGRESS_GUARD_RANGES.prerequisite_max_wait_hours, { min: 1, max: 8760 });
  assert.deepEqual(PROGRESS_GUARD_RANGES.process_wait_max_count, { min: 0, max: 20 });
  assert.deepEqual(PROGRESS_GUARD_RANGES.process_wait_max_hours, { min: 1, max: 72 });
  assert.deepEqual(PROGRESS_GUARD_RANGES.external_blocker_limit, { min: 0, max: 20 });
  for (const [key, { min, max }] of Object.entries(PROGRESS_GUARD_RANGES)) {
    for (const ok of [min, max]) assert.equal(validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, [key]: ok })[key], ok);
    for (const bad of [min - 1, max + 1, 1.5, "1", null]) {
      assert.throws(() => validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, [key]: bad }), (e) => e.field === key);
    }
  }
  assert.throws(() => validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, prerequisite_sync_base: "yes" }), (e) => e.field === "prerequisite_sync_base");
  assert.throws(() => validateProgressGuardSettings({ no_progress_limit: 3 }), /exactly/);
  assert.throws(() => validateProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, extra: 1 }), /exactly/);
});

test("a value saved with only no_progress_limit reads with the other keys at their defaults", () => {
  const warnings = [];
  assert.deepEqual(readProgressGuardSettings({ no_progress_limit: 5 }, (m) => warnings.push(m)), { ...DEFAULT_PROGRESS_GUARD_SETTINGS, no_progress_limit: 5 });
  assert.equal(warnings.length, 0);
  assert.equal(readProgressGuardSettings({ no_progress_limit: 5 }).external_blocker_limit, 2);
  assert.deepEqual(
    readProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, prerequisite_max_wait_hours: 0, prerequisite_sync_base: false }, (m) => warnings.push(m)),
    { ...DEFAULT_PROGRESS_GUARD_SETTINGS, prerequisite_sync_base: false },
  );
  assert.equal(warnings.length, 1);
});
