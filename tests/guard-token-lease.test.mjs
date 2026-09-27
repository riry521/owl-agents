// Every agent process gets its own guard token file, bound to its role and
// run, and the token is revoked when the process ends. Fake harness
// executables stand in for the real CLIs.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCliProvider } from "../packages/agent-runtime/dist/provider.js";
import { runExecutor } from "../packages/core/dist/executor.js";
import { GuardTokenRegistry } from "../apps/server/dist/guard-tokens.js";

const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

// Reports what a guard hook inside the process would see. With FAKE_OUT set it
// writes the report there and stays alive (a session); otherwise it prints it
// as a Claude result (Claude JSON) or an agent message event (Codex JSONL).
const FAKE_HARNESS = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const file = process.env.OWL_GUARD_TOKEN_FILE ?? null;
const report = JSON.stringify({
  file,
  token: file && existsSync(file) ? readFileSync(file, "utf8") : null,
  has_token_env: "OWL_GUARD_TOKEN" in process.env,
});
if (process.env.FAKE_OUT) {
  writeFileSync(process.env.FAKE_OUT, report);
  setInterval(() => {}, 1000);
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    const line = process.argv.includes("exec")
      ? { type: "item.completed", item: { type: "agent_message", text: report } }
      : { type: "result", subtype: "success", is_error: false, result: report };
    process.stdout.write(JSON.stringify(line) + "\\n");
  });
}
`;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-guard-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-harness");
  await writeFile(executable, FAKE_HARNESS, "utf8");
  await chmod(executable, 0o755);
  const registry = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => registry.clear());
  return { root, executable, registry };
}

/** An issuer that remembers which agent each token was issued to. */
function recordingIssuer(registry) {
  const issued = [];
  const issue = (agent) => {
    const lease = registry.issue(agent);
    issued.push({ agent, file: lease.file });
    return lease;
  };
  return { issue, issued };
}

function assertReportedToken(registry, report) {
  assert.equal(report.has_token_env, false);
  assert.ok(report.file?.startsWith(registry.directory), "the token file is in the registry directory");
  assert.ok(report.token, "the token file is readable while the process runs");
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail(`${path} was not written`);
}

test("a provider run gets a token for its role and run, revoked when it ends", async (t) => {
  const { root, executable, registry } = await setup(t);
  process.env.OWL_GUARD_TOKEN = "must-not-leak";
  t.after(() => { delete process.env.OWL_GUARD_TOKEN; });
  const issuer = recordingIssuer(registry);
  const provider = createCliProvider({ adapter: "claude-cli/v1", executablePath: executable, model: "m", env: baseEnv, guardToken: issuer.issue });
  const response = await provider.execute({
    adapter: "claude-cli/v1",
    role: "reviewer",
    model: "m",
    prompt: "check",
    invocation_id: "inv-7",
    cwd: root,
    env: { ...baseEnv, OWL_AGENT_ROLE: "reviewer", OWL_AGENT_RUN_ID: "run-7" },
  });
  const report = JSON.parse(JSON.parse(response.stdout).result);
  assertReportedToken(registry, report);
  assert.deepEqual(issuer.issued, [{ agent: { agent_run_id: "run-7", role: "reviewer" }, file: report.file }]);
  // execute() resolved after the process exited, so the token is gone.
  assert.equal(registry.verify(report.token), null);
  await assert.rejects(() => readFile(report.file), { code: "ENOENT" });
});

test("an Advisor session keeps its token until the session is stopped", async (t) => {
  const { root, executable, registry } = await setup(t);
  const out = join(root, "session-report.json");
  const provider = createCliProvider({
    adapter: "claude-cli/v1",
    executablePath: executable,
    model: "m",
    env: { ...baseEnv, OWL_CLAUDE_EXECUTABLE: executable, FAKE_OUT: out },
    guardToken: registry.issue,
  });
  const session = await provider.createSession({
    adapter: "claude-cli/v1",
    role: "advisor",
    model: "m",
    cwd: join(root, "advisor"),
    env: { OWL_AGENT_ROLE: "advisor", OWL_AGENT_RUN_ID: "session-1", OWL_AGENT_CWD: join(root, "advisor") },
    system_prompt: "advise",
  });
  const report = JSON.parse(await waitForFile(out));
  assertReportedToken(registry, report);
  assert.deepEqual(registry.verify(report.token), { agent_run_id: "session-1", role: "advisor" });
  await session.stop("test", 100);
  assert.equal(registry.verify(report.token), null);
  await assert.rejects(() => readFile(report.file), { code: "ENOENT" });
});

test("a Hybrid Executor process gets a worker token for its subtask, revoked when it ends", async (t) => {
  const { root, executable, registry } = await setup(t);
  const issuer = recordingIssuer(registry);
  const result = await runExecutor(
    {
      subtask_id: "sub-9",
      instruction: "work",
      workspace_dir: join(root, "ws"),
      task: { title: "Task", acceptance: "It works.", context: "", rules: null, owner_guidance: [] },
    },
    { provider: "codex", model: "gpt-5.6-terra", timeout_ms: 5000 },
    {},
    { owlRoot: process.cwd(), env: baseEnv, executables: { codex: executable }, guardToken: issuer.issue },
  );
  assert.equal(result.success, true, result.output);
  const report = JSON.parse(result.output);
  assertReportedToken(registry, report);
  assert.deepEqual(issuer.issued, [{ agent: { agent_run_id: "sub-9", role: "worker" }, file: report.file }]);
  assert.equal(registry.verify(report.token), null);
  await assert.rejects(() => readFile(report.file), { code: "ENOENT" });
});
