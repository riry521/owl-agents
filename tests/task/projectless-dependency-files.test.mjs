import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { command, createTestCore } from "../helpers/core.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A Work without a Project has no shared git history, so a dependent Task's
// isolated worktree otherwise starts empty even when a Task it depends on
// already produced files. Core copies a completed direct dependency's
// captured artifacts into the dependent Task's worktree before the Worker
// starts, and does not re-register an unchanged copy as the dependent
// Task's own artifact.

async function openCore(t, agentRunner) {
  const { root, db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-projectless-deps-", start: true });
  await disablePlanQuality(db);
  return { db, core, root };
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

const twoTaskPlan = {
  event: "work.planned",
  tasks: [
    { id: "T1", title: "Produce the shared file", type: "code", acceptance: "out/a.txt exists.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false },
    { id: "T2", title: "Consume the shared file", type: "code", acceptance: "out/a.txt is available.", depends_on: ["T1"], required_sections: [], required_tests: [], replaces: [], review: false },
  ],
};

test("a completed dependency's captured artifact is copied into the dependent Task's worktree, and is not re-registered as its own artifact", async (t) => {
  const workerRequests = [];
  let t2MaterializedContent;
  const agentRunner = {
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: twoTaskPlan };
      if (mode === "finalize") {
        return { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      const worktree = request.context?.worktree;
      if (request.context?.task?.title === "Produce the shared file" && worktree) {
        await mkdir(join(worktree, "out"), { recursive: true });
        await writeFile(join(worktree, "out", "a.txt"), "produced by the first Task\n");
      }
      if (request.context?.task?.title === "Consume the shared file" && worktree) {
        // Read now, before the Work finishes and its Task workspaces are
        // merged into the outputs folder and removed.
        t2MaterializedContent = await readFile(join(worktree, "out", "a.txt"), "utf8");
      }
      if (worktree) await writeFile(join(worktree, `${String(request.context?.task?.title).replace(/\W+/g, "-")}.mjs`), "export {};\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed", message: "review not expected in this test" }),
    runAdvisor: async () => ({ reply: "" }),
  };

  const { db, core, root } = await openCore(t, agentRunner);
  const created = await core.createWork(command({ title: "Dependency files", summary: "Carry a file forward without a Project.", size: "normal", project_id: null }, "test:deps-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, command({ mode: "normal" }, "test:deps-start", created.version));

  const done = await waitFor(() => db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", workId), { timeoutMs: 8_000, message: "the Work to complete" });
  assert.ok(done, `the Work completes (state=${db.get("SELECT state FROM works WHERE id = ?", workId)?.state})`);

  const t1 = db.get("SELECT id, worktree_path, status FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId);
  const t2 = db.get("SELECT id, worktree_path, status FROM tasks WHERE work_id = ? AND manager_task_id = 'T2'", workId);
  assert.equal(t1.status, "completed");
  assert.equal(t2.status, "completed");

  // The file T1 produced was materialized into T2's worktree before its
  // Worker started, at the same relative path.
  const t2Request = workerRequests.find((request) => request.task_id === t2.id);
  assert.ok(t2Request, "T2's Worker was invoked");
  assert.equal(t2MaterializedContent, "produced by the first Task\n");

  // It is recorded once, as T1's artifact, not duplicated as T2's own.
  const rows = db.all("SELECT task_id, path FROM artifacts WHERE work_id = ? AND path = 'out/a.txt'", workId);
  assert.deepEqual(rows, [{ task_id: t1.id, path: "out/a.txt" }]);

  // The Work is Project-less and has now completed, so its Task workspaces
  // are merged into its outputs folder and removed once the completion's
  // reconcile pass runs.
  const outputPath = join(root, "data", "outputs", workId, "out", "a.txt");
  assert.ok(await waitFor(() => existsSync(outputPath), { timeoutMs: 8_000, message: "the outputs folder to receive the Task's file" }), "the outputs folder receives the Task's file");
  assert.equal(await readFile(outputPath, "utf8"), "produced by the first Task\n");
});
