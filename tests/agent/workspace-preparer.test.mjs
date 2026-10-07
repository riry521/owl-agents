import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentWorkspacePreparer, withWorkspacePreparation } from "../../packages/core/dist/agent-workspace-preparer.js";

function harness({ setup = null, refresh = null, prepareOutcome, refreshOutcome = null, alerts = [] } = {}) {
  const project = {
    id: "project-1",
    canonical_path: "/repo",
    worktree_prepare_argv_json: JSON.stringify(setup ?? []),
    worktree_refresh_argv_json: JSON.stringify(refresh ?? []),
    worktree_tool_state_json: "[]",
  };
  const calls = [];
  const db = {
    get(sql) {
      if (sql.includes("FROM works JOIN projects")) return project;
      return undefined;
    },
  };
  const writeLane = {
    async transact(fn) {
      return fn({
        get: (sql) => (sql.includes("worktree_tool_state_json") ? { worktree_tool_state_json: project.worktree_tool_state_json } : undefined),
        run: (sql, value) => { project.worktree_tool_state_json = value; },
      });
    },
  };
  const signatures = new Map();
  const tooling = {
    async prepareNewWorktree(input) {
      calls.push(["prepare", input.worktree, input.commands]);
      return prepareOutcome ?? { copied: [], skipped: [], setup: null, rehearsal: null, tool_state_paths: [] };
    },
    async refreshBeforeRun(input) {
      calls.push(["refresh", input.worktree]);
      return typeof refreshOutcome === "function" ? refreshOutcome() : refreshOutcome;
    },
    alertFor(key, problems) {
      const signature = problems.length === 0 ? null : problems.map((problem) => problem.kind).join(",");
      const previous = signatures.get(key) ?? null;
      signatures.set(key, signature);
      if (signature === previous) return null;
      return signature === null ? { kind: "agent_tooling_recovered" } : { kind: "agent_tooling_mismatch", problems };
    },
  };
  const preparer = new AgentWorkspacePreparer({
    db,
    writeLane,
    tooling,
    emitAlert: async (payload) => { alerts.push(payload); },
    language: () => "en",
  });
  return { preparer, calls, alerts, project };
}

const ok = { exit_code: 0, stdout: "", stderr: "", timed_out: false };

test("a new worktree is set up once, and its tool state is recorded", async () => {
  const { preparer, calls, project } = harness({
    setup: ["pnpm", "install"],
    prepareOutcome: { copied: [], skipped: [], setup: ok, rehearsal: null, tool_state_paths: ["node_modules/"] },
  });
  preparer.markCreated("/ws/W/T1");
  await preparer.beforeAgentRun("W", "/ws/W/T1");
  await preparer.beforeAgentRun("W", "/ws/W/T1");
  assert.deepEqual(calls.map(([kind]) => kind), ["prepare", "refresh", "refresh"]);
  assert.deepEqual(calls[0][2], { setup: ["pnpm", "install"], refresh: null });
  assert.deepEqual(JSON.parse(project.worktree_tool_state_json), ["node_modules/"]);
});

test("a reused worktree is only refreshed, and requests without a worktree are left alone", async () => {
  const { preparer, calls } = harness({ refresh: ["make", "index"], refreshOutcome: { result: ok, tool_state_paths: [] } });
  await preparer.beforeAgentRun("W", "/ws/W/T1");
  await preparer.beforeAgentRun("W", undefined);
  await preparer.beforeAgentRun("W", "");
  assert.deepEqual(calls.map(([kind]) => kind), ["refresh"]);
});

test("a failing refresh raises one alert, and a later success reports the recovery", async () => {
  let result = { exit_code: 2, stdout: "", stderr: "boom", timed_out: false };
  const { preparer, alerts, project } = harness({
    refresh: ["make", "index"],
    refreshOutcome: () => ({ result, tool_state_paths: [".index/"] }),
  });
  await preparer.beforeAgentRun("W", "/ws/W/T1");
  await preparer.beforeAgentRun("W", "/ws/W/T1");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "agent_tooling_mismatch");
  assert.equal(alerts[0].scope, "refresh");
  assert.equal(alerts[0].problems[0].kind, "refresh_failed");
  assert.match(alerts[0].message, /exited with code 2/);
  assert.match(alerts[0].message, /Project settings/);
  assert.deepEqual(JSON.parse(project.worktree_tool_state_json), [".index/"]);

  result = ok;
  await preparer.beforeAgentRun("W", "/ws/W/T1");
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].kind, "agent_tooling_recovered");
});

test("rehearsal problems are reported with guidance for the harness configuration", async () => {
  const { preparer, alerts } = harness({
    prepareOutcome: {
      copied: [],
      skipped: [],
      setup: null,
      rehearsal: {
        fingerprint: "f",
        servers: [],
        problems: [{ harness: "codex", server: "serena", kind: "codex_project_untrusted", detail: "not trusted" }],
      },
      tool_state_paths: [],
    },
  });
  preparer.markCreated("/ws/W/T1");
  await preparer.beforeAgentRun("W", "/ws/W/T1");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].scope, "rehearsal");
  assert.match(alerts[0].message, /codex\/serena: codex_project_untrusted/);
  assert.match(alerts[0].remediation, /trusted/);
});

test("preparation errors never stop the agent run", async () => {
  const { preparer } = harness({ refresh: ["make"], refreshOutcome: () => { throw new Error("spawn failed"); } });
  const order = [];
  const runner = withWorkspacePreparation({
    runManagerPlan: async () => { order.push("plan"); return {}; },
    runDesigner: async () => { order.push("designer"); return {}; },
    runWorker: async () => { order.push("worker"); return {}; },
    runReviewer: async () => { order.push("reviewer"); return {}; },
    runAdvisor: async () => { order.push("advisor"); return {}; },
  }, preparer);
  const originalError = console.error;
  console.error = () => {};
  try {
    await runner.runWorker({ work_id: "W", context: { worktree: "/ws/W/T1" } });
    await runner.runReviewer({ work_id: "W", context: { worktree: "/ws/W/T1" } });
    await runner.runManagerPlan({ work_id: "W", context: {} });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(order, ["worker", "reviewer", "plan"]);
  assert.equal("cancelAgent" in runner, false);
});
