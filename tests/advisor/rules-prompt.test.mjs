import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

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
  assert.match(prompt, /\n\n--- BEGIN OWL RULES ---\nThe operator's Rule Store sets these rules for you\. .*\n\[system\] Dangerous commands and operations on secret files are blocked mechanically at run time; a blocked call returns its reason\.\n\[system\] Say when you are unsure\.\n\[role\] advisor-rule-marker\n--- END OWL RULES ---\n\n/);
  assert.equal(prompt.includes("worker-rule-marker"), false);
  assert.equal(prompt.includes("Hard resets are forbidden"), false);
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

const projectRule = (text) => ["level: project", "rules:", `  - id: r_${text}`, "    kind: instruction", `    text: "${text}"`];

test("only a Project window's Advisor prompt carries that Project's rules, and a reload changes it", async (t) => {
  const { core, root } = await startCore(t, { "project/a.yaml": projectRule("rule-of-a"), "project/b.yaml": projectRule("rule-of-b") });
  const promptA = core.getAdvisorSettingsSnapshot("a").systemPrompt;
  const promptB = core.getAdvisorSettingsSnapshot("b").systemPrompt;
  const general = core.getAdvisorSettingsSnapshot(null).systemPrompt;
  assert.match(promptA, /--- BEGIN OWL RULES ---[\s\S]*\[project\] rule-of-a[\s\S]*--- END OWL RULES ---/);
  assert.equal(promptA.includes("rule-of-b"), false);
  assert.ok(promptB.includes("[project] rule-of-b"));
  assert.equal(promptB.includes("rule-of-a"), false);
  assert.equal(general.includes("OWL RULES"), false);
  assert.equal(general, core.getAdvisorSettingsSnapshot().systemPrompt);

  await writeRules(root, { "project/a.yaml": projectRule("rule-of-a-v2") });
  await core.ruleStore.load();
  assert.ok(core.getAdvisorSettingsSnapshot("a").systemPrompt.includes("[project] rule-of-a-v2"));
  assert.equal(core.getAdvisorSettingsSnapshot("b").systemPrompt, promptB);
  assert.equal(core.getAdvisorSettingsSnapshot(null).systemPrompt, general);
});

test("a rule reload reaches only the live session of that Project's window, on its next turn", async (t) => {
  const created = [];
  const providerClient = {
    createSession: async (request) => {
      const sent = [];
      const waiters = [];
      const driver = {
        request,
        sent,
        provider_session_id: `provider-${created.length + 1}`,
        pid: process.pid,
        send: async (turn) => { sent.push(turn); waiters.shift()?.(); },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "session.ready", provider_session_id: driver.provider_session_id, pid: process.pid };
            for (let handled = 0; ; handled += 1) {
              if (sent.length <= handled) await new Promise((resolve) => waiters.push(resolve));
              yield { type: "turn.completed", turn_id: sent[handled].turn_id, reply: "ok", usage: null };
            }
          },
        }),
        stop: async () => {},
      };
      created.push(driver);
      return driver;
    },
  };
  const root = await tempDir(t, "owl-advisor-rules-live-");
  const { core, db } = await createTestCore(t, {
    agentRunner,
    owlRoot: root,
    providerClient,
    dispatcher: { tick_interval_ms: 25 },
  }, { start: true });
  core.gitGateway().resolveAdvisorSessionDirectory = async () => ({ kind: "direct", cwd: root });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  core.gitGateway().sweepAdvisorWorkspaces = async () => {};

  const ownerId = "owner:default";
  const newProject = async (name) => {
    const projectId = createUlid();
    const now = new Date().toISOString();
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', '[]', '{}', '[]', ?, ?)`,
      projectId, ownerId, name, `/tmp/${projectId}`, now, now,
    ));
    return projectId;
  };
  const projectA = await newProject("A");
  const projectB = await newProject("B");
  await writeRules(root, { [`project/${projectA}.yaml`]: projectRule("rule-of-a"), [`project/${projectB}.yaml`]: projectRule("rule-of-b") });
  await core.ruleStore.load();
  const windowA = await core.ensureAdvisorWindow(ownerId, projectA);
  const windowB = await core.ensureAdvisorWindow(ownerId, projectB);
  const general = db.get("SELECT conversation_id FROM advisor_windows WHERE owner_id = ? AND scope = 'general'", ownerId);

  let n = 0;
  const ask = async (conversationId) => {
    const posted = await core.postMessage(conversationId, command({ body: `question ${n}`, attachment_ids: [] }, `rules-live:${n++}`));
    await core.advisorRespond(conversationId, posted.data.message_id, { channel: "web" });
  };
  const targets = [windowA.conversation_id, windowB.conversation_id, general.conversation_id];
  for (const conversationId of targets) await ask(conversationId);
  await waitFor(() => created.length === 3 && created.every((driver) => driver.sent.length === 1), { message: "each window's first turn is sent" });
  const driverA = created.find((driver) => driver.request.system_prompt.includes("rule-of-a"));
  const driverB = created.find((driver) => driver.request.system_prompt.includes("rule-of-b"));
  const driverGeneral = created.find((driver) => !driver.request.system_prompt.includes("rule-of-"));
  assert.ok(driverA && driverB && driverGeneral && new Set([driverA, driverB, driverGeneral]).size === 3);
  const updateOf = (driver) => driver.sent.filter((turn) => turn.text.includes("BEGIN UPDATED OWL INSTRUCTIONS"));
  assert.equal(driverA.sent.length, 1);

  await writeRules(root, { [`project/${projectA}.yaml`]: projectRule("rule-of-a-v2") });
  await core.ruleStore.load();
  for (const conversationId of targets) await ask(conversationId);
  await waitFor(() => created.every((driver) => driver.sent.length === 2), { message: "each window's second turn is sent" });

  assert.equal(created.length, 3, "no session is recreated");
  assert.equal(updateOf(driverA).length, 1);
  assert.match(updateOf(driverA)[0].text, /\[project\] rule-of-a-v2/);
  assert.equal(updateOf(driverB).length, 0);
  assert.equal(updateOf(driverGeneral).length, 0);
  assert.equal(driverB.sent.length, 2);
  assert.equal(driverGeneral.sent.length, 2);
});
