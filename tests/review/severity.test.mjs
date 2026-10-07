import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixContext } from "../../packages/core/dist/task-context.js";
import { buildDesignerRolePrompt, buildWorkerPrompt } from "../../packages/agent-runtime/dist/worker.js";
import { buildReviewerPrompt } from "../../packages/agent-runtime/dist/reviewer.js";
import { normalizeReviewFindings, normalizeReviewerVerdict } from "../../packages/core/dist/workflow-engine.js";

test("Worker review findings include only major findings, treating missing severity as major", () => {
  const findings = [
    { severity: "major", subject: "other", problem: "blocking" },
    { severity: "minor", subject: "other", problem: "polish" },
    { problem: "legacy finding" },
    { severity: "unknown", problem: "unclassified" },
  ];
  const db = {
    get(sql) {
      if (sql.includes("MAX(events.sequence)")) return { boundary: null };
      if (sql.includes("FROM events")) {
        return {
          type: "review.failed",
          agent_run_id: "reviewer-run",
          payload_json: JSON.stringify({ agent_run_id: "reviewer-run", review: { verdict: "fix_required" } }),
        };
      }
      if (sql.includes("FROM reviews")) {
        return {
          verdict: "fix_required",
          findings_json: JSON.stringify(findings),
          verification_report_json: JSON.stringify({ report: { result: "success" } }),
        };
      }
      return undefined;
    },
    all() { return []; },
  };

  assert.deepEqual(loadFixContext(db, "task-id"), {
    previous_report: { result: "success" },
    reviewer_findings: [findings[0], findings[2], findings[3]],
  });
});

test("a fix_required verdict with only minor findings normalizes to pass", () => {
  assert.equal(normalizeReviewerVerdict("fix_required", [{ severity: "minor" }]), "pass");
});

test("major or unclassified findings keep fix_required, and replan_required is unchanged", () => {
  assert.equal(normalizeReviewerVerdict("fix_required", [{ severity: "minor" }, { severity: "major" }]), "fix_required");
  assert.equal(normalizeReviewerVerdict("fix_required", [{ severity: "minor" }, {}]), "fix_required");
  assert.equal(normalizeReviewerVerdict("replan_required", [{ severity: "minor" }]), "replan_required");
});

const judge = (verdict, findings) => normalizeReviewerVerdict(verdict, normalizeReviewFindings(findings));

test("a major finding that only asks for work beyond the acceptance criteria does not send the Task back", () => {
  const beyond = { severity: "major", scope: "beyond_acceptance", problem: "add an extra test" };
  const inScope = { severity: "major", scope: "in_scope", problem: "criterion 2 fails" };
  assert.equal(judge("fix_required", [beyond]), "pass");
  assert.equal(normalizeReviewFindings([beyond])[0].severity, "minor");
  assert.equal(judge("fix_required", [inScope, beyond]), "fix_required");
  assert.equal(judge("replan_required", [beyond]), "pass");
  assert.equal(judge("replan_required", [beyond, inScope]), "replan_required");
});

test("a major finding on overbuilt work still sends the Task back", () => {
  assert.equal(judge("fix_required", [{ severity: "major", scope: "overbuilt", problem: "45 minute full run added" }]), "fix_required");
});

test("Worker, Designer and Reviewer prompts carry the necessity policy", () => {
  const task = { id: "T1", work_id: "W1", title: "t", type: "code", acceptance: "(1) a", status: "running" };
  assert.match(buildWorkerPrompt({ task }, "en"), /Do only what the Task's acceptance criteria and context need/);
  assert.match(buildWorkerPrompt({ task }, "en", null, true), /optional proposal/);
  const design = { ...task, type: "design" };
  assert.match(buildDesignerRolePrompt({ task: design, context: { design_document_path: "/tmp/d.md", reviewer_findings: [] } }), /Design only what the Task's acceptance criteria/);
  const prompt = buildReviewerPrompt({ task, report: {}, review_round: 1 }, "en");
  assert.match(prompt, /beyond_acceptance/);
  assert.match(prompt, /overbuilt/);
});
