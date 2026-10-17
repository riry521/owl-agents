import assert from "node:assert/strict";
import { test } from "node:test";

import { CHILD_RUN_PROVIDERS, DEFAULT_CHILD_RUN_SETTINGS } from "../dist/index.js";

test("child run defaults pick one Executor harness with a model and effort row for every harness", () => {
  assert.equal(DEFAULT_CHILD_RUN_SETTINGS.executor_harness, "codex");
  assert.deepEqual(Object.keys(DEFAULT_CHILD_RUN_SETTINGS.executor_by_harness).sort(), [...CHILD_RUN_PROVIDERS].sort());
  assert.deepEqual(DEFAULT_CHILD_RUN_SETTINGS.executor_by_harness, {
    claude: { model: "claude-sonnet-5-5", effort: "medium" },
    codex: { model: "gpt-5.6-luna", effort: "medium" },
    opencode: { model: null, effort: null },
  });
});

test("only the opencode default row has no model, and the default Executor can run", () => {
  const { executor_harness: harness, executor_by_harness: rows } = DEFAULT_CHILD_RUN_SETTINGS;
  assert.notEqual(rows[harness].model, null);
  for (const [name, row] of Object.entries(rows)) assert.equal(row.model === null, name === "opencode", name);
});
