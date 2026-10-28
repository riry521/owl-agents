import assert from "node:assert/strict";
import { test } from "node:test";

import { isPlanRejection, validateReplan } from "../../packages/core/dist/replan-plan.js";

// When a Reviewer or Worker reports an acceptance defect, the Manager must rewrite the named
// criteria and record each change in auto_recovery.criteria_relaxations. If it only forgets the
// record, Core writes it from the defect; it never does so for Owner criteria or unnamed ones.

const MANAGER = { kind: "manager", source: null, quote: "" };
const OWNER = { kind: "owner", source: "summary", quote: "check it" };
const stored = (id, origin) => ({ id, text: `${id} holds`, check: "node --test the file", kind: "work_check", check_weight: "light", weight_reason: "", serves: "fixture", if_omitted: "fixture", origin });
const rewritten = (before) => ({ ...before, text: `${before.id} holds for a sample`, check: "node --test the sample file" });
const snapshot = { tasks: [{ id: "T1", manager_task_id: "T1", status: "failed", failed_by_dependency: false }], edges: [] };
const retry = (criteria, relaxations) => ({
  id: "T1", title: "A", type: "code", acceptance: "new acceptance", depends_on: [], replaces: [],
  acceptance_criteria: criteria, auto_recovery: relaxations === undefined ? undefined : { criteria_relaxations: relaxations },
});
const defect = (criterionId, extra = {}) => ({ criterion_id: criterionId, criterion: `${criterionId} holds`, reason: "cannot be proven inside the Task", suggestion: "", ...extra });
const validate = (current, criteria, defects, relaxations) =>
  validateReplan([retry(criteria, relaxations)], snapshot, ["T1"], {
    currentCriteria: new Map([["T1", current]]),
    automatic: true,
    acceptanceRevisionRequired: new Map([["T1", "old acceptance"]]),
    acceptanceDefects: new Map([["T1", defects]]),
  });

test("a changed Manager criterion named by the defects gets its relaxation entry filled in", () => {
  const before = stored("AC1", MANAGER);
  const plan = validate([before], [rewritten(before)], [defect("AC1")], []);
  assert.ok(!isPlanRejection(plan), JSON.stringify(plan));
  assert.deepEqual(plan.revisions.get("T1").criteria_relaxations, [
    { criterion_id: "AC1", reason: "cannot be proven inside the Task", keeps: "node --test the sample file" },
  ]);
});

test("a defect without criterion_id is matched by its quoted criterion text; the Manager's own entry is kept", () => {
  const first = stored("AC1", MANAGER);
  const second = stored("AC2", MANAGER);
  const own = { criterion_id: "AC1", reason: "mine", keeps: "mine too" };
  const plan = validate([first, second], [rewritten(first), rewritten(second)], [defect("", { criterion: "AC2 holds" })], [own]);
  assert.ok(!isPlanRejection(plan), JSON.stringify(plan));
  assert.deepEqual(plan.revisions.get("T1").criteria_relaxations.map((entry) => entry.criterion_id), ["AC1", "AC2"]);
  assert.equal(plan.revisions.get("T1").criteria_relaxations[0].reason, "mine");
});

test("a changed Manager criterion that no defect names is still rejected without an entry", () => {
  const named = stored("AC1", MANAGER);
  const other = stored("AC2", MANAGER);
  const result = validate([named, other], [rewritten(named), rewritten(other)], [defect("AC1")], []);
  assert.ok(isPlanRejection(result));
  assert.match(result.errors.join("\n"), /Criterion AC2 was changed but has no entry/);
  assert.doesNotMatch(result.errors.join("\n"), /Criterion AC1/);
});

test("an Owner criterion named by a defect is never filled in or changed by an automatic replan", () => {
  const before = stored("AC1", OWNER);
  const result = validate([before], [rewritten(before)], [defect("AC1")], []);
  assert.ok(isPlanRejection(result));
  assert.match(result.errors.join("\n"), /comes from the Owner/);
});

test("the blocking quality checks still run on a filled-in criterion", () => {
  const before = stored("AC1", MANAGER);
  const result = validate([before], [{ ...rewritten(before), text: "Run it on 全件" }], [defect("AC1")], []);
  assert.ok(isPlanRejection(result));
  assert.match(result.errors.join("\n"), /plan quality/);
});
