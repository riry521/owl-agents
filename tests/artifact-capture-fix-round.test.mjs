import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core, NoopGitGateway } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: `test:${suffix}:${createUlid()}`, expected_version: expectedVersion, payload };
}

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
    return ["a.txt"];
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
        findings: [{ severity: "major", pre_existing: false, file: "", problem: "The report leaves out the commands.", fix: "List them." }],
        tests: { ran: false, command: "none", passed: 0, failed: 0 },
      };
  return { outcome: verdict === "pass" ? "success" : "failed", report_valid: true, report: review, review };
}

async function waitFor(read, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a fix round that leaves the files unchanged still completes the Task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-artifact-fix-round-"));
  const worktree = await mkdtemp(join(tmpdir(), "owl-artifact-fix-round-wt-"));
  await writeFile(join(worktree, "a.txt"), "same contents\n");
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  let workerCalls = 0;
  let reviewerCalls = 0;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if ((request.mode ?? request.context?.mode) === "plan") {
        return {
          outcome: "success",
          report_valid: true,
          report: { event: "work.planned", tasks: [{ id: "T1", title: "A", type: "code", acceptance: "Done.", depends_on: [], replaces: [], review: true }] },
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
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, git: new FixedWorktreeGit(worktree), dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "fix round", summary: "Re-run a Worker without file changes.", size: "normal", project_id: null }, "create"));
  await core.startWork(created.data.work_id, commandEnvelope({ mode: "normal" }, "start", created.version));

  const task = await waitFor(() => db.get("SELECT status FROM tasks WHERE manager_task_id = 'T1' AND status = 'completed'"));
  assert.ok(task, "the Task completes after the fix round");
  assert.equal(workerCalls, 2);
  assert.equal(reviewerCalls, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.crashed'").n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'artifact.created'").n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM artifacts WHERE path = 'a.txt'").n, 1);
});
