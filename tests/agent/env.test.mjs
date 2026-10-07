import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { buildAgentEnv, isOwlSecretEnvName } from "../../apps/server/dist/agent-env.js";
import { buildAgentPermissionArgs } from "../../packages/shared/dist/index.js";
import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

async function withRoot(t, dotEnv, run) {
  const root = await tempDir(t, "owl-agent-env-");
  if (dotEnv !== null) await writeFile(join(root, ".env"), dotEnv, { mode: 0o600 });
  return await run(root);
}

test("agent env withholds Owl credentials and passes everything else through", async (t) => {
  await withRoot(t, null, async (root) => {
    const env = buildAgentEnv({
      PATH: "/usr/bin",
      HOME: "/home/owl",
      CODEX_HOME: "/home/owl/.codex-alt",
      CLAUDE_CONFIG_DIR: "/home/owl/.claude-alt",
      HTTPS_PROXY: "http://proxy.test:8080",
      TMPDIR: "/tmp/owl",
      GITHUB_PERSONAL_ACCESS_TOKEN: "mcp-credential",
      SOME_MCP_SERVER_KEY: "mcp-key",
      OWL_GUARD_TOKEN: "guard",
      OWL_API_TOKEN: "api",
      OWL_SECRET_PASSPHRASE: "vault",
      SLACK_BOT_TOKEN: "xoxb",
      SLACK_APP_TOKEN: "xapp",
      SLACK_SIGNING_SECRET: "signing",
      DISCORD_BOT_TOKEN: "discord",
      TYPESAFE_API_KEY: "typesafe",
      OWL_TYPESAFE_API_KEY: "typesafe",
      OWL_PROVIDER_ORCA_API_KEY: "custom",
      CUSTOM_PROVIDER_KEY: "custom-named",
    }, { owlRoot: root, deny: ["CUSTOM_PROVIDER_KEY"], extra: { OWL_GUARD_API_BASE: "http://127.0.0.1:1" } });
    for (const name of ["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "TMPDIR", "GITHUB_PERSONAL_ACCESS_TOKEN", "SOME_MCP_SERVER_KEY"]) {
      assert.ok(name in env, `${name} passes through`);
    }
    for (const name of [
      "OWL_GUARD_TOKEN", "OWL_API_TOKEN", "OWL_SECRET_PASSPHRASE", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
      "SLACK_SIGNING_SECRET", "DISCORD_BOT_TOKEN", "TYPESAFE_API_KEY", "OWL_TYPESAFE_API_KEY",
      "OWL_PROVIDER_ORCA_API_KEY", "CUSTOM_PROVIDER_KEY",
    ]) {
      assert.equal(name in env, false, `${name} is withheld`);
    }
    assert.equal(env.OWL_ROOT, root);
    assert.equal(env.OWL_GUARD_API_BASE, "http://127.0.0.1:1");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONPROJECT_CLAUDE_MD, "1");
  });
});

test("keys defined in Owl's project .env are withheld unless they are shared CLI settings", async (t) => {
  await withRoot(t, "OWL_PROVIDER=real\nSOME_OWL_SECRET=abc\nCODEX_HOME=/alt/codex\nLC_ALL=C\nOWL_PROVIDER_TIMEOUT_MS=1000\nOWL_PROVIDER_TIMEOUT_MS_WORKER=2000\nOWL_PROVIDER_IDLE_TIMEOUT_MS_WORKER=3000\nOWL_ROLE_SESSION_CONTEXT_LIMIT=1234\nOWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER=4321\n", async (root) => {
    const env = buildAgentEnv({
      PATH: "/usr/bin",
      HOME: "/home/owl",
      OWL_PROVIDER: "real",
      SOME_OWL_SECRET: "abc",
      CODEX_HOME: "/alt/codex",
      LC_ALL: "C",
      OWL_PROVIDER_TIMEOUT_MS: "1000",
      OWL_PROVIDER_TIMEOUT_MS_WORKER: "2000",
      OWL_PROVIDER_IDLE_TIMEOUT_MS_WORKER: "3000",
      OWL_ROLE_SESSION_CONTEXT_LIMIT: "1234",
      OWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER: "4321",
      UNRELATED_USER_SETTING: "kept",
    }, { owlRoot: root });
    assert.equal(env.OWL_PROVIDER, undefined);
    assert.equal(env.SOME_OWL_SECRET, undefined);
    assert.equal(env.CODEX_HOME, "/alt/codex");
    assert.equal(env.LC_ALL, "C");
    assert.equal(env.OWL_PROVIDER_TIMEOUT_MS, "1000");
    assert.equal(env.OWL_PROVIDER_TIMEOUT_MS_WORKER, "2000");
    assert.equal(env.OWL_PROVIDER_IDLE_TIMEOUT_MS_WORKER, "3000");
    assert.equal(env.OWL_ROLE_SESSION_CONTEXT_LIMIT, "1234");
    assert.equal(env.OWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER, "4321");
    assert.equal(env.UNRELATED_USER_SETTING, "kept");
  });
});

test("Owl secret names are recognized by name and by the custom provider key pattern", () => {
  assert.equal(isOwlSecretEnvName("OWL_GUARD_TOKEN"), true);
  assert.equal(isOwlSecretEnvName("OWL_PROVIDER_MY_ENDPOINT_API_KEY"), true);
  assert.equal(isOwlSecretEnvName("OPENAI_API_KEY"), false);
  assert.equal(isOwlSecretEnvName("GITHUB_TOKEN"), false);
});

test("a custom provider key reaches only that provider's process, under the harness key name", async () => {
  const calls = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    env: { PATH: "/usr/bin", HOME: "/home/owl" },
    providers: { orca: { adapter: "claude-cli/v1", backend_url: "https://orca.test", api_key_env: "OWL_PROVIDER_ORCA_API_KEY" } },
    providerApiKeys: { OWL_PROVIDER_ORCA_API_KEY: "orca-key" },
    provider: {
      execute: async (request) => {
        calls.push(request);
        return { adapter: request.adapter, stdout: JSON.stringify({ reply: "ok" }), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const advisorInput = (provider) => ({ conversation_id: "c1", messages: [{ role: "user", content: "hi" }], system_prompt: "s", provider });
  await runner.runAdvisor(advisorInput("orca")).catch(() => undefined);
  await runner.runAdvisor(advisorInput("anthropic")).catch(() => undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].env.ANTHROPIC_API_KEY, "orca-key");
  assert.equal(calls[0].env.ANTHROPIC_BASE_URL, "https://orca.test");
  assert.equal(calls[1].env.ANTHROPIC_API_KEY, undefined);
  for (const call of calls) assert.equal(call.env.OWL_PROVIDER_ORCA_API_KEY, undefined);
});

test("claude args swap superpowers for a hook-free view of its skills and leave other plugins and settings alone", async (t) => {
  const home = await tempDir(t, "owl-sp-home-");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const installPath = join(home, ".claude", "plugins", "cache", "claude-plugins-official", "superpowers", "9.9.9");
    await mkdir(join(installPath, ".claude-plugin"), { recursive: true });
    await mkdir(join(installPath, "skills", "brainstorming"), { recursive: true });
    await mkdir(join(installPath, "hooks"), { recursive: true });
    await writeFile(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superpowers", version: "9.9.9" }));
    await writeFile(join(installPath, "skills", "brainstorming", "SKILL.md"), "canary");
    await writeFile(join(installPath, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] } }));
    await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "superpowers@claude-plugins-official": [{ installPath, version: "9.9.9" }], "codex@openai-codex": [{ installPath: "/x/codex" }] },
    }));
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "codex@openai-codex": true } }));
    const before = await readFile(join(home, ".claude", "settings.json"), "utf8");

    const args = buildAgentPermissionArgs("worker", "claude", { owlRoot: process.cwd() });
    const view = args[args.indexOf("--plugin-dir") + 1];
    assert.equal(args.filter((arg) => arg === "--plugin-dir").length, 1);
    assert.ok(view.startsWith(join(home, ".owl")));
    assert.equal(JSON.parse(await readFile(join(view, ".claude-plugin", "plugin.json"), "utf8")).name, "superpowers");
    assert.equal(await readFile(join(view, "skills", "brainstorming", "SKILL.md"), "utf8"), "canary");
    assert.deepEqual((await readdir(view)).sort(), [".claude-plugin", "skills"]);

    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.equal(settings.hooks.SessionStart, undefined);
    assert.equal(settings.enabledPlugins, undefined);
    assert.equal(settings.disableAllHooks, undefined);
    assert.equal(args.includes("--bare"), false);
    assert.equal(await readFile(join(home, ".claude", "settings.json"), "utf8"), before);

    assert.deepEqual(buildAgentPermissionArgs("worker", "claude", { owlRoot: process.cwd() }), args);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("claude args add no plugin dir when superpowers is not installed", () => {
  const args = buildAgentPermissionArgs("worker", "claude", { owlRoot: process.cwd(), env: { CLAUDE_CONFIG_DIR: "/nonexistent-owl-claude" } });
  assert.equal(args.includes("--plugin-dir"), false);
});

test("claude args pick the effective superpowers install across marketplaces, scopes and entries", async (t) => {
  const home = await tempDir(t, "owl-sp-multi-");
  try {
    const install = async (name, version, marker) => {
      const path = join(home, ".claude", "plugins", "cache", name, version);
      await mkdir(join(path, ".claude-plugin"), { recursive: true });
      await mkdir(join(path, "skills"), { recursive: true });
      await mkdir(join(path, "hooks"), { recursive: true });
      await writeFile(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superpowers" }));
      await writeFile(join(path, "skills", "marker.md"), marker);
      await writeFile(join(path, "hooks", "hooks.json"), "{}");
      return path;
    };
    const project = await install("m1", "7.0.0", "project-7");
    const user = await install("m2", "6.0.0", "user-6");
    const old = await install("m2", "5.0.0", "user-5");
    await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "superpowers@claude-plugins-official": [{ scope: "project", projectPath: "/work/a", installPath: project, version: "7.0.0" }],
        "superpowers@superpowers-marketplace": [
          { scope: "user", installPath: old, version: "5.0.0" },
          { scope: "user", installPath: user, version: "6.0.0" },
        ],
      },
    }));
    const env = { CLAUDE_CONFIG_DIR: join(home, ".claude"), HOME: home };
    const pick = async (cwd) => {
      const args = buildAgentPermissionArgs("worker", "claude", { owlRoot: process.cwd(), cwd, env });
      if (!args.includes("--plugin-dir")) return null;
      const view = args[args.indexOf("--plugin-dir") + 1];
      assert.deepEqual((await readdir(view)).sort(), [".claude-plugin", "skills"]);
      return readFile(join(view, "skills", "marker.md"), "utf8");
    };
    assert.equal(await pick("/work/a"), "user-6");
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@superpowers-marketplace": false } }));
    assert.equal(await pick("/work/a"), "project-7");
    assert.equal(await pick("/work/b"), null);
  } finally {
    // tempDir removes the directory in t.after
  }
});
