import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandEnvelope(payload, suffix) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}`,
    expected_version: 0,
    payload,
  };
}

// The Manager prompt asks only for {"tasks":[...]}. A provider that follows
// the prompt exactly must still yield a plan Core accepts.
const promptCompliantPlan = {
  tasks: [
    { id: "T1", title: "Add archived_at migration", type: "code", acceptance: "Migration applies cleanly.", depends_on: [], replaces: [], context: "", notes: "", review: null },
  ],
};

function runnerReturning(body) {
  return createAgentRunner({
    adapter: "claude-cli/v1",
    provider: {
      execute: async (request) => ({
        adapter: request.adapter,
        stdout: JSON.stringify(body),
        stderr: "",
        exit_code: 0,
        signal: null,
        format: "plain-text",
      }),
    },
  });
}

test("Core-shaped Manager plan without an explicit event is reported as work.planned", async () => {
  const runner = runnerReturning(promptCompliantPlan);
  const result = await runner.runManagerPlan({
    invocation_id: "manager-plan-no-event",
    work_id: "work-plan-no-event",
    task_id: null,
    attempt: 1,
    context: { mode: "plan", work: { id: "work-plan-no-event", title: "Archive Works", summary: "Hide finished Works." } },
  });
  assert.equal(result.outcome, "success");
  assert.equal(result.report.event, "work.planned");
  assert.equal(result.report.tasks.length, 1);
});

test("role-shaped Manager plan without an explicit event is reported as work.planned", async () => {
  const runner = runnerReturning(promptCompliantPlan);
  const result = await runner.runManagerPlan({ work: { id: "work-role-plan", title: "Archive Works" }, mode: "plan" });
  assert.equal(result.event, "work.planned");
});

test("Manager plan still rejects an event that contradicts the requested mode", async () => {
  const runner = runnerReturning({ ...promptCompliantPlan, event: "work.completed" });
  const result = await runner.runManagerPlan({
    invocation_id: "manager-plan-bad-event",
    work_id: "work-plan-bad-event",
    task_id: null,
    attempt: 1,
    context: { mode: "plan", work: { id: "work-plan-bad-event", title: "Archive Works" } },
  });
  assert.notEqual(result.outcome, "success");
});

test("A Core-issued Decision carries the actual tick failure instead of the generic reconcile text", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-core-decision-reason-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "manager-failure-marker" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  try {
    await core.start();
    const created = await core.createWork(commandEnvelope({
      title: "Decision reason test",
      summary: "The Manager plan fails.",
      size: "normal",
      project_id: null,
    }, "decision-reason-create"));
    const workId = created.data.work_id;
    await core.startWork(workId, {
      ...commandEnvelope({ mode: "normal" }, "decision-reason-start"),
      expected_version: created.version,
    });
    const deadline = Date.now() + 5_000;
    let decision;
    while (!decision && Date.now() < deadline) {
      decision = db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId);
      if (!decision) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(decision, "a Decision should be opened for the owner");
    assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
    assert.match(decision.reason, /manager-failure-marker/u);
    assert.doesNotMatch(decision.reason, /Core could not safely reconcile/u);
  } finally {
    await core.stop({ force: true });
    db.close();
  }
});
