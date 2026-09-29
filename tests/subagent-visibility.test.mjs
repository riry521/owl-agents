import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import {
  agentCliOf,
  agentCliNames,
  installedAgentCliMatches,
  listProcesses,
  modelFromArgs,
  planSubagentReconciliation,
  subagentLabel,
} from "../packages/core/dist/subagent-watcher.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = agentCliNames({});

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: `test:${suffix}`, expected_version: expectedVersion, payload };
}

async function waitFor(read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("agent CLIs are recognised from any launcher, shells running -c are not", () => {
  const installed = (name, path) => name === "codex" && ["/opt/homebrew/bin/codex", "/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex"].includes(path);
  assert.equal(agentCliOf("node /opt/homebrew/bin/codex exec --json --model gpt-5", names, installed), "codex");
  assert.equal(agentCliOf("/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex exec --json", names, installed), "codex");
  assert.equal(agentCliOf("claude", names), "claude");
  assert.equal(agentCliOf("node /tmp/x/claude -p", names, installed), null);
  assert.equal(agentCliOf("/bin/sh /tmp/x/codex exec", names, installed), null);
  assert.equal(agentCliOf("gemini -m gemini-2.5-pro", names), "gemini");
  assert.equal(agentCliOf("/bin/zsh -c codex exec hi", names), null);
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
  assert.equal(subagentLabel("claude", "claude -p --output-format json"), "claude -p");
  assert.equal(subagentLabel("claude", "claude"), "claude");
});

test("process tree reconciliation finds nested agent CLIs of any provider under the nearest run", () => {
  const processes = [
    { pid: 100, ppid: 1, args: "node /srv/owl/server.js" },
    // Worker run (Claude) → shell tool → Codex launcher → Codex native binary.
    { pid: 200, ppid: 100, args: "claude -p --output-format json" },
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

test("installed CLI paths and symlinks count while temporary scripts do not", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-cli-paths-"));
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
  // Hybrid Executor stand-in: starts another agent CLI itself, then reports.
  await writeFile(join(bin, "claude"), [
    "#!/bin/sh",
    "cat >/dev/null",
    `"${join(bin, "codex")}" exec --model gpt-test &`,
    "wait",
    `echo '{"type":"result","result":"subtask done"}'`,
    "",
  ].join("\n"));
  await writeFile(join(bin, "codex"), ["#!/bin/sh", "sleep 1.5", ""].join("\n"));
  await chmod(join(bin, "claude"), 0o755);
  await chmod(join(bin, "codex"), 0o755);
  return bin;
}

test("Hybrid records its phases and every Executor, and nested agent CLIs are detected", { skip: process.platform === "win32" || listProcesses() === null }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-subagents-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${await fakeAgentBin(root)}:${originalPath}`;
  let core;
  t.after(async () => {
    process.env.PATH = originalPath;
    if (core) await core.stop({ force: true });
    db.close();
  });

  const phasesSeenByWorker = [];
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Hybrid", type: "research", acceptance: "Done.", depends_on: [], replaces: [] }] } }
      : { outcome: "failed", message: "unexpected" },
    runWorker: async (request) => {
      const phase = request.context.hybrid_phase;
      phasesSeenByWorker.push(db.get("SELECT phase FROM agent_runs WHERE id = ?", request.invocation_id)?.phase);
      if (phase === "plan") {
        return { outcome: "success", report_valid: true, report: { subtasks: [
          { subtask_id: "s1", title: "Write the notes", instruction: "Work in the current worktree. Do not read secrets.\nWrite the notes with details" },
          { subtask_id: "s2", title: "Check the notes", instruction: "Check the notes" },
        ] } };
      }
      return {
        outcome: "success",
        report_valid: true,
        report: {
          kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id, result: "success",
          work_done: "Done.", changes: [], verification: { passed: true, method: "Checked the result." }, remaining_issues: [], next_action: "none",
          needs_replanning: false, question_for_manager: null, verdict: "ok",
        },
      };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  await core.start();
  await core.setHybridMode(true);
  const created = await core.createWork(commandEnvelope({ title: "Hybrid visibility", summary: "x", size: "normal", project_id: null }, "sv-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "sv-start", created.version));

  // While the first Executor runs, its own nested agent CLI is found under it.
  const observed = await waitFor(async () => {
    await core.workflow.scanSubagents();
    return db.get("SELECT * FROM agent_runs WHERE origin = 'observed'");
  });
  assert.ok(observed, "the nested codex process should be recorded");
  assert.equal(observed.provider, "codex");
  assert.equal(observed.model, "gpt-test");
  assert.equal(observed.label, "codex exec");
  const observedParent = db.get("SELECT role, origin, label FROM agent_runs WHERE id = ?", observed.parent_agent_id);
  assert.deepEqual({ ...observedParent }, { role: "executor", origin: "spawned", label: "s1: Write the notes" });

  const finished = await waitFor(() => {
    const worker = db.get("SELECT * FROM agent_runs WHERE role = 'worker'");
    return worker && !["launch_pending", "spawned", "running"].includes(worker.status) ? worker : null;
  }, 20_000);
  assert.ok(finished, "the Hybrid Worker run should finish");
  assert.equal(finished.phase, "verdict");
  assert.deepEqual(phasesSeenByWorker, ["plan", "verdict"]);

  const executors = db.all("SELECT * FROM agent_runs WHERE origin = 'spawned' ORDER BY created_at");
  assert.deepEqual(executors.map((run) => [run.label, run.status, run.parent_agent_id, run.provider, run.pid]), [
    ["s1: Write the notes", "completed", finished.id, "claude", null],
    ["s2: Check the notes", "completed", finished.id, "claude", null],
  ]);
  await waitFor(async () => {
    await core.workflow.scanSubagents();
    return db.get("SELECT status FROM agent_runs WHERE origin = 'observed' AND status = 'running'") ? null : true;
  });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE origin = 'observed' AND status = 'exited'").n >= 1, true);

  const eventTypes = db.all("SELECT type FROM events WHERE work_id = ? ORDER BY rowid", workId).map((row) => row.type);
  const phaseEvents = db.all("SELECT json_extract(payload_json, '$.phase') AS phase FROM events WHERE type = 'worker.phase_changed' ORDER BY rowid").map((row) => row.phase);
  assert.deepEqual(phaseEvents, ["plan", "executing", "verdict"]);
  assert.equal(eventTypes.filter((type) => type === "executor.started").length, 2);
  assert.equal(eventTypes.filter((type) => type === "executor.completed").length, 2);
  assert.ok(eventTypes.includes("subagent.detected"));
  assert.ok(eventTypes.includes("subagent.exited"));

  const listed = core.listAgentRuns({ work_id: workId }).data;
  const listedExecutor = listed.find((run) => run.label === "s2: Check the notes");
  assert.equal(listedExecutor.parent_agent_id, finished.id);
  assert.equal(listedExecutor.origin, "spawned");
  assert.equal(listed.find((run) => run.id === finished.id).phase, "verdict");
  assert.equal(listed.find((run) => run.id === finished.id).subtask_count, 2);
  const lastOutputAt = db.get("SELECT last_output_at FROM agent_runs WHERE id = ?", finished.id).last_output_at;
  assert.ok(lastOutputAt);
  assert.equal(listed.find((run) => run.id === finished.id).last_output_at, lastOutputAt);
});
