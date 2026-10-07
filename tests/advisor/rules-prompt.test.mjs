import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

async function writeRules(root, files) {
  for (const [relative, lines] of Object.entries(files)) {
    const target = join(root, "rules", relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${lines.join("\n")}\n`);
  }
}

async function startCore(t, files, persona = "") {
  const root = await tempDir(t, "owl-advisor-rules-");
  await writeRules(root, files);
  return createTestCore(t, { agentRunner, owlRoot: root, getAdvisorPersona: () => persona }, { start: true });
}

const RULES = {
  "system/s.yaml": [
    "level: system",
    "rules:",
    "  - id: no_reset",
    "    kind: block_command",
    '    pattern: "git reset --hard"',
    '    message: "Hard resets are forbidden."',
    "  - id: honest",
    "    kind: instruction",
    '    text: "Say when you are unsure."',
  ],
  "role/advisor.yaml": ["level: role", "role: advisor", "rules:", "  - id: advisor_only", "    kind: instruction", '    text: "advisor-rule-marker"'],
  "role/worker.yaml": ["level: role", "role: worker", "rules:", "  - id: worker_only", "    kind: instruction", '    text: "worker-rule-marker"'],
};

test("the Advisor system prompt carries its Rule Store rules before the persona", async (t) => {
  const { core } = await startCore(t, RULES, "Speak like a pirate.");
  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.match(prompt, /\n\n--- BEGIN OWL RULES ---\nThe operator's Rule Store sets these rules for you\. .*\n\[system\] Hard resets are forbidden\.\n\[system\] Say when you are unsure\.\n\[role\] advisor-rule-marker\n--- END OWL RULES ---\n\n/);
  assert.equal(prompt.includes("worker-rule-marker"), false);
  assert.ok(prompt.indexOf("--- END OWL RULES ---") < prompt.indexOf("--- BEGIN OPERATOR PERSONA ---"));
  assert.ok(prompt.startsWith("You are the Owl Advisor"));
});

test("the Advisor system prompt has no rules block when the Rule Store is empty", async (t) => {
  const { core } = await startCore(t, {});
  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.equal(prompt.includes("OWL RULES"), false);
  assert.equal(prompt.includes("OPERATOR PERSONA"), false);
});

test("a rule reload changes the Advisor system prompt", async (t) => {
  const { core, root } = await startCore(t, RULES);
  const before = core.getAdvisorSettingsSnapshot().systemPrompt;
  await writeRules(root, {
    "role/advisor.yaml": ["level: role", "role: advisor", "rules:", "  - id: advisor_only", "    kind: instruction", '    text: "advisor-rule-marker-v2"'],
  });
  await core.ruleStore.load();
  const after = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.notEqual(after, before);
  assert.ok(after.includes("[role] advisor-rule-marker-v2"));
});
