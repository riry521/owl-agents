import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";

/** workerPassed: a boolean is a stored legacy 1.0.0 report; a status string is a 1.1.0 report. */
function workerReport(workerPassed, invocationId) {
  const common = {
    kind: "report", invocation_id: invocationId, result: "success",
    work_done: "Done.", changes: [{ file: "code.mjs", action: "added" }], remaining_issues: [], next_action: "none",
    needs_replanning: false, question_for_manager: null,
  };
  if (typeof workerPassed === "boolean") {
    return { ...common, schema_version: "1.0.0", verification: { passed: workerPassed, method: "Checked." } };
  }
  return {
    ...common, schema_version: "1.1.0",
    verification: {
      status: workerPassed, method: "Checked.", checks: [], integration_check: null,
      acceptance: [{ criterion_id: "AC1", criterion: "Code exists.", status: workerPassed, evidence: "Looked." }],
    },
  };
}

/** Run one reviewed code Task and return its first verification outcome and the Reviewer run count. */
async function firstVerification(t, { workerPassed, projectExitCode }) {
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Implement", type: "code", acceptance: "Code exists.", depends_on: [], required_sections: [], required_tests: [], replaces: [] },
        ] } }
      : { outcome: "success", report_valid: true, report: { event: "work.completed", summary: "Done." } },
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "code.mjs"), "export {};\n");
      return {
        outcome: "success",
        report_valid: true,
        report: workerReport(workerPassed, request.invocation_id),
      };
    },
    runReviewer: async (request) => ({
      outcome: "success",
      report_valid: true,
      report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { root, db, core } = await createTestCore(t, { agentRunner }, { prefix: "owl-verification-and-" });
  const project = join(root, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const now = new Date().toISOString();
  const plan = projectExitCode === null ? [] : [{
    command_id: "project-check",
    argv: [process.execPath, "-e", `process.exit(${projectExitCode})`],
    cwd: ".", env_allowlist: [], timeout_seconds: 10, stdout_limit: 1024, stderr_limit: 1024, expected_exit_codes: [0], executor: "core",
  }];
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    transaction.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, ?, '[]', ?, ?)`,
      "project:and", "owner:default", "And", project, JSON.stringify([root]), JSON.stringify(plan), now, now,
    );
  });
  await core.start();
  await disablePlanQuality(db);
  const created = await core.createWork({
    request_id: createUlid(),
    idempotency_key: "test:and-create",
    expected_version: 0,
    payload: { title: "And", summary: "x", size: "normal", project_id: "project:and" },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, { request_id: createUlid(), idempotency_key: "test:and-start", expected_version: created.version, payload: { mode: "normal" } });
  // A Worker verification that is not passed is stopped by the completion gate before Core verification.
  const event = await waitFor(() => db.get("SELECT type, payload_json FROM events WHERE work_id = ? AND type IN ('verification.completed', 'task.failure.classified') ORDER BY rowid LIMIT 1", workId));
  assert.ok(event, "verification.completed or a gate failure was recorded");
  const outcome = event.type === "verification.completed" ? JSON.parse(event.payload_json).outcome : "fail";
  if (outcome === "pass") await waitFor(() => db.get("SELECT 1 AS n FROM agent_runs WHERE work_id = ? AND role = 'reviewer'", workId));
  else await new Promise((r) => setTimeout(r, 200));
  const reviewerRuns = db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ? AND role = 'reviewer'", workId).n;
  return { outcome, reviewerRuns };
}

test("a failing Worker verification fails the Task even when the Project checks pass", async (t) => {
  assert.deepEqual(await firstVerification(t, { workerPassed: false, projectExitCode: 0 }), { outcome: "fail", reviewerRuns: 0 });
});

test("a failing Project check fails the Task even when the Worker verification passed", async (t) => {
  assert.deepEqual(await firstVerification(t, { workerPassed: true, projectExitCode: 1 }), { outcome: "fail", reviewerRuns: 0 });
});

test("the Reviewer starts when the Worker verification and the Project checks both pass", async (t) => {
  const result = await firstVerification(t, { workerPassed: true, projectExitCode: 0 });
  assert.equal(result.outcome, "pass");
  assert.ok(result.reviewerRuns >= 1);
});

test("without a Project check the Worker verification decides", async (t) => {
  const result = await firstVerification(t, { workerPassed: true, projectExitCode: null });
  assert.equal(result.outcome, "pass");
  assert.ok(result.reviewerRuns >= 1);
});

test("schema 1.1.0: only status passed lets the Project checks and the Reviewer run; failed and blocked both fail the Task", async (t) => {
  const passed = await firstVerification(t, { workerPassed: "passed", projectExitCode: 0 });
  assert.equal(passed.outcome, "pass");
  assert.ok(passed.reviewerRuns >= 1);
  assert.deepEqual(await firstVerification(t, { workerPassed: "failed", projectExitCode: 0 }), { outcome: "fail", reviewerRuns: 0 });
  assert.deepEqual(await firstVerification(t, { workerPassed: "blocked", projectExitCode: 0 }), { outcome: "fail", reviewerRuns: 0 });
  assert.deepEqual(await firstVerification(t, { workerPassed: "blocked", projectExitCode: null }), { outcome: "fail", reviewerRuns: 0 });
});
