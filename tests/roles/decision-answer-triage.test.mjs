import assert from "node:assert/strict";
import { test } from "node:test";

import { OutputFormatError } from "../../packages/agent-runtime/dist/output-resubmit.js";
import { buildDecisionAnswerTriagePrompt, parseDecisionAnswerTriageResponse } from "../../packages/agent-runtime/dist/decision-answer-triage.js";
import { readDecisionAnswerTriage } from "../../packages/shared/dist/decision-answer-triage.js";

const request = (changes = {}) => ({
  language: "en",
  decision: {
    reason: "Waiting for the Owner",
    question: "Does the staging server run the export job yet?",
    current_state: "The Task waits for the Owner.",
    options: [{ key: "retry", label: "Retry", description: "Run the Task again" }],
    chosen_option_key: "retry",
    explanation_summary: null,
  },
  task: { title: "Add the export job", acceptance_criteria: [{ id: "AC1", text: "The export job runs on staging.", check: "node --test" }] },
  answer: "Use this Mac only, not the staging server.",
  timeout_ms: 1000,
  ...changes,
});
const response = (stdout) => ({ adapter: "claude", stdout, format: "text" });
const ids = ["AC1", "AC2"];
const rewrite = (id = "AC1") => ({ criterion_id: id, after: "Runs on this Mac.", check: "node --test" });
const report = (changes = {}) => ({ route: "manager", reason: "The words change the scope.", criteria_rewrites: [rewrite()], ...changes });

test("the prompt carries the Decision, the Task's criteria, the Owner's words and the doubt rule", () => {
  const prompt = buildDecisionAnswerTriagePrompt(request());
  assert.match(prompt, /Does the staging server run the export job yet\?/);
  assert.match(prompt, /AC1/);
  assert.match(prompt, /The export job runs on staging\./);
  assert.match(prompt, /Use this Mac only, not the staging server\./);
  assert.match(prompt, /when in doubt, choose manager/i);
});

test("parseDecisionAnswerTriageResponse reads one JSON object and throws OutputFormatError otherwise", () => {
  assert.deepEqual(parseDecisionAnswerTriageResponse(response(JSON.stringify(report()))), report());
  for (const stdout of ["", "no json here", "[1]", `${JSON.stringify(report())} ${JSON.stringify(report())}`]) {
    assert.throws(() => parseDecisionAnswerTriageResponse(response(stdout)), OutputFormatError, stdout);
  }
});

test("readDecisionAnswerTriage accepts a manager route with known ids and a worker route without rewrites", () => {
  assert.equal(readDecisionAnswerTriage(report(), ids).ok, true);
  assert.equal(readDecisionAnswerTriage(report({ criteria_rewrites: [] }), ids).ok, true);
  assert.equal(readDecisionAnswerTriage(report({ route: "worker", criteria_rewrites: [] }), ids).ok, true);
});

test("readDecisionAnswerTriage rejects bad shapes, unknown ids, duplicates and a worker with rewrites", () => {
  for (const value of [null, "manager", {}, report({ route: "other" }), report({ reason: "" }), report({ criteria_rewrites: "x" }), report({ criteria_rewrites: [{ criterion_id: "AC1" }] })]) {
    assert.equal(readDecisionAnswerTriage(value, ids).ok, false, JSON.stringify(value));
  }
  assert.equal(readDecisionAnswerTriage(report({ criteria_rewrites: [rewrite("AC9")] }), ids).ok, false);
  assert.equal(readDecisionAnswerTriage(report({ criteria_rewrites: [rewrite(), rewrite()] }), ids).ok, false);
  assert.equal(readDecisionAnswerTriage(report({ route: "worker" }), ids).ok, false);
});
