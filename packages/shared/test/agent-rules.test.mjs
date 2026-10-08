import assert from "node:assert/strict";
import test from "node:test";
import { WORKER_OWN_SUBAGENT_RULES, WORKER_SUBAGENT_RULES, workerOwnSubagentRules, workerSubagentRules } from "../dist/agent-rules.js";
import { isResearchSubagentType, researchToolDecision } from "../dist/research-subagent.js";

test("worker rules explain choosing a child from another harness", () => {
  const rules = WORKER_SUBAGENT_RULES.join(" ").toLowerCase();
  assert.match(rules, /claude.*codex.*gpt-5\.6-luna/);
  assert.match(rules, /provider, model, and effort.*independently/);
  assert.match(rules, /omit.*configured default.*harness different from the parent/);
});

test("worker rules explain choosing a same-model child with a different effort", () => {
  const rules = WORKER_SUBAGENT_RULES.join(" ").toLowerCase();
  assert.match(rules, /sonnet 5\.5 medium.*sonnet 5\.5 low/);
});

const researcher = { reference: "REF", scope: "SCOPE" };

test("without the researcher the rule lists are the published constants and never mention a researcher", () => {
  assert.deepEqual(workerSubagentRules(null), WORKER_SUBAGENT_RULES);
  assert.deepEqual(workerOwnSubagentRules(null), WORKER_OWN_SUBAGENT_RULES);
  assert.doesNotMatch([...WORKER_SUBAGENT_RULES, ...WORKER_OWN_SUBAGENT_RULES].join(" "), /researcher/i);
});

test("hybrid on with the researcher keeps the other rules, adds the one exception and waits for every researcher", () => {
  const base = workerSubagentRules(null);
  const rules = workerSubagentRules(researcher);
  assert.deepEqual(rules.slice(0, base.length - 1), base.slice(0, -1));
  assert.equal(rules.length, base.length + 1);
  const ban = rules[base.length - 1];
  assert.ok(ban.startsWith("Do not use your own subagents (for example Claude's Agent tool), forks, or other provider-native subagent"));
  assert.match(ban, /The one exception is Owl's read-only researcher, REF: you may use it for SCOPE, in parallel or in the background/);
  assert.match(rules.at(-1), /do not end your turn until you have received the results of every dispatched run and every researcher you started/);
});

test("hybrid off with the researcher keeps the wait-for-results rule and adds the researcher line before the last rule", () => {
  const base = workerOwnSubagentRules(null);
  const rules = workerOwnSubagentRules(researcher);
  assert.deepEqual([...rules.slice(0, -2), rules.at(-1)], base);
  assert.ok(rules.some((rule) => rule.includes("Never end your turn or report while a subagent result is still pending")));
  assert.match(rules.at(-2), /^For SCOPE, prefer Owl's read-only researcher, REF:/);
});

test("the researcher may call only its read tools; shell, writes, agents, MCP, unknown and prototype names are denied", () => {
  const claudeTools = ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch", "read"];
  const codexTools = ["web_search", "webrun"];
  for (const tool of claudeTools) assert.equal(researchToolDecision("owl-researcher", tool), "allow", tool);
  for (const tool of codexTools) assert.equal(researchToolDecision("owl_researcher", tool), "allow", tool);
  // Each researcher gets only its own adapter's list: no local reads for Codex, no Codex tools for Claude.
  for (const tool of claudeTools) assert.equal(researchToolDecision("owl_researcher", tool), "deny", tool);
  for (const tool of codexTools) assert.equal(researchToolDecision("owl-researcher", tool), "deny", tool);
  // Codex child tools reach the hook as Bash, apply_patch, collaborationspawn_agent and webrun (codex-cli 0.159.2).
  for (const tool of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task", "shell", "exec_command", "exec", "apply_patch", "spawn_agent", "collaborationspawn_agent", "mcp__owl-memory__search", "Foo", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
    for (const type of ["owl-researcher", "owl_researcher"]) assert.equal(researchToolDecision(type, tool), "deny", `${type} ${tool}`);
  }
  for (const type of [undefined, "general-purpose", "toString"]) assert.equal(researchToolDecision(type, "Read"), "deny", String(type));
  assert.equal(isResearchSubagentType("owl-researcher"), true);
  assert.equal(isResearchSubagentType("owl_researcher"), true);
  for (const type of [undefined, null, "general-purpose", "toString", 1]) assert.equal(isResearchSubagentType(type), false, String(type));
});
