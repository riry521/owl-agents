import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";

test("runner throttles output notifications to one per second", async () => {
  const observed = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        request.on_output?.();
        request.on_output?.();
        return { adapter: request.adapter, stdout: JSON.stringify({ tasks: [] }), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  runner.setOutputObserver((id) => observed.push(id));
  await runner.runManagerPlan({
    invocation_id: "run-progress", work_id: "work-progress", task_id: null, attempt: 1,
    context: { mode: "plan", work: { id: "work-progress", title: "Progress" } },
  });
  assert.deepEqual(observed, ["run-progress"]);
});
