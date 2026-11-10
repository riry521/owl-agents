import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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
    schema_version: "1.1.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Done.",
    changes: [],
    verification: { status: "passed", acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "ok" }], checks: [], method: "Checked.", integration_check: null },
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
  // A Project-less Work still archives the bytes for its dependent Tasks.
  assert.ok(db.get("SELECT storage_path FROM artifacts WHERE path = 'a.mjs'").storage_path);
});

test("pruning data/artifacts removes Project and expired finished Work folders, and keeps running, recent and uploaded files", async (t) => {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-artifact-prune-" });
  const day = 86_400_000;
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 20 * day).toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", nowIso, nowIso);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES ('P1', 'owner:default', 'P', '/tmp/p1', 'main', '[]', '{}', '[]', ?, ?)`,
      nowIso, nowIso,
    );
    const work = (id, projectId, state, updatedAt) => tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', ?, 'w', '', 'normal', ?, '[]', '[]', ?, ?)`,
      id, projectId, state, updatedAt, updatedAt,
    );
    work("W-project", "P1", "running", nowIso);
    work("W-running", null, "running", oldIso);
    work("W-recent", null, "completed", nowIso);
    work("W-old", null, "completed", oldIso);
  });
  for (const id of ["W-project", "W-running", "W-recent", "W-old", "W-deleted"]) {
    await mkdir(join(root, "data", "artifacts", id, "T1"), { recursive: true });
    await writeFile(join(root, "data", "artifacts", id, "T1", "hash"), "x");
  }
  await mkdir(join(root, "data", "uploads"), { recursive: true });
  await writeFile(join(root, "data", "uploads", "received.txt"), "from the Owner");

  const removed = await core.workflow.pruneStoredArtifacts(14 * day);

  assert.deepEqual(removed.sort(), ["W-deleted", "W-old", "W-project"]);
  assert.deepEqual((await readdir(join(root, "data", "artifacts"))).sort(), ["W-recent", "W-running"]);
  assert.equal(existsSync(join(root, "data", "uploads", "received.txt")), true);
});
