import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerPrompt } from "../../packages/agent-runtime/dist/worker.js";

const request = { task: { id: "t", title: "t", acceptance: "a" }, context: {} };

test("the prompt allows own subagents and passes Task rules on without dispatch order or ban when hybrid is off", () => {
  const p = buildWorkerPrompt(request, undefined, null, false);
  assert.match(p, /your own subagents \(for example Claude's Agent tool\)/);
  assert.match(p, /Use a fork when the part needs your conversation/);
  assert.match(p, /put them in its instruction/);
  assert.match(p, /disjoint write scope/);
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
