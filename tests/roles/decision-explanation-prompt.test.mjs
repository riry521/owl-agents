import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDecisionExplanationPrompt, parseDecisionExplanationResponse } from "../../packages/agent-runtime/dist/decision-explanation.js";

const request = (changes = {}) => ({
  kind: "partial_limit",
  language: "en",
  decision: {
    reason: "r",
    question: "q",
    current_state: "s",
    tried: "t",
    options: [{ key: "retry", label: "Retry", description: "d" }, { key: "cancel", label: "Cancel", description: "d" }],
    recommended: null,
  },
  task: { title: "T", acceptance_criteria: [{ id: "AC1", text: "x" }] },
  reports: [],
  verification: null,
  rules: null,
  forbidden_terms: ["TERM-ONE"],
  revision: null,
  timeout_ms: 1000,
  ...changes,
});
const instructionsOf = (prompt) => prompt.slice(0, prompt.indexOf("## Input"));

test("the prompt carries the general writing rules for every kind", () => {
  for (const kind of ["partial_limit", "merge_failed"]) {
    const prompt = buildDecisionExplanationPrompt(request({ kind }));
    assert.match(prompt, /plain sentences/u);
    assert.match(prompt, /Never write an id/u);
    assert.match(prompt, /auto_recovery or plan_rejected/u);
    assert.match(prompt, /setting or file name, may be written when it is in `backticks`/u);
    assert.doesNotMatch(prompt, /Never write English internal terms/u);
    assert.match(prompt, /"TERM-ONE"/u);
    assert.match(prompt, /option_notes: for every option in Decision\.options/u);
    assert.match(prompt, /recommended_option_key: exactly one key/u);
    assert.match(prompt, /the neck, in the Owner's words/u);
    assert.match(prompt, /Never ask the Owner to do the Manager's or a Worker's work/u);
    assert.match(prompt, /a word in the answer field is enough and the Manager will follow it/u);
    assert.doesNotMatch(prompt, /one or two sentences/u);
  }
});

test("the fix option instructions appear only for kinds that allow them", () => {
  const limit = buildDecisionExplanationPrompt(request());
  const other = buildDecisionExplanationPrompt(request({ kind: "merge_failed" }));
  assert.match(limit, /criteria_rewrites: for each criterion to reword/u);
  assert.match(limit, /every way to go on that makes sense in this situation/u);
  assert.match(limit, /〜にしますか？/u);
  assert.match(limit, /from the Owner's side/u);
  assert.doesNotMatch(other, /criteria_rewrites: for each criterion to reword/u);
  assert.doesNotMatch(other, /every way to go on/u);
  assert.match(other, /options must be \[\]/u);
});

test("Revision is in the prompt only for a rewrite", () => {
  assert.doesNotMatch(buildDecisionExplanationPrompt(request()), /### Revision/u);
  const revision = { texts: { summary: "s", next_steps: "n", options: [] }, problems: ["too long"] };
  const prompt = buildDecisionExplanationPrompt(request({ revision }));
  assert.match(prompt, /### Revision/u);
  assert.match(prompt, /too long/u);
});

test("the prompt without its inputs has no absolute path", () => {
  const text = instructionsOf(buildDecisionExplanationPrompt(request({ revision: { texts: { summary: "s", next_steps: "n", options: [] }, problems: [] } })));
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /(^|[\s"'(])(~\/|\/[A-Za-z0-9._-]+\/)/u);
});

test("parseDecisionExplanationResponse returns the JSON object unchecked, leaving the content checks to Core", () => {
  const answer = { summary: "It stopped.", cause_kind: "work", next_steps: "Retry it.", option_notes: [], options: [], recommended_option_key: "retry" };
  const response = (stdout) => ({ adapter: "claude", format: "text", stdout });
  assert.deepEqual(parseDecisionExplanationResponse(response(JSON.stringify(answer))), answer);
  assert.throws(() => parseDecisionExplanationResponse(response("not json")), { name: "OutputFormatError" });
});
