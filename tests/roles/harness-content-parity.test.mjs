import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import {
  DEFAULT_CHILD_RUN_SETTINGS,
  DEFAULT_HARNESS_MODELS,
  DESIGN_MOCK_MCP_ENABLE_ENV,
  DISPATCH_MCP_ENABLE_ENV,
  PROCESS_SKILLS_PROMPT_FILES,
  claudeMcpArgs,
  codexMcpArgs,
  opencodeMcpConfig,
  owlMcpServers,
} from "../../packages/shared/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const PROVIDERS = { claude: "anthropic", codex: "openai", opencode: "opencode" };
const SOURCES = ["setting", "claude", "codex"];

const RULES = "[system] SYSTEM-RULE-MARKER\n[absolute] ABSOLUTE-RULE-MARKER\n[role] ROLE-RULE-MARKER";
const RULE_MARKERS = ["[system] SYSTEM-RULE-MARKER", "[absolute] ABSOLUTE-RULE-MARKER", "[role] ROLE-RULE-MARKER"];
const KNOWLEDGE = "<owl-memory scope=\"project\">MEMORY-INDEX-MARKER</owl-memory>";
const SKILLS = "- skill-index-marker: Use when checking parity.";

async function makeProcessSkillsPack(root) {
  const skillsDir = join(root, "pack", "skills");
  for (const path of PROCESS_SKILLS_PROMPT_FILES) {
    await mkdir(join(skillsDir, path, ".."), { recursive: true });
    await writeFile(join(skillsDir, path), "# Procedure\n");
  }
  return skillsDir;
}

/** A runner that records every provider request and answers nothing usable; only the prompt matters here. */
function recordingRunner(calls) {
  return createAgentRunner({
    adapter: "claude",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        return { adapter: request.adapter, stdout: "{}", stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
}

const task = {
  id: "task-1", work_id: "work-1", title: "Test task", status: "running", type: "code",
  state_version: 0, updated_at: "2026-09-01T00:00:00.000Z", parent_task_id: null,
  acceptance: "Done.", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [],
};
const report = {
  kind: "report", schema_version: "1.0.0", invocation_id: "worker-1", result: "success",
  work_done: "Done.", changes: [], verification: { passed: true, method: "Checked." },
  delegation: { decomposition: "Kept whole.", delegated: [], retained: [{ part: "Whole task", reason: "No safe split." }] },
  remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
};
const shared = { rules: RULES, knowledge: KNOWLEDGE, skills: SKILLS };
const ids = { invocation_id: "inv-1", work_id: "work-1", task_id: "task-1", attempt: 1 };

/** Each entry calls one runner entry point; `markers` are the pieces its prompt must carry. */
const ENTRIES = [
  {
    name: "Manager plan", markers: [...RULE_MARKERS, "Owl Manager", "MEMORY-INDEX-MARKER", "skill-index-marker"],
    run: (runner, provider, pack) => runner.runManagerPlan({
      ...ids, task_id: null, provider, model: "m",
      context: { mode: "plan", work: { id: "work-1", title: "Test work" }, ...shared, ...pack },
    }),
  },
  {
    name: "Manager finalize", markers: [...RULE_MARKERS, "Owl Manager", "MEMORY-INDEX-MARKER", "skill-index-marker"],
    run: (runner, provider, pack) => runner.runManagerPlan({
      ...ids, task_id: null, provider, model: "m",
      context: { mode: "finalize", work: { id: "work-1", title: "Test work" }, ...shared, ...pack },
    }),
  },
  {
    name: "Designer", markers: [...RULE_MARKERS, "You are the Owl Designer.", "MEMORY-INDEX-MARKER", "skill-index-marker"],
    run: (runner, provider, pack) => runner.runDesigner({ ...ids, provider, model: "m", context: { task: { ...task, type: "design" }, ...shared, ...pack } }),
  },
  {
    name: "Lead Designer", markers: [...RULE_MARKERS, "You are the Owl Lead Designer.", "MEMORY-INDEX-MARKER", "skill-index-marker"],
    run: (runner, provider, pack) => runner.runDesigner({ ...ids, provider, model: "m", context: { task: { ...task, type: "design" }, design_tier: "lead", ...shared, ...pack } }),
  },
  {
    name: "Worker", markers: [...RULE_MARKERS, "You are the Owl Worker.", "MEMORY-INDEX-MARKER", "skill-index-marker"],
    run: (runner, provider, pack) => runner.runWorker({ ...ids, provider, model: "m", context: { task, ...shared, ...pack } }),
  },
  {
    name: "Fixer", markers: [...RULE_MARKERS, "You are the Owl Worker.", "REVIEW-FINDING-MARKER", "MEMORY-INDEX-MARKER", "skill-index-marker"],
    run: (runner, provider, pack) => runner.runWorker({
      ...ids, provider, model: "m",
      context: {
        task,
        reviewer_findings: [{ id: "F1", file: "a.ts", line: 1, target: "t", problem: "REVIEW-FINDING-MARKER", reason: "r", fix: "f" }],
        ...shared, ...pack,
      },
    }),
  },
  {
    name: "Reviewer", markers: [...RULE_MARKERS, "Reviewer", "MEMORY-INDEX-MARKER", "skill-index-marker"],
    run: (runner, provider, pack) => runner.runReviewer({ ...ids, review_round: 1, provider, model: "m", context: { task, report, ...shared, ...pack } }),
  },
  {
    name: "Curator", noProcessSkills: true, markers: ["Owl's Curator", "MEMORY-INDEX-MARKER", "curator-skill-marker"],
    run: (runner, provider) => runner.runCurator({
      proposals: [], candidates: [], usages: [], with_judgement: true, provider, model: "m",
      skill_index: [{ name: "curator-skill-marker", description: "d" }], knowledge: KNOWLEDGE,
    }),
  },
  {
    name: "Librarian operations", noProcessSkills: true, markers: [...RULE_MARKERS, "Owl's Librarian"],
    run: (runner, provider) => runner.runLibrarianOperations({
      run_id: "run-1", pages: [], dormant_candidates: [], rules: RULES, max_output_tokens: 1000, model: { provider, model: "m" },
    }),
  },
];

async function promptFor(entry, harness, pack, extraContext = {}) {
  const calls = [];
  const runner = recordingRunner(calls);
  const input = entry.run(runner, PROVIDERS[harness], { ...pack, ...extraContext });
  await Promise.resolve(input).catch(() => undefined);
  assert.equal(calls.length > 0, true, `${entry.name} on ${harness} reached the provider`);
  return calls[0].prompt;
}

/** The "## Process skills" section's lines, or null when the prompt has none. */
function processSkillsLines(prompt) {
  const start = prompt.indexOf("## Process skills\n");
  if (start === -1) return null;
  const end = prompt.indexOf("\n\n", start);
  return prompt.slice(start, end === -1 ? undefined : end).split("\n");
}

const invocationForms = {
  claude: (path, name) => new RegExp(`^- [\\w-]+: .*Use the Skill tool with skill: "superpowers:${name}", or read ${path} if that is unavailable\\.$`, "u"),
  codex: (path, name) => new RegExp(`^- [\\w-]+: .*Use the "superpowers:${name}" skill from your available skills list, or read ${path} if it is not listed\\.$`, "u"),
  plain: (path) => new RegExp(`^- [\\w-]+: .*Read ${path}\\.$`, "u"),
};

/** Stage 1: the allowed differences (design 3.4 rows 1 and 2) have exactly the agreed shape. */
function assertAllowedDifferences(lines, harness, source) {
  const claudeRef = lines.filter((line) => line.includes("references/claude-code-tools.md"));
  const codexRef = lines.filter((line) => line.includes("references/codex-tools.md"));
  assert.equal(claudeRef.length, harness === "claude" ? 1 : 0, `${harness}: claude tools reference lines`);
  assert.equal(codexRef.length, harness === "codex" ? 1 : 0, `${harness}: codex tools reference lines`);

  const skillLines = lines.filter((line) => line.startsWith("- ") && /\/SKILL\.md/u.test(line));
  assert.equal(skillLines.length > 0, true, `${harness}: has SKILL.md lines`);
  const native = harness === source;
  for (const line of skillLines) {
    const [, rawPath, skillDir] = /(\/\S+\/([^/\s]+)\/SKILL\.md)/u.exec(line);
    const path = rawPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const form = native ? harness : "plain";
    // The invoked skill must be the one the referenced SKILL.md belongs to, not any name.
    assert.match(line, invocationForms[form](path, skillDir), `${harness}/${source}: ${line}`);
  }
}

/** Stage 2: only the lines stage 1 checked are replaced by fixed marks. */
function normalize(prompt) {
  const lines = processSkillsLines(prompt);
  if (!lines) return prompt;
  const section = lines.join("\n");
  const normalized = lines
    .filter((line) => !line.includes("references/claude-code-tools.md") && !line.includes("references/codex-tools.md"))
    .map((line) => {
      if (!line.startsWith("- ") || !/\/SKILL\.md/u.test(line)) return line;
      return line.replace(
        /(?:Use the Skill tool with skill: "superpowers:[\w-]+", or read (\S+) if that is unavailable\.|Use the "superpowers:[\w-]+" skill from your available skills list, or read (\S+) if it is not listed\.|Read (\S+)\.)$/u,
        (_match, a, b, c) => `<invoke:${a ?? b ?? c}>`,
      );
    })
    .join("\n");
  return prompt.replace(section, normalized);
}

for (const entry of ENTRIES) {
  test(`${entry.name} prompt carries the same content on claude, codex and opencode`, async (t) => {
    const root = await tempDir(t, "owl-harness-parity-");
    const skillsDir = await makeProcessSkillsPack(root);
    for (const source of SOURCES) {
      const prompts = {};
      for (const harness of Object.keys(PROVIDERS)) {
        prompts[harness] = await promptFor(entry, harness, { process_skills_dir: skillsDir, process_skills_source: source });
        const lines = processSkillsLines(prompts[harness]);
        if (entry.noProcessSkills) assert.equal(lines, null, `${entry.name}/${harness}: no process skills section`);
        else assertAllowedDifferences(lines ?? assert.fail(`${entry.name}/${harness}: process skills section`), harness, source);
      }
      const normalized = Object.fromEntries(Object.entries(prompts).map(([harness, prompt]) => [harness, normalize(prompt)]));
      assert.equal(normalized.codex, normalized.claude, `${entry.name}/${source}: codex differs from claude`);
      assert.equal(normalized.opencode, normalized.claude, `${entry.name}/${source}: opencode differs from claude`);
      for (const marker of entry.markers) assert.equal(normalized.claude.includes(marker), true, `${entry.name}: missing ${marker}`);
    }
  });
}

test("a Worker's research subagent does not change the opencode prompt", async (t) => {
  const root = await tempDir(t, "owl-harness-parity-");
  const pack = { process_skills_dir: await makeProcessSkillsPack(root), process_skills_source: "setting" };
  const worker = ENTRIES.find((entry) => entry.name === "Worker");
  const plain = await promptFor(worker, "opencode", pack);
  const withResearch = await promptFor(worker, "opencode", pack, { research_subagent: DEFAULT_CHILD_RUN_SETTINGS.research_subagent });
  assert.equal(withResearch, plain);
  // Control: the setting is live for the other harnesses, so the equality above is not vacuous.
  assert.notEqual(
    await promptFor(worker, "claude", pack, { research_subagent: DEFAULT_CHILD_RUN_SETTINGS.research_subagent }),
    await promptFor(worker, "claude", pack),
  );
});

const noopAgentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("the Advisor system prompt differs across harnesses only by the Harness tool names sentence", async (t) => {
  const root = await tempDir(t, "owl-harness-parity-advisor-");
  const skillsDir = await makeProcessSkillsPack(root);
  await mkdir(join(root, "rules", "role"), { recursive: true });
  await writeFile(join(root, "rules", "role", "advisor.yaml"), ["level: role", "role: advisor", "rules:", "  - id: advisor_only", "    kind: instruction", '    text: "advisor-rule-marker"', ""].join("\n"));
  const { core } = await createTestCore(
    t,
    { agentRunner: noopAgentRunner, owlRoot: root, processSkillsDetection: { env: {}, homedir: join(root, "home") } },
    { start: true },
  );
  await core.setProcessSkillsSettings({ enabled: true, path: join(root, "pack") });

  const prompts = {};
  for (const [harness, provider] of Object.entries(PROVIDERS)) {
    const current = core.getModelSettings();
    await core.updateModelSettings(command({
      roles: current.roles.map((role) => (role.role === "advisor" ? { ...role, provider, model: harness === "opencode" ? "fake-provider/fake-model" : DEFAULT_HARNESS_MODELS[harness] } : role)),
    }, `parity:${harness}`, current.version));
    prompts[harness] = core.getAdvisorSettingsSnapshot().systemPrompt;
  }

  const toolsSentence = (file) => `Harness tool names: Read ${join(skillsDir, "using-superpowers/references", file)} when selecting harness-specific tools.`;
  const count = (text, part) => text.split(part).length - 1;
  assert.equal(count(prompts.claude, toolsSentence("claude-code-tools.md")), 1);
  assert.equal(prompts.claude.includes("codex-tools.md"), false);
  assert.equal(count(prompts.codex, toolsSentence("codex-tools.md")), 1);
  assert.equal(prompts.codex.includes("claude-code-tools.md"), false);
  assert.equal(prompts.opencode.includes("Harness tool names:"), false);
  assert.equal(prompts.opencode.includes("tools.md"), false);
  const brainstorming = `read and follow ${join(skillsDir, "brainstorming/SKILL.md")}, with these limits:`;
  for (const prompt of Object.values(prompts)) assert.equal(count(prompt, brainstorming), 1);

  const withoutSentence = {
    claude: prompts.claude.replace(` ${toolsSentence("claude-code-tools.md")}`, ""),
    codex: prompts.codex.replace(` ${toolsSentence("codex-tools.md")}`, ""),
    opencode: prompts.opencode,
  };
  assert.equal(withoutSentence.codex, withoutSentence.claude);
  assert.equal(withoutSentence.opencode, withoutSentence.claude);
  assert.match(withoutSentence.claude, /--- BEGIN OWL RULES ---[\s\S]*advisor-rule-marker[\s\S]*--- END OWL RULES ---/u);
});

const guardEnv = { OWL_AGENT_RUN_ID: "run-1", OWL_GUARD_API_BASE: "http://127.0.0.1:1/guard", OWL_GUARD_TOKEN_FILE: "/tmp/token-file" };
const memoryEnv = { OWL_WORK_ID: "work-1", OWL_TASK_ID: "task-1", OWL_API_BASE: "http://127.0.0.1:1/api" };

const MCP_CASES = [
  { name: "advisor", role: "advisor", env: { ...guardEnv, ...memoryEnv }, names: ["owl-memory", "owl-api"] },
  { name: "worker without dispatch", role: "worker", env: { ...guardEnv, ...memoryEnv }, names: ["owl-memory"] },
  { name: "worker with dispatch", role: "worker", env: { ...guardEnv, ...memoryEnv, [DISPATCH_MCP_ENABLE_ENV]: "1" }, names: ["owl-memory", "owl-dispatch"] },
  { name: "designer without mock", role: "designer", env: { ...guardEnv, ...memoryEnv }, names: ["owl-memory"] },
  { name: "designer with mock", role: "designer", env: { ...guardEnv, ...memoryEnv, [DESIGN_MOCK_MCP_ENABLE_ENV]: "1" }, names: ["owl-memory", "owl-design"] },
  { name: "reviewer", role: "reviewer", env: { ...guardEnv, ...memoryEnv }, names: ["owl-memory"] },
];

const timeout = (ms) => (ms === undefined ? {} : { timeoutMs: ms });

/** Reads the Claude --mcp-config files back into specs. */
async function specsFromClaude(args) {
  const specs = [];
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], "--mcp-config");
    const { mcpServers } = JSON.parse(await readFile(args[index + 1], "utf8"));
    for (const [name, server] of Object.entries(mcpServers)) specs.push({ name, command: server.command, args: server.args, env: server.env, ...timeout(server.timeout) });
  }
  return specs;
}

/** Reads Codex `--config mcp_servers.<name>.<key>=<TOML value>` pairs back into specs; the values are JSON-compatible. */
function specsFromCodex(args) {
  const byName = new Map();
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], "--config");
    const [, name, key, value] = /^mcp_servers\.([^.]+)\.(\w+)=(.*)$/su.exec(args[index + 1]);
    const entry = byName.get(name) ?? { name };
    if (key === "command" || key === "args") entry[key] = JSON.parse(value);
    else if (key === "env") {
      entry.env = Object.fromEntries([...value.slice(1, -1).matchAll(/(\w+)=("(?:[^"\\]|\\.)*")/gu)].map((pair) => [pair[1], JSON.parse(pair[2])]));
    } else if (key === "tool_timeout_sec") entry.timeoutMs = Number(value) * 1000;
    byName.set(name, entry);
  }
  return [...byName.values()];
}

function specsFromOpencode(config) {
  return Object.entries(config.servers).map(([name, server]) => ({
    name, command: server.command[0], args: server.command.slice(1), env: server.environment, ...timeout(server.timeout.execution),
  }));
}

for (const mcpCase of MCP_CASES) {
  test(`MCP servers for ${mcpCase.name} read back the same from claude, codex and opencode`, async () => {
    const servers = owlMcpServers({ owlRoot: repoRoot, role: mcpCase.role, env: mcpCase.env });
    assert.deepEqual(servers.map((server) => server.name), mcpCase.names);
    const expected = servers.map((server) => ({ name: server.name, command: server.command, args: [...server.args], env: { ...server.env }, ...timeout(server.toolTimeoutMs) }));

    const fromClaude = await specsFromClaude(claudeMcpArgs(servers));
    const fromCodex = specsFromCodex(codexMcpArgs(servers));
    const fromOpencode = specsFromOpencode(opencodeMcpConfig(servers));
    assert.deepEqual(fromClaude, expected);
    assert.deepEqual(fromCodex, expected);
    assert.deepEqual(fromOpencode, expected);
    // The timeout comes from the same toolTimeoutMs on each side: opencode's execution and Codex's tool_timeout_sec agree.
    for (const server of servers) assert.equal(typeof server.toolTimeoutMs, server.name === "owl-memory" ? "undefined" : "number");
  });
}
