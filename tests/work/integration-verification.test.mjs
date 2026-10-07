import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { createStubTestRunner, openTestRunCore, phaseOf, plannedTask, workerReport } from "../helpers/test-run-core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

// ---- Real git: each Task passes alone, the combination fails the Project check ----

const CHECK_PLAN = [{
  command_id: "check", argv: ["node", "check.mjs"], cwd: ".", env_allowlist: [], timeout_seconds: 60,
  stdout_limit: 10_000, stderr_limit: 10_000, expected_exit_codes: [0], executor: "core",
}];

async function gitFixture(t, verificationPlan, allowedRoots) {
  const parent = await tempDir(t, "owl-work-integration-");
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  // check.mjs fails only when both flag files exist.
  await writeFile(
    join(project, "check.mjs"),
    'import { existsSync } from "node:fs";\nprocess.exit(existsSync("a.flag") && existsSync("b.flag") ? 1 : 0);\n',
  );
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const db = {
    get(sql) {
      if (sql.includes("SELECT project_id FROM works")) return { project_id: "project-1" };
      if (sql.includes("FROM projects")) {
        return {
          canonical_path: project,
          base_branch: "main",
          allowed_roots_json: JSON.stringify(allowedRoots ?? [parent]),
          verification_plan_json: JSON.stringify(verificationPlan),
        };
      }
      return undefined;
    },
  };
  return { gateway: new GitWorktreeGateway(db, join(parent, "owl")) };
}

async function integrateFlag(gateway, taskId, file) {
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: taskId });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, file), "x\n");
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: taskId, worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
}

test("Work branch verification fails for a combination of Tasks that each pass alone", async (t) => {
  const { gateway } = await gitFixture(t, CHECK_PLAN);
  await integrateFlag(gateway, "T1", "a.flag");
  const alone = await gateway.verifyWorkBranch({ work_id: "W" });
  assert.equal(alone.status, "passed", alone.message ?? "");
  assert.match(alone.work_commit, /^[0-9a-f]{40}$/u);

  await integrateFlag(gateway, "T2", "b.flag");
  const combined = await gateway.verifyWorkBranch({ work_id: "W" });
  assert.equal(combined.status, "failed");
  assert.equal(combined.reason, "verification_failed");
  assert.equal(combined.failed_command_id, "check");
  assert.equal(combined.commands[0].exit_code, 1);
  assert.notEqual(combined.work_commit, alone.work_commit);
});

test("Work branch verification has nothing to run without a plan", async (t) => {
  const { gateway } = await gitFixture(t, []);
  const result = await gateway.verifyWorkBranch({ work_id: "W" });
  assert.equal(result.status, "not_applicable");
  assert.equal(result.reason, "empty_plan");
});

// ---- Core: the verification gates the Final Manager and Work completion ----

function commandEnvelope(payload, suffix) {
  return command(payload, `test:${suffix}:${createUlid()}`, 0);
}

const merged = {
  kind: "merged", ok: true, exit_code: 0, recorded: false, message: "merged",
  worktree_path: "/tmp/integration", base_branch: "main", work_branch: "owl/work/test/work",
  old_base_commit: "a".repeat(40), new_base_commit: "b".repeat(40), merge_commit: "b".repeat(40),
  verification_commands_run: [],
};

function passed() {
  return { status: "passed", reason: null, work_commit: "c".repeat(40), commands: [{ command_id: "check", argv: ["node", "check.mjs"], passed: true, exit_code: 0, timed_out: false, duration_ms: 1, stdout_tail: "", stderr_tail: "" }], failed_command_id: null, message: null };
}

function failed() {
  return {
    status: "failed", reason: "verification_failed", work_commit: "c".repeat(40),
    commands: [{ command_id: "check", argv: ["node", "check.mjs"], passed: false, exit_code: 1, timed_out: false, duration_ms: 1, stdout_tail: "", stderr_tail: "boom" }],
    failed_command_id: "check", message: "Verification command check failed (exit 1).",
  };
}

async function openCore(t, verifyWorkBranch) {
  const calls = [];
  const gitStub = {
    async abortIntegrationMerge() { return { ok: true, message: "none" }; },
    async mergeWorkIntoBase(request) { calls.push(["mergeWorkIntoBase", request.work_id]); return { ...merged }; },
    async deleteMergedWorkBranches() { return { ok: true, message: "ok", deleted_branches: {} }; },
    async removeIntegrationWorktree() { return { ok: true, message: "ok" }; },
    async removeMergedIntegrationWorktree() { return { ok: true, message: "ok" }; },
    async listWorkspaces() { return []; },
    async discardTaskWorktree() { return { ok: true, message: "ok" }; },
    async discardMergedWorktree() { return { ok: true, message: "ok" }; },
    async removeWorktree() { return { ok: true, message: "ok" }; },
  };
  if (verifyWorkBranch) {
    gitStub.verifyWorkBranch = async (request) => { calls.push(["verifyWorkBranch", request.work_id]); return verifyWorkBranch(); };
  }
  const managerRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => (managerRequests.push(request), {
      outcome: "success",
      report_valid: true,
      report: {
        tasks: [],
        event: request.mode === "replan" ? "task.replanned" : null,
        verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] },
      },
    }),
    runWorker: async () => ({ outcome: "failed", message: "unexpected worker call" }),
    runReviewer: async () => ({ outcome: "failed", message: "unexpected reviewer call" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createTestCore(t, { git: gitStub, agentRunner, dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 } }, { prefix: "owl-work-integration-core-", start: true });
  return { db, core, calls, managerRequests };
}

async function seedFinishedWork(core, db, withProject) {
  if (withProject) {
    await core.createProject(commandEnvelope({
      name: "Integration project",
      canonical_path: join(tmpdir(), `owl-project-${createUlid()}`),
      base_branch: "main",
      allowed_roots: [tmpdir()],
      verification_plan: [],
    }, "project"));
  }
  const projectId = withProject ? db.get("SELECT id FROM projects ORDER BY created_at DESC LIMIT 1").id : null;
  const created = await core.createWork(commandEnvelope({ title: "Integration", summary: "Combined checks.", size: "normal", project_id: projectId }, "work"));
  const workId = created.data.work_id;
  const taskId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks
         (id, work_id, title, type, status, priority, context, acceptance,
          state_version, failure_count, same_error_count, review_round, worker_generation,
          created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'Done', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    const runId = createUlid();
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)`,
      runId, workId, taskId, now, now,
    );
    tx.run(
      `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
       VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
      createUlid(), runId, JSON.stringify({ kind: "report", result: "success", work_done: "Done." }), "0".repeat(64), now,
    );
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  return workId;
}

const finalizeRequests = (requests) => requests.filter((request) => request.mode === "finalize");
const workState = (db, workId) => db.get("SELECT state FROM works WHERE id = ?", workId).state;
const integrationEvents = (db, workId) => db.all(
  "SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.integration_verification_completed' ORDER BY sequence ASC",
  workId,
).map((row) => JSON.parse(row.payload_json));

test("a failing integration verification keeps the Work from completing and goes to a Manager replan", async (t) => {
  const { db, core, calls, managerRequests } = await openCore(t, failed);
  const workId = await seedFinishedWork(core, db, true);

  await core.tick(workId);

  assert.notEqual(workState(db, workId), "completed");
  assert.equal(finalizeRequests(managerRequests).length, 0);
  assert.equal(calls.some(([name]) => name === "mergeWorkIntoBase"), false);
  const replan = managerRequests.find((request) => request.mode === "replan");
  assert.ok(replan, "the Manager is asked to replan");
  assert.equal(replan.context.work_verification.failed_command_id, "check");
  assert.equal(replan.context.work_verification.commands[0].stderr_tail, "boom");
  const [event] = integrationEvents(db, workId);
  assert.equal(event.status, "failed");
  assert.equal(event.routed_to, "manager");
  assert.equal(event.failed_command_id, "check");
});

test("repeated integration failures end in an Owner Decision, not completion", async (t) => {
  const { db, core, managerRequests } = await openCore(t, failed);
  const workId = await seedFinishedWork(core, db, true);

  for (let i = 0; i < 4; i += 1) await core.tick(workId);

  assert.equal(workState(db, workId), "judgement_waiting");
  assert.deepEqual(integrationEvents(db, workId).map((event) => event.routed_to), ["manager", "manager", "owner"]);
  assert.equal(managerRequests.filter((request) => request.mode === "replan").length, 2);
  assert.equal(finalizeRequests(managerRequests).length, 0);
  const alert = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId).payload_json);
  assert.equal(alert.kind, "work_integration_verification_failed");
  assert.equal(alert.failed_command_id, "check");
  assert.ok(db.get("SELECT id FROM decisions WHERE work_id = ? AND status = 'open'", workId));
});

test("a passing integration verification reaches the Final Manager and completes the Work as before", async (t) => {
  const { db, core, calls, managerRequests } = await openCore(t, passed);
  const workId = await seedFinishedWork(core, db, true);

  await core.tick(workId);

  assert.equal(workState(db, workId), "completed");
  assert.deepEqual(calls.map(([name]) => name).slice(0, 2), ["verifyWorkBranch", "mergeWorkIntoBase"]);
  const [finalize] = finalizeRequests(managerRequests);
  assert.equal(finalize.context.work_verification.status, "passed");
  assert.equal(finalize.context.work_verification.commands[0].command_id, "check");
  assert.equal(integrationEvents(db, workId)[0].routed_to, "final_manager");
});

test("a Work without a Project skips the integration verification and completes", async (t) => {
  const { db, core, managerRequests } = await openCore(t, async () => ({ status: "not_applicable", reason: "no_project", work_commit: null, commands: [], failed_command_id: null, message: null }));
  const workId = await seedFinishedWork(core, db, false);

  await core.tick(workId);

  assert.equal(workState(db, workId), "completed");
  const [finalize] = finalizeRequests(managerRequests);
  assert.equal(finalize.context.work_verification.status, "not_applicable");
  assert.equal(finalize.context.work_verification.reason, "no_project");
});

test("a Work with a Project is not completed when the Git gateway cannot verify the Work branch", async (t) => {
  const { db, core, managerRequests } = await openCore(t, null);
  const workId = await seedFinishedWork(core, db, true);

  await core.tick(workId);

  assert.notEqual(workState(db, workId), "completed");
  assert.equal(finalizeRequests(managerRequests).length, 0);
  const [event] = integrationEvents(db, workId);
  assert.equal(event.status, "error");
  assert.equal(event.routed_to, "manager");
});

// ---- Core activity events: start and end of the background steps, one pair per step ----

const activityEvents = (db, workId) => db.all(
  "SELECT type, payload_json FROM events WHERE work_id = ? AND type LIKE 'work.core_activity_%' ORDER BY sequence ASC",
  workId,
).map((row) => ({ type: row.type, ...JSON.parse(row.payload_json) }));

/** Every started has exactly one completed with the same activity_id, in that order. */
function pairedActivities(events) {
  const completed = new Map(events.filter((event) => event.type === "work.core_activity_completed").map((event) => [event.activity_id, event]));
  return events.filter((event) => event.type === "work.core_activity_started").map((started) => {
    const end = completed.get(started.activity_id);
    assert.ok(end, `${started.kind} has a completed event`);
    assert.ok(events.indexOf(started) < events.indexOf(end), `${started.kind} starts before it completes`);
    assert.equal(end.kind, started.kind);
    assert.equal(end.started_at, started.started_at);
    return { started, end };
  });
}

test("a Work that passes every check reports each background step's start and end with the same activity_id", async (t) => {
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } },
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "src/a.mjs"), "export const a = 2;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, ["src/a.mjs"]) };
    },
    runReviewer: async (request) => ({ outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id }, review: { verdict: "pass", findings: [], tests: {} } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { run } = createStubTestRunner(() => false);
  const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-work-activity-" });
  const created = await core.createWork(envelope({ title: "Activity", summary: "x", size: "normal", project_id: projectId }, "work"));
  const workId = created.data.work_id;
  await core.startWork(workId, { ...envelope({ mode: "normal" }, "start"), expected_version: created.version });
  await waitFor(() => workState(db, workId) === "completed", { timeoutMs: 60_000, message: "the Work to complete" });

  const pairs = pairedActivities(activityEvents(db, workId));
  const byKind = (kind) => pairs.filter(({ started }) => started.kind === kind);
  // The base did not move, so the pre-merge verification is skipped and reports nothing.
  for (const kind of ["integration_verification", "core_tests", "base_merge"]) {
    assert.equal(byKind(kind).length, 1, `${kind} reported once`);
    assert.equal(byKind(kind)[0].end.outcome, "passed", kind);
  }
  assert.equal(byKind("merge_verification").length, 0);
  assert.equal(core.getWorkCoreActivity(workId).activities.length, 0);
});

test("an integration verification that fails or throws still ends its activity", async (t) => {
  const events = [];
  const reporter = (workId, kind) => {
    const id = `${kind}-${events.length}`;
    events.push({ phase: "started", kind, id });
    return { command() {}, output() {}, end: async (outcome) => { events.push({ phase: "completed", kind, id, outcome }); } };
  };
  const failing = await gitFixture(t, CHECK_PLAN);
  failing.gateway.onCoreActivity(reporter);
  await integrateFlag(failing.gateway, "T1", "a.flag");
  await integrateFlag(failing.gateway, "T2", "b.flag");
  assert.equal((await failing.gateway.verifyWorkBranch({ work_id: "W" })).status, "failed");

  const broken = await gitFixture(t, CHECK_PLAN, ["/nonexistent-owl-root"]);
  broken.gateway.onCoreActivity(reporter);
  assert.equal((await broken.gateway.verifyWorkBranch({ work_id: "W" })).status, "error");

  const verifications = events.filter((event) => event.kind === "integration_verification");
  assert.deepEqual(verifications.map(({ phase, outcome }) => [phase, outcome]), [["started", undefined], ["completed", "failed"], ["started", undefined], ["completed", "error"]]);
});

for (const [mode, expected] of [["fail", "failed"], ["throw", "error"]]) {
  test(`a Core test run that ${mode === "fail" ? "fails" : "throws"} still ends its core_tests activity with ${expected}`, async (t) => {
    const { run: passing } = createStubTestRunner(() => false);
    const { run: failing } = createStubTestRunner((_file, phase) => phase === "work");
    // Only the first run on the integrated Work branch misbehaves ; the Work then recovers.
    let broken = true;
    const runner = (argv, cwd, ...rest) => {
      if (!broken || phaseOf(cwd) === "task") return passing(argv, cwd, ...rest);
      if (mode === "throw") throw new Error("runner exploded");
      return failing(argv, cwd, ...rest);
    };
    const agentRunner = {
      runManagerPlan: async (request) => {
        if (request.mode === "finalize") return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
        if (request.mode === "replan") {
          broken = false;
          return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [plannedTask("T2", "Fix")] } };
        }
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } };
      },
      runWorker: async (request) => {
        await writeFile(join(request.context.worktree, "src/a.mjs"), `export const a = ${broken ? 2 : 3};\n`);
        return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, ["src/a.mjs"]) };
      },
      runReviewer: async (request) => ({ outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id }, review: { verdict: "pass", findings: [], tests: {} } }),
      runAdvisor: async () => ({ reply: "" }),
    };
    const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner, prefix: "owl-work-activity-fail-" });
    const created = await core.createWork(envelope({ title: "Activity", summary: "x", size: "normal", project_id: projectId }, "work"));
    const workId = created.data.work_id;
    await core.startWork(workId, { ...envelope({ mode: "normal" }, "start"), expected_version: created.version });
    const coreTests = () => pairedActivities(activityEvents(db, workId)).filter(({ started }) => started.kind === "core_tests");
    await waitFor(() => activityEvents(db, workId).some((event) => event.type === "work.core_activity_completed" && event.kind === "core_tests"), { timeoutMs: 60_000, message: "the first core_tests activity" });

    assert.equal(coreTests()[0].end.outcome, expected);
  });
}
