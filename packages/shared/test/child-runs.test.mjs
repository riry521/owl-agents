import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CHILD_RUN_SETTINGS } from "../dist/index.js";

test("child run defaults are selected by parent harness and allow the configured model and effort choices", () => {
  assert.deepEqual(DEFAULT_CHILD_RUN_SETTINGS.defaults_by_parent_harness, {
    claude: { provider: "codex", model: "gpt-5.6-luna", effort: "medium" },
    codex: { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" },
  });
  assert.ok(DEFAULT_CHILD_RUN_SETTINGS.allowed_models.some((choice) => choice.provider === "claude" && choice.model === "claude-sonnet-5-5"));
  assert.ok(DEFAULT_CHILD_RUN_SETTINGS.allowed_models.some((choice) => choice.provider === "codex" && choice.model === "gpt-5.6-luna"));
  assert.ok(DEFAULT_CHILD_RUN_SETTINGS.allowed_efforts.includes("low"));
  assert.ok(DEFAULT_CHILD_RUN_SETTINGS.allowed_efforts.includes("medium"));
});

test("each parent-harness child default is allowed by the configured model and effort lists", () => {
  for (const preset of Object.values(DEFAULT_CHILD_RUN_SETTINGS.defaults_by_parent_harness)) {
    assert.ok(DEFAULT_CHILD_RUN_SETTINGS.allowed_models.some((choice) => choice.provider === preset.provider && choice.model === preset.model));
    assert.ok(preset.effort === null || DEFAULT_CHILD_RUN_SETTINGS.allowed_efforts.includes(preset.effort));
  }
});
