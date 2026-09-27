import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixContext } from "../packages/core/dist/task-context.js";
import { normalizeReviewerVerdict } from "../packages/core/dist/workflow-engine.js";

test("Worker review findings include only major findings, treating missing severity as major", () => {
  const findings = [
    { severity: "major", problem: "blocking" },
    { severity: "minor", problem: "polish" },
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
