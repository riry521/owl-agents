import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createChildRunScheduler } from "../dist/child-run-scheduler.js";
import { NoopGitGateway, WorkflowEngine, createTaskPlanInTransaction, createWorkInTransaction } from "../dist/index.js";
import { DEFAULT_CHILD_RUN_SETTINGS, MINIMAL_CODE_RULES, WORKING_STYLE_RULES } from "../../shared/dist/index.js";
import { createUlid, openDatabase } from "../../db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const fakeClaude = [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const prompt = fs.readFileSync(0, 'utf8');",
  "fs.writeFileSync(process.env.OWL_TEST_PROMPT_FILE, prompt);",
  "if (prompt.includes('HANG_CHILD')) { process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000); }",
  "else {",
  "  const report = '```owl-child-report\\n' + JSON.stringify({ result: 'succeeded', summary: 'child completed', changed_files: ['src/child.ts'], checks: [{ command: 'node --test', passed: true }], remaining_issues: [] }) + '\\n```';",
  "  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: report }));",
  "}",
].join("\n");

/** Executor settings that run children through the fake claude executable, whatever the Worker's harness. */
const CLAUDE_EXECUTOR = {
  ...DEFAULT_CHILD_RUN_SETTINGS,
  executor_harness: "claude",
};

async function setup(t, workerRun, { settings = CLAUDE_EXECUTOR, runOpencode } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-child-run-workflow-"));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(bin), mkdir(workspace)]);
  const claude = join(bin, "claude");
  const promptFile = join(root, "child-prompt.txt");
  await writeFile(claude, fakeClaude);
  await chmod(claude, 0o755);

  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const ids = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Parent Work", summary: "", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{
      id: "CHILD-TEST",
      title: "Parent Task",
      type: "code",
      context: "Parent task context marker",
      acceptance: "Parent acceptance marker",
      depends_on: [],
    }]);
    tx.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json,
          allow_free_text, issuer_role, created_at, resolved_at)
       VALUES ('decision:child-test', ?, 'work', 'resolved', '[]', 'Owner reason marker', '', '', '[]', 1, 'core', ?, ?)`,
      work.id, new Date().toISOString(), new Date().toISOString(),
    );
    tx.run(
      `INSERT INTO decision_answers (id, decision_id, answerer_id, answer_json, source, received_at)
       VALUES ('answer:child-test', 'decision:child-test', 'owner:default', ?, 'web', ?)`,
      JSON.stringify({ answer: "Owner instruction marker" }), new Date().toISOString(),
    );
    return { work_id: work.id, task_id: task.id };
  });

  const childRuns = createChildRunScheduler({
    db,
    writeLane: db.createWriteLane(),
    executorRuntime: () => ({
      owlRoot: repoRoot,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root, OWL_TEST_PROMPT_FILE: promptFile },
      executables: { claude },
      ...(runOpencode ? { runOpencode } : {}),
    }),
    settings: () => settings,
    onParentActivity() {},
  });
  const workflow = new WorkflowEngine({
    db,
    agentRunner: { runWorker: workerRun },
    childRuns,
    git: new NoopGitGateway(),
    owlRoot: workspace,
    dataDir: root,
    ruleStore: { getInstructionsForRole: () => ["Owl rule marker"] },
  });
  workflow.start();
  await workflow.resolveDependencies(ids.work_id);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", ids.task_id).status, "ready");
  t.after(async () => {
    await workflow.stop();
    await childRuns.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, ids, workflow, childRuns, promptFile };
}

function success() {
  return { outcome: "success", report_valid: true, report: { result: "success", verification: { passed: true } }, skill_feedback: null };
}

test("Workflow registers a Worker so it can dispatch, wait, and pass automatic child context", { skip: process.platform === "win32" }, async (t) => {
  let dispatchError;
  let dispatchEnabled;
  let childResult;
  const ctx = await setup(t, async (request) => {
    dispatchEnabled = request.context.dispatch_enabled;
    try {
      const child = await ctx.childRuns.dispatch(request.invocation_id, {
        title: "Bounded child task",
        instruction: "Implement the child change.",
        write_paths: ["src/child.ts"],
      }, "workflow-child");
      childResult = await ctx.childRuns.wait(request.invocation_id, {
        child_ids: [child.child_id],
        timeout_seconds: 8,
      }, new AbortController().signal);
    } catch (error) {
      dispatchError = error;
    }
    return success();
  });

  assert.deepEqual(await ctx.workflow.launchReady(ctx.ids.work_id), [ctx.ids.task_id]);
  await ctx.workflow.drainPipelines();

  assert.equal(dispatchEnabled, true);
  assert.equal(dispatchError, undefined, dispatchError?.message);
  assert.equal(childResult.done, true);
  assert.equal(childResult.children[0].status, "completed");
  const [child] = ctx.childRuns.list({ task_id: ctx.ids.task_id });
  const parentRun = ctx.db.get("SELECT id FROM agent_runs WHERE task_id = ? AND role = 'worker'", ctx.ids.task_id);
  assert.equal(child.parent_agent_run_id, parentRun.id);
  const childRun = ctx.db.get("SELECT parent_agent_id FROM agent_runs WHERE child_run_id = ?", child.id);
  assert.equal(childRun.parent_agent_id, child.parent_agent_run_id);

  const prompt = await readFile(ctx.promptFile, "utf8");
  assert.match(prompt, /Owl rule marker/u);
  assert.match(prompt, /Owner instruction marker/u);
  assert.match(prompt, /Parent Task[\s\S]*Parent acceptance marker[\s\S]*Parent task context marker/u);
  for (const rule of MINIMAL_CODE_RULES) assert.ok(prompt.includes(rule), `missing automatic rule: ${rule}`);
  for (const rule of WORKING_STYLE_RULES) assert.ok(prompt.includes(rule), `missing working rule: ${rule}`);
  assert.match(prompt, /Inspect relevant existing code/u);
});

test("Worker completion releases an unawaited child process", { skip: process.platform === "win32" }, async (t) => {
  let dispatchError;
  let dispatched;
  const ctx = await setup(t, async (request) => {
    try {
      dispatched = await ctx.childRuns.dispatch(request.invocation_id, {
        title: "Long child task",
        instruction: "HANG_CHILD",
        write_paths: ["src/long.ts"],
      }, "workflow-long-child");
    } catch (error) {
      dispatchError = error;
    }
    return success();
  });

  assert.deepEqual(await ctx.workflow.launchReady(ctx.ids.work_id), [ctx.ids.task_id]);
  await ctx.workflow.drainPipelines();

  assert.equal(dispatchError, undefined, dispatchError?.message);
  assert.ok(dispatched);
  const [child] = ctx.childRuns.list({ task_id: ctx.ids.task_id });
  assert.equal(child.status, "cancelled", JSON.stringify(child));
  assert.equal(child.failure_kind, "parent_ended");
  assert.equal(ctx.db.get("SELECT pid FROM agent_runs WHERE child_run_id = ?", child.id).pid, null);
});

test("Worker errors release and stop any remaining children", { skip: process.platform === "win32" }, async (t) => {
  let dispatchError;
  let dispatched;
  const ctx = await setup(t, async (request) => {
    try {
      dispatched = await ctx.childRuns.dispatch(request.invocation_id, {
        title: "Interrupted child task",
        instruction: "HANG_CHILD",
        write_paths: ["src/interrupted.ts"],
      }, "workflow-interrupted-child");
    } catch (error) {
      dispatchError = error;
    }
    throw new Error("Worker interrupted");
  });

  assert.deepEqual(await ctx.workflow.launchReady(ctx.ids.work_id), [ctx.ids.task_id]);
  await ctx.workflow.drainPipelines();

  assert.equal(dispatchError, undefined, dispatchError?.message);
  assert.ok(dispatched);
  const [child] = ctx.childRuns.list({ task_id: ctx.ids.task_id });
  assert.equal(child.status, "cancelled", JSON.stringify(child));
  assert.equal(child.failure_kind, "cancelled");
  assert.equal(ctx.db.get("SELECT pid FROM agent_runs WHERE child_run_id = ?", child.id).pid, null);
});

test("an opencode Executor child completes through runOpencode whatever the Worker's harness", { skip: process.platform === "win32" }, async (t) => {
  const fence = "`".repeat(3);
  const report = `${fence}owl-child-report\n${JSON.stringify({ result: "succeeded", summary: "opencode child completed", changed_files: [], checks: [], remaining_issues: [] })}\n${fence}`;
  const requests = [];
  const runOpencode = async (request) => {
    requests.push(request);
    return { success: true, output: report, exit_code: 0, usage: null };
  };
  const settings = {
    ...DEFAULT_CHILD_RUN_SETTINGS,
    executor_harness: "opencode",
    executor_by_harness: { ...DEFAULT_CHILD_RUN_SETTINGS.executor_by_harness, opencode: { model: "anthropic/claude-sonnet-5-5", effort: null } },
  };
  let childResult;
  let dispatchError;
  const ctx = await setup(t, async (request) => {
    try {
      const child = await ctx.childRuns.dispatch(request.invocation_id, { title: "Opencode child", instruction: "Do it.", write_paths: ["src/oc.ts"] }, "workflow-opencode-child");
      childResult = await ctx.childRuns.wait(request.invocation_id, { child_ids: [child.child_id], timeout_seconds: 8 }, new AbortController().signal);
    } catch (error) {
      dispatchError = error;
    }
    return success();
  }, { settings, runOpencode });

  assert.deepEqual(await ctx.workflow.launchReady(ctx.ids.work_id), [ctx.ids.task_id]);
  await ctx.workflow.drainPipelines();

  assert.equal(dispatchError, undefined, dispatchError?.message);
  assert.equal(childResult.children[0].status, "completed", JSON.stringify(childResult));
  assert.equal(childResult.children[0].summary.summary, "opencode child completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "anthropic/claude-sonnet-5-5");
});

for (const parentProvider of ["claude", "codex", "opencode"]) {
  test(`Workflow registers a ${parentProvider} Worker and its child follows the Executor settings`, { skip: process.platform === "win32" }, async (t) => {
    let childResult;
    let dispatchError;
    let dispatched;
    const ctx = await setup(t, async (request) => {
      try {
        dispatched = await ctx.childRuns.dispatch(request.invocation_id, { title: "Setting child", instruction: "Do it.", write_paths: ["src/s.ts"] }, `workflow-${parentProvider}-child`);
        childResult = await ctx.childRuns.wait(request.invocation_id, { child_ids: [dispatched.child_id], timeout_seconds: 8 }, new AbortController().signal);
      } catch (error) {
        dispatchError = error;
      }
      return success();
    });
    await ctx.db.createWriteLane().transact((tx) => tx.run(
      "INSERT OR REPLACE INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ roles: ["worker", "reviewer", "fixer", "designer", "lead_designer"].map((role) => ({ role, provider: parentProvider, model: "parent-model", effort: "low" })) }),
      new Date().toISOString(),
    ));

    assert.deepEqual(await ctx.workflow.launchReady(ctx.ids.work_id), [ctx.ids.task_id]);
    await ctx.workflow.drainPipelines();

    assert.equal(dispatchError, undefined, dispatchError?.message);
    const parentRun = ctx.db.get("SELECT provider FROM agent_runs WHERE task_id = ? AND role = 'worker'", ctx.ids.task_id);
    assert.equal(parentRun.provider, parentProvider);
    const expected = CLAUDE_EXECUTOR.executor_by_harness.claude;
    assert.equal(dispatched.provider, "claude");
    assert.equal(dispatched.model, expected.model);
    assert.equal(dispatched.effort, expected.effort);
    assert.equal(childResult.children[0].status, "completed");
    const [child] = ctx.childRuns.list({ task_id: ctx.ids.task_id });
    assert.deepEqual([child.provider, child.model, child.effort], ["claude", expected.model, expected.effort]);
  });
}

test("migration 070 lets child_runs.provider be opencode and keeps existing rows and agent run links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-child-run-migration-"));
  const migrations = join(repoRoot, "packages/db/migrations");
  const db = openDatabase(join(root, "owl.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes("070_child_run_opencode_provider.sql"));
  const early = join(root, "early");
  await mkdir(early);
  for (const name of files.filter((file) => file < "070")) await copyFile(join(migrations, name), join(early, name));
  db.migrate(early);

  const now = new Date().toISOString();
  const ids = { work: createUlid(), task: createUlid(), parent: createUlid(), child: createUlid(), childRun: createUlid() };
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Migration Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      ids.work, now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Migration Task', 'code', 'running', 'normal', '', '', ?, ?)`,
      ids.task, ids.work, now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, effort, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'claude', 'm', NULL, 'running', ?, ?)`,
      ids.parent, ids.work, ids.task, now, now,
    );
    tx.run(
      `INSERT INTO child_runs (id, work_id, task_id, parent_agent_run_id, seq, title, instruction, write_paths_json, workspace_dir,
         provider, model, effort, timeout_ms, max_attempts, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'child', 'do', '["src"]', '/tmp/w', 'claude', 'claude-sonnet-5-5', 'medium', 1000, 2, 'queued', ?, ?)`,
      ids.childRun, ids.work, ids.task, ids.parent, now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, effort, status, parent_agent_id, child_run_id, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'claude', 'claude-sonnet-5-5', 'medium', 'running', ?, ?, ?, ?)`,
      ids.child, ids.work, ids.task, ids.parent, ids.childRun, now, now,
    );
    return null;
  });
  const insertOpencode = (tx, id, seq) => tx.run(
    `INSERT INTO child_runs (id, work_id, task_id, parent_agent_run_id, seq, title, instruction, write_paths_json, workspace_dir,
       provider, model, effort, timeout_ms, max_attempts, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'child', 'do', '[]', '/tmp/w', 'opencode', 'p/m', NULL, 1000, 2, 'queued', ?, ?)`,
    id, ids.work, ids.task, ids.parent, seq, now, now,
  );
  await assert.rejects(db.createWriteLane().transact((tx) => { insertOpencode(tx, createUlid(), 2); return null; }), /CHECK constraint failed/);

  db.migrate(migrations);

  assert.deepEqual(
    db.get("SELECT id, provider, model, effort, status FROM child_runs WHERE id = ?", ids.childRun),
    { id: ids.childRun, provider: "claude", model: "claude-sonnet-5-5", effort: "medium", status: "queued" },
  );
  assert.equal(db.get("SELECT child_run_id FROM agent_runs WHERE id = ?", ids.child).child_run_id, ids.childRun);
  assert.equal(db.get("SELECT child_run_id FROM agent_runs WHERE id = ?", ids.parent).child_run_id, null);
  await db.createWriteLane().transact((tx) => { insertOpencode(tx, createUlid(), 2); return null; });
  assert.equal(db.get("SELECT COUNT(*) AS count FROM child_runs").count, 2);
  assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
});
