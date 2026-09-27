import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { Core } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";
import { PROCESS_SKILLS_INSTALL_COMMANDS } from "../packages/shared/dist/index.js";

const migrations = join(process.cwd(), "packages/db/migrations");
const requiredSkills = ["brainstorming", "test-driven-development", "verification-before-completion"];

const installCommands = [
  { harness: "claude", command: PROCESS_SKILLS_INSTALL_COMMANDS.claude },
  { harness: "codex", command: PROCESS_SKILLS_INSTALL_COMMANDS.codex },
];
// The HTTP server sees only the Claude CLI, so it lists only the Claude install command.
const serverInstallCommands = [{ harness: "claude", command: PROCESS_SKILLS_INSTALL_COMMANDS.claude }];
const claudeOnlyProviders = () => [
  { harnessId: "claude", available: true },
  { harnessId: "codex", available: false },
];

async function makePack(skillsDir, skills = requiredSkills) {
  for (const skill of skills) {
    const directory = join(skillsDir, skill);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `# ${skill}\n`);
  }
}

/** Writes the Claude plugin install record an installed superpowers pack leaves behind. */
async function installClaudePack(configHome, autoSkillsDir, marketplace = "official", version = "1.0.0") {
  await makePack(autoSkillsDir);
  const installPath = join(configHome, "plugins", "cache", marketplace, "superpowers", version);
  await mkdir(configHome, { recursive: true });
  await writeFile(
    join(configHome, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { [`superpowers@${marketplace}`]: [{ scope: "user", installPath, version }] },
    }),
  );
}

async function startServer(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-process-skills-"));
  const configHome = join(root, "claude-config");
  const autoSkillsDir = join(configHome, "plugins", "cache", "official", "superpowers", "1.0.0", "skills");
  await installClaudePack(configHome, autoSkillsDir);
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const durableCore = new Core({
    db,
    agentRunner,
    version: "test",
    owlRoot: root,
    processSkillsDetection: { env: { CLAUDE_CONFIG_DIR: configHome }, homedir: join(root, "home") },
  });
  await durableCore.start();
  const core = new ExternalCoreAdapter(durableCore, db, root, root, undefined, {
    detectProviderAvailability: claudeOnlyProviders,
  });

  const priorToken = process.env.OWL_API_TOKEN;
  const token = "test-process-skills-token";
  process.env.OWL_API_TOKEN = token;
  const http = createOwlHttpServer({
    core,
    db,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  let listening = false;
  t.after(async () => {
    if (listening) await http.close();
    await durableCore.stop({ force: true });
    db.close();
    if (priorToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = priorToken;
    await rm(root, { recursive: true, force: true });
  });
  await http.listen();
  listening = true;
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    root,
    autoSkillsDir,
    get: (authorized = true) => fetch(`${base}/settings/process-skills`, { headers: authorized ? headers : {} }),
    put: (payload, key, authorized = true) => fetch(`${base}/settings/process-skills`, {
      method: "PUT",
      headers: authorized ? headers : { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: `process-skills-${key}`,
        idempotency_key: `process-skills:${key}`,
        expected_version: 0,
        payload,
      }),
    }),
  };
}

test("process skills settings GET and PUT report settings and the detected location", async (t) => {
  const api = await startServer(t);

  const initial = await api.get();
  assert.equal(initial.status, 200);
  const initialData = (await initial.json()).data;
  assert.deepEqual(initialData, {
    enabled: true,
    path: null,
    detected: { skills_dir: api.autoSkillsDir, version: "1.0.0", source: "claude" },
    install_commands: serverInstallCommands,
  });

  const configuredRoot = join(api.root, "manual-pack");
  const configuredSkillsDir = join(configuredRoot, "skills");
  await makePack(configuredSkillsDir);
  const updated = await api.put({ enabled: true, path: configuredRoot }, "roundtrip");
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).data, {
    enabled: true,
    path: configuredRoot,
    detected: { skills_dir: configuredSkillsDir, version: null, source: "setting" },
    install_commands: serverInstallCommands,
  });

  const readBack = await api.get();
  assert.equal(readBack.status, 200);
  assert.deepEqual((await readBack.json()).data, {
    enabled: true,
    path: configuredRoot,
    detected: { skills_dir: configuredSkillsDir, version: null, source: "setting" },
    install_commands: serverInstallCommands,
  });

  const disabled = await api.put({ enabled: false, path: null }, "disabled");
  assert.equal(disabled.status, 200);
  assert.deepEqual((await disabled.json()).data, { enabled: false, path: null, detected: null, install_commands: serverInstallCommands });
});

test("process skills settings reject invalid pack paths and require Owner authorization", async (t) => {
  const api = await startServer(t);
  const incomplete = join(api.root, "incomplete-pack");
  await makePack(incomplete, ["brainstorming"]);

  for (const [key, path] of [
    ["relative", "relative/pack"],
    ["missing", join(api.root, "missing-pack")],
    ["incomplete", incomplete],
  ]) {
    const response = await api.put({ enabled: true, path }, key);
    assert.equal(response.status, 400, key);
  }

  assert.equal((await api.get(false)).status, 401);
  assert.equal((await api.put({ enabled: false, path: null }, "unauthorized", false)).status, 401);
});

test("Core settings persist, validate, and re-detect the selected pack", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-core-process-skills-"));
  const configHome = join(root, "claude-config");
  const autoSkillsDir = join(configHome, "plugins", "cache", "official", "superpowers", "1.0.0", "skills");
  await installClaudePack(configHome, autoSkillsDir);
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({
    db,
    agentRunner,
    version: "test",
    owlRoot: root,
    processSkillsDetection: { env: { CLAUDE_CONFIG_DIR: configHome }, homedir: join(root, "home") },
  });
  core.ruleStore.startWatching = async () => {};
  await core.start();
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(await core.getProcessSkillsSettings(), {
    enabled: true,
    path: null,
    detected: { skills_dir: autoSkillsDir, version: "1.0.0", source: "claude" },
    install_commands: installCommands,
  });

  const manualRoot = join(root, "manual-pack");
  const manualSkillsDir = join(manualRoot, "skills");
  await makePack(manualSkillsDir);
  assert.deepEqual(await core.setProcessSkillsSettings({ enabled: true, path: manualRoot }), {
    enabled: true,
    path: manualRoot,
    detected: { skills_dir: manualSkillsDir, version: null, source: "setting" },
    install_commands: installCommands,
  });
  assert.deepEqual(await core.getProcessSkillsSettings(), {
    enabled: true,
    path: manualRoot,
    detected: { skills_dir: manualSkillsDir, version: null, source: "setting" },
    install_commands: installCommands,
  });

  for (const path of ["relative/pack", join(root, "missing-pack"), join(root, "incomplete-pack")]) {
    if (path.endsWith("incomplete-pack")) await makePack(path, ["brainstorming"]);
    await assert.rejects(core.setProcessSkillsSettings({ enabled: true, path }), { code: "validation_error" });
  }
  assert.deepEqual(await core.setProcessSkillsSettings({ enabled: false, path: null }), {
    enabled: false,
    path: null,
    detected: null,
    install_commands: installCommands,
  });
  const advisorPrompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.match(advisorPrompt, /First classify every request as small, normal, or large/u);
  assert.equal(advisorPrompt.includes("brainstorming/SKILL.md"), false);
});

test("OpenAPI documents process skills settings and detection data", async () => {
  const openapi = await readFile(join(process.cwd(), "contracts/openapi/owl-api-v1.yaml"), "utf8");
  assert.match(openapi, /\/api\/v1\/settings\/process-skills:/u);
  assert.match(openapi, /operationId: getProcessSkillsSettings/u);
  assert.match(openapi, /operationId: updateProcessSkillsSettings/u);
  assert.match(openapi, /ProcessSkillsSettingsResponse/u);
  assert.match(openapi, /UpdateProcessSkillsSettingsCommand/u);
  assert.match(openapi, /DetectedProcessSkillsPack:[\s\S]*?enum:[\s\S]*?- setting\n\s+- claude\n\s+- codex/u);
  assert.match(openapi, /ProcessSkillsInstallCommand:[\s\S]*?enum:[\s\S]*?- claude\n\s+- codex/u);
  assert.match(openapi, /ProcessSkillsSettingsData:[\s\S]*?install_commands:[\s\S]*?ProcessSkillsInstallCommand/u);
});
