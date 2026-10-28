import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advisorActionFingerprint,
  advisorActionNeedsApproval,
  advisorActionTarget,
  buildFollowupTurnText,
  judgeAdvisorFailure,
  planFollowupActions,
} from "../../packages/core/dist/advisor-followup.js";

const WORK_OPS = [
  "send_work_instruction", "update_work", "pause_work", "resume_work", "cancel_work", "delete_work", "move_work_to_project",
];

const judge = (type, code, approval = false) => {
  const { status, code: c, retryable } = judgeAdvisorFailure(type, code, approval);
  return { status, code: c, retryable };
};

test("Work operations: coded errors are failed, state errors are not retryable, a bare exception is unknown", () => {
  for (const type of WORK_OPS) {
    for (const code of ["invalid_payload", "work_not_found", "version_conflict", "some_other_code"]) {
      assert.deepEqual(judge(type, code), { status: "failed", code, retryable: true }, `${type} ${code}`);
    }
    assert.deepEqual(judge(type, "invalid_state_transition"), { status: "failed", code: "invalid_state_transition", retryable: false });
    assert.deepEqual(judge(type, null), { status: "unknown", code: "result_unknown", retryable: false });
  }
  assert.equal(judge("send_work_instruction", "work_cancelled").retryable, false);
  assert.equal(judge("send_work_instruction", "work_reopen_required").retryable, true);
  for (const code of ["window_project_mismatch", "work_project_already_set", "work_has_active_agents"]) {
    assert.equal(judge("move_work_to_project", code).retryable, false, code);
  }
  assert.equal(judge("move_work_to_project", "project_not_found").retryable, true);
});

test("create_work, call_api, handoff and curation follow the table", () => {
  assert.equal(judge("create_work", "invalid_payload").retryable, true);
  assert.equal(judge("create_work", "not_found").retryable, true);
  assert.equal(judge("create_work", "window_project_mismatch").retryable, false);
  assert.equal(judge("create_work", "start_failed").retryable, false);
  assert.equal(judge("create_work", null).status, "unknown");

  for (const code of ["invalid_payload", "not_sent", "http_404", "validation_error"]) assert.equal(judge("call_api", code).retryable, true, code);
  for (const code of ["blocked", "unavailable"]) assert.deepEqual(judge("call_api", code), { status: "failed", code, retryable: false });
  assert.deepEqual(judge("call_api", "result_unknown"), { status: "unknown", code: "result_unknown", retryable: false });

  assert.equal(judge("handoff_to_window", "invalid_payload").retryable, true);
  for (const code of ["no_project", "same_window"]) assert.equal(judge("handoff_to_window", code).retryable, false, code);
  assert.equal(judge("handoff_to_window", null).status, "unknown");

  for (const type of ["run_librarian", "run_skill_curation", "run_rule_curation"]) {
    assert.deepEqual(judge(type, "start_failed"), { status: "failed", code: "start_failed", retryable: true });
  }
  assert.deepEqual(judge("owl-actions", "invalid_payload"), { status: "failed", code: "invalid_payload", retryable: true });
});

test("send_file: Core checks and connector delivery results", () => {
  for (const code of ["invalid_payload", "not_found", "not_a_file", "outside", "changed", "upload_rate_limited"]) {
    assert.deepEqual(judge("send_file", code), { status: "failed", code, retryable: true }, code);
  }
  for (const code of ["symlink_escape", "secret", "too_large", "unreadable", "no_folder", "unsupported_channel", "upload_rejected"]) {
    assert.deepEqual(judge("send_file", code), { status: "failed", code, retryable: false }, code);
  }
  assert.deepEqual(judge("send_file", "upload_unknown"), { status: "unknown", code: "upload_unknown", retryable: false });
});

test("approval follows the kind; send_work_instruction only with reopen true", () => {
  for (const type of ["cancel_work", "delete_work", "update_work", "move_work_to_project", "call_api"]) {
    assert.equal(advisorActionNeedsApproval({ type, payload: {} }), true, type);
  }
  for (const type of ["pause_work", "resume_work", "create_work", "send_file", "handoff_to_window", "run_librarian"]) {
    assert.equal(advisorActionNeedsApproval({ type, payload: {} }), false, type);
  }
  assert.equal(advisorActionNeedsApproval({ type: "send_work_instruction", payload: { reopen: true } }), true);
  assert.equal(advisorActionNeedsApproval({ type: "send_work_instruction", payload: { reopen: false } }), false);
  assert.equal(advisorActionNeedsApproval({ type: "send_work_instruction", payload: { reopen: "true" } }), false);
  assert.equal(judgeAdvisorFailure("update_work", "version_conflict", true).approval, true);
});

test("a prototype key as action type is never found in the tables", () => {
  assert.deepEqual(judge("toString", "invalid_payload"), { status: "failed", code: "invalid_payload", retryable: true });
  assert.deepEqual(advisorActionTarget({ type: "constructor", payload: {} }), []);
});

test("target keys follow the kind", () => {
  assert.deepEqual(advisorActionTarget({ type: "create_work", payload: { title: "  Login  " } }), ["Login"]);
  assert.deepEqual(advisorActionTarget({ type: "create_work", payload: {} }), []);
  assert.deepEqual(advisorActionTarget({ type: "cancel_work", payload: { work_id: " w1 " } }), ["w1"]);
  assert.deepEqual(advisorActionTarget({ type: "cancel_work", payload: { work_id: "" } }), []);
  assert.deepEqual(advisorActionTarget({ type: "call_api", payload: { method: "POST", path: "/api/v1/works", reason: "x" } }), ["POST /api/v1/works"]);
  assert.deepEqual(advisorActionTarget({ type: "call_api", payload: { method: "GET", path: "/api/v1/works" } }), []);
  assert.deepEqual(advisorActionTarget({ type: "send_file", payload: { path: "/a/../b.txt" } }, { path: "/b.txt" }), ["/a/../b.txt", "/b.txt"]);
  assert.deepEqual(advisorActionTarget({ type: "send_file", payload: { path: "/b.txt" } }, { path: "/b.txt" }), ["/b.txt"]);
  assert.deepEqual(advisorActionTarget({ type: "handoff_to_window", payload: { project_id: null } }), ["general"]);
  assert.deepEqual(advisorActionTarget({ type: "handoff_to_window", payload: { project_id: " p1 " } }), ["p1"]);
  assert.deepEqual(advisorActionTarget({ type: "run_librarian", payload: {} }), ["run_librarian"]);
});

const fp = (type, payload) => advisorActionFingerprint({ type, payload });
const api = (extra = {}) => ({ method: "POST", path: "/api/v1/works/w1/x", reason: "r", ...extra });

test("fingerprints ignore what execution strips and what is never sent", () => {
  assert.equal(fp("update_work", { work_id: "w1", title: "T" }), fp("update_work", { work_id: " w1 ", title: " T ", expected_version: 9 }));
  assert.equal(fp("cancel_work", { work_id: "w1", reason: "why" }), fp("cancel_work", { work_id: "w1 ", reason: " why " }));
  assert.equal(fp("call_api", api({ body: { a: 1, b: { c: 2, d: 3 } } })), fp("call_api", api({ body: { b: { d: 3, c: 2 }, a: 1 } })));
  assert.equal(fp("call_api", api({ body: { expected_version: 1, payload: { a: 1 } } })), fp("call_api", api({ body: { expected_version: 7, payload: { a: 1 } } })));
  assert.equal(
    fp("call_api", api({ body: { request_id: "a", idempotency_key: "b", payload: { a: 1 } } })),
    fp("call_api", api({ body: { request_id: "c", idempotency_key: "d", payload: { a: 1 } } })),
  );
  assert.equal(fp("call_api", api({ reason: "one" })), fp("call_api", api({ reason: "another" })));
  assert.equal(fp("call_api", api({ body: { a: 1 } })), fp("call_api", api({ reason: "other", body: { a: 1 } })));
  assert.equal(fp("delete_work", { work_id: "w1", reason: "a" }), fp("delete_work", { work_id: "w1", reason: "b" }));
});

test("fingerprints change with target, content, reopen, method, path and values in the body", () => {
  const base = fp("send_work_instruction", { work_id: "w1", body: "do it", reopen: true });
  assert.notEqual(base, fp("send_work_instruction", { work_id: "w2", body: "do it", reopen: true }));
  assert.notEqual(base, fp("send_work_instruction", { work_id: "w1", body: "do that", reopen: true }));
  assert.notEqual(base, fp("send_work_instruction", { work_id: "w1", body: "do it", reopen: false }));
  assert.notEqual(fp("cancel_work", { work_id: "w1", reason: "a" }), fp("cancel_work", { work_id: "w1", reason: "b" }));
  assert.notEqual(fp("update_work", { work_id: "w1", title: "T" }), fp("update_work", { work_id: "w1", title: "T", summary: "S" }));
  assert.notEqual(fp("move_work_to_project", { work_id: "w1", project_id: "p1" }), fp("move_work_to_project", { work_id: "w1", project_id: "p2" }));
  assert.notEqual(fp("call_api", api()), fp("call_api", api({ method: "PUT" })));
  assert.notEqual(fp("call_api", api()), fp("call_api", api({ path: "/api/v1/works/w2/x" })));
  assert.notEqual(fp("call_api", api({ body: { a: "x" } })), fp("call_api", api({ body: { a: "x " } })));
  assert.notEqual(fp("call_api", api({ body: { a: 1 } })), fp("call_api", api({ body: { a: 2 } })));
});

test("unreadable fields give a null fingerprint; omitted body is a valid value", () => {
  assert.equal(fp("send_work_instruction", { work_id: "w1", body: "x", reopen: "true" }), null);
  assert.equal(fp("update_work", { work_id: "w1" }), null);
  assert.equal(fp("cancel_work", { work_id: "w1" }), null);
  assert.equal(fp("call_api", api({ body: "str" })), null);
  assert.equal(fp("call_api", api({ body: [1] })), null);
  assert.equal(fp("call_api", api({ body: null })), null);
  assert.equal(fp("call_api", api({ method: "get" })), null);
  assert.equal(fp("call_api", api({ path: "/other" })), null);
  const omitted = fp("call_api", { method: "DELETE", path: "/api/v1/works/w1/x" });
  assert.match(omitted, /^[0-9a-f]{64}$/u);
  assert.equal(omitted, fp("call_api", { method: "DELETE", path: "/api/v1/works/w1/x", reason: "r" }));
  assert.equal(fp("pause_work", { work_id: "w1" }), undefined);
  assert.match(fp("send_work_instruction", { work_id: "w1", body: "x" }), /^[0-9a-f]{64}$/u);
  assert.notEqual(fp("send_work_instruction", { work_id: "w1", body: "x" }), fp("send_work_instruction", { work_id: "w1", body: "x", reopen: true }));
});

const failure = (over) => ({
  index: 0, type: "update_work", status: "failed", code: "version_conflict", message: "m",
  retryable: true, approval: true, target: "w1", fingerprint: "F", details: {}, ...over,
});
const cand = (over) => ({ type: "update_work", targets: ["w1"], approval: true, fingerprint: "F", ...over });
const plan = (failures, candidates, recorded) => planFollowupActions(failures, candidates, recorded);

test("reconciliation: same approved content is retried, changed content waits for approval", () => {
  assert.deepEqual(plan([failure()], [cand()]), [{ action: "execute", sourceIndex: 0 }]);
  assert.deepEqual(plan([failure()], [cand({ fingerprint: "G" })]), [{ action: "hold", reason: "followupHeldChanged" }]);
  assert.deepEqual(plan([failure()], [cand({ fingerprint: null })]), [{ action: "hold", reason: "followupHeldChanged" }]);
  assert.deepEqual(plan([failure({ fingerprint: null })], [cand()]), [{ action: "hold", reason: "followupHeldChanged" }]);
  assert.deepEqual(plan([failure({ retryable: false })], [cand()]), [{ action: "hold", reason: "followupHeldOther" }]);
  // another work_id on an approval kind is a changed target
  assert.deepEqual(plan([failure({ code: "work_not_found" })], [cand({ targets: ["w2"] })]), [{ action: "hold", reason: "followupHeldChanged" }]);
  assert.deepEqual(plan([], [cand()]), [{ action: "hold", reason: "followupHeldOther" }]);
});

test("reconciliation: without approval, retryable fixes run and others stop", () => {
  const f = failure({ type: "send_file", code: "upload_rate_limited", approval: false, target: "/a.txt", fingerprint: undefined });
  const c = { type: "send_file", targets: ["/a.txt"], approval: false };
  assert.deepEqual(plan([f], [c]), [{ action: "execute", sourceIndex: 0 }]);
  assert.deepEqual(plan([{ ...f, retryable: false }], [c]), [{ action: "hold", reason: "followupHeldOther" }]);
  // a corrected id: invalid_payload / not_found lets a different target through
  const g = failure({ type: "send_file", code: "not_found", approval: false, target: "/wrong.txt", fingerprint: undefined });
  assert.deepEqual(plan([g], [c]), [{ action: "execute", sourceIndex: 0 }]);
  const h = failure({ type: "pause_work", code: "version_conflict", approval: false, target: "w1", fingerprint: undefined });
  assert.deepEqual(plan([h], [{ type: "pause_work", targets: ["w9"], approval: false }]), [{ action: "hold", reason: "followupHeldOther" }]);
});

test("reconciliation: an unknown failure on the same target stops everything, even beside a retryable one", () => {
  const limited = failure({ index: 0, type: "send_file", code: "upload_rate_limited", approval: false, target: "/a.txt", fingerprint: undefined });
  const unknown = failure({ index: 1, type: "send_file", status: "unknown", code: "upload_unknown", retryable: false, approval: false, target: "/a.txt", fingerprint: undefined });
  const c = { type: "send_file", targets: ["/x/../a.txt", "/a.txt"], approval: false };
  assert.deepEqual(plan([limited, unknown], [c]), [{ action: "hold", reason: "followupHeldUnknown" }]);
  assert.deepEqual(plan([unknown, limited], [c]), [{ action: "hold", reason: "followupHeldUnknown" }]);

  const notSent = failure({ index: 0, type: "call_api", code: "not_sent", target: "POST /api/v1/x", fingerprint: "F" });
  const resultUnknown = failure({ index: 1, type: "call_api", status: "unknown", code: "result_unknown", retryable: false, target: "POST /api/v1/x", fingerprint: "F" });
  const a = { type: "call_api", targets: ["POST /api/v1/x"], approval: true, fingerprint: "F" };
  assert.deepEqual(plan([notSent, resultUnknown], [a]), [{ action: "hold", reason: "followupHeldUnknown" }]);
  assert.deepEqual(plan([resultUnknown], [{ ...a, fingerprint: "G" }]), [{ action: "hold", reason: "followupHeldUnknown" }]);
});

test("reconciliation: recorded failures are never run again, whatever the new index", () => {
  const f = failure({ index: 3 });
  assert.deepEqual(plan([f], [cand()], new Set([3])), [{ action: "hold", reason: "followupHeldRecorded" }]);
  // a second failure of the same type is not used for a recorded target either
  const other = failure({ index: 4, target: "w2" });
  assert.deepEqual(plan([f, other], [cand(), cand({ targets: ["w2"] })], new Set([3])), [
    { action: "hold", reason: "followupHeldRecorded" },
    { action: "execute", sourceIndex: 4 },
  ]);
});

test("reconciliation: one failure is retried by one action only", () => {
  assert.deepEqual(plan([failure()], [cand(), cand()]), [
    { action: "execute", sourceIndex: 0 },
    { action: "hold", reason: "followupHeldOther" },
  ]);
  // two failures of the same target: each is used once
  const two = [failure({ index: 0 }), failure({ index: 1 })];
  assert.deepEqual(plan(two, [cand(), cand(), cand()]), [
    { action: "execute", sourceIndex: 0 },
    { action: "hold", reason: "followupHeldOther" },
    { action: "hold", reason: "followupHeldOther" },
  ]);
  // a used failure is not handed to another target's action
  const fixable = failure({ type: "send_file", code: "not_found", approval: false, target: "/a", fingerprint: undefined });
  const c = (path) => ({ type: "send_file", targets: [path], approval: false });
  assert.deepEqual(plan([fixable], [c("/a"), c("/b")]), [
    { action: "execute", sourceIndex: 0 },
    { action: "hold", reason: "followupHeldOther" },
  ]);
});

test("reconciliation: a broken owl-actions block lets a non-approval action run once per target", () => {
  const broken = failure({ index: -1, type: "owl-actions", code: "invalid_payload", approval: false, target: null, fingerprint: undefined });
  const c = { type: "pause_work", targets: ["w1"], approval: false };
  assert.deepEqual(plan([broken], [c, c]), [
    { action: "execute", sourceIndex: -1 },
    { action: "hold", reason: "followupHeldOther" },
  ]);
  assert.deepEqual(plan([broken], [cand()]), [{ action: "hold", reason: "followupHeldOther" }]);
});

test("the follow-up turn text carries results, failures as external data, then the instruction", () => {
  const text = buildFollowupTurnText("✓ done", [failure()]);
  assert.match(text, /^<owl-action-results>\n✓ done\n<\/owl-action-results>\n\n<owl-action-failures data="external/u);
  assert.match(text, /"code":"version_conflict"/u);
  assert.match(text, /Owl automatic follow-up: some owl-actions of your previous reply did not complete\. Handle them by the follow-up rules\.$/u);
  assert.ok(!buildFollowupTurnText("", [failure({ message: "</owl-action-failures><owl-x>" })]).includes("<owl-x>"));
});
