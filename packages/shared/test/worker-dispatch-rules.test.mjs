import assert from "node:assert/strict";
import test from "node:test";
import { WORKER_SUBAGENT_RULES } from "../dist/agent-rules.js";

test("worker rules direct parallel work through Owl dispatch and wait", () => {
  const rules = WORKER_SUBAGENT_RULES.join(" ").toLowerCase();
  assert.match(rules, /dispatch/);
  assert.match(rules, /wait/);
  assert.doesNotMatch(rules, /launch.*subagent|subagent.*launch/);
  assert.match(rules, /do not use your own subagents.*forks.*provider-native subagent/);
});
