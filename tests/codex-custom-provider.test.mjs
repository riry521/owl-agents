// A codex-harness custom provider is selected through a dedicated Codex model
// provider (--config overrides) with the key in the child's environment only;
// built-in provider launches carry no such overrides.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CodexSessionDriver, classifyProviderFailure, createAgentRunner } from "../packages/agent-runtime/dist/index.js";
import { withProviderDetail } from "../packages/agent-runtime/dist/provider-error.js";
import { createCliProvider } from "../packages/agent-runtime/dist/provider.js";
import {
  buildCodexCustomProviderArgs,
  CODEX_PROVIDER_API_KEY_ENV,
  CODEX_PROVIDER_BASE_URL_ENV,
} from "../packages/shared/dist/index.js";

const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
const customEnv = {
  [CODEX_PROVIDER_BASE_URL_ENV]: "https://api.orca.test/v1",
  [CODEX_PROVIDER_API_KEY_ENV]: "orca-secret-key",
};
const EXPECTED_ARGS = [
  "--config",
  'model_provider="owl_custom"',
  "--config",
  'model_providers.owl_custom={name="owl-custom",base_url="https://api.orca.test/v1",env_key="OWL_PROVIDER_CODEX_API_KEY",wire_api="responses"}',
];

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_START_LOG, JSON.stringify({
  args: process.argv.slice(2),
  env: {
    base: process.env.OWL_PROVIDER_CODEX_BASE_URL ?? null,
    key: process.env.OWL_PROVIDER_CODEX_API_KEY ?? null,
    openaiKey: process.env.OPENAI_API_KEY ?? null,
    openaiBase: process.env.OPENAI_BASE_URL ?? null,
  },
}));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

async function withFakeCodex(run) {
  const root = await mkdtemp(join(tmpdir(), "owl-codex-custom-"));
  try {
    const executable = join(root, "fake-codex");
    await writeFile(executable, FAKE_CODEX, "utf8");
    await chmod(executable, 0o755);
    const startLog = join(root, "start.json");
    return await run(root, executable, startLog);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("custom provider config arguments are TOML-escaped and absent without an endpoint", () => {
  assert.deepEqual(buildCodexCustomProviderArgs(customEnv), EXPECTED_ARGS);
  assert.deepEqual(buildCodexCustomProviderArgs({}), []);
  const keyless = buildCodexCustomProviderArgs({ [CODEX_PROVIDER_BASE_URL_ENV]: "http://localhost:8080/v1", [CODEX_PROVIDER_API_KEY_ENV]: "" });
  assert.ok(!keyless[3].includes("env_key"));
  assert.equal(keyless[3], 'model_providers.owl_custom={name="owl-custom",base_url="http://localhost:8080/v1",wire_api="responses"}');
  assert.deepEqual(buildCodexCustomProviderArgs(undefined), []);
  const escaped = buildCodexCustomProviderArgs({ [CODEX_PROVIDER_BASE_URL_ENV]: 'https://x.test/"v1"\\' });
  assert.ok(escaped[3].includes('base_url="https://x.test/\\"v1\\"\\\\"'));
});

test("the agent runner selects the Codex endpoint variables for a codex-harness custom provider", async () => {
  const calls = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    env: baseEnv,
    providers: { orca: { adapter: "codex", backend_url: "https://api.orca.test/v1", api_key_env: "OWL_PROVIDER_ORCA_API_KEY" } },
    providerApiKeys: { OWL_PROVIDER_ORCA_API_KEY: "orca-secret-key" },
    provider: {
      execute: async (request) => {
        calls.push(request);
        return { adapter: request.adapter, stdout: JSON.stringify({ reply: "ok" }), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const advisorInput = (provider) => ({ conversation_id: "c1", messages: [{ role: "user", content: "hi" }], system_prompt: "s", provider });
  await runner.runAdvisor(advisorInput("orca")).catch(() => undefined);
  await runner.runAdvisor(advisorInput("openai")).catch(() => undefined);
  assert.equal(calls[0].adapter, "codex");
  assert.equal(calls[0].env[CODEX_PROVIDER_BASE_URL_ENV], "https://api.orca.test/v1");
  assert.equal(calls[0].env[CODEX_PROVIDER_API_KEY_ENV], "orca-secret-key");
  assert.equal(calls[0].env.OPENAI_API_KEY, undefined);
  assert.equal(calls[0].env.OPENAI_BASE_URL, undefined);
  assert.equal(calls[1].env[CODEX_PROVIDER_BASE_URL_ENV], undefined);
  assert.equal(calls[1].env[CODEX_PROVIDER_API_KEY_ENV], undefined);
});

async function execCodex(root, executable, env) {
  const provider = createCliProvider({ adapter: "codex", executablePath: executable, model: "openai/gpt-6-luna", env: baseEnv });
  await provider.execute({
    adapter: "codex",
    role: "worker",
    model: "openai/gpt-6-luna",
    prompt: "work",
    invocation_id: "inv-1",
    cwd: root,
    env: { ...baseEnv, ...env },
  });
}

test("codex exec for a custom provider carries the model provider overrides and the key env", async () => {
  await withFakeCodex(async (root, executable, startLog) => {
    await execCodex(root, executable, { ...customEnv, FAKE_START_LOG: startLog });
    const started = JSON.parse(await readFile(startLog, "utf8"));
    const start = started.args.indexOf("--config", started.args.indexOf("--json"));
    const at = started.args.indexOf(EXPECTED_ARGS[1]);
    assert.ok(at > 0, "model_provider override present");
    assert.deepEqual(started.args.slice(at - 1, at + 3), EXPECTED_ARGS);
    assert.ok(start >= 0);
    assert.ok(at < started.args.indexOf("--model"));
    assert.equal(started.args[started.args.indexOf("--model") + 1], "openai/gpt-6-luna");
    assert.equal(started.env.key, "orca-secret-key");
    assert.equal(started.env.openaiKey, null);
    assert.equal(started.env.openaiBase, null);
    assert.ok(!started.args.join(" ").includes("orca-secret-key"));
  });
});

test("codex exec for a keyless custom provider names no env_key", async () => {
  await withFakeCodex(async (root, executable, startLog) => {
    await execCodex(root, executable, { [CODEX_PROVIDER_BASE_URL_ENV]: "http://localhost:8080/v1", FAKE_START_LOG: startLog });
    const started = JSON.parse(await readFile(startLog, "utf8"));
    const table = started.args.find((arg) => arg.startsWith("model_providers.owl_custom="));
    assert.ok(table && !table.includes("env_key"));
    assert.ok(started.args.includes('model_provider="owl_custom"'));
  });
});

test("codex exec for a built-in provider carries no model provider overrides", async () => {
  await withFakeCodex(async (root, executable, startLog) => {
    await execCodex(root, executable, { FAKE_START_LOG: startLog });
    const started = JSON.parse(await readFile(startLog, "utf8"));
    assert.ok(!started.args.some((arg) => arg.startsWith("model_provider")));
    assert.equal(started.env.base, null);
    assert.equal(started.env.key, null);
  });
});

async function startAppServer(env) {
  const root = await mkdtemp(join(tmpdir(), "owl-codex-custom-app-"));
  const executable = join(root, "fake-codex");
  await writeFile(executable, `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.FAKE_START_LOG, JSON.stringify({ args: process.argv.slice(2), key: process.env.OWL_PROVIDER_CODEX_API_KEY ?? null }));
process.exit(1);
`, "utf8");
  await chmod(executable, 0o755);
  const startLog = join(root, "start.json");
  await CodexSessionDriver.create({
    adapter: "codex",
    role: "advisor",
    model: "openai/gpt-6-luna",
    cwd: root,
    env: { ...baseEnv, CODEX_HOME: join(root, "home"), FAKE_START_LOG: startLog, ...env },
    system_prompt: "s",
  }, executable).catch(() => undefined);
  try {
    return JSON.parse(await readFile(startLog, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the Advisor app-server session selects the custom model provider and leaves built-ins alone", async () => {
  const custom = await startAppServer(customEnv);
  const at = custom.args.indexOf(EXPECTED_ARGS[1]);
  assert.deepEqual(custom.args.slice(at - 1, at + 3), EXPECTED_ARGS);
  assert.equal(custom.args.at(-1), "app-server");
  assert.equal(custom.key, "orca-secret-key");
  const keyless = await startAppServer({ [CODEX_PROVIDER_BASE_URL_ENV]: "http://localhost:8080/v1" });
  assert.ok(keyless.args.includes('model_provider="owl_custom"'));
  assert.ok(!keyless.args.find((arg) => arg.startsWith("model_providers.")).includes("env_key"));
  const builtin = await startAppServer({});
  assert.ok(!builtin.args.some((arg) => arg.startsWith("model_provider")));
  assert.equal(builtin.key, null);
});

test("a harness-reported provider error line is a bounded, masked detail kept out of the chat-visible message", () => {
  const cause = {
    exit_code: 1,
    signal: null,
    error: "The 'openai/gpt-6-luna' model is not supported when using Codex with a ChatGPT account.\nsecond line",
    stderr: "",
    harness_status: 400,
  };
  const classified = classifyProviderFailure("codex", cause, "ja");
  assert.ok(classified.message.includes("Codexへのリクエストが拒否されました"));
  assert.ok(!classified.message.includes("not supported"));
  assert.ok(withProviderDetail(classified, "ja").endsWith("詳細: The 'openai/gpt-6-luna' model is not supported when using Codex with a ChatGPT account."));
  assert.ok(!withProviderDetail(classified, "ja").includes("second line"));
  const masked = classifyProviderFailure("codex", { ...cause, error: `400 bad request key sk-abcdefghijklmnop ${"x".repeat(400)}` }, "en");
  const text = withProviderDetail(masked, "en");
  assert.ok(!text.includes("sk-abcdefghijklmnop"));
  assert.ok(text.length < 600);
  const shortKey = classifyProviderFailure("codex", { ...cause, error: "401 invalid key abc123 for this account" }, "en", undefined, ["abc123"]);
  assert.ok(!withProviderDetail(shortKey, "en").includes("abc123"));
  const timeout = classifyProviderFailure("codex", { exit_code: null, signal: null, kind: "timeout", timeout_kind: "wall", error: "boom" }, "en");
  assert.equal(timeout.detail_message, undefined);
});
