import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { NoopGitGateway } from "../../packages/core/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

/** A GitGateway whose Task worktree holds one changed file that no Worker run touches. */
class FixedWorktreeGit extends NoopGitGateway {
  constructor(worktree) {
    super();
    this.worktree = worktree;
  }
  async prepareWorktree(request) {
    return { ...(await super.prepareWorktree(request)), worktree_path: this.worktree };
  }
  async changedPaths() {
    return ["a.mjs"];
  }
}

function workerReport(invocationId) {
  return {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Done.",
    changes: [],
    verification: { passed: true, method: "Checked." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
}

function reviewResult(verdict) {
  const review = verdict === "pass"
    ? { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } }
    : {
        verdict,
        summary: "The report needs the commands.",
        findings: [{ severity: "major", subject: "other", file: "", problem: "The report leaves out the commands.", fix: "List them." }],
        tests: { ran: false, command: "none", passed: 0, failed: 0 },
      };
  return { outcome: verdict === "pass" ? "success" : "failed", report_valid: true, report: review, review };
}

test("a fix round that leaves the files unchanged still completes the Task", async (t) => {
  const worktree = await tempDir(t, "owl-artifact-fix-round-wt-");
  await writeFile(join(worktree, "a.mjs"), "export {};\n");
  let workerCalls = 0;
  let reviewerCalls = 0;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if ((request.mode ?? request.context?.mode) === "plan") {
        return {
          outcome: "success",
          report_valid: true,
          report: { event: "work.planned", tasks: [{ id: "T1", title: "A", type: "code", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true }] },
        };
      }
      return {
        outcome: "success",
        report_valid: true,
        report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } },
      };
    },
    runWorker: async (request) => {
      workerCalls += 1;
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => {
      reviewerCalls += 1;
      return reviewResult(reviewerCalls === 1 ? "fix_required" : "pass");
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createTestCore(t, { agentRunner, git: new FixedWorktreeGit(worktree), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-artifact-fix-round-", start: true });
  await disablePlanQuality(db);
  const created = await core.createWork(command({ title: "fix round", summary: "Re-run a Worker without file changes.", size: "normal", project_id: null }, "test:create"));
  await core.startWork(created.data.work_id, command({ mode: "normal" }, "test:start", created.version));

  const task = await waitFor(() => db.get("SELECT status FROM tasks WHERE manager_task_id = 'T1' AND status = 'completed'"), { timeoutMs: 5_000, message: "the Task to complete after the fix round" });
  assert.ok(task, "the Task completes after the fix round");
  assert.equal(workerCalls, 2);
  assert.equal(reviewerCalls, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.crashed'").n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'artifact.created'").n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM artifacts WHERE path = 'a.mjs'").n, 1);
});
