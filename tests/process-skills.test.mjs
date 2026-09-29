import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildExecutorPrompt, runExecutor } from "../packages/core/dist/executor.js";
import { detectProcessSkillsPack } from "../packages/core/dist/process-skills-pack.js";
import { PROCESS_SKILLS_SETTINGS_KEY, renderProcessSkills } from "../packages/shared/dist/index.js";
import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";
import { buildManagerPrompt } from "../packages/agent-runtime/dist/manager.js";
import { buildHybridPlanPrompt, buildHybridVerdictPrompt, buildWorkerPrompt } from "../packages/agent-runtime/dist/worker.js";
import { buildReviewerPrompt } from "../packages/agent-runtime/dist/reviewer.js";
import { renderRolePrompt } from "../packages/agent-runtime/dist/role-contract.js";
import { Core } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";

const REQUIRED_SKILLS = [
  "brainstorming",
  "test-driven-development",
  "verification-before-completion",
];

async function makePack(skillsDir, skills = REQUIRED_SKILLS) {
  for (const skill of skills) {
    const directory = join(skillsDir, skill);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `# ${skill}\n`);
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-process-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const claude = join(root, "claude-config");
  const codex = join(root, "codex-home");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(claude, { recursive: true }), mkdir(codex, { recursive: true })]);
  return {
    root,
    home,
    env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex },
    settings: { enabled: true, path: null },
    claude,
    codex,
  };
}

async function coreFixture(t, detection) {
  const root = await mkdtemp(join(tmpdir(), "owl-process-skills-core-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(process.cwd(), "packages/db/migrations"));
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, processSkillsDetection: detection });
  core.ruleStore.startWatching = async () => {};
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await core.start();
  return { core, root };
}

function claudeCacheDir(configHome, marketplace, version) {
  return join(configHome, "plugins", "cache", marketplace, "superpowers", version);
}

function codexPackDir(codexHome, marketplace) {
  return join(codexHome, "plugins", "cache", marketplace, "superpowers");
}

/** Writes the install record an installed Claude plugin leaves behind, replacing any prior record. */
async function writeClaudeInstalledPlugins(configHome, plugins) {
  await mkdir(join(configHome, "plugins"), { recursive: true });
  await writeFile(join(configHome, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

async function writeClaudeSettings(configHome, enabledPlugins) {
  await mkdir(configHome, { recursive: true });
  await writeFile(join(configHome, "settings.json"), JSON.stringify({ enabledPlugins }));
}

/** Installs a Claude superpowers pack (skills dir + install record) and returns its skills dir. */
async function installClaudePack(configHome, marketplace, version, scope = "user") {
  const installPath = claudeCacheDir(configHome, marketplace, version);
  const skillsDir = join(installPath, "skills");
  await makePack(skillsDir);
  await writeClaudeInstalledPlugins(configHome, { [`superpowers@${marketplace}`]: [{ scope, installPath, version }] });
  return skillsDir;
}

async function writeCodexConfig(codexHome, content) {
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), content);
}

/** Installs a Codex superpowers pack (skills dir + enabled config.toml entry) and returns its skills dir. */
async function installCodexPack(codexHome, marketplace, version) {
  const skillsDir = join(codexPackDir(codexHome, marketplace), version, "skills");
  await makePack(skillsDir);
  await writeCodexConfig(codexHome, `[plugins."superpowers@${marketplace}"]\nenabled = true\n`);
  return skillsDir;
}

test("process skills settings take priority and accept a repository root", async (t) => {
  const state = await fixture(t);
  const repo = join(state.root, "repository");
  const skillsDir = join(repo, "skills");
  await makePack(skillsDir);
  await installClaudePack(state.claude, "official", "9.0.0");

  const detected = detectProcessSkillsPack({ ...state, settings: { enabled: true, path: repo } });
  assert.deepEqual(detected, { skills_dir: skillsDir, version: null, source: "setting" });
});

test("process skills settings accept a skills directory even when it contains an unrelated skills folder", async (t) => {
  const state = await fixture(t);
  const skillsDir = join(state.root, "direct-skills");
  await makePack(skillsDir);
  await mkdir(join(skillsDir, "skills"), { recursive: true });

  assert.deepEqual(detectProcessSkillsPack({ ...state, settings: { enabled: true, path: skillsDir } }), {
    skills_dir: skillsDir,
    version: null,
    source: "setting",
  });
});

test("Claude detection reads the installed_plugins.json record and is enabled by default", async (t) => {
  const state = await fixture(t);
  const skillsDir = await installClaudePack(state.claude, "official", "6.4.1");

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: skillsDir, version: "6.4.1", source: "claude" });
});

test("Claude detection honors an explicit enabledPlugins: false", async (t) => {
  const state = await fixture(t);
  await installClaudePack(state.claude, "official", "6.4.1");
  await writeClaudeSettings(state.claude, { "superpowers@official": false });

  assert.equal(detectProcessSkillsPack(state), null);
});

test("Claude detection ignores a record whose installPath no longer exists", async (t) => {
  const state = await fixture(t);
  const installPath = claudeCacheDir(state.claude, "official", "6.4.1");
  await writeClaudeInstalledPlugins(state.claude, {
    "superpowers@official": [{ scope: "user", installPath, version: "6.4.1" }],
  });

  assert.equal(detectProcessSkillsPack(state), null);
});

test("Claude detection prefers the user-scope entry over other scopes, then the highest version", async (t) => {
  const state = await fixture(t);
  const projectPath = claudeCacheDir(state.claude, "official", "5.0.0");
  const userPath = claudeCacheDir(state.claude, "official", "4.0.0");
  await makePack(join(projectPath, "skills"));
  const userSkillsDir = join(userPath, "skills");
  await makePack(userSkillsDir);
  await writeClaudeInstalledPlugins(state.claude, {
    "superpowers@official": [
      { scope: "project", installPath: projectPath, version: "5.0.0" },
      { scope: "user", installPath: userPath, version: "4.0.0" },
    ],
  });

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: userSkillsDir, version: "4.0.0", source: "claude" });
});

test("a stray cache directory with no install record is ignored", async (t) => {
  const state = await fixture(t);
  await makePack(join(claudeCacheDir(state.claude, "official", "9.9.9"), "skills"));
  await makePack(join(codexPackDir(state.codex, "community"), "1.0.0", "skills"));

  assert.equal(detectProcessSkillsPack(state), null);
});

test("Claude detection falls back to the next entry when the preferred one is stale", async (t) => {
  const state = await fixture(t);
  const stalePath = claudeCacheDir(state.claude, "official", "7.0.0");
  const validPath = claudeCacheDir(state.claude, "official", "6.0.0");
  await makePack(join(stalePath, "skills"), ["brainstorming"]);
  await makePack(join(validPath, "skills"));
  await writeClaudeInstalledPlugins(state.claude, {
    "superpowers@official": [
      { scope: "user", installPath: stalePath, version: "7.0.0" },
      { scope: "user", installPath: validPath, version: "6.0.0" },
    ],
  });

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: join(validPath, "skills"), version: "6.0.0", source: "claude" });
});

test("malformed harness records count as not installed without throwing", async (t) => {
  const state = await fixture(t);
  await makePack(join(claudeCacheDir(state.claude, "official", "1.0.0"), "skills"));
  await mkdir(join(state.claude, "plugins"), { recursive: true });
  await writeFile(join(state.claude, "plugins", "installed_plugins.json"), "{not json");
  await writeFile(join(state.claude, "settings.json"), "{\"enabledPlugins\":");
  await makePack(join(codexPackDir(state.codex, "community"), "1.0.0", "skills"));
  await writeCodexConfig(state.codex, "[plugins.\"superpowers@community\"\nenabled = tru\n");
  assert.equal(detectProcessSkillsPack(state), null);

  // A malformed settings.json leaves the plugin enabled by default.
  await installClaudePack(state.claude, "official", "1.0.0");
  assert.equal(detectProcessSkillsPack(state)?.source, "claude");
});

test("Claude disabled in settings.json falls back to an enabled Codex pack", async (t) => {
  const state = await fixture(t);
  await installClaudePack(state.claude, "official", "6.4.1");
  await writeClaudeSettings(state.claude, { "superpowers@official": false });
  const codexSkillsDir = await installCodexPack(state.codex, "community", "1.2.3");

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: codexSkillsDir, version: "1.2.3", source: "codex" });
});

test("process skills detection rejects incomplete packs and disabled settings", async (t) => {
  const state = await fixture(t);
  const incompletePath = claudeCacheDir(state.claude, "official", "2.0.0");
  await makePack(join(incompletePath, "skills"), ["brainstorming", "test-driven-development"]);
  await writeClaudeInstalledPlugins(state.claude, {
    "superpowers@official": [{ scope: "user", installPath: incompletePath, version: "2.0.0" }],
  });
  assert.equal(detectProcessSkillsPack(state), null);

  const completePath = claudeCacheDir(state.claude, "official", "3.0.0");
  await makePack(join(completePath, "skills"));
  await writeClaudeInstalledPlugins(state.claude, {
    "superpowers@official": [
      { scope: "user", installPath: incompletePath, version: "2.0.0" },
      { scope: "user", installPath: completePath, version: "3.0.0" },
    ],
  });
  assert.equal(detectProcessSkillsPack(state)?.skills_dir, join(completePath, "skills"));
  assert.equal(detectProcessSkillsPack({ ...state, settings: { enabled: false, path: null } }), null);
});

test("process skills detection sees a newly installed version when run again", async (t) => {
  const state = await fixture(t);
  const olderPath = claudeCacheDir(state.claude, "official", "6.9.1");
  const olderSkillsDir = await installClaudePack(state.claude, "official", "6.9.1");
  assert.equal(detectProcessSkillsPack(state)?.skills_dir, olderSkillsDir);

  const latestPath = claudeCacheDir(state.claude, "official", "6.10.0");
  await makePack(join(latestPath, "skills"));
  await writeClaudeInstalledPlugins(state.claude, {
    "superpowers@official": [
      { scope: "user", installPath: olderPath, version: "6.9.1" },
      { scope: "user", installPath: latestPath, version: "6.10.0" },
    ],
  });
  assert.equal(detectProcessSkillsPack(state)?.skills_dir, join(latestPath, "skills"));
});

test("Codex detection reads config.toml's enabled marketplace", async (t) => {
  const state = await fixture(t);
  const skillsDir = await installCodexPack(state.codex, "community", "1.2.3");

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: skillsDir, version: "1.2.3", source: "codex" });
});

test("Codex detection ignores a marketplace whose enabled value is not literally true", async (t) => {
  const state = await fixture(t);
  await makePack(join(codexPackDir(state.codex, "community"), "1.2.3", "skills"));

  await writeCodexConfig(state.codex, `[plugins."superpowers@community"]\nenabled = false\n`);
  assert.equal(detectProcessSkillsPack(state), null);

  await writeCodexConfig(state.codex, `[plugins."superpowers@community"]\n# enabled left unset\n`);
  assert.equal(detectProcessSkillsPack(state), null);
});

/** Writes the install marker Codex leaves in a plugin cache directory installed from a remote marketplace. */
async function writeCodexRemoteMarker(codexHome, marketplace) {
  const packDir = codexPackDir(codexHome, marketplace);
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, ".codex-remote-plugin-install.json"),
    JSON.stringify({ schema_version: 1, remote_plugin_id: "plugins~Plugin_superpowers" }),
  );
}

test("Codex detection reads a remote install marker without a config.toml entry", async (t) => {
  const state = await fixture(t);
  const skillsDir = join(codexPackDir(state.codex, "openai-curated-remote"), "6.4.2", "skills");
  await makePack(skillsDir);
  await writeCodexRemoteMarker(state.codex, "openai-curated-remote");

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: skillsDir, version: "6.4.2", source: "codex" });

  await writeCodexConfig(state.codex, `[plugins."other@openai-curated-remote"]\nenabled = false\n`);
  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: skillsDir, version: "6.4.2", source: "codex" });
});

test("Codex detection honors enabled = false for a remote install marker", async (t) => {
  const state = await fixture(t);
  await makePack(join(codexPackDir(state.codex, "openai-curated-remote"), "6.4.2", "skills"));
  await writeCodexRemoteMarker(state.codex, "openai-curated-remote");
  await writeCodexConfig(state.codex, `[plugins."superpowers@openai-curated-remote"]\nenabled = false\n`);

  assert.equal(detectProcessSkillsPack(state), null);
});

test("Codex detection combines config.toml records and remote install markers", async (t) => {
  const state = await fixture(t);
  await installCodexPack(state.codex, "community", "1.2.3");
  const remoteSkillsDir = join(codexPackDir(state.codex, "openai-curated-remote"), "6.4.2", "skills");
  await makePack(remoteSkillsDir);
  await writeCodexRemoteMarker(state.codex, "openai-curated-remote");

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: remoteSkillsDir, version: "6.4.2", source: "codex" });
});

test("Codex detection follows a latest symlink over picking the highest semver", async (t) => {
  const state = await fixture(t);
  const packDir = codexPackDir(state.codex, "community");
  const older = join(packDir, "1.0.0");
  const newer = join(packDir, "2.0.0");
  await makePack(join(older, "skills"));
  await makePack(join(newer, "skills"));
  await symlink(older, join(packDir, "latest"), "dir");
  await writeCodexConfig(state.codex, `[plugins."superpowers@community"]\nenabled = true\n`);

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: join(packDir, "latest", "skills"), version: "1.0.0", source: "codex" });
});

test("Codex detection without a latest symlink picks the highest semver version dir", async (t) => {
  const state = await fixture(t);
  const packDir = codexPackDir(state.codex, "community");
  await makePack(join(packDir, "1.0.0", "skills"));
  const newer = join(packDir, "2.0.0");
  await makePack(join(newer, "skills"));
  await writeCodexConfig(state.codex, `[plugins."superpowers@community"]\nenabled = true\n`);

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: join(newer, "skills"), version: "2.0.0", source: "codex" });
});

test("Codex detection ends a plugin table at an array-of-tables header", async (t) => {
  const state = await fixture(t);
  await makePack(join(codexPackDir(state.codex, "m"), "1.0.0", "skills"));
  await writeCodexConfig(state.codex, `[plugins."superpowers@m"]\nenabled = false\n[[mcp.list]]\nenabled = true\n`);

  assert.equal(detectProcessSkillsPack(state), null);
});

test("Codex detection falls back to the next version when the preferred one is incomplete", async (t) => {
  const state = await fixture(t);
  const packDir = codexPackDir(state.codex, "community");
  await makePack(join(packDir, "2.0.0", "skills"), ["brainstorming"]);
  await makePack(join(packDir, "1.0.0", "skills"));
  await writeCodexConfig(state.codex, `[plugins."superpowers@community"]\nenabled = true\n`);

  assert.deepEqual(detectProcessSkillsPack(state), { skills_dir: join(packDir, "1.0.0", "skills"), version: "1.0.0", source: "codex" });
});

test("Codex detection ignores dot-named directories", async (t) => {
  const state = await fixture(t);
  await makePack(join(codexPackDir(state.codex, "community"), ".tmp", "skills"));
  await writeCodexConfig(state.codex, `[plugins."superpowers@community"]\nenabled = true\n`);

  assert.equal(detectProcessSkillsPack(state), null);
});

test("Codex version selection ranks a semver directory above a newer non-semver directory", async (t) => {
  const state = await fixture(t);
  const packDir = codexPackDir(state.codex, "official");
  const release = join(packDir, "1.0.0");
  await makePack(join(release, "skills"));
  const dev = join(packDir, "dev");
  await makePack(join(dev, "skills"));
  const future = new Date(Date.now() + 60_000);
  await utimes(dev, future, future);
  await writeCodexConfig(state.codex, `[plugins."superpowers@official"]\nenabled = true\n`);

  assert.equal(detectProcessSkillsPack(state)?.skills_dir, join(release, "skills"));
});

test("detection falls back to <home>/.claude and <home>/.codex when the env vars are unset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-process-skills-homedir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const skillsDir = await installClaudePack(join(home, ".claude"), "official", "1.0.0");

  assert.deepEqual(
    detectProcessSkillsPack({ env: {}, settings: { enabled: true, path: null }, homedir: home }),
    { skills_dir: skillsDir, version: "1.0.0", source: "claude" },
  );

  const codexHome = join(root, "codex-only-home");
  const codexSkillsDir = await installCodexPack(join(codexHome, ".codex"), "community", "1.2.3");
  assert.deepEqual(
    detectProcessSkillsPack({ env: {}, settings: { enabled: true, path: null }, homedir: codexHome }),
    { skills_dir: codexSkillsDir, version: "1.2.3", source: "codex" },
  );
});

const promptFiles = [
  "writing-plans/SKILL.md",
  "verification-before-completion/SKILL.md",
  "test-driven-development/SKILL.md",
  "systematic-debugging/SKILL.md",
  "receiving-code-review/SKILL.md",
  "requesting-code-review/code-reviewer.md",
  "using-superpowers/references/claude-code-tools.md",
  "using-superpowers/references/codex-tools.md",
];

async function makePromptPack(skillsDir) {
  await makePack(skillsDir);
  for (const path of promptFiles) {
    const file = join(skillsDir, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "# Procedure\n");
  }
}

test("process skills renders the shared preamble and native skill invocation when the pack matches the harness", () => {
  assert.equal(PROCESS_SKILLS_SETTINGS_KEY, "process_skills");
  const pack = { skills_dir: "/tmp/process-skills/skills", source: "claude", available_files: promptFiles };
  const cases = [
    ["manager_plan", ["writing-plans", 'superpowers:writing-plans', "/tmp/process-skills/skills/writing-plans/SKILL.md"]],
    ["manager_finalize", ["verification-before-completion", 'superpowers:verification-before-completion']],
    ["worker", ["test-driven-development", 'superpowers:test-driven-development', "systematic-debugging", "receiving-code-review"]],
    ["reviewer", ["verification-before-completion", "requesting-code-review/code-reviewer.md"]],
    ["executor", ["test-driven-development", "systematic-debugging", "verification-before-completion"]],
  ];
  for (const [role, expected] of cases) {
    const lines = renderProcessSkills(role, pack, "claude");
    assert.ok(lines);
    assert.match(lines.join("\n"), /You were dispatched as a subagent for one Owl role/u);
    assert.match(lines.join("\n"), /Do not use: brainstorming, writing-plans \(except where listed below\), subagent-driven-development/u);
    assert.match(lines.join("\n"), /Skill tool with skill: "superpowers:/u);
    assert.match(lines.join("\n"), /claude-code-tools\.md/u);
    for (const value of expected) assert.ok(lines.join("\n").includes(value), `${role} includes ${value}`);
  }
  // requesting-code-review/code-reviewer.md and the tools reference are resource files, not skills: always a path.
  assert.match(renderProcessSkills("reviewer", pack, "claude").join("\n"), /Read \/tmp\/process-skills\/skills\/requesting-code-review\/code-reviewer\.md\./u);
  assert.equal(renderProcessSkills("worker", null, "claude"), null);
});

test("process skills fall back to the file path when the pack's source is not this harness", () => {
  const pack = { skills_dir: "/tmp/process-skills/skills", source: "codex", available_files: promptFiles };
  const lines = renderProcessSkills("worker", pack, "claude").join("\n");
  assert.doesNotMatch(lines, /Skill tool with skill:/u);
  assert.match(lines, /Read \/tmp\/process-skills\/skills\/test-driven-development\/SKILL\.md\./u);

  const settingPack = { skills_dir: "/tmp/process-skills/skills", source: "setting", available_files: promptFiles };
  const settingLines = renderProcessSkills("worker", settingPack, "claude").join("\n");
  assert.doesNotMatch(settingLines, /Skill tool with skill:/u);
});

test("role prompts put process skills after Instructions and omit an empty section", () => {
  const slots = {
    role: "You are a test role.",
    instructions: ["Follow this instruction."],
    processSkills: ["Use the installed procedure."],
    output: { type: "object", properties: {}, required: [], additionalProperties: false },
    outputRules: [],
    language: "en",
    inputs: [],
  };
  const withSkills = renderRolePrompt(slots);
  assert.ok(withSkills.includes("## Instructions\nFollow this instruction.\n\n## Process skills\nUse the installed procedure."));
  assert.equal(renderRolePrompt({ ...slots, processSkills: null }).includes("## Process skills"), false);
});

test("process skills omits absent skill files and selects the harness tool reference", () => {
  const pack = {
    skills_dir: "/tmp/pack/skills",
    source: "codex",
    available_files: ["test-driven-development/SKILL.md", "using-superpowers/references/codex-tools.md"],
  };
  const lines = renderProcessSkills("worker", pack, "codex");
  assert.ok(lines);
  assert.match(lines.join("\n"), /test-driven-development\/SKILL\.md/u);
  assert.match(lines.join("\n"), /Use the "superpowers:test-driven-development" skill from your available skills list, or read .* if it is not listed\./u);
  assert.doesNotMatch(lines.join("\n"), /systematic-debugging\/SKILL\.md/u);
  assert.match(lines.join("\n"), /codex-tools\.md/u);
  assert.doesNotMatch(lines.join("\n"), /claude-tools\.md/u);
});

test("process skills reach Manager, Worker, Reviewer and Hybrid Executor prompts", async (t) => {
  const state = await fixture(t);
  const skillsDir = join(state.root, "installed", "skills");
  await makePromptPack(skillsDir);
  const calls = [];
  const runner = createAgentRunner({
    adapter: "codex",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        return { adapter: request.adapter, stdout: "{}", stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const task = {
    id: "task-1", work_id: "work-1", title: "Test task", status: "running", type: "code",
    state_version: 0, updated_at: "2026-09-01T00:00:00.000Z", parent_task_id: null,
    acceptance: "Done.", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [],
  };
  const report = {
    kind: "report", schema_version: "1.0.0", invocation_id: "worker-1", result: "success",
    work_done: "Done.", changes: [], verification: { passed: true, method: "Checked." },
    remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
  };
  await runner.runManagerPlan({
    invocation_id: "manager-1", work_id: "work-1", task_id: null, attempt: 1,
    context: { mode: "plan", work: { id: "work-1", title: "Test work" }, process_skills_dir: skillsDir, process_skills_source: "codex" },
  });
  await runner.runWorker({
    invocation_id: "worker-1", work_id: "work-1", task_id: "task-1", attempt: 1,
    context: { task, process_skills_dir: skillsDir, process_skills_source: "codex" },
  });
  await runner.runReviewer({
    invocation_id: "reviewer-1", work_id: "work-1", task_id: "task-1", attempt: 1, review_round: 1,
    context: { task, report, process_skills_dir: skillsDir, process_skills_source: "codex" },
  });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.prompt, /## Process skills\nYou were dispatched as a subagent/u);
    assert.match(call.prompt, /codex-tools\.md/u);
    assert.match(call.prompt, /skill from your available skills list, or read .* if it is not listed\./u);
    assert.match(call.prompt, /"knowledge": null/u);
    assert.match(call.prompt, /Rules are binding; context\.knowledge is reference information/u);
  }
  assert.match(calls[0].prompt, /superpowers:writing-plans/u);
  assert.match(calls[1].prompt, /superpowers:test-driven-development/u);
  // A resource file (not a skill's own SKILL.md), so it is always read by path even with a matching harness.
  assert.match(calls[2].prompt, /Read .*requesting-code-review\/code-reviewer\.md\./u);

  await runner.runWorker({
    invocation_id: "worker-2", work_id: "work-1", task_id: "task-1", attempt: 1,
    context: { task, hybrid_mode: true, hybrid_phase: "plan", process_skills_dir: skillsDir, process_skills_source: "codex" },
  });
  assert.ok(calls.length > 3);
  for (const call of calls.slice(3)) {
    assert.doesNotMatch(call.prompt, /## Process skills/u);
  }

  const executorPrompt = buildExecutorPrompt({
    subtask_id: "s1", instruction: "Implement the change.", workspace_dir: state.root,
    process_skills_dir: skillsDir,
    process_skills_source: "codex",
    task: { title: "Test task", acceptance: "Done.", context: "", rules: null, owner_guidance: [] },
  }, renderProcessSkills("executor", { skills_dir: skillsDir, source: "codex", available_files: promptFiles }, "codex"));
  assert.match(executorPrompt, /## Process skills/u);
  assert.match(executorPrompt, /superpowers:test-driven-development/u);
});

test("a Codex Executor gets native skill invocations for a Codex-sourced pack", async (t) => {
  const state = await fixture(t);
  const skillsDir = join(state.root, "installed", "skills");
  await makePromptPack(skillsDir);
  const promptFile = join(state.root, "executor-prompt.txt");
  const executable = join(state.root, "codex");
  await writeFile(executable, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(${JSON.stringify(promptFile)}, prompt);
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n");
});
`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [state.root, previousPath ?? ""].filter(Boolean).join(":");
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const result = await runExecutor(
    {
      subtask_id: "s1", instruction: "Implement the change.", workspace_dir: state.root,
      process_skills_dir: skillsDir,
      process_skills_source: "codex",
      task: { title: "Test task", acceptance: "Done.", context: "", rules: null, owner_guidance: [] },
    },
    { provider: "codex", model: "gpt-6-luna", timeout_ms: 5000 },
  );
  assert.equal(result.success, true, result.output);
  const prompt = await readFile(promptFile, "utf8");
  assert.match(prompt, /Use the "superpowers:test-driven-development" skill from your available skills list/u);
});

test("prompts with no detected pack stay byte-identical", () => {
  const task = {
    id: "task-1", work_id: "work-1", title: "Add archived_at column", status: "running", type: "code",
    state_version: 0, updated_at: "2026-09-24T00:00:00.000Z", parent_task_id: null,
    acceptance: "Migration applies cleanly.", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [],
  };
  const report = {
    kind: "report", schema_version: "1.0.0", invocation_id: "worker-1", result: "success",
    work_done: "Added the migration.", changes: [], verification: { passed: true, method: "Checked." },
    remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
  };
  const executorTask = {
    subtask_id: "s1", instruction: "Implement the migration.", workspace_dir: "/tmp/worktree",
    task: { title: task.title, acceptance: task.acceptance, context: "", rules: null, owner_guidance: [] },
  };
  const prompts = {
    manager_plan: buildManagerPrompt({ work: { id: "work-1", title: "Archive Works" }, mode: "plan", context: {} }, "en"),
    manager_finalize: buildManagerPrompt({ work: { id: "work-1", title: "Archive Works" }, mode: "finalize", context: {} }, "en"),
    worker: buildWorkerPrompt({ task }, "en"),
    hybrid_plan: buildHybridPlanPrompt({ task }, "en"),
    hybrid_verdict: buildHybridVerdictPrompt({ task }, [{ subtask_id: "s1", success: true, output: "done", exit_code: 0, duration_ms: 10 }], "en"),
    reviewer: buildReviewerPrompt({ task, report, review_round: 1 }, "en"),
    executor: buildExecutorPrompt(executorTask),
  };
  const expected = {
    manager_plan: "62e42e4c6ad7ff1b5c016c78add6fceb1e121f574d8c8011527879f98ff72064",
    manager_finalize: "dc137e92cc8c354e63bf11a2bd0234b6dd62ec9d158e7d87e0c4298f8a62a3a1",
    worker: "c09a75f96fd05821e1a4dfac1dd831da60c1172731c2385c2b79190b92a1c71c",
    hybrid_plan: "443a103fbc67de2f88b17d66cc30f9c3f75fd4f69e5931be242e2fbfe2a914f4",
    hybrid_verdict: "c72b9a1afa78c00a06571d8cdc63e692e9988900b6d4dc518db3706e8ca5d363",
    reviewer: "b7e6e879cb536b9fcfa2f5d117c1e5d12b4c6fb2df481bb16e5caf90e63d7769",
    executor: "1cd18917943503c4ce363a4a9b916c358dc5ab8c99d208944935587ff56e9d57",
  };
  for (const [role, prompt] of Object.entries(prompts)) {
    assert.equal(createHash("sha256").update(prompt).digest("hex"), expected[role], `${role} prompt changed without a pack`);
  }
});

test("buildExecutorPrompt adds the Workspace tools section only when the task carries a worktree", () => {
  const baseTask = {
    subtask_id: "s1", instruction: "Implement the migration.", workspace_dir: "/tmp/worktree",
    task: { title: "Add archived_at column", acceptance: "Migration applies cleanly.", context: "", rules: null, owner_guidance: [] },
  };
  const withoutWorktree = buildExecutorPrompt(baseTask);
  assert.equal(withoutWorktree.includes("## Workspace tools"), false);

  const withWorktree = buildExecutorPrompt({ ...baseTask, worktree: "/tmp/worktree" });
  assert.match(withWorktree, /## Workspace tools\n- You are working in the git worktree \/tmp\/worktree\./u);
  assert.match(withWorktree, /prefer the semantic search, reference search and impact-analysis tools/u);
});

test("Designer process skills apply design principles without starting dialogue", () => {
  assert.equal(renderProcessSkills("designer", null, "codex"), null);
  const lines = renderProcessSkills("designer", {
    skills_dir: "/skills",
    source: "setting",
    available_files: ["brainstorming/SKILL.md", "writing-plans/SKILL.md"],
  }, "codex").join("\n");
  assert.match(lines, /brainstorming:.*isolation, clear interfaces, and YAGNI/u);
  assert.match(lines, /without asking the operator questions or starting a dialogue/u);
  assert.match(lines, /writing-plans: When writing the implementation breakdown/u);
  // The skills the Designer is told to use are neither ignored nor forbidden.
  assert.doesNotMatch(lines, /start with brainstorming/u);
  const forbidden = lines.split("\n").find((line) => line.startsWith("Do not use:"));
  assert.ok(forbidden);
  assert.doesNotMatch(forbidden, /brainstorming|writing-plans/u);
  assert.doesNotMatch(lines, /\. use /u);
  for (const role of ["manager_plan", "manager_finalize", "worker", "reviewer", "executor"]) {
    const other = renderProcessSkills(role, { skills_dir: "/skills", source: "setting" }, "codex").join("\n");
    assert.match(other, /ignore any instruction to run using-superpowers or to start with brainstorming\./u);
    assert.match(other, /Do not use: brainstorming, writing-plans \(except where listed below\), subagent-driven-development/u);
  }
});

test("Advisor clarification rules apply with no pack and preserve direct-work and project rules", async (t) => {
  const { core } = await coreFixture(t, { env: {}, homedir: join(tmpdir(), "empty-process-skills-home") });
  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  for (const phrase of [
    "First classify every request as small, normal, or large.",
    "For a small request whose goal, target, and completion condition are unambiguous",
    "Otherwise, do not emit create_work in that turn.",
    "Emit create_work in the turn when the operator agrees",
    "If the operator declines further clarification or says",
    "each line starting \"Unconfirmed:\"",
    "発行して",
    "Do not write specification files or implementation plans",
  ]) assert.ok(prompt.includes(phrase), phrase);
  assert.equal(prompt.includes("Ask a brief clarifying question only when"), false);
  assert.match(prompt, /Only bypass Work when the operator explicitly asks/u);
  assert.match(prompt, /Set the exact project_id when one Project matches/u);
});

test("Advisor process skills line follows detection changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-process-skills-advisor-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const claude = join(root, "claude-config");
  const firstInstallPath = claudeCacheDir(claude, "official", "1.0.0");
  const firstSkillsDir = join(firstInstallPath, "skills");
  await makePack(firstSkillsDir);
  await writeClaudeInstalledPlugins(claude, {
    "superpowers@official": [{ scope: "user", installPath: firstInstallPath, version: "1.0.0" }],
  });
  const { core } = await coreFixture(t, { env: { CLAUDE_CONFIG_DIR: claude }, homedir: home });
  const firstPrompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.match(firstPrompt, new RegExp(`${firstSkillsDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/brainstorming/SKILL\\.md`));
  assert.match(firstPrompt, /skip the visual companion, the spec file, the spec review, and writing-plans/u);
  assert.match(firstPrompt, /treat create_work carrying the agreed design as the terminal state/u);

  const latestInstallPath = claudeCacheDir(claude, "official", "1.1.0");
  const latestSkillsDir = join(latestInstallPath, "skills");
  await makePack(latestSkillsDir);
  await writeClaudeInstalledPlugins(claude, {
    "superpowers@official": [
      { scope: "user", installPath: firstInstallPath, version: "1.0.0" },
      { scope: "user", installPath: latestInstallPath, version: "1.1.0" },
    ],
  });
  core.refreshProcessSkillsPack();
  const latestPrompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.notEqual(latestPrompt, firstPrompt);
  assert.ok(latestPrompt.includes(`${latestSkillsDir}/brainstorming/SKILL.md`));
  assert.equal(latestPrompt.includes(`${firstSkillsDir}/brainstorming/SKILL.md`), false);
});
