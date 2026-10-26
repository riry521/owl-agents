import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { withWorkspacePreparation } from "../../packages/core/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

function record(attempt, message = `error ${attempt}`) {
  return {
    harness: "codex", message, message_source: "harness_error", code: null, http_status: null, failure_kind: "exit",
    exit_code: 1, signal: null, failure_class: "transient", error_key: "provider_failed:rate_limit_transient",
    attempt, recorded_at: new Date().toISOString(),
  };
}

/** A runner that only keeps the observer Core registers, like the real runner before a call fails. */
function fakeRunner() {
  const runner = {
    observer: undefined,
    setProviderErrorObserver(observer) { runner.observer = observer; },
  };
  return runner;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

test("observer events are stored and read by invocation_id, attempt, since and role", async (t) => {
  const runner = fakeRunner();
  const { core, db } = await createTestCore(t, { agentRunner: runner });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W1', 'owner:default', NULL, 'Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES ('T1', 'W1', 'Task', 'code', 'running', 'normal', '', '', ?, ?)`,
      now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES ('run-1', 'W1', 'T1', 'worker', 'claude', 'test-model', 'running', ?, ?)`,
      now, now,
    );
  });
  const before = new Date(Date.now() - 1000).toISOString();
  runner.observer({ invocation_id: "curator-inv", role: "curator", record: record(1) });
  for (const attempt of [1, 2, 3]) runner.observer({ invocation_id: "run-1", role: "worker", record: record(attempt) });
  await settled();

  const curator = core.listProviderErrors({ invocation_id: "curator-inv" });
  assert.equal(curator.length, 1);
  assert.equal(curator[0].role, "curator");
  assert.equal(curator[0].record.message, "error 1");

  const run = core.listProviderErrors({ invocation_id: "run-1" });
  assert.deepEqual(run.map((row) => row.record.attempt).sort(), [1, 2, 3]);
  assert.equal(run.find((row) => row.record.attempt === 2).record.message, "error 2");

  assert.equal(core.listProviderErrors({ since: before }).length, 4);
  assert.deepEqual(core.listProviderErrors({ since: before, role: "curator" }).map((row) => row.invocation_id), ["curator-inv"]);
  assert.equal(core.listProviderErrors({ since: new Date(Date.now() + 60_000).toISOString() }).length, 0);
});

test("the observer reaches Core through withWorkspacePreparation", async (t) => {
  const runner = fakeRunner();
  const wrapped = withWorkspacePreparation(runner, { beforeAgentRun: async () => {}, markCreated() {} });
  const { core } = await createTestCore(t, { agentRunner: wrapped });
  assert.equal(typeof runner.observer, "function");
  runner.observer({ invocation_id: "wrapped-inv", role: "reviewer", record: record(1) });
  await settled();
  assert.equal(core.listProviderErrors({ invocation_id: "wrapped-inv" }).length, 1);
});

test("an Advisor turn failure stores the provider error under the turn id", async (t) => {
  const { core } = await createTestCore(t, { agentRunner: fakeRunner(), providerClient: { createSession() {} } });
  await core.advisorRuntime.markTurnFailed("turn-1", "failed", record(1, "advisor raw"));
  const rows = core.listProviderErrors({ invocation_id: "turn-1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "advisor");
  assert.equal(rows[0].record.message, "advisor raw");
});

test("a failure in the server's external runner reaches Core through the delegate and is stored", async (t) => {
  const { createExternalAgentRunner } = await import("../../apps/server/dist/agent-runner.js");
  const envKeys = ["OWL_PROVIDER", "OWL_PROVIDER_ID", "OWL_PROVIDER_ADAPTER", "OWL_PROVIDER_MODEL", "OWL_CLAUDE_EXECUTABLE", "OWL_CODEX_EXECUTABLE", "OWL_DATA_DIR", "HOME", "PATH"];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const root = await tempDir(t, "owl-provider-error-wiring-");
  const hookDir = join(root, "apps/server/dist");
  await mkdir(hookDir, { recursive: true });
  await symlink(join(repoRoot, "apps/server/dist/permission-hook.js"), join(hookDir, "permission-hook.js"));
  const executable = join(root, "failing-cli");
  await writeFile(executable, "#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stderr.write('raw provider failure'); process.exit(1); });\n", "utf8");
  await chmod(executable, 0o755);
  Object.assign(process.env, {
    OWL_PROVIDER: "real", OWL_PROVIDER_ID: "claude", OWL_PROVIDER_ADAPTER: "claude-cli/v1", OWL_PROVIDER_MODEL: "wiring-test",
    OWL_CLAUDE_EXECUTABLE: executable, OWL_CODEX_EXECUTABLE: executable, OWL_DATA_DIR: join(root, "server-data"), HOME: root, PATH: process.env.PATH ?? "",
  });
  const runner = await createExternalAgentRunner(root, false);
  const { core } = await createTestCore(t, { agentRunner: runner, owlRoot: root });
  const before = new Date(Date.now() - 1000).toISOString();
  const result = await runner.runKeywordExtraction({ items: [] });
  assert.equal(result.ok, false, JSON.stringify(result));
  await settled();
  const rows = core.listProviderErrors({ since: before });
  assert.ok(rows.length >= 1);
  assert.match(rows[0].record.message, /raw provider failure/u);
});
