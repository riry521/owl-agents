import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createChildRunScheduler, summarizeChildReport } from "../../packages/core/dist/child-run-scheduler.js";
import { runExecutorProcess } from "../../packages/core/dist/executor.js";
import { DEFAULT_CHILD_RUN_SETTINGS, GUARD_TOKEN_FILE_ENV, MINIMAL_CODE_RULES } from "../../packages/shared/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const fakeClaude = [
  `#!${process.execPath}`,
  "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  "const prompt = readFileSync(0, 'utf8');",
  "const dir = process.env.OWL_TEST_RECORD_DIR;",
  "const childId = process.env.OWL_AGENT_SUBTASK_ID;",
  "const runId = process.env.OWL_AGENT_RUN_ID;",
  `const tokenFile = process.env.${GUARD_TOKEN_FILE_ENV};`,
  "writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ prompt, args: process.argv.slice(2), runId, childId, dispatchMcp: process.env.OWL_DISPATCH_MCP ?? null, workId: process.env.OWL_WORK_ID ?? null, taskId: process.env.OWL_TASK_ID ?? null, projectId: process.env.OWL_PROJECT_ID ?? null, token: tokenFile && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : null }));",
  "const countFile = join(dir, `${childId}.count`);",
  "const count = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;",
  "writeFileSync(countFile, String(count + 1));",
  "if (prompt.includes('HANG_CHILD')) { process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000); }",
  "if (prompt.includes('RETRY_ONCE') && count === 0) { process.exit(17); }",
  "if (prompt.includes('RATE_LIMIT_ONCE') && count === 0) { console.log(JSON.stringify({ type: 'result', result: 'rate limit marker' })); process.exit(1); }",
  "const summary = prompt.includes('LARGE_REPORT') ? 'x'.repeat(1200) : 'child summary';",
  "const fence = String.fromCharCode(96).repeat(3);",
  "const report = fence + 'owl-child-report\\n' + JSON.stringify({ result: 'succeeded', summary, changed_files: ['src/child.ts'], checks: [{ command: 'node --test', passed: true }], remaining_issues: [] }) + '\\n' + fence;",
  "const finish = () => setTimeout(() => { console.log(JSON.stringify({ type: 'result', subtype: 'success', result: report })); }, 100);",
  // USAGE_PLAN: one request per prompt size (each id on two lines, like Claude). The memo goes out with the first request,
  // so a child stopped later still streamed one. Then: hang (HANG_AFTER_PLAN), hand off once Owl asks, or finish.
  "const segment = count + 1;",
  "const plan = prompt.match(/USAGE_PLAN=(\\[[0-9,]+\\])/u);",
  "const finishOn = prompt.match(/FINISH_ON_SEGMENT=([0-9]+)/u);",
  "if (plan && !(finishOn && Number(finishOn[1]) === segment)) {",
  "  const args = process.argv.slice(2);",
  "  const model = args[args.indexOf('--model') + 1];",
  "  const memo = fence + 'owl-child-handoff\\n' + JSON.stringify({ summary: 'memo of segment ' + segment, done: ['done ' + segment], remaining: ['remaining ' + segment], next_steps: ['continue ' + segment], changed_files: ['src/relay-' + segment + '.ts'], notes: '' }) + '\\n' + fence;",
  "  const line = (index, tokens, text) => JSON.stringify({ type: 'assistant', message: { id: 'msg_' + index, model, usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 5 }, content: [{ type: 'text', text }] } });",
  "  JSON.parse(plan[1]).forEach((tokens, index) => { console.log(line(index, tokens, 'step')); console.log(line(index, tokens, index === 0 ? memo : 'step')); });",
  "  if (prompt.includes('HANG_AFTER_PLAN')) { process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000); }",
  "  else {",
  "    const deadline = Date.now() + 2000;",
  "    const poll = () => {",
  "      let state = null;",
  "      try { state = JSON.parse(readFileSync(process.env.OWL_RELAY_STATE_FILE, 'utf8')); } catch {}",
  "      if (state && state.phase === 'handoff') { console.log(JSON.stringify({ type: 'result', subtype: 'success', result: memo })); return; }",
  "      if (Date.now() < deadline) setTimeout(poll, 50); else finish();",
  "    };",
  "    poll();",
  "  }",
  "} else finish();",
].join("\n");

const fakeCodex = [
  `#!${process.execPath}`,
  "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  "const prompt = readFileSync(0, 'utf8');",
  "const dir = process.env.OWL_TEST_RECORD_DIR;",
  "const runId = process.env.OWL_AGENT_RUN_ID;",
  "const childId = process.env.OWL_AGENT_SUBTASK_ID;",
  `const tokenFile = process.env.${GUARD_TOKEN_FILE_ENV};`,
  "writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ prompt, args: process.argv.slice(2), runId, childId, dispatchMcp: process.env.OWL_DISPATCH_MCP ?? null, workId: process.env.OWL_WORK_ID ?? null, taskId: process.env.OWL_TASK_ID ?? null, projectId: process.env.OWL_PROJECT_ID ?? null, token: tokenFile && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : null }));",
  "const fence = String.fromCharCode(96).repeat(3);",
  "const report = fence + 'owl-child-report\\n' + JSON.stringify({ result: 'succeeded', summary: 'codex child summary', changed_files: ['src/codex.ts'], checks: [], remaining_issues: [] }) + '\\n' + fence;",
  "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: report } }));",
].join("\n");

async function setup(t, { settings = {}, pauseController, parentHarness = "claude", parentModel = "test-model", parentEffort = null } = {}) {
  const root = await tempDir(t, "owl-child-run-scheduler-");
  const bin = join(root, "bin");
  const records = join(root, "records");
  const workspace = join(root, "workspace");
  const guardFiles = join(root, "guards");
  await Promise.all([mkdir(bin), mkdir(records), mkdir(workspace), mkdir(guardFiles)]);
  const claude = join(bin, "claude");
  const codex = join(bin, "codex");
  await writeFile(claude, fakeClaude);
  await writeFile(codex, fakeCodex);
  await chmod(claude, 0o755);
  await chmod(codex, 0o755);

  const db = createTestDatabase(root);
  const ids = { work: createUlid(), task: createUlid(), parent: createUlid() };
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Child Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      ids.work, now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Child Task', 'code', 'running', 'normal', 'context marker', 'acceptance marker', ?, ?)`,
      ids.task, ids.work, now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, effort, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', ?, ?, ?, 'running', ?, ?)`,
      ids.parent, ids.work, ids.task, parentHarness, parentModel, parentEffort, now, now,
    );
  });

  const guardCalls = [];
  const runtime = {
    owlRoot: repoRoot,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root, OWL_TEST_RECORD_DIR: records, OWL_DISPATCH_MCP: "must-not-reach-child" },
    executables: { claude, codex },
    guardToken: ({ agent_run_id, role }) => {
      guardCalls.push({ agent_run_id, role });
      const file = join(guardFiles, agent_run_id);
      writeFileSync(file, "child-guard-token");
      return { file, release() {} };
    },
    detectRateLimit: (_provider, stdout) => stdout.includes("rate limit marker") ? { resets_at: null } : null,
  };
  const scheduler = createChildRunScheduler({
    db,
    writeLane: db.createWriteLane(),
    executorRuntime: () => runtime,
    providerPauseController: pauseController,
    settings: () => ({ ...DEFAULT_CHILD_RUN_SETTINGS, ...settings }),
    onParentActivity() {},
  });
  scheduler.registerParent({
    agent_run_id: ids.parent,
    work_id: ids.work,
    task_id: ids.task,
    project_id: "project-marker",
    harness: parentHarness,
    workspace_dir: workspace,
    worktree: workspace,
    task: { title: "Task marker", acceptance_criteria: [{ id: "AC1", text: "Acceptance marker", check: "Check marker", serves: "Serves marker", if_omitted: "Omitted marker", check_weight: "light", weight_reason: "" }], context: "Context marker", manager_notes: null, necessity: null, rules: "Rule Store marker", owner_guidance: [{ decision: "Owner marker" }], knowledge: "Memory catalog marker" },
  });
  t.after(async () => {
    await scheduler.stop();
    db.close();
  });
  return { db, scheduler, ids, records, workspace, guardCalls, runtime };
}

function dispatch(scheduler, parentId, instruction, writePaths, requestKey = instruction, extra = {}) {
  return scheduler.dispatch(parentId, { title: instruction, instruction, write_paths: writePaths, ...extra }, requestKey);
}

test("disjoint children run in parallel, overlapping write_paths queue, and the child prompt and guard are automatic", { skip: process.platform === "win32" }, async (t) => {
  const { db, scheduler, ids, records, guardCalls } = await setup(t, {});
  const first = await dispatch(scheduler, ids.parent, "first child", ["src/shared"]);
  const overlap = await dispatch(scheduler, ids.parent, "overlapping child", ["src/shared/file.ts"]);
  const disjoint = await dispatch(scheduler, ids.parent, "disjoint child", ["docs/other.md"]);

  assert.equal(first.status, "running");
  assert.equal(overlap.status, "queued");
  assert.equal(overlap.blocked_reason, "write_scope");
  assert.equal(disjoint.status, "running");
  const finished = await scheduler.wait(ids.parent, { child_ids: [first.child_id, overlap.child_id, disjoint.child_id], timeout_seconds: 8 }, new AbortController().signal);
  assert.equal(finished.done, true);
  assert.ok(finished.children.every((item) => item.status === "completed"), JSON.stringify(finished.children));

  const runRows = db.all("SELECT id, child_run_id, parent_agent_id FROM agent_runs WHERE child_run_id IS NOT NULL ORDER BY created_at, id");
  assert.equal(runRows.length, 3);
  assert.ok(runRows.every((run) => run.parent_agent_id === ids.parent));
  assert.ok(guardCalls.every((call) => call.agent_run_id.startsWith("01") && call.role === "worker"));
  const childOutput = JSON.parse(await readFile(join(records, `${runRows[0].id}.json`), "utf8"));
  assert.equal(childOutput.runId, runRows[0].id);
  assert.equal(childOutput.childId, runRows[0].child_run_id);
  assert.equal(childOutput.dispatchMcp, null);
  assert.equal(childOutput.workId, ids.work);
  assert.equal(childOutput.taskId, ids.task);
  assert.equal(childOutput.projectId, "project-marker");
  assert.match(childOutput.prompt, /## Memory catalog[\s\S]*Memory catalog marker/u);
  assert.equal(childOutput.token, "child-guard-token");
  assert.match(childOutput.prompt, /You are a child agent dispatched by the Worker of an Owl Task/u);
  assert.match(childOutput.prompt, /Your write_paths: /u);
  assert.match(childOutput.prompt, /"acceptance_criteria":\[\{"id":"AC1","text":"Acceptance marker"[\s\S]*"context":"Context marker"/u);
  assert.match(childOutput.prompt, /Rule Store marker[\s\S]*Owner marker/u);
  for (const rule of MINIMAL_CODE_RULES) assert.ok(childOutput.prompt.includes(rule));
  assert.match(childOutput.prompt, /```owl-child-report/u);
});

test("legacy child settings with non-default model and effort are completed when read", async (t) => {
  const { db, runtime, workspace } = await setup(t);
  const now = new Date().toISOString();
  const legacy = { default_provider: "codex", default_model: "gpt-5.6-terra", default_effort: "medium" };
  await db.createWriteLane().transact((tx) => {
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('child_run_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify(legacy), now,
    );
  });
  const { core } = await createTestCore(t, { db, version: "child-run-legacy-test", owlRoot: runtime.owlRoot, dataDir: workspace });

  const settings = core.getChildRunSettings();
  assert.equal(settings.default_provider, "codex");
  assert.equal(settings.default_model, "gpt-5.6-terra");
  assert.equal(settings.default_effort, "medium");
  assert.ok(settings.allowed_models.some((choice) => choice.provider === "codex" && choice.model === "gpt-5.6-terra"));
  assert.ok(settings.allowed_efforts.includes("medium"));
  assert.deepEqual(settings.defaults_by_parent_harness, DEFAULT_CHILD_RUN_SETTINGS.defaults_by_parent_harness);

  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE settings SET value_json = ? WHERE key = 'child_run_settings'", JSON.stringify({ ...legacy, default_effort: "xhigh" }));
  });
  const withLegacyEffort = core.getChildRunSettings();
  assert.equal(withLegacyEffort.default_effort, "xhigh");
  assert.ok(withLegacyEffort.allowed_efforts.includes("xhigh"));
});

test("stored child settings with the removed parallel-limit keys load without them", async (t) => {
  const stale = { ...DEFAULT_CHILD_RUN_SETTINGS, max_parallel_per_worker: 3, max_parallel_total: 6 };
  const { db, runtime, workspace, scheduler, ids } = await setup(t, { settings: stale });
  const dispatched = await dispatch(scheduler, ids.parent, "HANG_CHILD stale-keys", ["src/stale"]);
  assert.equal(dispatched.status, "running");
  await db.createWriteLane().transact((tx) => {
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('child_run_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify(stale), new Date().toISOString(),
    );
  });
  const { core } = await createTestCore(t, { db, version: "child-run-stale-keys-test", owlRoot: runtime.owlRoot, dataDir: workspace });
  const settings = core.getChildRunSettings();
  assert.equal("max_parallel_per_worker" in settings, false);
  assert.equal("max_parallel_total" in settings, false);
  assert.equal("max_parallel_per_worker" in await core.setChildRunSettings(stale), false);
});

test("children with disjoint write scopes all run at once, however many there are", { skip: process.platform === "win32" }, async (t) => {
  const { scheduler, ids } = await setup(t);
  const children = [];
  for (let index = 0; index < 10; index += 1) {
    children.push(await dispatch(scheduler, ids.parent, `HANG_CHILD ${index}`, [`src/scope-${index}`]));
  }
  assert.deepEqual(children.map((child) => child.status), Array(10).fill("running"));
});

test("explicit parent defaults outside narrowed allowlists reject settings without changing the saved value", async (t) => {
  const { db, runtime, workspace } = await setup(t);
  const { core } = await createTestCore(t, { db, version: "child-run-validation-test", owlRoot: runtime.owlRoot, dataDir: workspace });

  const saved = await core.setChildRunSettings(DEFAULT_CHILD_RUN_SETTINGS);
  const invalid = {
    ...saved,
    allowed_models: [{ provider: "claude", model: "claude-sonnet-5" }],
    allowed_efforts: ["low"],
    default_effort: "low",
    defaults_by_parent_harness: DEFAULT_CHILD_RUN_SETTINGS.defaults_by_parent_harness,
  };
  await assert.rejects(
    () => core.setChildRunSettings(invalid),
    (error) => error?.code === "validation_error",
  );
  assert.deepEqual(core.getChildRunSettings(), saved);
});

test("exit_code is retried once with a linked AgentRun and retry context in the prompt", { skip: process.platform === "win32" }, async (t) => {
  const { db, scheduler, ids, records } = await setup(t, { parentHarness: "codex" });
  const child = await dispatch(scheduler, ids.parent, "RETRY_ONCE", ["src/retry.ts"]);
  const result = await scheduler.wait(ids.parent, { child_ids: [child.child_id], timeout_seconds: 8 }, new AbortController().signal);
  assert.equal(result.children[0].status, "completed", JSON.stringify(result.children[0]));
  assert.equal(result.children[0].attempt, 2);
  const runs = db.all("SELECT id, retry_of_run_id FROM agent_runs WHERE child_run_id = ? ORDER BY created_at, id", child.child_id);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].retry_of_run_id, runs[0].id);
  const retriedPrompt = JSON.parse(await readFile(join(records, `${runs[1].id}.json`), "utf8")).prompt;
  assert.match(retriedPrompt, /Previous attempt: \{"failure_kind":"exit_code","failure_reason":/u);
});

test("a Codex child uses its allowlisted provider and model with the same automatic prompt", { skip: process.platform === "win32" }, async (t) => {
  const previousHome = process.env.HOME;
  const { scheduler, ids, records, runtime } = await setup(t);
  process.env.HOME = runtime.env.HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const child = await dispatch(scheduler, ids.parent, "Codex child", ["src/codex.ts"], "codex-child", { provider: "codex", model: "gpt-5.6-luna" });
  const response = await scheduler.wait(ids.parent, { child_ids: [child.child_id], timeout_seconds: 8 }, new AbortController().signal);
  assert.equal(response.children[0].status, "completed");
  assert.equal(child.provider, "codex");
  assert.equal(child.model, "gpt-5.6-luna");
  const run = scheduler.list({ parent_agent_run_id: ids.parent }).find((item) => item.id === child.child_id).current_agent_run_id;
  const record = JSON.parse(await readFile(join(records, `${run}.json`), "utf8"));
  assert.equal(record.dispatchMcp, null);
  assert.equal(record.workId, ids.work);
  assert.match(record.prompt, /Your write_paths: src\/codex\.ts/u);
});

test("the default settings allow a claude-haiku-5-5 child; an allowlist without it rejects the dispatch", { skip: process.platform === "win32" }, async (t) => {
  const { scheduler, ids } = await setup(t);
  const child = await dispatch(scheduler, ids.parent, "Haiku child", ["src/haiku.ts"], "haiku-child", { provider: "claude", model: "claude-haiku-5-5" });
  assert.equal(child.provider, "claude");
  assert.equal(child.model, "claude-haiku-5-5");
  const response = await scheduler.wait(ids.parent, { child_ids: [child.child_id], timeout_seconds: 8 }, new AbortController().signal);
  assert.equal(response.children[0].status, "completed");

  const withoutHaiku = DEFAULT_CHILD_RUN_SETTINGS.allowed_models.filter((choice) => choice.model !== "claude-haiku-5-5");
  const narrowed = await setup(t, { settings: { allowed_models: withoutHaiku } });
  await assert.rejects(
    dispatch(narrowed.scheduler, narrowed.ids.parent, "Haiku child", ["src/haiku.ts"], "haiku-denied", { provider: "claude", model: "claude-haiku-5-5" }),
    (error) => error.code === "model_not_allowed",
  );
});

const HAIKU = { provider: "claude", model: "claude-haiku-5-5" };
const relaySettings = (tokenRelay) => ({ token_relay: { ...DEFAULT_CHILD_RUN_SETTINGS.token_relay, ...tokenRelay } });

async function runHaikuChild(fixture, instruction) {
  const child = await dispatch(fixture.scheduler, fixture.ids.parent, instruction, ["src/relay"], instruction, HAIKU);
  const waited = await fixture.scheduler.wait(fixture.ids.parent, { child_ids: [child.child_id], timeout_seconds: 20 }, new AbortController().signal);
  const events = (type) => fixture.db.all("SELECT payload_json FROM events WHERE type = ? AND json_extract(payload_json, '$.child_run_id') = ?", type, child.child_id)
    .map((row) => JSON.parse(row.payload_json));
  const runs = fixture.db.all("SELECT id, status FROM agent_runs WHERE child_run_id = ?", child.child_id);
  const prompt = async (runId) => JSON.parse(await readFile(join(fixture.records, `${runId}.json`), "utf8")).prompt;
  return {
    child: waited.children[0],
    row: fixture.db.get("SELECT relay_count, attempt, handoff_json FROM child_runs WHERE id = ?", child.child_id),
    relayed: events("child_run.relayed"),
    limited: events("child_run.relay_limited"),
    runs,
    prompt,
  };
}

test("a Haiku child that hands off at the handoff limit is restarted from its memo without using an attempt", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await setup(t);
  const result = await runHaikuChild(fixture, "USAGE_PLAN=[1000,72000] FINISH_ON_SEGMENT=2");

  assert.equal(result.child.status, "completed", JSON.stringify(result.child));
  assert.equal(result.child.summary.result, "succeeded");
  assert.equal(result.row.relay_count, 1);
  assert.equal(result.row.attempt, 1);
  assert.equal(result.relayed.length, 1);
  assert.equal(result.relayed[0].reason, "handoff");
  assert.equal(result.relayed[0].relay_count, 1);
  assert.equal(result.relayed[0].has_memo, true);
  assert.equal(result.runs.length, 2);
  const first = result.relayed[0].agent_run_id;
  const second = result.runs.find((run) => run.id !== first).id;
  assert.doesNotMatch(await result.prompt(first), /## Handoff from the previous child/u);
  const resumed = await result.prompt(second);
  assert.match(resumed, /## Handoff from the previous child[\s\S]*\(handoff\)[\s\S]*Memo: .*memo of segment 1/u);
  assert.equal(fixture.scheduler.list({ parent_agent_run_id: fixture.ids.parent })[0].relay_count, 1);

  // Each request is one row even though Claude repeats a message id over several lines.
  const requests = fixture.db.all("SELECT * FROM agent_run_requests WHERE agent_run_id = ? ORDER BY prompt_tokens", first);
  assert.deepEqual(requests.map((row) => [row.message_id, row.prompt_tokens, row.model, row.provider, row.subagent, row.child_run_id, row.work_id]), [
    ["msg_0", 1000, "claude-haiku-5-5", "claude", 0, result.child.child_id, fixture.ids.work],
    ["msg_1", 72000, "claude-haiku-5-5", "claude", 0, result.child.child_id, fixture.ids.work],
  ]);
});

test("a Haiku child stopped at the stop limit is restarted from the last memo it streamed", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await setup(t);
  const result = await runHaikuChild(fixture, "USAGE_PLAN=[1000,96000] HANG_AFTER_PLAN FINISH_ON_SEGMENT=2");

  assert.equal(result.child.status, "completed", JSON.stringify(result.child));
  assert.equal(result.row.relay_count, 1);
  assert.equal(result.row.attempt, 1);
  assert.equal(result.relayed.length, 1);
  assert.equal(result.relayed[0].reason, "kill");
  assert.equal(result.relayed[0].peak_prompt_tokens, 96000);
  const first = result.relayed[0].agent_run_id;
  assert.equal(result.runs.find((run) => run.id === first).status, "failed");
  const resumed = await result.prompt(result.runs.find((run) => run.id !== first).id);
  assert.match(resumed, /## Handoff from the previous child[\s\S]*\(kill\)[\s\S]*Memo: .*memo of segment 1/u);
});

test("past max_relays the child returns to the Worker as partial with the latest memo as its remaining work", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await setup(t, { settings: relaySettings({ max_relays: 1 }) });
  const result = await runHaikuChild(fixture, "USAGE_PLAN=[1000,72000]");

  assert.equal(result.child.status, "completed", JSON.stringify(result.child));
  assert.equal(result.child.summary.result, "partial");
  assert.match(result.child.summary.summary, /after 1 restarts \(token relay limit\)\. Last handoff: memo of segment 2/u);
  assert.deepEqual(result.child.summary.remaining_issues, ["remaining 2", "next: continue 2"]);
  assert.deepEqual(result.child.summary.changed_files, ["src/relay-2.ts"]);
  assert.equal(result.row.relay_count, 1);
  assert.equal(JSON.parse(result.row.handoff_json).memo.summary, "memo of segment 2");
  assert.equal(result.relayed.length, 1);
  assert.deepEqual(result.limited, [{ child_run_id: result.child.child_id, relay_count: 1, peak_prompt_tokens: 72000 }]);
});

test("token relay settings decide whether a child hands off, returns at once, or is stopped", { skip: process.platform === "win32" }, async (t) => {
  const higherHandoff = await runHaikuChild(await setup(t, { settings: relaySettings({ handoff_tokens: 80_000 }) }), "USAGE_PLAN=[1000,72000]");
  assert.equal(higherHandoff.child.status, "completed");
  assert.equal(higherHandoff.child.summary.result, "succeeded");
  assert.equal(higherHandoff.row.relay_count, 0);
  assert.equal(higherHandoff.relayed.length + higherHandoff.limited.length, 0);

  const noRelays = await runHaikuChild(await setup(t, { settings: relaySettings({ max_relays: 0 }) }), "USAGE_PLAN=[1000,72000]");
  assert.equal(noRelays.child.summary.result, "partial");
  assert.equal(noRelays.row.relay_count, 0);
  assert.equal(noRelays.relayed.length, 0);
  assert.equal(noRelays.limited.length, 1);
  assert.equal(noRelays.runs.length, 1);

  const lowerStop = await runHaikuChild(await setup(t, { settings: relaySettings({ handoff_tokens: 60_000, kill_tokens: 71_000 }) }), "USAGE_PLAN=[1000,72000] HANG_AFTER_PLAN FINISH_ON_SEGMENT=2");
  assert.equal(lowerStop.child.status, "completed");
  assert.equal(lowerStop.relayed.length, 1);
  assert.equal(lowerStop.relayed[0].reason, "kill");
});

test("dispatch resolves provider, model and effort independently from the parent's harness defaults", { skip: process.platform === "win32" }, async (t) => {
  const previousHome = process.env.HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const cases = [
    { parentHarness: "claude", request: {}, expected: { provider: "codex", model: "gpt-5.6-luna", effort: "medium" } },
    { parentHarness: "codex", request: {}, expected: { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" } },
    { parentHarness: "claude", request: { effort: "low" }, expected: { provider: "codex", model: "gpt-5.6-luna", effort: "low" } },
    { parentHarness: "claude", parentModel: "claude-sonnet-5-5", parentEffort: "medium", request: { provider: "claude", model: "claude-sonnet-5-5", effort: "low" }, expected: { provider: "claude", model: "claude-sonnet-5-5", effort: "low" } },
  ];

  for (const [index, item] of cases.entries()) {
    const { db, scheduler, ids, records, runtime } = await setup(t, { parentHarness: item.parentHarness, parentModel: item.parentModel, parentEffort: item.parentEffort });
    process.env.HOME = runtime.env.HOME;
    const child = await dispatch(scheduler, ids.parent, `resolved child ${index}`, [`src/resolved-${index}.ts`], `resolved-${index}`, item.request);
    const waited = await scheduler.wait(ids.parent, { child_ids: [child.child_id], timeout_seconds: 8 }, new AbortController().signal);
    assert.equal(waited.children[0].status, "completed");
    assert.deepEqual({ provider: child.provider, model: child.model, effort: child.effort }, item.expected);

    const run = db.get("SELECT id, provider, model, effort FROM agent_runs WHERE child_run_id = ?", child.child_id);
    assert.deepEqual({ provider: run.provider, model: run.model, effort: run.effort }, item.expected);
    const args = JSON.parse(await readFile(join(records, `${run.id}.json`), "utf8")).args;
    assert.equal(args[args.indexOf("--model") + 1], item.expected.model);
    if (item.expected.provider === "claude") {
      assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", item.expected.effort]);
    } else {
      const effortSettingIndex = args.indexOf(`model_reasoning_effort=${item.expected.effort}`);
      assert.ok(effortSettingIndex > 0);
      assert.equal(args[effortSettingIndex - 1], "--config");
    }
  }
});

test("executor spawn failures carry failure_kind=spawn_error", { skip: process.platform === "win32" }, async (t) => {
  const { runtime, workspace } = await setup(t);
  const result = await runExecutorProcess(
    { subtask_id: "child-spawn-error", instruction: "run", workspace_dir: workspace, task: { title: "t", acceptance: "", context: "", rules: "", owner_guidance: [] } },
    { provider: "claude", model: "test-model", timeout_ms: 1000 },
    {},
    { usage: null },
    { ...runtime, executables: { claude: join(workspace, "missing-claude") } },
  );
  assert.equal(result.success, false);
  assert.equal(result.failure_kind, "spawn_error");
});

test("a per-child timeout fails the run without retrying", { skip: process.platform === "win32" }, async (t) => {
  let paused = true;
  const pauseController = {
    isPaused() { return paused; },
    async recordRateLimit() { throw new Error("unexpected rate limit"); },
    async noteProviderSucceeded() { return null; },
  };
  const { db, scheduler, ids } = await setup(t, { pauseController, parentHarness: "codex" });
  const child = await dispatch(scheduler, ids.parent, "HANG_CHILD", ["src/timeout.ts"]);
  assert.equal(child.status, "queued");
  assert.equal(child.blocked_reason, "provider_paused");
  await db.createWriteLane().transact((tx) => tx.run("UPDATE child_runs SET timeout_ms = 80 WHERE id = ?", child.child_id));
  paused = false;
  scheduler.pump();
  const result = await scheduler.wait(ids.parent, { child_ids: [child.child_id], timeout_seconds: 8 }, new AbortController().signal);
  assert.equal(result.children[0].status, "failed");
  assert.equal(result.children[0].summary.failure.kind, "timeout", JSON.stringify(result.children[0].summary));
  assert.equal(result.children[0].attempt, 1);
});

test("rate-limited children queue without consuming an attempt and resume after resumeNow", { skip: process.platform === "win32" }, async (t) => {
  let paused = false;
  const pauseController = {
    isPaused() { return paused; },
    async recordRateLimit() { paused = true; return {}; },
    async resumeNow() { paused = false; return {}; },
    async noteProviderSucceeded() { return null; },
  };
  const { db, scheduler, ids } = await setup(t, { pauseController, parentHarness: "codex" });
  const child = await dispatch(scheduler, ids.parent, "RATE_LIMIT_ONCE", ["src/rate-limit.ts"]);
  const queued = await waitFor(() => db.get("SELECT status FROM child_runs WHERE id = ? AND blocked_reason = 'provider_paused'", child.child_id), { timeoutMs: 8_000 });
  assert.equal(queued.status, "queued");
  assert.equal(db.get("SELECT attempt, rate_limit_requeues FROM child_runs WHERE id = ?", child.child_id).attempt, 0);
  await pauseController.resumeNow("claude");
  scheduler.pump();
  const result = await scheduler.wait(ids.parent, { child_ids: [child.child_id], timeout_seconds: 8 }, new AbortController().signal);
  assert.equal(result.children[0].status, "completed");
  assert.equal(result.children[0].attempt, 1);
  assert.equal(db.get("SELECT rate_limit_requeues FROM child_runs WHERE id = ?", child.child_id).rate_limit_requeues, 1);
});

test("dispatch rejects models and effort outside configured allowlists; wait caps its ID count", { skip: process.platform === "win32" }, async (t) => {
  const { scheduler, ids } = await setup(t);
  await assert.rejects(
    scheduler.dispatch(ids.parent, { title: "not allowed", instruction: "run", write_paths: ["src/a"], model: "unapproved-model" }, "bad-model"),
    (error) => error.code === "model_not_allowed",
  );
  await assert.rejects(
    scheduler.dispatch(ids.parent, { title: "not allowed", instruction: "run", write_paths: ["src/a"], effort: "xhigh" }, "bad-effort"),
    (error) => error.code === "effort_not_allowed",
  );
  await assert.rejects(
    scheduler.wait(ids.parent, { child_ids: Array.from({ length: 17 }, () => "missing") }, new AbortController().signal),
    (error) => error.code === "validation_error",
  );
});

test("releaseParent cancels both queued and running children", { skip: process.platform === "win32" }, async (t) => {
  const { scheduler, ids } = await setup(t);
  const running = await dispatch(scheduler, ids.parent, "HANG_CHILD running", ["src/release"]);
  const queued = await dispatch(scheduler, ids.parent, "HANG_CHILD queued", ["src/release/file.ts"]);
  assert.equal(running.status, "running");
  assert.equal(queued.status, "queued");
  const released = await scheduler.releaseParent(ids.parent, "parent_ended");
  assert.deepEqual(new Set(released.map((item) => item.status)), new Set(["cancelled"]));
  assert.deepEqual(new Set(released.map((item) => item.failure_kind)), new Set(["parent_ended"]));
});

test("structured child summaries and wait responses stay within their size limits", { skip: process.platform === "win32" }, async (t) => {
  const fence = String.fromCharCode(96).repeat(3);
  const hugeReport = `${fence}owl-child-report\n${JSON.stringify({
    result: "succeeded",
    summary: "s".repeat(1200),
    changed_files: Array.from({ length: 40 }, (_, index) => `${index}-${"f".repeat(190)}`),
    checks: Array.from({ length: 8 }, () => ({ command: "c".repeat(200), passed: true })),
    remaining_issues: Array.from({ length: 5 }, () => "i".repeat(300)),
  })}\n${fence}`;
  const summary = summarizeChildReport(hugeReport, { success: true, failure_kind: null, failure_reason: null }, 1, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 3 * 1024);

  const { scheduler, ids } = await setup(t, { parentHarness: "codex" });
  const children = [];
  for (let index = 0; index < 16; index += 1) {
    children.push(await dispatch(scheduler, ids.parent, `LARGE_REPORT ${index}`, [`src/${index}.ts`]));
  }
  const response = await scheduler.wait(ids.parent, { child_ids: children.map((item) => item.child_id), timeout_seconds: 12 }, new AbortController().signal);
  assert.equal(response.done, true);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 16 * 1024);
  assert.equal(response.truncated, true);
  assert.ok(response.children.some((item) => item.summary_omitted));
});
