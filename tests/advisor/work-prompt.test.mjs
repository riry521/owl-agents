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
