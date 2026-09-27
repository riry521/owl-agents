import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildAgentEnv, isOwlSecretEnvName } from "../apps/server/dist/agent-env.js";
import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";

async function withRoot(dotEnv, run) {
  const root = await mkdtemp(join(tmpdir(), "owl-agent-env-"));
  try {
    if (dotEnv !== null) await writeFile(join(root, ".env"), dotEnv, { mode: 0o600 });
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("agent env withholds Owl credentials and passes everything else through", async () => {
  await withRoot(null, async (root) => {
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

test("keys defined in Owl's project .env are withheld unless they are shared CLI settings", async () => {
  await withRoot("OWL_PROVIDER=real\nSOME_OWL_SECRET=abc\nCODEX_HOME=/alt/codex\nLC_ALL=C\nOWL_PROVIDER_TIMEOUT_MS=1000\n", async (root) => {
    const env = buildAgentEnv({
      PATH: "/usr/bin",
      HOME: "/home/owl",
      OWL_PROVIDER: "real",
      SOME_OWL_SECRET: "abc",
      CODEX_HOME: "/alt/codex",
      LC_ALL: "C",
      OWL_PROVIDER_TIMEOUT_MS: "1000",
      UNRELATED_USER_SETTING: "kept",
    }, { owlRoot: root });
    assert.equal(env.OWL_PROVIDER, undefined);
    assert.equal(env.SOME_OWL_SECRET, undefined);
    assert.equal(env.CODEX_HOME, "/alt/codex");
    assert.equal(env.LC_ALL, "C");
    assert.equal(env.OWL_PROVIDER_TIMEOUT_MS, "1000");
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
