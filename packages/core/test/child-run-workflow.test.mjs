import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createChildRunScheduler } from "../dist/child-run-scheduler.js";
import { NoopGitGateway, WorkflowEngine, createTaskPlanInTransaction, createWorkInTransaction } from "../dist/index.js";
import { DEFAULT_CHILD_RUN_SETTINGS, MINIMAL_CODE_RULES, WORKING_STYLE_RULES } from "../../shared/dist/index.js";
import { openDatabase } from "../../db/dist/index.js";

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

async function setup(t, workerRun) {
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
    }),
    settings: () => DEFAULT_CHILD_RUN_SETTINGS,
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
