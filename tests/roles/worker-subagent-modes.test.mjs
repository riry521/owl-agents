import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerPrompt } from "../../packages/agent-runtime/dist/worker.js";
import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { DEFAULT_CHILD_RUN_SETTINGS, researchSubagentPromptRef } from "../../packages/shared/dist/index.js";

const request = { task: { id: "t", title: "t", acceptance: "a" }, context: {} };

test("the prompt allows own subagents and passes Task rules on without dispatch order or ban when hybrid is off", () => {
  const p = buildWorkerPrompt(request, undefined, null, false);
  assert.match(p, /your own subagents \(for example Claude's Agent tool\)/);
  assert.match(p, /Use a fork when the part needs your conversation/);
  assert.match(p, /put them in its instruction/);
  assert.match(p, /disjoint write scope/);
  assert.match(p, /wait until their results come back/);
  assert.match(p, /If you start any in the background, do not end your turn until you have received every one of their results/);
  assert.match(p, /Never end your turn or report while a subagent result is still pending/);
  assert.doesNotMatch(p, /Do not use your own subagents/);
  assert.doesNotMatch(p, /Do not use provider-native subagent/);
  assert.doesNotMatch(p, /use Owl's dispatch tool/);
  assert.match(p, /goes in decomposition; delegated holds only child_ids returned by dispatch/);
});

test("the prompt keeps dispatch rules and bans own subagents and fork when hybrid is on", () => {
  const p = buildWorkerPrompt(request, undefined, null, true);
  assert.match(p, /use Owl's dispatch tool/);
  assert.match(p, /Choose provider, model, and effort independently/);
  assert.match(p, /Use wait on every dispatched run/);
  assert.match(p, /integrate the work, and check it together/);
  assert.doesNotMatch(p, /you may use your own fork/);
  assert.doesNotMatch(p, /Apart from fork/);
  assert.match(p, /Do not use your own subagents \(for example Claude's Agent tool\), forks, or other provider-native subagent/);
});

const researcher = researchSubagentPromptRef("claude");

test("with the researcher, hybrid on allows only Owl's read-only researcher and waits for every result before finishing", () => {
  const p = buildWorkerPrompt(request, undefined, null, true, researcher);
  assert.match(p, /Do not use your own subagents \(for example Claude's Agent tool\), forks, or other provider-native subagent/);
  assert.match(p, /The one exception is Owl's read-only researcher, the `owl-researcher` agent in Claude's Agent tool/);
  assert.match(p, /never give it implementation work/);
  assert.match(p, /do not end your turn until you have received the results of every dispatched run and every researcher you started/);
  assert.match(p, /set delegation\.own_subagents_used to true/);
  assert.match(p, /not provider-native subagents; only Owl's read-only researcher is allowed, for research/);
  assert.match(p, /Use wait on every dispatched run and receive all results, including every researcher result, before moving on/);
});

test("with the researcher, hybrid off keeps the wait-for-results rule and recommends the researcher", () => {
  const p = buildWorkerPrompt(request, undefined, null, false, researcher);
  assert.match(p, /Never end your turn or report while a subagent result is still pending/);
  assert.match(p, /For web or codebase research, prefer Owl's read-only researcher, the `owl-researcher` agent/);
  assert.match(p, /wait for its result like any other subagent/);
});

test("without the researcher the prompt is the same as the default call", () => {
  for (const hybrid of [false, true]) {
    assert.equal(buildWorkerPrompt(request, undefined, null, hybrid, null), buildWorkerPrompt(request, undefined, null, hybrid));
    assert.doesNotMatch(buildWorkerPrompt(request, undefined, null, hybrid), /researcher/);
  }
});

test("the runner gives Claude and Codex Workers their researcher in both prompt and request", async () => {
  const task = { id: "task-1", work_id: "work-1", title: "T", status: "running", type: "code", state_version: 0, updated_at: "2026-09-01T00:00:00.000Z", parent_task_id: null, acceptance: "Done.", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [] };
  const research = DEFAULT_CHILD_RUN_SETTINGS.research_subagent;
  const callsFor = async (adapter, context) => {
    const calls = [];
    const runner = createAgentRunner({
      adapter, outputLogDir: null,
      provider: { execute: async (req) => { calls.push(req); return { adapter: req.adapter, stdout: "{}", stderr: "", exit_code: 0, signal: null, format: "plain-text" }; } },
    });
    await runner.runWorker({ invocation_id: "worker-1", work_id: "work-1", task_id: "task-1", attempt: 1, context: { task, ...context } });
    return calls[0];
  };
  for (const hybrid_mode of [false, true]) {
    const claude = await callsFor("claude-cli/v1", { hybrid_mode, research_subagent: research });
    assert.deepEqual(claude.research_subagent, research);
    assert.match(claude.prompt, /owl-researcher/);
  }
  const codex = await callsFor("codex", { research_subagent: research });
  assert.deepEqual(codex.research_subagent, research);
  assert.match(codex.prompt, /the `owl_researcher` agent role in Codex's multi-agent tools/);
  const none = await callsFor("claude-cli/v1", {});
  assert.equal(none.research_subagent, undefined);
  assert.doesNotMatch(none.prompt, /researcher/);
});
