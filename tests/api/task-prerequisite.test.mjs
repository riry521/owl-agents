import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { buildNotificationCard } from "../../packages/plugin-sdk/dist/shared/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The HTTP surface of a prerequisite wait and of the no-progress limit: the Task
// list says why a Task waits and what for, a judgement_waiting Task carries the
// reason it stopped, the Owner can resume a wait, and the Decision card says why.

const QUESTION = "page-format.ts does not exist yet; wait for it to land on main?";

const planTask = (extra = {}) => ({ id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false, ...extra });
const workerReport = (invocationId, question) => ({
  kind: "report", schema_version: "1.0.0", invocation_id: invocationId, result: question ? "partial" : "success",
  work_done: "Done.", changes: [], verification: { passed: true, method: "Checked." }, remaining_issues: [],
  next_action: "none", needs_replanning: false, question_for_manager: question ?? null,
});

/** The Worker asks QUESTION on its first run (or every run); the Manager retries with `wait()` as wait_for. */
function makeRunner({ wait = () => undefined, alwaysAsk = false } = {}) {
  const state = { workerCalls: 0 };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask({ wait_for: wait() })] } };
      return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, alwaysAsk || state.workerCalls === 1 ? QUESTION : null) };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function setup(t, runner) {
  const { root, db, core } = await createTestCore(t, { agentRunner: runner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-api-prereq-", start: true });
  await disablePlanQuality(db);
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const server = await startTestHttpServer(t, { core: adapter, webOut: root, owlRoot: root }, { token: "prereq-token" });
  if (!server) {
    t.skip("listen not permitted");
    return null;
  }
  const get = async (path) => (await server.request("GET", `/api/v1${path}`)).json();
  const resume = (taskId, payload = {}) => server.request("POST", `/api/v1/tasks/${taskId}/prerequisite/resume`, {
    request_id: createUlid(), idempotency_key: `resume:${createUlid()}`, expected_version: 0, payload,
  });
  const created = await core.createWork({ request_id: createUlid(), idempotency_key: `w:${createUlid()}`, expected_version: 0, payload: { title: "w", summary: "s", size: "normal", project_id: null } });
  const workId = created.data.work_id;
  await runner.prepare?.(core);
  await core.startWork(workId, { request_id: createUlid(), idempotency_key: `s:${createUlid()}`, expected_version: created.version, payload: { mode: "normal" } });
  return { db, core, adapter, get, resume, workId, runner };
}

const taskRow = (db, workId) => db.get("SELECT id, status, prerequisite_json FROM tasks WHERE work_id = ?", workId);

test("the Task list shows why a Task waits and what for; the Owner resumes it over HTTP", async (t) => {
  let condition; // another Work that never finishes: an owner condition would open a Decision at once
  const runner = makeRunner({ wait: () => ({ reason: "needs the Owner's go-ahead", conditions: [condition] }) });
  runner.prepare = async (core) => {
    const other = await core.createWork({ request_id: createUlid(), idempotency_key: `o:${createUlid()}`, expected_version: 0, payload: { title: "other", summary: "The Work being waited for.", size: "normal", project_id: null } });
    condition = { kind: "work", target: other.data.work_id, paths: [], description: "Owner confirms" };
  };
  const api = await setup(t, runner);
  if (!api) return;
  assert.ok(await waitFor(() => taskRow(api.db, api.workId)?.status === "waiting" && taskRow(api.db, api.workId)?.prerequisite_json, { timeoutMs: 15_000 }), "the Task waits");
  const taskId = taskRow(api.db, api.workId).id;

  const list = await api.get(`/works/${api.workId}/tasks`);
  const listed = list.data.find((task) => task.id === taskId);
  assert.equal(listed.status, "waiting");
  assert.equal(listed.prerequisite.reason, "needs the Owner's go-ahead");
  assert.deepEqual(listed.prerequisite.conditions, [{ kind: "work", target: condition.target, description: "Owner confirms" }]);
  assert.ok(listed.prerequisite.deadline_at);
  assert.equal(listed.stop_reason, null);
  assert.equal((await api.get(`/tasks/${taskId}`)).data.prerequisite.reason, "needs the Owner's go-ahead");

  assert.equal((await api.resume(createUlid())).status, 404);
  assert.equal((await api.resume(taskId, { extra: 1 })).status, 400);
  const resumed = await api.resume(taskId, { message: "go ahead" });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).data.resumed, true);
  assert.ok(await waitFor(() => taskRow(api.db, api.workId).prerequisite_json === null, { timeoutMs: 15_000 }), "the mark is cleared");
  assert.equal((await api.get(`/tasks/${taskId}`)).data.prerequisite, null);
  assert.equal((await api.resume(taskId)).status, 409, "a Task that waits on nothing cannot be resumed");

  // Without the Core feature the route answers 503, not a silent success.
  api.adapter.core = {};
  assert.equal((await api.resume(taskId)).status, 503);
});

test("a Task stopped by the no-progress limit carries the reason in the list and in the Decision card", async (t) => {
  const api = await setup(t, makeRunner({ alwaysAsk: true }));
  if (!api) return;
  assert.ok(await waitFor(() => api.db.get("SELECT state FROM works WHERE id = ?", api.workId).state === "judgement_waiting", { timeoutMs: 15_000 }), "the Work waits for the Owner");
  const taskId = taskRow(api.db, api.workId).id;

  const listed = (await api.get(`/works/${api.workId}/tasks`)).data.find((task) => task.id === taskId);
  assert.equal(listed.status, "judgement_waiting");
  assert.equal(listed.prerequisite, null);
  assert.ok(listed.stop_reason.includes(taskId), "the reason names the Task");
  assert.ok(listed.stop_reason.includes(QUESTION) || listed.stop_reason.includes("上限"), "the reason says it hit the limit");

  const opened = await waitFor(() => api.db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'decision.opened'", api.workId), { timeoutMs: 15_000 });
  const card = buildNotificationCard({ event_id: "e1", type: "decision.opened", payload: JSON.parse(opened.payload_json) }, { language: "ja", formatTime: String, replyStyle: "thread" });
  const reason = card.fields.find((field) => field.label === "理由");
  assert.ok(reason?.value.includes(taskId), "the card carries the limit reason");
  assert.equal(reason.value, listed.stop_reason);
});
