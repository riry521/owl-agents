import assert from "node:assert/strict";
import test from "node:test";
import { WORKER_SUBAGENT_RULES } from "../dist/agent-rules.js";

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
