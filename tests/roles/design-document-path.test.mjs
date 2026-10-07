import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { designDocumentPath } from "../../packages/shared/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { necessityFor, criteriaFor } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

test("design document paths stay under the data directory and use work/task ids", () => {
  assert.equal(
    designDocumentPath("/var/lib/owl/data", "01WORK", "01TASK"),
    "/var/lib/owl/data/designs/01WORK/01TASK.md",
  );
  assert.equal(designDocumentPath("/var/lib/owl/data", "../escape", "01TASK"), "/var/lib/owl/data/designs/___escape/01TASK.md");
  assert.equal(designDocumentPath("/var/lib/owl/data", "01WORK"), "/var/lib/owl/data/designs/01WORK");
});

// design_completed: once every design Task of a Work is completed, Core calls the
// Manager once with those Tasks; the implementation Tasks it returns join the plan
// and the final check comes after them.

const managerTask = (id, type, dependsOn = []) => ({
  id, title: `${id} title`, type, necessity: necessityFor(), acceptance_criteria: criteriaFor("Done; verified by the test."),
  depends_on: dependsOn, context: "", notes: "", review: false, required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [],
});

const workerReport = (invocationId, files) => ({
  kind: "report", schema_version: "1.1.0", invocation_id: invocationId, result: "success", work_done: "Done.",
  changes: files.map((file) => ({ file, action: "added" })), remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
  verification: {
    status: "passed", method: "Checked.", checks: [], integration_check: null,
    acceptance: [{ criterion_id: "AC1", criterion: "Done.", status: "passed", evidence: "Looked." }],
  },
});

/** A stub Manager that logs each call and answers design_completed with `implement`. */
function stubRunner(calls, { firstPlan, implement, gate, writeDesign = false }) {
  return {
    runManagerPlan: async (request) => {
      const trigger = request.context?.trigger ?? request.trigger;
      const kind = request.mode === "finalize" ? "final_check" : request.mode === "replan" ? trigger.kind : "initial_plan";
      calls.push({ kind, ids: trigger?.design_task_ids ?? null, documents: request.context?.design_documents ?? null });
      if (kind === "final_check") {
        return { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
      }
      if (kind === "design_completed") return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: implement } };
      return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: firstPlan } };
    },
    runDesigner: async (request) => {
      if (writeDesign) {
        await writeFile(request.context.design_document_path, "# Design\n\nDone.\n");
        return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, []) };
      }
      await gate.promise;
      return { outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" };
    },
    runWorker: async (request) => {
      if (gate.hold) await gate.promise;
      // A code Task must leave a changed file in its worktree to pass Core's output check.
      const file = "out.mjs";
      await writeFile(join(request.context.worktree, file), "export const x = 1;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [file]) };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function startPlannedWork(t, calls, options) {
  let release;
  const gate = { promise: new Promise((resolveGate) => { release = resolveGate; }), hold: options.hold ?? false };
  t.after(() => release());
  const { db, core, root } = await createTestCore(t, {
    agentRunner: stubRunner(calls, { ...options, gate }),
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-design-completed-", start: true });
  const created = await core.createWork(command({ title: "W", summary: "x", size: "normal", project_id: null, ...(options.designMode ? { design_mode: options.designMode } : {}) }, `test:create:${createUlid()}`));
  const workId = created.data.work_id;
  core.startWork(workId, command({ mode: "normal" }, `test:start:${createUlid()}`, created.version)).catch(() => {});
  await waitFor(() => db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n >= options.firstPlan.length);
  const complete = (managerId) => db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'completed' WHERE work_id = ? AND manager_task_id = ?", workId, managerId);
    return null;
  });
  return { db, core, root, workId, complete };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

test("design_completed is sent once after both design Tasks complete, and the returned code Task runs before final_check", async (t) => {
  const calls = [];
  const { db, workId, complete } = await startPlannedWork(t, calls, {
    firstPlan: [managerTask("D1", "design"), managerTask("D2", "design")],
    implement: [managerTask("I1", "code", ["D1", "D2"])],
  });
  await complete("D1");
  await sleep(300);
  assert.deepEqual(calls.map((call) => call.kind), ["initial_plan"], "one design Task still open: no call yet");
  await complete("D2");
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed", { timeoutMs: 10_000 });
  assert.deepEqual(calls.map((call) => call.kind), ["initial_plan", "design_completed", "final_check"]);
  const ids = db.all("SELECT id FROM tasks WHERE work_id = ? AND type = 'design' ORDER BY id", workId).map((row) => row.id);
  assert.deepEqual([...calls[1].ids].sort(), ids);
  assert.deepEqual(calls[1].documents.map((document) => document.task_id).sort(), ids);
  assert.equal(db.get("SELECT status FROM tasks WHERE work_id = ? AND manager_task_id = 'I1'", workId).status, "completed");
});

test("design_completed is not sent again after a Core restart", async (t) => {
  const calls = [];
  const { db, core, root, workId, complete } = await startPlannedWork(t, calls, {
    firstPlan: [managerTask("D1", "design")],
    implement: [managerTask("I1", "code")], // no dependency on D1: only the stored marker can stop a second call
    hold: true,
  });
  await complete("D1");
  await waitFor(() => db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n === 2);
  assert.equal(calls.filter((call) => call.kind === "design_completed").length, 1);
  await core.stop({ force: true });
  const gate = { promise: new Promise(() => {}), hold: true };
  const second = await createTestCore(t, {
    db, owlRoot: root, agentRunner: stubRunner(calls, { firstPlan: [], implement: [], gate }),
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { start: true });
  await second.core.tick(workId);
  await sleep(300);
  assert.equal(calls.filter((call) => call.kind === "design_completed").length, 1);
  await second.core.stop({ force: true });
});

test("a Work without design Tasks only sees initial_plan and final_check", async (t) => {
  const calls = [];
  const { db, workId } = await startPlannedWork(t, calls, { firstPlan: [managerTask("C1", "code")], implement: [] });
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed", { timeoutMs: 10_000 });
  assert.deepEqual(calls.map((call) => call.kind), ["initial_plan", "final_check"]);
});

test("design_completed includes a completed design Task that only another design Task depends on", async (t) => {
  const calls = [];
  const { db, workId, complete } = await startPlannedWork(t, calls, {
    firstPlan: [managerTask("D1", "design"), managerTask("D2", "design", ["D1"])],
    implement: [managerTask("I1", "code", ["D2"])],
  });
  await complete("D1");
  await complete("D2");
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed", { timeoutMs: 10_000 });
  const ids = db.all("SELECT id FROM tasks WHERE work_id = ? AND type = 'design' ORDER BY id", workId).map((row) => row.id);
  assert.deepEqual([...calls.find((call) => call.kind === "design_completed").ids].sort(), ids);
});

test("a Lead Designer design Task that completes through the normal path triggers design_completed", async (t) => {
  const calls = [];
  const { db, workId } = await startPlannedWork(t, calls, {
    firstPlan: [managerTask("D1", "design")],
    implement: [managerTask("I1", "code", ["D1"])],
    designMode: "lead",
    writeDesign: true,
  });
  assert.notEqual(db.get("SELECT lead_designer_start_round AS r FROM tasks WHERE work_id = ? AND manager_task_id = 'D1'", workId).r, null);
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed", { timeoutMs: 15_000 });
  assert.deepEqual(calls.map((call) => call.kind), ["initial_plan", "design_completed", "final_check"]);
  const design = db.get("SELECT id FROM tasks WHERE work_id = ? AND type = 'design'", workId);
  assert.deepEqual(calls[1].ids, [design.id]);
  assert.deepEqual(calls[1].documents.map((document) => document.task_id), [design.id]);
});
