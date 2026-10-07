import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateCondition, evaluatePrerequisite } from "../../packages/core/dist/prerequisite-monitor.js";

const NOW = "2026-01-01T00:00:00.000Z";
const FUTURE = "2026-01-02T00:00:00.000Z";
const PAST = "2025-12-31T00:00:00.000Z";

const spec = (conditions, extra = {}) => ({ reason: "r", source: "manager", conditions, base_head: "aaa", deadline_at: FUTURE, replan_question: null, ...extra });
const facts = ({ tasks = {}, works = {}, base = { head: "aaa", missing_paths: [] } } = {}) => ({
  taskStatus: (id) => tasks[id],
  workState: (id) => works[id],
  baseBranch: () => base,
});
const taskCondition = { kind: "task", task_id: "T", description: "task" };
const workCondition = { kind: "work", work_id: "W", description: "work" };

for (const [name, condition, key] of [["task", taskCondition, "tasks"], ["work", workCondition, "works"]]) {
  const id = name === "task" ? "T" : "W";
  test(`${name} condition: completed is satisfied`, () => {
    assert.equal(evaluateCondition(condition, spec([condition]), facts({ [key]: { [id]: "completed" } })), "satisfied");
  });
  test(`${name} condition: running, failed and judgement_waiting stay pending`, () => {
    for (const status of ["running", "failed", "waiting", "judgement_waiting", "paused"]) {
      assert.equal(evaluateCondition(condition, spec([condition]), facts({ [key]: { [id]: status } })), "pending", status);
    }
  });
  test(`${name} condition: cancelled or a missing row is unreachable`, () => {
    assert.equal(evaluateCondition(condition, spec([condition]), facts({ [key]: { [id]: "cancelled" } })), "unreachable");
    assert.equal(evaluateCondition(condition, spec([condition]), facts()), "unreachable");
  });
}

test("base_branch with paths: satisfied only when none is missing", () => {
  const condition = { kind: "base_branch", paths: ["a.ts", "b.ts"], description: "files" };
  assert.equal(evaluateCondition(condition, spec([condition]), facts({ base: { head: "aaa", missing_paths: [] } })), "satisfied", "head unchanged but paths present");
  assert.equal(evaluateCondition(condition, spec([condition]), facts({ base: { head: "bbb", missing_paths: ["b.ts"] } })), "pending", "head moved but one path is missing");
  assert.equal(evaluateCondition(condition, spec([condition]), facts({ base: { head: "bbb", missing_paths: ["other.ts"] } })), "satisfied", "a path of another wait is irrelevant");
});

test("base_branch without paths: satisfied when the head moved", () => {
  const condition = { kind: "base_branch", paths: [], description: "any update" };
  assert.equal(evaluateCondition(condition, spec([condition]), facts({ base: { head: "aaa", missing_paths: [] } })), "pending");
  assert.equal(evaluateCondition(condition, spec([condition]), facts({ base: { head: "bbb", missing_paths: [] } })), "satisfied");
});

test("base_branch is pending when git could not be read", () => {
  const condition = { kind: "base_branch", paths: ["a.ts"], description: "files" };
  assert.equal(evaluateCondition(condition, spec([condition]), facts({ base: null })), "pending");
});

test("an owner condition never resolves by itself", () => {
  const condition = { kind: "owner", description: "Owner says go" };
  assert.equal(evaluateCondition(condition, spec([condition]), facts()), "pending");
  const both = spec([taskCondition, condition]);
  assert.equal(evaluatePrerequisite(both, facts({ tasks: { T: "completed" } }), NOW).verdict, "pending");
});

test("evaluatePrerequisite: every condition must hold (AND)", () => {
  const both = spec([taskCondition, workCondition]);
  assert.equal(evaluatePrerequisite(both, facts({ tasks: { T: "completed" }, works: { W: "running" } }), NOW).verdict, "pending");
  assert.equal(evaluatePrerequisite(both, facts({ tasks: { T: "completed" }, works: { W: "completed" } }), NOW).verdict, "satisfied");
});

test("evaluatePrerequisite: one unreachable condition makes the wait unreachable", () => {
  const both = spec([taskCondition, workCondition]);
  const outcome = evaluatePrerequisite(both, facts({ tasks: { T: "completed" }, works: { W: "cancelled" } }), NOW);
  assert.equal(outcome.verdict, "unreachable");
  assert.match(outcome.detail, /work/);
});

test("evaluatePrerequisite: the deadline wins over every other verdict", () => {
  const expired = spec([taskCondition], { deadline_at: PAST });
  assert.equal(evaluatePrerequisite(expired, facts({ tasks: { T: "completed" } }), NOW).verdict, "expired");
  assert.equal(evaluatePrerequisite(expired, facts(), NOW).verdict, "expired");
  assert.equal(evaluatePrerequisite(spec([taskCondition], { deadline_at: NOW }), facts(), NOW).verdict, "expired", "now >= deadline");
});
