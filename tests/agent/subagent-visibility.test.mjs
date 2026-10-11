import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  agentCliOf,
  agentCliNames,
  installedAgentCliMatches,
  listProcesses,
  modelFromArgs,
  planSubagentReconciliation,
  subagentLabel,
} from "../../packages/core/dist/subagent-watcher.js";
import { validateReportEnvelope } from "../../packages/agent-runtime/dist/index.js";
import { WORKER_REPORT_SCHEMA } from "../../packages/agent-runtime/dist/worker.js";
import { renderOutputTemplate } from "../../packages/agent-runtime/dist/role-contract.js";
import { evaluateWorkerCompletion } from "../../packages/core/dist/task-completion-gate.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

// Child processes (sh, sleep) need a PATH even when the runner has none.
process.env.PATH ||= `${process.execPath.replace(/\/[^\/]*$/, "")}:/usr/bin:/bin`;

const names = agentCliNames({});

test("agent CLIs are recognised from any launcher, shells running -c are not", () => {
  const installed = (name, path) => name === "codex" && ["/opt/homebrew/bin/codex", "/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex"].includes(path);
  assert.equal(agentCliOf("node /opt/homebrew/bin/codex exec --json --model gpt-5", names, installed), "codex");
  assert.equal(agentCliOf("/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex exec --json", names, installed), "codex");
  assert.equal(agentCliOf("claude", names), "claude");
  assert.equal(agentCliOf("node /tmp/x/claude -p", names, installed), null);
  assert.equal(agentCliOf("/bin/sh /tmp/x/codex exec", names, installed), null);
  assert.equal(agentCliOf("gemini -m gemini-2.5-pro", names), "gemini");
  assert.equal(agentCliOf("/bin/zsh -c codex exec hi", names), null);
  assert.equal(agentCliOf("python3 -c import codex", names), null);
  assert.equal(agentCliOf("node /opt/homebrew/bin/codex exec -c model=o3", names, installed), "codex", "the CLI's own -c option is not the interpreter's");
  assert.equal(agentCliOf("node /srv/app/server.js", names), null);
  assert.equal(agentCliOf("my-agent run", names), null);
  assert.equal(agentCliOf("my-agent run", agentCliNames({ OWL_SUBAGENT_CLI_NAMES: "my-agent, bad name" })), "my-agent");
});

test("subagent labels and models never copy prompts or unsafe values", () => {
  assert.equal(modelFromArgs("codex exec --model gpt-5.5 -- -"), "gpt-5.5");
  assert.equal(modelFromArgs("claude -p --model=claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(modelFromArgs("gemini -m 'x y'"), null);
  assert.equal(modelFromArgs("claude -p"), null);
  assert.equal(subagentLabel("codex", "node /usr/bin/codex exec --json"), "codex exec");
  assert.equal(subagentLabel("claude", "claude -p --output-format stream-json --verbose"), "claude -p");
  assert.equal(subagentLabel("claude", "claude"), "claude");
});

test("process tree reconciliation finds nested agent CLIs of any provider under the nearest run", () => {
  const processes = [
    { pid: 100, ppid: 1, args: "node /srv/owl/server.js" },
    // Worker run (Claude) → shell tool → Codex launcher → Codex native binary.
    { pid: 200, ppid: 100, args: "claude -p --output-format stream-json --verbose" },
    { pid: 210, ppid: 200, args: "/bin/zsh -c codex exec --model gpt-5.5 hi" },
    { pid: 220, ppid: 210, args: "node /opt/homebrew/bin/codex exec --model gpt-5.5" },
    { pid: 221, ppid: 220, args: "/opt/codex/vendor/bin/codex exec --model gpt-5.5" },
    // Worker run (Codex) → shell tool → Claude.
    { pid: 300, ppid: 100, args: "node /opt/homebrew/bin/codex exec --json" },
    { pid: 301, ppid: 300, args: "/opt/codex/vendor/bin/codex exec --json" },
    { pid: 310, ppid: 301, args: "/bin/bash -c claude -p" },
    { pid: 311, ppid: 310, args: "claude -p --model claude-opus-5-5" },
    // Agent CLIs outside any run are ignored.
    { pid: 400, ppid: 1, args: "codex app-server" },
  ];
  const runs = [
    { id: "RUN_CLAUDE", pid: 200, origin: null },
    { id: "RUN_CODEX", pid: 300, origin: null },
    { id: "RUN_GONE", pid: 999, origin: "observed" },
    { id: "RUN_REUSED", pid: 100, origin: "observed" },
  ];
  const plan = planSubagentReconciliation(processes, runs, names, (name, path) => name === "codex" && ["/opt/homebrew/bin/codex", "/opt/codex/vendor/bin/codex"].includes(path));
  assert.deepEqual(
    plan.detected.map((found) => [found.pid, found.parent_run_id, found.provider, found.model, found.label]),
    [
      [220, "RUN_CLAUDE", "codex", "gpt-5.5", "codex exec"],
      [311, "RUN_CODEX", "claude", "claude-opus-5-5", "claude -p"],
    ],
  );
  assert.deepEqual([...plan.exited].sort(), ["RUN_GONE", "RUN_REUSED"]);
});

test("installed CLI paths and symlinks count while temporary scripts do not", async (t) => {
  const root = await tempDir(t, "owl-cli-paths-");
  const bin = join(root, "bin");
  await mkdir(bin);
  const installed = join(bin, "claude");
  const alias = join(root, "claude");
  const fake = join(root, "fake", "claude");
  await mkdir(join(root, "fake"));
  await writeFile(installed, "#!/bin/sh\n");
  await chmod(installed, 0o755);
  await symlink(installed, alias);
  await writeFile(fake, "#!/bin/sh\n");
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.equal(agentCliOf(`node ${installed} -p`, names, installedAgentCliMatches), "claude");
    assert.equal(agentCliOf(`${alias} -p`, names, installedAgentCliMatches), "claude");
    assert.equal(agentCliOf(`node ${fake} -p`, names, installedAgentCliMatches), null);
    assert.equal(agentCliOf("claude -p", names, installedAgentCliMatches), "claude");
    const processes = [
      { pid: 10, ppid: 1, args: "codex exec" },
      { pid: 11, ppid: 10, args: `node ${fake} -p` },
      { pid: 12, ppid: 10, args: `${alias} -p` },
    ];
    const plan = planSubagentReconciliation(processes, [
      { id: "worker", pid: 10, origin: null },
      { id: "fake", pid: 11, origin: "observed" },
    ], names, installedAgentCliMatches);
    assert.deepEqual(plan.detected.map((entry) => entry.pid), [12]);
    assert.deepEqual(plan.exited, ["fake"]);
  } finally {
    process.env.PATH = originalPath;
  }
});

async function fakeAgentBin(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "claude"), [
    "#!/bin/sh",
    "cat >/dev/null",
    `"${join(bin, "codex")}" exec --model gpt-test &`,
    "wait",
    `echo '{\"type\":\"system\",\"subtype\":\"init\"}'`,
    `echo '{\"type\":\"result\",\"result\":\"subtask done\"}'`,
    "",
  ].join("\n"));
  await writeFile(join(bin, "codex"), ["#!/bin/sh", "sleep 1.5", ""].join("\n"));
  await chmod(join(bin, "claude"), 0o755);
  await chmod(join(bin, "codex"), 0o755);
  return bin;
}

test("the Hybrid Worker dispatches its own child and owns nested agent processes", { skip: process.platform === "win32" || listProcesses() === null }, async (t) => {
  const root = await tempDir(t, "owl-subagents-");
  const originalPath = process.env.PATH;
  process.env.PATH = `${await fakeAgentBin(root)}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  let core;
  let db;

  const workerRequests = [];
  let child;
  let childWait;
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Hybrid", type: "research", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [] }] } }
      : { outcome: "failed", message: "unexpected" },
    runWorker: async (request) => {
      workerRequests.push(request);
      await writeFile(join(request.context.worktree, "out.mjs"), "export {};\n");
      child = await core.dispatchChildRun(request.invocation_id, {
        title: "Write the notes",
        instruction: "Write the notes with details",
        write_paths: ["notes.md"],
      }, "visibility-notes");
      childWait = await core.waitChildRuns(request.invocation_id, { child_ids: [child.child_id], timeout_seconds: 8 }, new AbortController().signal);
      return {
        outcome: "success",
        report_valid: true,
        report: {
          kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id, result: "success",
          work_done: "The notes were written and checked.", changes: [], verification: { passed: true, method: "Checked the complete task.", integration_check: { status: "passed", evidence: "built" } },
          remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
          delegation: {
            decomposition: "Writing notes is independent; whole-task checking stays with the Worker.",
            delegated: [{ child_id: child.child_id, instruction: "Write the notes with details", provider: child.provider, model: child.model }],
            retained: [{ part: "Whole-task check", reason: "The Worker must review the completed notes." }],
          },
        },
      };
    },
    runReviewer: async () => ({ outcome: "success", report_valid: true, report: { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } }, review: { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  ({ core, db } = await createTestCore(t, {
    agentRunner,
    owlRoot: root,
    executorRuntime: () => ({
      owlRoot: repoRoot,
      env: { PATH: process.env.PATH, HOME: root },
      executables: { claude: join(root, "bin", "claude") },
    }),
    dispatcher: { tick_interval_ms: 25 },
  }));
  await core.start();
  await disablePlanQuality(db);
  await core.setHybridMode(true);
  const created = await core.createWork(command({ title: "Hybrid visibility", summary: "x", size: "normal", project_id: null }, "sv-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, command({ mode: "normal" }, "sv-start", created.version));

  const observed = await waitFor(async () => {
    await core.workflow.scanSubagents();
    return db.get("SELECT * FROM agent_runs WHERE origin = 'observed'");
  });
  assert.ok(observed, "the nested codex process should be recorded");
  assert.equal(observed.provider, "codex");
  assert.equal(observed.model, "gpt-test");
  const observedParent = db.get("SELECT role, origin, label FROM agent_runs WHERE id = ?", observed.parent_agent_id);
  assert.deepEqual({ ...observedParent }, { role: "executor", origin: "spawned", label: "Write the notes" });

  const finished = await waitFor(() => {
    const worker = db.get("SELECT * FROM agent_runs WHERE role = 'worker'");
    return worker && !["launch_pending", "spawned", "running"].includes(worker.status) ? worker : null;
  }, 20_000);
  assert.ok(finished, "the Worker run should finish after its child");
  assert.equal(finished.status, "completed", "the completion gate must accept the Worker's report, or the Task is retried");
  assert.equal(workerRequests.length, 1);
  assert.equal(workerRequests[0].context.hybrid_phase, undefined);
  assert.equal(childWait.done, true);
  assert.equal(childWait.children[0].status, "completed");
  assert.equal(finished.phase, null);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'worker.phase_changed'").n, 0);
  const executor = db.get("SELECT * FROM agent_runs WHERE child_run_id = ?", child.child_id);
  assert.equal(executor.parent_agent_id, finished.id);
  assert.equal(executor.status, "completed");

  await waitFor(async () => {
    await core.workflow.scanSubagents();
    return db.get("SELECT status FROM agent_runs WHERE origin = 'observed' AND status = 'running'") ? null : true;
  });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE origin = 'observed' AND status = 'exited'").n >= 1, true);
  const eventTypes = db.all("SELECT type FROM events WHERE work_id = ? ORDER BY rowid", workId).map((row) => row.type);
  assert.ok(eventTypes.includes("subagent.detected"));
  assert.ok(eventTypes.includes("subagent.exited"));
  const listed = core.listAgentRuns({ work_id: workId }).data;
  assert.equal(listed.find((run) => run.id === executor.id).parent_agent_id, finished.id);
  assert.equal(listed.find((run) => run.id === finished.id).phase, null);
});

const gateReport = (delegation = {}, integration_check = null) => ({
  kind: "report", schema_version: "1.1.0", invocation_id: "run", result: "success", work_done: "Done.",
  delegation: { decomposition: "x", delegated: [], retained: [], ...delegation }, changes: [], remaining_issues: [],
  next_action: "none", needs_replanning: false, question_for_manager: null,
  verification: { status: "passed", method: "Checked.", checks: [], acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "e" }], integration_check },
});
const reportedChild = (id) => ({ child_id: id, instruction: "i", provider: "p", model: "m" });

test("a parent with an unfinished, unknown or unreported child never passes the completion gate", () => {
  const evaluate = (children, delegated = children.filter((c) => c.kind === "dispatched").map((c) => reportedChild(c.id))) =>
    evaluateWorkerCompletion(gateReport({ delegated }, { status: "passed", evidence: "ok", required: true }), { hybrid: false, delegated_work_detected: children.some((c) => c.kind === "observed"), children });
  for (const status of ["queued", "running", "mystery"]) {
    for (const kind of ["dispatched", "observed"]) {
      const verdict = evaluate([{ id: "c1", kind, status }]);
      assert.equal(verdict.passed, false, `${kind}/${status}`);
      assert.equal(verdict.error_key, "worker_children_incomplete");
    }
  }
  const unreported = evaluate([{ id: "c1", kind: "dispatched", status: "completed" }], []);
  assert.equal(unreported.error_key, "worker_children_incomplete");
  assert.equal(evaluate([
    { id: "c1", kind: "dispatched", status: "completed" },
    { id: "c2", kind: "dispatched", status: "failed" },
    { id: "c3", kind: "observed", status: "exited" },
  ]).passed, true);
});

test("own subagent use is declared in the report schema, template and validation", () => {
  assert.equal(WORKER_REPORT_SCHEMA.properties.delegation.properties.own_subagents_used.type, "boolean");
  assert.ok("own_subagents_used" in renderOutputTemplate(WORKER_REPORT_SCHEMA).delegation);
  const withDeclaration = { ...gateReport({}, { status: "passed", evidence: "ok", required: true }), delegation: { decomposition: "x", delegated: [], retained: [], own_subagents_used: true } };
  assert.doesNotThrow(() => validateReportEnvelope(withDeclaration));
  assert.throws(() => validateReportEnvelope({ ...withDeclaration, delegation: { ...withDeclaration.delegation, own_subagents_used: "yes" } }));
});

test("a declaration or a hook detection alone makes integration_check mandatory", () => {
  const verdict = (declared, detected, integration) => evaluateWorkerCompletion(
    gateReport(declared ? { own_subagents_used: true } : {}, integration),
    { hybrid: false, delegated_work_detected: detected },
  );
  const required = { status: "passed", evidence: "ok", required: true };
  for (const [declared, detected] of [[true, false], [false, true]]) {
    assert.equal(verdict(declared, detected, null).error_key, "hybrid_integration_verification_missing");
    assert.equal(verdict(declared, detected, { status: "failed", evidence: "ok" }).error_key, "hybrid_integration_verification_missing");
    assert.equal(verdict(declared, detected, { status: "passed", evidence: "ok" }).passed, true);
    assert.equal(verdict(declared, detected, required).passed, true);
  }
  assert.equal(verdict(false, false, null).passed, true);
});
