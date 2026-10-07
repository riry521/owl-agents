import assert from "node:assert/strict";
import { test } from "node:test";

import { lineageUsage } from "../../packages/core/dist/task-lineage.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_REMAKE_LIMIT_SETTINGS } from "../../packages/shared/dist/remake-limit-settings.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// After an Owner instruction, a replan may replace a Task stopped at a remake
// limit and the dependent that failed because of it; the new Task's lineage
// totals start from 0.

const envelope = (payload, suffix, expectedVersion = 0) => command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
const task = (id, depends_on = []) => ({ id, title: id, type: "code", acceptance: "Done; verified by the test.", depends_on, required_sections: [], required_tests: [], replaces: [], review: false });
const LIMIT = { ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_worker_runs: 1, lineage_review_attempts: 1000, non_functional_remakes: 100 };

test("an Owner-instructed replan replaces the limit-stopped Task and its failed dependent, restarting the lineage", async (t) => {
  let replanReport = null;
  const runner = {
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [task("T1"), task("T2", ["T1"])] } };
      if (mode === "replan") return { outcome: "success", report_valid: true, report: replanReport?.() ?? { event: "task.replanned", tasks: [] } };
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async () => (replanReport === null ? { outcome: "failed", message: "boom" } : new Promise(() => {})),
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createTestCore(t, { agentRunner: withNecessity(runner), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-owner-restart-", start: true });
  await core.setRemakeLimitSettings(LIMIT);
  const created = await core.createWork(envelope({ title: "W", summary: "Restart lineage.", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, envelope({ mode: "normal" }, "start", created.version));
  const rows = () => db.all("SELECT id, title, status, failed_by_dependency_task_id AS failed_by_dependency FROM tasks WHERE work_id = ?", workId);
  const byTitle = (title) => rows().find((r) => r.title === title);
  assert.ok(await waitFor(() => byTitle("T1")?.status === "judgement_waiting" && byTitle("T2")?.status === "failed"), `states: ${JSON.stringify(rows())}`);
  assert.ok(byTitle("T2").failed_by_dependency);
  const oldIds = [byTitle("T1").id, byTitle("T2").id];
  assert.ok(lineageUsage(db, oldIds[0], LIMIT).worker_runs >= 1);

  replanReport = () => ({ event: "task.replanned", tasks: [{ ...task("N1"), replaces: oldIds }] });
  const version = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.postWorkInstruction(workId, envelope({ body: "Change approach" }, "instruction", version));
  const fresh = await waitFor(() => byTitle("N1"));
  assert.ok(fresh, `no new Task; states: ${JSON.stringify(rows())}`);
  const usage = lineageUsage(db, fresh.id, LIMIT);
  assert.equal(usage.worker_runs, 0);
  assert.equal(usage.review_attempts, 0);
});

// Without an Owner instruction the lineage is inherited and a failed_by_dependency Task cannot be replaced.
async function autoReplanCore(t, replanTasks, replanRequests) {
  // The replan can run before this function returns, so the lookup must not depend on the caller's variable.
  let workId;
  let db;
  const byTitle = (title) => db.all("SELECT id, title, status FROM tasks WHERE work_id = ?", workId).find((r) => r.title === title);
  const runner = {
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [task("T1"), task("T2", ["T1"])] } };
      if (mode === "replan") {
        replanRequests.push(JSON.stringify(request));
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: replanTasks(byTitle) } };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    // Match the title, not the serialized request: random ULIDs in it can contain "N1" and hang a first-round Worker.
    runWorker: async (request) => (request.context?.task?.title === "N1" ? new Promise(() => {}) : { outcome: "failed", message: "boom" }),
    runReviewer: async () => ({ outcome: "failed", message: "unused" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const testCore = await createTestCore(t, { agentRunner: withNecessity(runner), dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 } }, { prefix: "owl-auto-replan-", start: true });
  const { core } = testCore;
  db = testCore.db;
  const limit = { ...LIMIT, lineage_worker_runs: 1000 };
  await core.setRemakeLimitSettings(limit);
  const created = await core.createWork(envelope({ title: "W", summary: "Auto replan.", size: "normal", project_id: null }, "create"));
  workId = created.data.work_id;
  await core.startWork(workId, envelope({ mode: "normal" }, "start", created.version));
  return { db, byTitle, limit };
}

test("a replan without an Owner instruction carries the previous lineage usage forward", async (t) => {
  const ctx = await autoReplanCore(t, (byTitle) => [{ ...task("N1"), replaces: [byTitle("T1").id] }], []);
  const fresh = await waitFor(() => ctx.byTitle("N1"));
  assert.ok(fresh, "no new Task");
  assert.ok(lineageUsage(ctx.db, fresh.id, ctx.limit).worker_runs > 0);
});

test("a replan without an Owner instruction rejects replacing a failed_by_dependency Task", async (t) => {
  const requests = [];
  const ctx = await autoReplanCore(t, (byTitle) => [{ ...task("N1"), replaces: [byTitle("T2").id] }], requests);
  assert.ok(await waitFor(() => requests.length >= 2));
  assert.equal(ctx.byTitle("N1"), undefined);
  assert.ok(requests.slice(1).some((r) => r.includes("not a root failed Task")), "rejection reason was not fed back");
});
