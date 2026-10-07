import assert from "node:assert/strict";
import { test } from "node:test";

import { buildManagerPrompt, parseManagerPlanWithFeedback } from "../../packages/agent-runtime/dist/manager.js";

const request = { work: { id: "work-1", title: "T" }, mode: "replan", context: {} };
const parse = (payload) => parseManagerPlanWithFeedback({ tasks: [], ...payload }, request).result;

test("replan output carries updated_title and updated_summary when they are present", () => {
  const result = parse({ updated_title: "New title", updated_summary: "New summary" });
  assert.equal(result.updated_title, "New title");
  assert.equal(result.updated_summary, "New summary");
});

test("replan output parses as unchanged when the fields are missing or null", () => {
  for (const payload of [{}, { updated_title: null, updated_summary: null }]) {
    const result = parse(payload);
    assert.equal(result.updated_title, null);
    assert.equal(result.updated_summary, null);
  }
});

test("replan output rejects an empty, oversized or mistyped title or summary", () => {
  for (const payload of [
    { updated_title: "" },
    { updated_title: "   " },
    { updated_title: "a".repeat(501) },
    { updated_title: 5 },
    { updated_summary: "" },
    { updated_summary: "a".repeat(20_001) },
    { updated_summary: ["x"] },
  ]) {
    assert.throws(() => parse(payload), { name: "AgentRuntimeError" });
  }
  assert.equal(parse({ updated_title: "a".repeat(500), updated_summary: "a".repeat(20_000) }).updated_title.length, 500);
});

test("replan prompt tells the Manager to reflect only what the Owner changed", () => {
  const prompt = buildManagerPrompt(request, "en");
  assert.match(prompt, /Reflect only what the Owner's request changed/);
  assert.match(prompt, /updated_summary/);
});

test("pages finalize accepts lessons even if they omit theme and cross_project", () => {
  const lesson = { lesson: "x", basis: "b", applies_to: "a", kind: "fact", topic: "t", procedure: "", rule_text: "", rule_scope: "all", keywords: ["a", "b", "c"] };
  const payload = { skills_used: [], skill_proposals: [], verdict: { verdict: "complete", summary: "s", missing: [], unaddressed_backlog_items: [], lessons: [lesson] } };
  const req = { work: { id: "w", title: "T" }, mode: "finalize", memory_mode: "pages", context: {} };
  const { result } = parseManagerPlanWithFeedback(payload, req);
  assert.equal(result.verdict.lessons[0].theme, "");
  assert.equal(result.verdict.lessons[0].cross_project, false);
});

test("every manager mode prompt explains work.advisor_backlog linked and dismissed", () => {
  for (const mode of ["plan", "replan", "finalize"]) {
    const prompt = buildManagerPrompt({ work: { id: "w", title: "T" }, mode, context: {} }, "en");
    assert.match(prompt, /work\.advisor_backlog is \{linked, dismissed\}/, mode);
    assert.match(prompt, /dismissed items were judged not worth doing/, mode);
    assert.match(prompt, /## Dismissed backlog items/, mode);
  }
});
