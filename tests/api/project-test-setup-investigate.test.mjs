import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createExternalAgentRunner } from "../../apps/server/dist/agent-runner.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const READY = {
  verdict: "ready",
  setup_argvs: [],
  test_run: { mode: "whole", whole_argv: ["node", "--test"], file_argv: [], prepare_argv: [], test_patterns: ["**/*.test.mjs"], cwd: "." },
  executables: [],
  confirm_files: [],
  probe_argvs: [],
  sources: ["package.json"],
  attempts: [],
  installed: [],
  outside_installs: [],
  missing: [],
  notes: "",
};

function stubAgent() {
  const calls = [];
  return {
    calls,
    async runTestSetupInvestigation(request) {
      calls.push(request);
      return { ok: true, invocation_id: request.invocation_id, investigation: READY };
    },
  };
}

async function setup(t, { agentRunner }) {
  const { root, db, core } = await createTestCore(t, {
    agentRunner,
    testCommandRunner: async () => ({ exit_code: 0, timed_out: false, stdout: "ok\n", stderr: "", duration_ms: 1 }),
    version: "api-project-test-setup-investigate",
  }, { prefix: "owl-api-test-setup-investigate-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const server = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir, guardTokens }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  const register = async (name, extra = {}) => {
    const repo = join(root, name);
    await mkdir(repo, { recursive: true });
    git(repo, "init", "--initial-branch=main");
    await writeFile(join(repo, "package.json"), "{}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");
    const created = await core.createProject(command({ name, canonical_path: repo, base_branch: "main", allowed_roots: [root], verification_plan: [], ...extra }, `project-${name}-${randomUUID()}`));
    await core.whenTestSetupIdle();
    return created.data.id;
  };
  const post = (projectId) => server.request("POST", `/api/v1/projects/${projectId}/test-setup/investigate`);
  const stored = (projectId) => JSON.parse(db.get("SELECT test_setup_json FROM projects WHERE id = ?", projectId).test_setup_json);
  const get = (projectId) => server.request("GET", `/api/v1/projects/${projectId}/test-setup/investigation`);
  return { core, root, get, post, register, stored };
}

test("POST test-setup/investigate returns 202 and saves a test_setup with trigger manual", async (t) => {
  const agent = stubAgent();
  const ctx = await setup(t, { agentRunner: agent });
  if (!ctx) return;
  const projectId = await ctx.register("manual");
  assert.equal(agent.calls.length, 1);
  assert.equal(ctx.stored(projectId).trigger, "project_registered");
  const response = await ctx.post(projectId);
  assert.equal(response.status, 202);
  assert.deepEqual((await response.json()).data, { project_id: projectId, trigger: "manual", accepted: true });
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1].trigger, "manual");
  assert.equal(ctx.stored(projectId).trigger, "manual");
});

test("POST test-setup/investigate answers 409 with the reason and starts nothing", async (t) => {
  const agent = stubAgent();
  const ctx = await setup(t, { agentRunner: agent });
  if (!ctx) return;
  const explicit = await ctx.register("explicit", {
    test_run: { test_patterns: ["tests/**/*.test.mjs"], file_argv: ["node", "--test", "{file}"], concurrency: 1, flaky_retries: 0, source_map: [] },
  });
  const plain = await ctx.register("plain");
  const before = agent.calls.length;
  const expectReason = async (projectId, reason) => {
    const response = await ctx.post(projectId);
    assert.equal(response.status, 409);
    const { error } = await response.json();
    assert.equal(error.code, "test_setup_unavailable");
    assert.equal(error.details.reason, reason);
  };
  await expectReason(explicit, "explicit_test_run");
  const pause = ctx.core.providerPauseController;
  const original = pause.isPaused;
  pause.isPaused = () => true;
  t.after(() => { pause.isPaused = original; });
  await expectReason(plain, "provider_paused");
  pause.isPaused = original;
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, before, "no investigation started");
  assert.equal((await ctx.post("01ARZ3NDEKTSV4RRFFQ69G5FAV")).status, 404);
});

test("GET test-setup/investigation reports the latest run, and a run that saves no record as not saved", async (t) => {
  const ctx = await setup(t, { agentRunner: stubAgent() });
  if (!ctx) return;
  const projectId = await ctx.register("state");
  const read = async () => (await (await ctx.get(projectId)).json()).data;
  assert.deepEqual(await read(), { project_id: projectId, running: false, outcome: { saved: true, status: "ready", reason: null } });
  assert.equal((await ctx.get("01ARZ3NDEKTSV4RRFFQ69G5FAV")).status, 404);
  rmSync(join(ctx.root, "state", ".git"), { recursive: true, force: true });
  assert.equal((await ctx.post(projectId)).status, 202);
  await ctx.core.whenTestSetupIdle();
  assert.deepEqual(await read(), { project_id: projectId, running: false, outcome: { saved: false, status: null, reason: "not_a_git_checkout" } });
});

test("POST test-setup/investigate answers 409 runner_unavailable for a runner without runTestSetupInvestigation", async (t) => {
  const ctx = await setup(t, { agentRunner: {} });
  if (!ctx) return;
  const projectId = await ctx.register("norunner");
  const response = await ctx.post(projectId);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.details.reason, "runner_unavailable");
});

test("the production agent runner delegates a manual test-setup request to agent-runtime", async (t) => {
  const root = await tempDir(t, "owl-api-test-setup-runner-");
  const checkout = join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  // The runner looks for the built permission hook under owlRoot; link the built tree instead of pointing at the repo's data/.
  for (const name of ["apps", "packages", "node_modules", "package.json"]) await symlink(join(REPO_ROOT, name), join(root, name));
  // Stands in for the claude CLI so no external provider is called.
  const executable = join(root, "fake-claude");
  const answer = JSON.stringify(JSON.stringify(READY));
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    `process.stdin.on("end", () => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${answer} }) + "\\n"));`,
    "",
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  // The runner refuses to start without HOME; Core runs this file without one, so the test supplies its own.
  const keys = ["OWL_PROVIDER", "OWL_CLAUDE_EXECUTABLE", "HOME"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  process.env.OWL_PROVIDER = "real";
  process.env.OWL_CLAUDE_EXECUTABLE = executable;
  process.env.HOME = root;
  const runner = await createExternalAgentRunner(root, false);
  const result = await runner.runTestSetupInvestigation({
    invocation_id: "inv-manual",
    project: { id: "p", name: "p" },
    scope: "project",
    checkout,
    trigger: "manual",
    mode: "find",
    explicit_test_run: null,
    first_candidate: null,
    current: null,
    failure: null,
    approved_installs: [],
    bootstrap: {},
    role: "worker",
    timeout_ms: 20_000,
    env: {},
  });
  assert.equal(result.ok, true, String(result.error));
  assert.equal(result.investigation.verdict, "ready");
});
