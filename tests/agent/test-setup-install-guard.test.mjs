import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_TEST_SETUP_SETTINGS } from "../../packages/shared/dist/test-setup-settings.js";
import { RuleStore } from "../../packages/core/dist/rule-store.js";
import { classifyInstallCommand, execInstallQuery, gatedTestRunner, outsideWriteTargets, resolveInstallTarget } from "../../packages/core/dist/test-setup-install-guard.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const SETTINGS = DEFAULT_TEST_SETUP_SETTINGS.install;
const EXECUTABLE = "#!/bin/sh\nexit 0\n";

/** A Project folder and a folder outside it, both temporary; `python3` is an executable file in `outside/bin`. */
async function sandbox(t) {
  const base = await tempDir(t, "owl-install-guard-");
  const proj = path.join(base, "proj");
  const outside = path.join(base, "outside");
  await mkdir(proj, { recursive: true });
  await mkdir(path.join(outside, "bin"), { recursive: true });
  for (const name of ["python3", "python"]) {
    await writeFile(path.join(outside, "bin", name), EXECUTABLE);
    await chmod(path.join(outside, "bin", name), 0o755);
  }
  return { base, proj, outside, bin: path.join(outside, "bin") };
}

/** A query that answers from a table keyed by the argv tail it is asked; anything else fails. */
function stubQuery(answers) {
  const asked = [];
  const query = async (argv) => {
    asked.push(argv.join(" "));
    const key = Object.keys(answers).find((candidate) => argv.join(" ").includes(candidate));
    if (key === undefined) return { exit_code: null, stdout: "" };
    const answer = answers[key];
    return typeof answer === "string" ? { exit_code: 0, stdout: answer } : answer;
  };
  return { query, asked };
}

const PIP_OK = (prefix) => ({ "sys.prefix": JSON.stringify([prefix, "/usr/local"]), "pip config list": "" });
const NPM_OK = { "config get global": "false\n", "config get location": "user\n" };

function context(box, over = {}) {
  return { cwd: box.proj, roots: [box.proj], env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.base, UV_PYTHON_DOWNLOADS: "never" }, approved: [], settings: SETTINGS, query: stubQuery({}).query, ...over };
}

const scopeOf = async (command, ctx) => (await classifyInstallCommand(command, ctx)).scope;

test("resolveInstallTarget follows symlinks, missing folders and dangling links", async (t) => {
  const box = await sandbox(t);
  await symlink(box.outside, path.join(box.proj, "linked"));
  await symlink(path.join(box.base, "nowhere"), path.join(box.proj, "dangling"));
  assert.equal(resolveInstallTarget(".venv", box.proj, [box.proj]), "inside");
  assert.equal(resolveInstallTarget("a/b/c", box.proj, [box.proj]), "inside");
  assert.equal(resolveInstallTarget("linked/x", box.proj, [box.proj]), "outside");
  assert.equal(resolveInstallTarget("dangling/x", box.proj, [box.proj]), "outside");
  assert.equal(resolveInstallTarget("missing/../../x", box.proj, [box.proj]), "outside");
  assert.equal(resolveInstallTarget(box.outside, box.proj, [box.proj]), "outside");
  assert.equal(resolveInstallTarget("x", "__OWL_UNKNOWN_CWD__", [box.proj]), "outside");
});

test("an install into a venv whose python links outside is inside; a venv created at a missing .venv is inside", async (t) => {
  const box = await sandbox(t);
  await mkdir(path.join(box.proj, ".venv", "bin"), { recursive: true });
  await symlink(path.join(box.bin, "python3"), path.join(box.proj, ".venv", "bin", "python"));
  const { query } = stubQuery(PIP_OK(path.join(box.proj, ".venv")));
  const ctx = context(box, { query });
  assert.equal(await scopeOf(".venv/bin/python -m pip install pytest", ctx), "inside");
  assert.equal(await scopeOf([".venv/bin/python", "-m", "pip", "install", "-q", "pytest"], ctx), "inside");
  const fresh = await sandbox(t);
  assert.equal(await scopeOf("python3 -m venv .venv", context(fresh)), "inside");
});

test("a venv or node_modules that is a symlink to the outside is outside", async (t) => {
  const box = await sandbox(t);
  await symlink(box.outside, path.join(box.proj, ".venv"));
  await symlink(box.outside, path.join(box.proj, "node_modules"));
  assert.equal(await scopeOf("python3 -m venv .venv", context(box)), "outside");
  assert.equal(await scopeOf("npm install", context(box, { query: stubQuery(NPM_OK).query })), "outside");
  const fine = await sandbox(t);
  assert.equal(await scopeOf("npm install", context(fine, { query: stubQuery(NPM_OK).query })), "inside");
});

test("pip installs that leave the venv are outside", async (t) => {
  const box = await sandbox(t);
  await mkdir(path.join(box.proj, ".venv", "bin"), { recursive: true });
  await symlink(path.join(box.bin, "python3"), path.join(box.proj, ".venv", "bin", "python"));
  const venv = path.join(box.proj, ".venv");
  const ctx = (answers = PIP_OK(venv), over = {}) => context(box, { query: stubQuery(answers).query, ...over });
  const pip = ".venv/bin/python -m pip install pytest";
  for (const flags of [`--target ${box.outside}`, `--prefix=${box.outside}`, `--root ${box.outside}`, "--user", "--break-system-packages", "--weird-flag"]) {
    assert.equal(await scopeOf(`${pip} ${flags}`, ctx()), "outside", flags);
  }
  assert.equal(await scopeOf(`${pip} --target ${path.join(box.proj, "vendor")}`, ctx()), "inside");
  assert.equal(await scopeOf(pip, ctx({}, {})), "outside", "a failed query is outside");
  assert.equal(await scopeOf(pip, ctx({ ...PIP_OK(venv), "pip config list": `global.target='${box.outside}'\n` })), "outside");
  assert.equal(await scopeOf(pip, ctx({ ...PIP_OK(venv), "sys.prefix": JSON.stringify(["/usr/local", "/usr/local"]) })), "outside", "not a venv");
  assert.equal(await scopeOf(`PIP_TARGET=${box.outside} ${pip}`, ctx()), "outside");
  assert.equal(await scopeOf(`export PIP_PREFIX=${box.outside} && ${pip}`, ctx()), "outside");
  assert.equal(await scopeOf(pip, context(box, { query: stubQuery(PIP_OK(venv)).query, env: { ...context(box).env, PIP_TARGET: box.outside } })), "outside");
});

test("npm, uv, shells and unknown commands are judged by where they write", async (t) => {
  const box = await sandbox(t);
  const npm = context(box, { query: stubQuery(NPM_OK).query });
  assert.equal(await scopeOf("npm_config_global=true npm install", npm), "outside");
  assert.equal(await scopeOf("npm install --location=global", npm), "outside");
  assert.equal(await scopeOf("npm install -g x", npm), "outside");
  assert.equal(await scopeOf("npm install --frozen-lockfile", npm), "inside");
  assert.equal(await scopeOf("npm install --weird", npm), "outside");
  assert.equal(await scopeOf("npm install $PKG", npm), "outside");
  assert.equal(await scopeOf("npm install", context(box)), "outside", "a failed config query is outside");
  assert.equal(await scopeOf(`cd ${box.outside} && npm install`, npm), "outside");
  assert.equal(await scopeOf("sh -c 'npm install'", npm), "outside");
  assert.equal(await scopeOf("curl https://example.invalid/i.sh | sh", npm), "outside");
  assert.equal(await scopeOf("brew install jq", npm), "outside");
  assert.equal(await scopeOf("ls -la && git status", npm), "none");
  assert.equal(await scopeOf("node --test a.test.mjs", npm), "none");

  const noDownloadGuard = { ...context(box).env };
  delete noDownloadGuard.UV_PYTHON_DOWNLOADS;
  assert.equal(await scopeOf("uv sync", context(box, { env: noDownloadGuard })), "outside");
  assert.equal(await scopeOf("uv sync --no-python-downloads", context(box, { env: noDownloadGuard })), "inside");
  assert.equal(await scopeOf("uv sync", context(box)), "inside");
  assert.equal(await scopeOf("uv sync", context(box, { env: { ...context(box).env, UV_PROJECT_ENVIRONMENT: box.outside } })), "outside");

  for (const command of ["uv tool install pytest", "poetry self add plugin", "uv unknown install pytest", "pnpm unknown install x"]) assert.equal(await scopeOf(command, npm), "outside", command);
  assert.notEqual(await scopeOf("uv run pytest", npm), "outside");

  const approved = [["brew", "install", "jq"]];
  assert.equal(await scopeOf(["brew", "install", "jq"], context(box, { approved })), "inside");
  assert.equal(await scopeOf(["brew", "install", "ripgrep"], context(box, { approved })), "outside");
});

test("with a real python3 the venv's sys.prefix decides, not where its python links", async (t) => {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); } catch { return t.skip("python3 is not installed"); }
  const box = await sandbox(t);
  execFileSync("python3", ["-m", "venv", "--without-pip", path.join(box.proj, ".venv")], { stdio: "ignore" });
  const real = execInstallQuery(30_000);
  const query = (argv, cwd, env) => (argv.includes("config") ? Promise.resolve({ exit_code: 0, stdout: "" }) : real(argv, cwd, env));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: box.base };
  assert.equal(await scopeOf(".venv/bin/python -m pip install pytest", context(box, { env, query })), "inside");
  assert.equal(await scopeOf("python3 -m pip install pytest", context(box, { env, query })), "outside", "the system python is not a venv");
});

/** The guard endpoint with a registered investigation, an unregistered Worker, and the denial event. */
test("guard/check denies a registered investigation's outside installs and writes, and nobody else's", async (t) => {
  const box = await sandbox(t);
  const { core, db, root } = await createTestCore(t, { version: "test-setup-guard" }, { prefix: "owl-test-setup-guard-" });
  const guardTokens = GuardTokenRegistry.open(path.join(root, "guard-tokens"));
  const ruleStore = new RuleStore(root);
  await ruleStore.ensureDirectories();
  await ruleStore.load();
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir: root, ruleStore, guardTokens });
  if (!api) return t.skip("localhost listen is unavailable");
  const unregister = core.registerTestSetupRun("run-investigation", {
    project_id: "P1",
    roots: [box.proj],
    env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.base },
    approved: [["brew", "install", "jq"]],
    installs: [],
  });
  const check = async (runId, toolName, toolInput) => {
    const lease = guardTokens.issue({ agent_run_id: runId, role: "worker" });
    const token = (await readFile(lease.file, "utf8")).trim();
    const response = await fetch(`${api.baseUrl}/api/v1/guard/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ request_id: "r", idempotency_key: "k", expected_version: 0, payload: { role: "worker", tool_name: toolName, tool_input: toolInput, cwd: box.proj } }),
    });
    lease.release();
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const bash = (runId, command) => check(runId, "Bash", { command });

  for (const command of ["sudo brew install ripgrep", `echo x > ${path.join(box.outside, "f")}`, `echo x | tee ${path.join(box.outside, "f")}`]) {
    const denied = await bash("run-investigation", command);
    assert.equal(denied.allowed, false, command);
    assert.equal(denied.rule_id, "test-setup-install", command);
  }
  for (const toolInput of [{ file_path: path.join(box.outside, "f"), content: "x" }]) {
    const denied = await check("run-investigation", "Write", toolInput);
    assert.equal(denied.rule_id, "test-setup-install");
  }

  for (const command of ["brew install ripgrep", "npm install -g typescript", "uv tool install pytest", "pip install --user x"]) assert.equal((await bash("run-investigation", command)).allowed, true, `${command} is let through`);
  assert.equal((await bash("run-investigation", "brew install jq")).allowed, true, "an approved argv passes");
  assert.equal((await bash("run-investigation", "ls -la && git status")).allowed, true);
  assert.equal((await bash("run-investigation", "echo x > out.txt 2>/dev/null")).allowed, true);
  assert.equal((await check("run-investigation", "Write", { file_path: path.join(box.proj, "f"), content: "x" })).allowed, true);
  assert.notEqual((await check("run-investigation", "Read", { file_path: path.join(box.outside, "f") })).rule_id, "test-setup-install", "reads are not this guard's concern");

  assert.notEqual((await bash("run-other-worker", "sudo brew install ripgrep")).rule_id, "test-setup-install", "an unregistered run is not judged");
  assert.notEqual((await bash("run-other-worker", `echo x > ${path.join(box.outside, "f")}`)).rule_id, "test-setup-install");

  const events = db.all("SELECT payload_json FROM events WHERE type = 'test_setup.install_denied'").map((row) => JSON.parse(row.payload_json));
  assert.equal(events.length, 4);
  assert.ok(events.every((payload) => payload.invocation_id === "run-investigation" && payload.project_id === "P1" && typeof payload.reason === "string"));

  unregister();
  assert.notEqual((await bash("run-investigation", "sudo brew install ripgrep")).rule_id, "test-setup-install", "after unregister the run is judged no more");
});

test("checkTestSetupTool judges pip installs through the query it is given", async (t) => {
  const box = await sandbox(t);
  const { core } = await createTestCore(t, { version: "test-setup-guard-pip" }, { prefix: "owl-test-setup-guard-pip-" });
  await mkdir(path.join(box.proj, ".venv", "bin"), { recursive: true });
  await symlink(path.join(box.bin, "python3"), path.join(box.proj, ".venv", "bin", "python"));
  const installs = [];
  core.registerTestSetupRun("run-pip", { project_id: "P1", roots: [box.proj], env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.base }, approved: [], installs });
  const check = async (i) => { const r = await core.checkTestSetupTool(i); if (!r.denied) core.recordTestSetupInstalls("run-pip", r.installs); return r; };
  const input = (command, query) => ({ agent_run_id: "run-pip", tool_name: "Bash", tool_input: { command }, cwd: box.proj, query });
  const venv = path.join(box.proj, ".venv");
  assert.equal((await check(input(".venv/bin/python -m pip install pytest", stubQuery(PIP_OK(venv)).query))).denied, false);
  assert.deepEqual(installs, [], "an install inside the Project is not recorded");
  assert.equal((await check(input(`.venv/bin/python -m pip install --target ${box.outside} pytest`, stubQuery(PIP_OK(venv)).query))).denied, false);
  assert.equal((await check(input(".venv/bin/python -m pip install pytest", stubQuery({}).query))).denied, false);
  assert.equal(installs.length, 2, "installs whose target is outside or unknown are recorded");
});

test("env -C and nested cd move the working directory; approved commands cover their nested text; unknown venv and poetry flags are outside", async (t) => {
  const box = await sandbox(t);
  const npm = context(box, { query: stubQuery(NPM_OK).query });
  assert.equal(await scopeOf(`env -C ${box.outside} npm install`, npm), "outside");
  assert.equal(await scopeOf(`env --chdir=${box.outside} npm install`, npm), "outside");
  assert.equal(await scopeOf(`env -C ${box.proj} npm install`, npm), "inside");
  const approved = [["sh", "-c", "brew install jq"]];
  assert.equal(await scopeOf(["sh", "-c", "brew install jq"], context(box, { approved })), "inside");
  assert.equal(await scopeOf(["sh", "-c", "brew install wget"], context(box, { approved })), "outside");
  assert.equal(await scopeOf("python3 -m venv --unknown .venv", context(box)), "outside");
  assert.equal(await scopeOf("uv venv --unknown .venv", context(box)), "outside");
  assert.equal(await scopeOf("poetry install --unknown", context(box)), "outside");
});

test("outsideWriteTargets places writes after env -C and inside nested cd", async (t) => {
  const box = await sandbox(t);
  const input = { cwd: box.proj, roots: [box.proj], writable: [] };
  assert.equal(outsideWriteTargets(`sh -c 'cd ${box.outside}; echo x > file'`, input).length, 1);
  assert.equal(outsideWriteTargets(`sh -c 'cd ${box.outside}; echo x | tee file'`, input).length, 1);
  assert.equal(outsideWriteTargets(`env -C ${box.outside} tee file`, input).length, 1);
  assert.equal(outsideWriteTargets("sh -c 'echo x > file'", input).length, 0);
});

test("approval covers only the nested text of the approved parent; env -i / -u drop the environment; redirects use the calling shell's directory", async (t) => {
  const box = await sandbox(t);
  const approved = [["echo", "brew install jq"]];
  assert.equal(await scopeOf(`echo "brew install jq"; sh -c "brew install jq"`, context(box, { approved })), "outside");
  const both = [["sh", "-c", "brew install jq"]];
  assert.equal(await scopeOf(`sh -c "brew install jq"; bash -c "brew install jq"`, context(box, { approved: both })), "outside");
  const uv = context(box, { env: { PATH: process.env.PATH ?? "", UV_PYTHON_DOWNLOADS: "never" }, query: stubQuery({}).query });
  assert.equal(await scopeOf("uv sync", uv), "inside");
  assert.equal(await scopeOf("env -i uv sync", uv), "outside");
  assert.equal(await scopeOf("env -u UV_PYTHON_DOWNLOADS uv sync", uv), "outside");
  const input = { cwd: box.proj, roots: [box.proj], writable: [] };
  assert.equal(outsideWriteTargets(`env -C ${box.outside} sh -c "echo x > file"`, input).length, 1);
  assert.equal(outsideWriteTargets(`cd ${box.outside}; env -C ${box.proj} echo x > file`, input).length, 1);
});

test("env -uNAME joins the value, uv global options are read before the subcommand, and >& / &> are writes while >&2 is not", async (t) => {
  const box = await sandbox(t);
  const uv = context(box, { env: { PATH: process.env.PATH ?? "", UV_PYTHON_DOWNLOADS: "never" } });
  assert.equal(await scopeOf("env -uUV_PYTHON_DOWNLOADS uv sync", uv), "outside");
  assert.equal(await scopeOf(`uv --directory ${box.outside} sync`, uv), "outside");
  assert.equal(await scopeOf(`uv --directory ${box.proj} --no-python-downloads sync`, uv), "inside");
  assert.equal(await scopeOf("uv --unknown-option sync", uv), "outside");
  const input = { cwd: box.proj, roots: [box.proj], writable: [] };
  const target = path.join(box.outside, "out");
  assert.equal(outsideWriteTargets(`echo x >& ${target}`, input).length, 1);
  assert.equal(outsideWriteTargets(`echo x &> ${target}`, input).length, 1);
  assert.equal(outsideWriteTargets(`echo x >| ${target}`, input).length, 1);
  assert.equal(outsideWriteTargets("echo x >&2", input).length, 0);
  assert.equal(outsideWriteTargets("echo x 2>&1", input).length, 0);
});

test("the tool names the classifier uses come from the settings", async (t) => {
  const box = await sandbox(t);
  const ctx = context(box, { env: { PATH: process.env.PATH ?? "", UV_PYTHON_DOWNLOADS: "never" } });
  assert.equal(await scopeOf("fastpkg sync", ctx), "outside");
  const renamed = { ...SETTINGS, names: { ...SETTINGS.names, uv: "fastpkg" }, neutral_flags: { ...SETTINGS.neutral_flags, fastpkg: SETTINGS.neutral_flags.uv }, path_flags: { ...SETTINGS.path_flags, fastpkg: SETTINGS.path_flags.uv }, target_env: { ...SETTINGS.target_env, fastpkg: SETTINGS.target_env.uv } };
  assert.equal(await scopeOf("fastpkg sync", { ...ctx, settings: renamed }), "inside");
  assert.equal(await scopeOf(`fastpkg --directory ${box.outside} sync`, { ...ctx, settings: renamed }), "outside");
});

test("unknown node options before the subcommand are outside, uv venv follows --directory, and a CLI flag stops uv's Python download", async (t) => {
  const box = await sandbox(t);
  const ctx = context(box, { env: { PATH: process.env.PATH ?? "" }, query: stubQuery(NPM_OK).query });
  assert.equal(await scopeOf("npm --unknown-option value install", ctx), "outside");
  assert.equal(await scopeOf("pnpm --unknown-option value add foo", ctx), "outside");
  assert.equal(await scopeOf(`uv --directory ${box.outside} venv --no-python-downloads .venv`, ctx), "outside");
  assert.equal(await scopeOf(`uv --directory ${box.proj} --no-python-downloads sync`, ctx), "inside");
});

test("uv --directory moves relative targets apart from --project, poetry --directory moves the environment query, and pip's front options are read", async (t) => {
  const box = await sandbox(t);
  const base = { env: { PATH: process.env.PATH ?? "" } };
  assert.equal(await scopeOf(`uv --directory ${box.outside} --project ${box.proj} venv --no-python-downloads .venv`, context(box, base)), "outside");
  assert.equal(await scopeOf(`uv --directory ${box.proj} --project ${box.outside} venv --no-python-downloads .venv`, context(box, base)), "inside");
  const byCwd = async (argv, cwd) => (argv[0] === "poetry" ? { exit_code: 0, stdout: path.join(cwd, ".venv") } : { exit_code: 1, stdout: "" });
  assert.equal(await scopeOf("poetry run pytest", context(box, { ...base, query: byCwd })), "none");
  assert.equal(await scopeOf(`poetry --directory ${box.outside} run pytest`, context(box, { ...base, query: byCwd })), "outside");
  const byPython = async (argv) => argv.includes("config") ? { exit_code: 0, stdout: "" } : { exit_code: 0, stdout: JSON.stringify([argv[0].startsWith(box.proj) ? box.proj : box.outside, "/usr/local"]) };
  const pipPython = path.join(box.proj, "python");
  await writeFile(pipPython, EXECUTABLE);
  await chmod(pipPython, 0o755);
  const pip = context(box, { env: { PATH: `${box.proj}:${box.bin}` }, query: byPython });
  assert.equal(await scopeOf("python -m pip install pytest", pip), "inside");
  assert.equal(await scopeOf(`pip --python ${path.join(box.bin, "python3")} install pytest`, pip), "outside");
  assert.equal(await scopeOf("pip --unknown-option value install pytest", pip), "outside");
});

test("reading commands are not installs, -e takes its source from anywhere, and Mac-wide installs run, are recorded and only credentials are refused", async (t) => {
  const box = await sandbox(t);
  const ctx = context(box, { query: stubQuery(NPM_OK).query });
  for (const command of ["/opt/homebrew/bin/bun --version", "bun --version", "npm --version", "python3 --version", "which bun", "brew --version", "brew list", "brew -v", "brew --verbose list", "pipx --version", "yarn --version", "yarn -v", "yarn --help", "yarn -h"]) assert.equal(await scopeOf(command, ctx), "none", command);
  for (const command of ["brew -v install jq", "pipx -v install black", "brew --unknown list"]) assert.equal(await scopeOf(command, ctx), "outside", `${command} is read by its own flags and subcommand`);
  assert.equal(await scopeOf("bun --unknown-option install x", ctx), "outside", "an unknown flag in front of a real install stays an install");
  for (const command of ["yarn", "yarn --frozen-lockfile", "yarn install", "yarn --version --frozen-lockfile"]) assert.notEqual(await scopeOf(command, ctx), "none", `${command} still installs`);

  await mkdir(path.join(box.proj, ".venv", "bin"), { recursive: true });
  await symlink(path.join(box.bin, "python3"), path.join(box.proj, ".venv", "bin", "python"));
  const source = path.join(box.outside, "pkg");
  const pip = context(box, { query: stubQuery(PIP_OK(path.join(box.proj, ".venv"))).query });
  assert.equal(await scopeOf(`.venv/bin/python -m pip install -e ${source}`, pip), "inside");
  assert.equal(await scopeOf(`.venv/bin/python -m pip install --editable=${source}`, pip), "inside");
  assert.equal(await scopeOf(`.venv/bin/python -m pip install -e ${source} --target ${box.outside}`, pip), "outside");

  for (const command of ["(pnpm install --frozen-lockfile --silent 2>&1)", "pnpm install --frozen-lockfile --silent 2>&1 | tail -5"]) {
    const result = await classifyInstallCommand(command, context(box, { query: stubQuery(NPM_OK).query }));
    assert.equal(result.segments[0].argv.join(" "), "pnpm install --frozen-lockfile --silent", command);
    assert.notEqual(result.scope, "outside", `${command}: ${result.segments[0].reason}`);
  }
  const mac = await classifyInstallCommand("(brew install jq 2>&1)", ctx);
  assert.deepEqual(mac.segments.map((seg) => [seg.argv.join(" "), seg.scope]), [["brew install jq", "outside"]]);

  const quoted = await classifyInstallCommand(["npm", "install", "--prefix", `${box.proj})`], context(box, { query: stubQuery(NPM_OK).query }));
  assert.equal(quoted.segments[0].argv.at(-1), `${box.proj})`);
  assert.equal(quoted.scope, "outside");
  assert.equal((await classifyInstallCommand("brew install 'pkg)'", ctx)).segments[0].argv.at(-1), "pkg)");
  assert.deepEqual((await classifyInstallCommand("(brew install ')')", ctx)).segments[0].argv, ["brew", "install", ")"]);
  const piped = await classifyInstallCommand("(brew install jq 2>&1 | brew install y)", ctx);
  assert.deepEqual(piped.segments.map((seg) => seg.argv), [["brew", "install", "jq"], ["brew", "install", "y"]]);

  const sudo = await classifyInstallCommand("sudo brew install jq", ctx);
  assert.equal(sudo.segments[0].denied, true);
  assert.equal((await classifyInstallCommand("brew install jq", ctx)).segments[0].denied, undefined);

  const calls = [];
  const run = async (argv) => { calls.push(argv.join(" ")); return { exit_code: 0, timed_out: false, stdout: "", stderr: "", duration_ms: 0 }; };
  const seen = [];
  const gated = gatedTestRunner(run, { gate: "all", roots: () => [box.proj], env: ctx.env, approved: [], settings: SETTINGS, query: ctx.query, onInstall: (argv) => seen.push(argv.join(" ")) });
  assert.equal((await gated(["bun", "--version"], box.proj, 1000, 1000)).error, undefined);
  assert.equal((await gated(["brew", "install", "jq"], box.proj, 1000, 1000)).error, undefined);
  assert.match((await gated(["sudo", "brew", "install", "jq"], box.proj, 1000, 1000)).error, /^install_needs_approval/u);
  assert.match((await gated(["sh", "-c", "brew install x; sudo brew install y"], box.proj, 1000, 1000)).error, /^install_needs_approval/u);
  assert.deepEqual(calls, ["bun --version", "brew install jq"]);
  assert.deepEqual(seen, ["brew install jq"]);

  const { core } = await createTestCore(t, { version: "test-setup-guard-mac" }, { prefix: "owl-test-setup-guard-mac-" });
  const installs = [];
  core.registerTestSetupRun("run-mac", { project_id: "P1", roots: [box.proj], env: ctx.env, approved: [], installs });
  const check = async (command) => { const r = await core.checkTestSetupTool({ agent_run_id: "run-mac", tool_name: "Bash", tool_input: { command }, cwd: box.proj, query: ctx.query }); if (!r.denied) core.recordTestSetupInstalls("run-mac", r.installs); return r; };
  assert.equal((await check("brew install jq")).denied, false);
  assert.equal((await check("pnpm add -g x")).denied, false);
  assert.equal((await check("sudo brew install jq")).denied, true);
  assert.equal((await check(`echo x > ${path.join(box.outside, "f")}`)).denied, true);
  assert.deepEqual(installs.map((argv) => argv.join(" ")), ["brew install jq", "pnpm add -g x"]);
});
