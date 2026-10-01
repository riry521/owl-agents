import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("the built Advisor prompt explains Work operations and their confirmation rules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-work-prompt-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();

  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  for (const action of [
    "send_work_instruction",
    "update_work",
    "pause_work",
    "resume_work",
    "cancel_work",
  ]) {
    assert.ok(prompt.includes(action), `prompt is missing ${action}`);
  }
  assert.match(prompt, /Confirmation rules:/u);
  assert.match(prompt, /ask for approval, and emit the action only in a later turn after the operator agrees/u);
  assert.match(prompt, /Adding reopen:true to an instruction for a completed Work also needs the operator's explicit approval/u);
  assert.match(prompt, /If several Works match or none does, ask which Work before emitting the action/u);
});
