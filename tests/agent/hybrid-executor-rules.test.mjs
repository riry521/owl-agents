import { createRequire } from "node:module";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createTestCore, command } from "../helpers/core.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { splitRolePrompt } from "../../packages/agent-runtime/dist/role-contract.js";
import { writeCommonIndex } from "../helpers/seed-knowledge.mjs";

// Child processes (sh, sleep) need a PATH even when the runner has none.
process.env.PATH ||= `${process.execPath.replace(/\/[^\/]*$/, "")}:/usr/bin:/bin`;


function promptInput(prompt, name) {
  const inputs = splitRolePrompt(prompt)?.inputs;
  assert.ok(inputs && Object.hasOwn(inputs, name), `prompt includes ${name}`);
  return inputs[name];
}



test("Hybrid Tasks use one Worker session to dispatch, wait, verify, then send its delegation report to the Reviewer", { skip: process.platform === "win32" }, async (t) => {
  const root = await tempDir(t, "owl-hybrid-worker-dispatch-");
  await mkdir(join(root, "rules", "system"), { recursive: true });
  await writeFile(join(root, "rules/system/markers.yaml"), [
    "level: system",
    "rules:",
    "  - id: worker_marker",
    "    kind: instruction",
    '    text: "worker-rule-marker"',
    "",
  ].join("\n"));
  const bin = join(root, "bin");
  const prompts = join(root, "prompts");
  await mkdir(bin, { recursive: true });
  await mkdir(prompts, { recursive: true });
  await writeFile(join(bin, "claude"), [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    `fs.writeFileSync(process.env.OWL_TEST_PROMPTS + '/' + process.env.OWL_AGENT_RUN_ID + '.txt', prompt);`,
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'child done' }));",
    "",
  ].join("\n"));
  await chmod(join(bin, "claude"), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  let core;
  const workerRequests = [];
  const reviewerRequests = [];
  let reviewerRequest = null;
  let children = [];
  const dispatchedByWorkerRun = new Map();
  let childWait = null;
  let workerError = null;
  let wholeTaskChecked = false;
  const providerRequests = [];
  let reportMode = "paraphrase";
  const runtimeAgentRunner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        providerRequests.push(request);
        let report;
        if (request.role === "worker") {
          workerError = null;
          wholeTaskChecked = false;
          childWait = null;
          try {
            children = [];
            for (const [index, writePath] of ["src/feature-a.ts", "src/feature-b.ts"].entries()) {
              children.push(await core.dispatchChildRun(request.invocation_id, {
                title: `Implement feature ${index + 1}`,
                instruction: `Implement delegated feature ${index + 1}.`,
                write_paths: [writePath],
              }, `hybrid-feature-${index + 1}`));
            }
            dispatchedByWorkerRun.set(request.invocation_id, children.map((child) => child.child_id));
            childWait = await core.waitChildRuns(request.invocation_id, {
              child_ids: children.map((child) => child.child_id),
              timeout_seconds: 8,
            }, new AbortController().signal);
            wholeTaskChecked = childWait.done && childWait.children.length === children.length && childWait.children.every((item) => item.status === "completed");
          } catch (error) {
            workerError = error;
          }
          const delegated = children.map((child, index) => ({
            child_id: reportMode === "unknown-child" && index === 0 ? "not-dispatched-child" : child.child_id,
            instruction: reportMode === "paraphrase"
              ? `Build the requested feature and check it; write_paths: src/feature-${index === 0 ? "a" : "b"}.ts.`
              : `Implement delegated feature ${index + 1}.`,
            provider: child.provider,
            model: reportMode === "effort" && index === 0 ? `${child.model} low` : child.model,
          }));
          report = {
            kind: "report", schema_version: "1.1.0", invocation_id: request.invocation_id, result: "success",
            work_done: "Implemented and checked the whole Task after the child completed.",
            changes: [], verification: { status: wholeTaskChecked ? "passed" : "blocked", method: "Checked the whole Task after wait.", acceptance: [{ criterion_id: "AC1", status: wholeTaskChecked ? "passed" : "blocked", evidence: "e" }], checks: [], integration_check: wholeTaskChecked ? { status: "passed", evidence: "built" } : null },
            remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null, pending_process: null, external_blocker: null,
            delegation: {
              decomposition: "The feature implementation was independent and safe to delegate.",
              delegated: reportMode === "missing-child" ? delegated.slice(0, 1) : delegated,
              retained: [{ part: "Whole-Task verification", reason: "It requires integrating all child results." }],
            },
          };
        } else if (request.role === "reviewer") {
          report = { verdict: "pass", summary: "The whole Task is complete.", findings: [], tests: { ran: true, command: "Checked the whole Task", passed: 1, failed: 0 } };
        } else {
          throw new Error(`Unexpected provider role: ${request.role}`);
        }
        return { adapter: request.adapter, stdout: JSON.stringify(report), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: {
        event: "work.planned",
        tasks: [{ id: "T1", title: "Hybrid delegation", type: "code", acceptance: "acceptance-marker", context: "context-marker", depends_on: [], required_sections: [], required_tests: [], replaces: [] }],
      } }
      : request.mode === "finalize" || request.context?.mode === "finalize"
        ? { outcome: "success", report_valid: true, report: { event: null, tasks: request.tasks ?? [], verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "failed", message: "Unexpected Manager request." },
    runWorker: async (request) => {
      workerRequests.push(request);
      await writeFile(join(request.context.worktree, "out.mjs"), "export {};\n");
      return runtimeAgentRunner.runWorker(request);
    },
    runReviewer: async (request) => {
      reviewerRequest = request;
      reviewerRequests.push(request);
      return runtimeAgentRunner.runReviewer(request);
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const testCore = await createTestCore(t, {
    agentRunner,
    version: "test",
    owlRoot: root,
    executorRuntime: () => ({
      owlRoot: repoRoot,
      env: { PATH: process.env.PATH, HOME: root, OWL_TEST_PROMPTS: prompts },
      executables: { claude: join(bin, "claude") },
    }),
    dispatcher: { tick_interval_ms: 25 },
  });
  core = testCore.core;
  const { db } = testCore;

  await core.start();
  await disablePlanQuality(db);
  await core.setHybridMode(true);
  await writeCommonIndex(core.knowledgeLocation.activeDir(), "knowledge-marker is useful when implementing hybrid delegation.");
  await core.memory.reindex({ mode: "full" });
  async function runScenario(name) {
    reportMode = name;
    const expectedCount = reviewerRequests.length + 1;
    const created = await core.createWork(command({ title: `Hybrid delegation ${name}`, summary: "x", size: "normal", project_id: null }, `test:hybrid-dispatch-${name}-create`));
    await core.startWork(created.data.work_id, command({ mode: "normal" }, `test:hybrid-dispatch-${name}-start`, created.version));
    const reviewed = await waitFor(() => reviewerRequests.length === expectedCount ? reviewerRequests.at(-1) : null);
    await waitFor(() => db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", created.data.work_id));
    return reviewed;
  }

  const paraphraseReviewerRequest = await runScenario("paraphrase");
  assert.equal(workerRequests.length, 1, `the Hybrid Task has one Worker session, with no plan or verdict session: ${workerRequests.map((request) => `${request.task_id}/${request.attempt}`).join(",")}`);
  assert.deepEqual(providerRequests.map((request) => request.role), ["worker", "reviewer"]);
  assert.equal(providerRequests.filter((request) => request.role === "worker").length, 1, "the fake provider saw one Worker process request");
  assert.equal(promptInput(providerRequests[0].prompt, "Project").rules, "[system] worker-rule-marker");
  const workerProjectInput = promptInput(providerRequests[0].prompt, "Project");
  assert.match(workerProjectInput.knowledge, /knowledge-marker/u);
  assert.equal(providerRequests[0].prompt.split("worker-rule-marker").length - 1, 1, "rules are sent once in the single Worker prompt");
  assert.equal(providerRequests[0].prompt.split(JSON.stringify(workerProjectInput.knowledge)).length - 1, 1, "the knowledge excerpt is sent once in the single Worker prompt");
  assert.equal(workerRequests[0].context.hybrid_mode, true);
  assert.equal(workerRequests[0].context.hybrid_phase, undefined);
  assert.equal(workerRequests[0].context.dispatch_enabled, true);
  assert.equal(workerRequests[0].context.rules, "[system] worker-rule-marker");
  assert.equal(workerError, null, workerError?.message);
  assert.equal(wholeTaskChecked, true, "the Worker waits for its child and checks the whole Task before reporting");
  assert.equal(childWait.done, true);
  assert.deepEqual(childWait.children.map((item) => item.status), ["completed", "completed"]);
  assert.equal(paraphraseReviewerRequest.context.report.work_done, "Implemented and checked the whole Task after the child completed.");
  assert.deepEqual(paraphraseReviewerRequest.context.report.delegation.delegated.map((item) => item.child_id), children.map((child) => child.child_id));
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type = 'worker.delegation_mismatch'", paraphraseReviewerRequest.task_id).count, 0, "paraphrased instructions with write_paths remain matched by child_id");
  const workerRuns = db.all("SELECT phase FROM agent_runs WHERE task_id = ? AND role = 'worker'", paraphraseReviewerRequest.task_id);
  assert.equal(workerRuns.length, 1);
  assert.equal(workerRuns[0].phase, null);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = ? AND role = 'executor' AND child_run_id IS NULL", paraphraseReviewerRequest.task_id).count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type = 'worker.phase_changed'", paraphraseReviewerRequest.task_id).count, 0);
  const effortReviewerRequest = await runScenario("effort");
  assert.equal(workerRequests.length, 2, "each hybrid Task uses exactly one Worker session");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type = 'worker.delegation_mismatch'", effortReviewerRequest.task_id).count, 0, "a model with an effort suffix remains matched by child_id");
  assert.equal(workerError, null, workerError?.message);
  assert.equal(wholeTaskChecked, true);

  // The completion gate stops a parent with unreported or unknown children: no success, no Reviewer.
  async function runBlockedScenario(name) {
    reportMode = name;
    const reviewersBefore = reviewerRequests.length;
    const created = await core.createWork(command({ title: `Hybrid delegation ${name}`, summary: "x", size: "normal", project_id: null }, `test:hybrid-dispatch-${name}-create`));
    await core.startWork(created.data.work_id, command({ mode: "normal" }, `test:hybrid-dispatch-${name}-start`, created.version));
    const taskId = (await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ?", created.data.work_id))).id;
    const mismatch = await waitFor(() => db.get("SELECT payload_json FROM events WHERE task_id = ? AND type = 'worker.delegation_mismatch'", taskId));
    const gate = await waitFor(() => db.get("SELECT payload_json FROM events WHERE task_id = ? AND type = 'task.failure.classified' AND json_extract(payload_json, '$.error_key') = 'worker_children_incomplete'", taskId));
    assert.equal(JSON.parse(gate.payload_json).error_key, "worker_children_incomplete", `${name}: the completion gate stopped the parent`);
    assert.equal(reviewerRequests.length, reviewersBefore, `${name}: the Reviewer is not called`);
    assert.notEqual(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "success", `${name}: the parent does not become success`);
    return JSON.parse(mismatch.payload_json);
  }

  const missing = await runBlockedScenario("missing-child");
  assert.deepEqual(missing.mismatches, [{ kind: "unreported_child", child_id: dispatchedByWorkerRun.get(missing.agent_run_id)[1] }]);

  const unknown = await runBlockedScenario("unknown-child");
  assert.ok(unknown.mismatches.some((item) => item.kind === "unknown_child" && item.child_id === "not-dispatched-child"), JSON.stringify(unknown.mismatches));
  // The gate sends the stopped Task back for another attempt, so only the first two Tasks have a fixed Worker count.
  assert.ok(workerRequests.length >= 4);

  const promptFiles = await readdir(prompts);
  assert.ok(promptFiles.length >= 8);
  const childPrompts = await Promise.all(promptFiles.map((file) => readFile(join(prompts, file), "utf8")));
  assert.ok(childPrompts.some((prompt) => /Implement delegated feature 1/u.test(prompt)));
  assert.ok(childPrompts.every((prompt) => /worker-rule-marker/u.test(prompt)));
});

test("a malformed hybrid_mode setting keeps Hybrid Mode off, logs the error and leaves an Owner-visible alert", async (t) => {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-hybrid-malformed-", start: true });
  await core.setHybridMode(true);
  raw(root).exec("PRAGMA ignore_check_constraints = ON; UPDATE settings SET value_json = '{broken', updated_at = 'bad-1' WHERE key = 'hybrid_mode'");
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  assert.equal(await core.getHybridMode(), false);
  assert.ok(logged.some((args) => /Hybrid Mode setting is malformed/u.test(String(args[0]))), "the parse error is logged");
  const alert = await waitFor(() => db.get("SELECT payload_json FROM events WHERE type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'hybrid_mode_setting_malformed'"));
  assert.match(JSON.parse(alert.payload_json).message, /Hybrid Mode is off/u);
  await core.getHybridMode();
  assert.equal(db.all("SELECT 1 FROM events WHERE json_extract(payload_json, '$.kind') = 'hybrid_mode_setting_malformed'").length, 1, "the same broken value alerts once");
});

// A second connection to the test DB file: OwlDatabase hides its handle, and the test plants bad rows.
function raw(root) {
  const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))("better-sqlite3");
  return new Database(join(root, "owl.db"));
}
