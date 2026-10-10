import assert from "node:assert/strict";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("the built Advisor prompt explains Work operations and their confirmation rules", async (t) => {
  const { core } = await createTestCore(t, { agentRunner }, { prefix: "owl-advisor-work-prompt-", start: true });

  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  for (const action of [
    "send_work_instruction",
    "update_work",
    "pause_work",
    "resume_work",
    "cancel_work",
    "delete_work",
  ]) {
    assert.ok(prompt.includes(action), `prompt is missing ${action}`);
  }
  assert.match(prompt, /Confirmation rules:/u);
  assert.match(prompt, /Never emit cancel_work, delete_work or update_work before the operator confirms/u);
  assert.match(prompt, /deleted completely and cannot be undone/u);
  assert.match(prompt, /only completed \/ cancelled Works qualify/u);
  assert.match(prompt, /ask for approval, and emit the action only in a later turn after the operator agrees/u);
  assert.match(prompt, /Adding reopen:true to an instruction for a completed Work also needs the operator's explicit approval/u);
  assert.match(prompt, /If several Works match or none does, ask which Work before emitting the action/u);
});

test("the built Advisor prompt explains the owl-api tool, the 403 fallback and the call_api confirmation rule", async (t) => {
  const { core } = await createTestCore(t, { agentRunner }, { prefix: "owl-advisor-api-prompt-", start: true });

  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.match(prompt, /owl-api MCP tool `request` \{method, api_path, json_body\?\}/u);
  assert.match(prompt, /answer 403 advisor_action_required with details\.alternative_actions/u);
  assert.match(prompt, /owl_api_result_unknown/u);
  assert.match(prompt, /\{type:"call_api",description,payload:\{method,path,body\?,reason\}\}/u);
  assert.match(prompt, /emit call_api only in a later turn after the operator agrees/u);
  assert.doesNotMatch(prompt, /127\.0\.0\.1|localhost|guard-tokens/u);
});

test("the Advisor system prompt carries the external-data policy exactly once", async (t) => {
  const { EXTERNAL_DATA_POLICY } = await import("../../packages/shared/dist/index.js");
  const { core } = await createTestCore(t, { agentRunner }, { prefix: "owl-advisor-policy-prompt-", start: true });
  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.equal(prompt.split(EXTERNAL_DATA_POLICY).length - 1, 1);
});
