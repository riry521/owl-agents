import assert from "node:assert/strict";
import test from "node:test";
import { readStoredReport, validateReportEnvelope, validateReportSemantics } from "../dist/index.js";
import { normalizeWorkerResponse, normalizeWorkerResponseWithFeedback } from "../dist/worker.js";

const ac = (id, status = "passed") => ({ criterion_id: id, criterion: `criterion ${id}`, status, evidence: `evidence ${id}` });

const verification = (over = {}) => ({
  status: "passed",
  method: "Ran the tests.",
  acceptance: [ac("AC1"), ac("AC2")],
  checks: [{ name: "typecheck", status: "passed", evidence: "no errors" }],
  integration_check: null,
  ...over,
});

const report = (over = {}) => ({
  kind: "report",
  schema_version: "1.1.0",
  invocation_id: "run-1",
  result: "success",
  work_done: "Done.",
  delegation: { decomposition: "One unit.", delegated: [], retained: [{ part: "All", reason: "Small" }] },
  changes: [],
  verification: verification(),
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: null,
  ...over,
});

const reason = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.message + " " + (error.reason ?? "");
  }
  return null;
};

test("structured verification (1.1.0) parses", () => {
  const parsed = validateReportEnvelope(report());
  assert.equal(parsed.schema_version, "1.1.0");
  assert.equal(parsed.verification.acceptance.length, 2);
  assert.equal(reason(() => validateReportSemantics(parsed)), null);
});

test("evidence or criterion missing or empty is rejected", () => {
  for (const key of ["evidence", "criterion"]) {
    const empty = { ...ac("AC1"), [key]: "  " };
    assert.match(reason(() => validateReportEnvelope(report({ verification: verification({ acceptance: [empty] }) }))), /acceptance_invalid/);
    const { [key]: _gone, ...missing } = ac("AC1");
    assert.match(reason(() => validateReportEnvelope(report({ verification: verification({ acceptance: [missing] }) }))), /acceptance_invalid/);
  }
});

test("shape rules: duplicate ids, empty AC list, bad status, extra fields, empty method, check shapes", () => {
  const bad = (v, pattern) => assert.match(reason(() => validateReportEnvelope(report({ verification: v }))), pattern);
  bad(verification({ acceptance: [ac("AC1"), ac("AC1")] }), /criterion_id_duplicate/);
  bad(verification({ acceptance: [] }), /acceptance_empty/);
  bad(verification({ status: "ok" }), /status_invalid/);
  bad(verification({ acceptance: [ac("AC1", "done")] }), /acceptance_invalid/);
  bad({ ...verification(), extra: 1 }, /verification_invalid/);
  bad(verification({ method: "" }), /method_invalid/);
  bad(verification({ checks: [{ name: "build", status: "passed" }] }), /checks_invalid/);
  bad(verification({ integration_check: { status: "passed" } }), /integration_invalid/);
  bad(verification({ integration_check: { status: "maybe", evidence: "x" } }), /integration_invalid/);
  assert.equal(validateReportEnvelope(report({ verification: verification({ integration_check: { status: "passed", evidence: "built" } }) })).verification.integration_check.status, "passed");
});

test("success with a failed verification is rejected", () => {
  const failed = validateReportEnvelope(report({ verification: verification({ status: "failed", acceptance: [ac("AC1", "failed")] }) }));
  assert.match(reason(() => validateReportSemantics(failed)), /success_with_verification_failed/);
  const itemFailed = validateReportEnvelope(report({ verification: verification({ acceptance: [ac("AC1"), ac("AC2", "failed")] }) }));
  assert.match(reason(() => validateReportSemantics(itemFailed)), /success_with_failed_item/);
});

test("success with a blocked verification is rejected, and blocked is not failed", () => {
  const blocked = validateReportEnvelope(report({ verification: verification({ status: "blocked", acceptance: [ac("AC1", "blocked")] }) }));
  assert.match(reason(() => validateReportSemantics(blocked)), /success_with_verification_blocked/);
  const partial = validateReportEnvelope(report({ result: "partial", verification: verification({ status: "blocked", acceptance: [ac("AC1", "blocked")] }) }));
  assert.equal(reason(() => validateReportSemantics(partial)), null);
});

test("success with needs_replanning or a question is rejected", () => {
  assert.match(reason(() => validateReportSemantics(validateReportEnvelope(report({ needs_replanning: true })))), /needs_replanning/);
  assert.match(reason(() => validateReportSemantics(validateReportEnvelope(report({ question_for_manager: "Which?" })))), /question_for_manager/);
});

const delegatedReport = () => ({
  ...report().delegation,
  delegated: [{ child_id: "c1", instruction: "do", provider: "claude", model: "sonnet" }],
});

test("Hybrid: ok needs a passed integration check; retry needs retry_subtasks", () => {
  const noIntegration = validateReportEnvelope(report());
  const delegation = delegatedReport();
  const delegatedNoIntegration = validateReportEnvelope(report({ delegation }));
  assert.match(reason(() => validateReportSemantics(delegatedNoIntegration, { verdict: "ok", retry_subtasks: [] })), /hybrid_ok_without_passed_integration/);
  const failedIntegration = validateReportEnvelope(report({ delegation, verification: verification({ integration_check: { status: "failed", evidence: "x" } }) }));
  assert.match(reason(() => validateReportSemantics(failedIntegration, { verdict: "ok", retry_subtasks: [] })), /hybrid_ok_without_passed_integration/);
  const passedIntegration = validateReportEnvelope(report({ verification: verification({ integration_check: { status: "passed", evidence: "x" } }) }));
  assert.equal(reason(() => validateReportSemantics(passedIntegration, { verdict: "ok", retry_subtasks: [] })), null);
  assert.match(reason(() => validateReportSemantics(noIntegration, { verdict: "retry", retry_subtasks: [] })), /hybrid_retry_without_subtasks/);
  assert.equal(reason(() => validateReportSemantics(noIntegration, { verdict: "retry", retry_subtasks: [{ subtask_id: "s1" }] })), null);
});

const legacy = () => report({ schema_version: "1.0.0", verification: { passed: true, method: "Checked." } });

test("a stored legacy 1.0.0 report is still readable", () => {
  const stored = readStoredReport(legacy());
  assert.equal(stored.schema_version, "1.0.0");
  assert.equal(stored.verification.passed, true);
  assert.equal(readStoredReport(report()).schema_version, "1.1.0");
});

test("Hybrid success without delegated children passes with integration_check null", () => {
  assert.doesNotThrow(() => validateReportSemantics(report(), { verdict: "ok", retry_subtasks: [] }));
});

test("Hybrid success with delegated children still needs a passed integration_check", () => {
  for (const integration_check of [null, { status: "failed", evidence: "x" }]) {
    const r = validateReportEnvelope(report({ delegation: delegatedReport(), verification: verification({ integration_check }) }));
    assert.match(reason(() => validateReportSemantics(r, { verdict: "ok", retry_subtasks: [] })), /hybrid_ok_without_passed_integration/);
  }
});

test("new agent output in the legacy format is a contract failure", () => {
  assert.match(reason(() => validateReportEnvelope(legacy())), /report_schema_version_legacy/);
  const response = { adapter: "claude-cli/v1", stdout: JSON.stringify({ ...legacy(), pending_process: null, external_blocker: null }), format: "plain-text" };
  assert.match(reason(() => normalizeWorkerResponse(response, "run-1")), /worker_output_schema:schema_version:not_one_of_1.1.0/);
});

// The Worker acceptance path: provider stdout -> normalizeWorkerResponseWithFeedback, the
// function that decides whether a Worker report is accepted. Hybrid is its third argument.
// The Worker points at criteria by id only; the stored `criterion` text comes from the Task.
const CRITERIA = [{ id: "AC1", text: "first criterion", check: "c", serves: "s", if_omitted: "i", check_weight: "light", weight_reason: "" }, { id: "AC2", text: "second criterion", check: "c", serves: "s", if_omitted: "i", check_weight: "light", weight_reason: "" }];
const TASK = { acceptance: "(1) first criterion\n(2) second criterion", acceptance_criteria: CRITERIA };
const idOnly = (payload) => ({ ...payload, verification: { ...payload.verification, acceptance: payload.verification.acceptance.map(({ criterion: _text, ...item }) => item) } });
const accept = (payload, hybrid = false, task = TASK) =>
  normalizeWorkerResponseWithFeedback({ adapter: "claude-cli/v1", stdout: JSON.stringify({ ...idOnly(payload), pending_process: null, external_blocker: null }), format: "plain-text" }, "run-1", hybrid, task).report;

test("Worker acceptance takes criterion ids and fills the criterion text from the Task", () => {
  assert.deepEqual(accept(report()).verification.acceptance.map((item) => item.criterion), ["first criterion", "second criterion"]);
});

test("Worker acceptance rejects an unknown, missing or duplicated criterion id", () => {
  const withIds = (...ids) => report({ verification: verification({ acceptance: ids.map((id) => ac(id)) }) });
  for (const bad of [withIds("AC1", "AC9"), withIds("AC1"), withIds("AC1", "AC2", "AC2")]) {
    assert.match(reason(() => accept(bad)), /report_invalid|worker_acceptance_criterion_ids/);
  }
  assert.throws(() => accept(withIds("AC1", "AC9")), (error) => error.code === "report_invalid" && /worker_acceptance_criterion_ids:unknown=\[AC9\],missing=\[AC2\]/.test(error.reason));
  const restated = report({ verification: verification({ acceptance: [{ ...ac("AC1"), criterion: "first criterion" }, ac("AC2")] }) });
  const raw = { adapter: "claude-cli/v1", stdout: JSON.stringify({ ...restated, pending_process: null, external_blocker: null }), format: "plain-text" };
  assert.match(reason(() => normalizeWorkerResponseWithFeedback(raw, "run-1", false, TASK)), /worker_output_schema/);
});

test("a legacy free-text Task reads as AC1 and a report that points at AC1 is accepted", () => {
  const legacyTask = { acceptance: "do the thing", acceptance_criteria: [{ id: "AC1", text: "do the thing", check: "", serves: "", if_omitted: "", check_weight: null, weight_reason: "", legacy: true }] };
  const one = report({ verification: verification({ acceptance: [ac("AC1")] }) });
  assert.equal(accept(one, false, legacyTask).verification.acceptance[0].criterion, "do the thing");
  assert.match(reason(() => accept(report(), false, legacyTask)), /worker_acceptance_criterion_ids/);
});

test("Worker acceptance lowers a success report that its verification contradicts to partial", () => {
  const failed = report({ verification: verification({ status: "failed", acceptance: [ac("AC1", "failed"), ac("AC2")] }) });
  assert.equal(accept(failed).result, "partial");
  const blocked = report({ verification: verification({ status: "blocked", acceptance: [ac("AC1", "blocked"), ac("AC2")] }) });
  assert.equal(accept(blocked).result, "partial");
  const failedItem = report({ verification: verification({ acceptance: [ac("AC1"), ac("AC2", "failed")] }) });
  assert.equal(accept(failedItem).result, "partial");
  const replan = accept(report({ needs_replanning: true }));
  assert.deepEqual([replan.result, replan.needs_replanning], ["partial", true]);
  const asked = accept(report({ question_for_manager: "Which?" }));
  assert.deepEqual([asked.result, asked.question_for_manager], ["partial", "Which?"]);
  assert.equal(accept(report()).result, "success");
});

test("Worker acceptance lowers a Hybrid success with delegated children and no passed integration_check to partial", () => {
  for (const integration_check of [null, { status: "failed", evidence: "x" }]) {
    const delegated = report({ delegation: delegatedReport(), verification: verification({ integration_check }) });
    assert.equal(accept(delegated, true).result, "partial");
    // Outside Hybrid the same report is not subject to the integration rule.
    assert.equal(accept(delegated, false).result, "success");
  }
});

test("Worker acceptance accepts a Hybrid success with a passed integration_check or without delegated children", () => {
  const integrated = report({ delegation: delegatedReport(), verification: verification({ integration_check: { status: "passed", evidence: "x" } }) });
  assert.equal(accept(integrated, true).delegation.delegated.length, 1);
  assert.equal(accept(report(), true).verification.integration_check, null);
});
