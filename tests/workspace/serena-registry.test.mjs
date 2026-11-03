import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { createRequire } from "node:module";

import { WorkspaceTooling } from "../../packages/core/dist/workspace-tooling.js";
import { editSerenaConfig, pruneMissingSerenaProjects, readRegisteredProjects, registerSerenaProject, removeRegisteredProjects, serenaConfigPath, unregisterSerenaProject } from "../../packages/core/dist/serena-registry.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";

// yaml is a dependency of @owl/core only, so resolve it from there.
const { parse } = createRequire(new URL("../../packages/core/package.json", import.meta.url))("yaml");

const CONFIG ="# keep this comment\nlanguage_backend: LSP\nprojects:\n- /other/one\n- /other/two\nline_ending: native\n";

async function setup(t, { config = CONFIG } = {}) {
  const home = await tempDir(t, "owl-serena-");
  const serenaHome = join(home, "custom");
  await mkdir(serenaHome, { recursive: true });
  const configPath = join(serenaHome, "serena_config.yml");
  if (config !== null) await writeFile(configPath, config);
  return { home, serenaHome, configPath };
}

async function worktree(dir, name, { serena = true } = {}) {
  const path = join(dir, name);
  await mkdir(join(path, ".serena"), { recursive: true });
  if (serena) await writeFile(join(path, ".serena", "project.yml"), "project_name: x\n");
  return path;
}

const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

test("concurrent registrations keep the config readable as YAML and register every worktree", async (t) => {
  const { home, configPath } = await setup(t);
  const trees = await Promise.all(Array.from({ length: 8 }, (_, i) => worktree(home, `wt-${i}`)));
  let reading = true;
  let reads = 0;
  const reader = (async () => {
    while (reading) {
      const parsed = parse(await readFile(configPath, "utf8"));
      assert.ok(Array.isArray(parsed.projects));
      reads += 1;
    }
  })();
  await Promise.all(trees.map((tree) => registerSerenaProject(configPath, tree)));
  reading = false;
  await reader;
  assert.ok(reads > 0);
  const parsed = parse(await readFile(configPath, "utf8"));
  for (const tree of trees) assert.ok(parsed.projects.includes(tree));
  assert.equal(parsed.projects.length, 10);
});

test("registering an already registered worktree does not touch the config", async (t) => {
  const { home, configPath } = await setup(t);
  const tree = await worktree(home, "wt");
  assert.equal(await registerSerenaProject(configPath, tree), true);
  const hash = await digest(configPath);
  const { mtimeMs } = await stat(configPath);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await registerSerenaProject(configPath, tree), false);
  assert.equal(await digest(configPath), hash);
  assert.equal((await stat(configPath)).mtimeMs, mtimeMs);
});

test("unregistering removes only that worktree and keeps other entries, keys and their order", async (t) => {
  const { home, configPath } = await setup(t);
  const tree = await worktree(home, "wt");
  await registerSerenaProject(configPath, tree);
  assert.equal(await unregisterSerenaProject(configPath, tree), true);
  assert.equal(await readFile(configPath, "utf8"), CONFIG);
});

test("a missing config or a worktree without .serena/project.yml is left alone without error", async (t) => {
  const missing = await setup(t, { config: null });
  const tree = await worktree(missing.home, "wt");
  assert.equal(await registerSerenaProject(missing.configPath, tree), false);
  assert.equal(await unregisterSerenaProject(missing.configPath, tree), false);
  await assert.rejects(access(missing.configPath));

  const present = await setup(t);
  const bare = await worktree(present.home, "bare", { serena: false });
  const hash = await digest(present.configPath);
  assert.equal(await registerSerenaProject(present.configPath, bare), false);
  assert.equal(await unregisterSerenaProject(present.configPath, bare), false);
  assert.equal(await digest(present.configPath), hash);
});

test("a missing SERENA_HOME folder is not created and no lock file is left", async (t) => {
  const home = await tempDir(t, "owl-serena-");
  const tree = await worktree(home, "wt");
  const configPath = join(home, "absent", "serena_config.yml");
  assert.equal(await registerSerenaProject(configPath, tree), false);
  assert.equal(await unregisterSerenaProject(configPath, tree), false);
  await assert.rejects(access(join(home, "absent")));
  const noConfig = await setup(t, { config: null });
  await registerSerenaProject(noConfig.configPath, tree);
  await assert.rejects(access(`${noConfig.configPath}.lock`));
});

test("unregistering a registered worktree without .serena/project.yml leaves the config unchanged", async (t) => {
  const { home, configPath } = await setup(t);
  const bare = await worktree(home, "bare", { serena: false });
  await writeFile(configPath, CONFIG.replace("- /other/one", `- ${bare}\n- /other/one`));
  const hash = await digest(configPath);
  assert.equal(await unregisterSerenaProject(configPath, bare), false);
  assert.equal(await digest(configPath), hash);
});

test("the exported editSerenaConfig with readRegisteredProjects/removeRegisteredProjects removes any path and creates nothing when the config is missing", async (t) => {
  const { configPath } = await setup(t);
  const changed = await editSerenaConfig(configPath, (doc) => {
    assert.deepEqual(readRegisteredProjects(doc), ["/other/one", "/other/two"]);
    return removeRegisteredProjects(doc, ["/other/one"]);
  });
  assert.equal(changed, true);
  assert.equal(await readFile(configPath, "utf8"), CONFIG.replace("- /other/one\n", ""));

  const missing = await setup(t, { config: null });
  assert.equal(await editSerenaConfig(missing.configPath, (doc) => removeRegisteredProjects(doc, ["/x"])), false);
  await assert.rejects(access(missing.configPath));
  await assert.rejects(access(`${missing.configPath}.lock`));
});

test("a lock left by a dead process is reclaimed", async (t) => {
  const { home, configPath } = await setup(t);
  const tree = await worktree(home, "wt");
  await writeFile(`${configPath}.lock`, "2147483646:dead");
  assert.equal(await registerSerenaProject(configPath, tree), true);
  await assert.rejects(access(`${configPath}.lock`));
});

test("the config location follows SERENA_HOME, or the home's .serena when it is unset or empty", async (t) => {
  const { home, serenaHome, configPath } = await setup(t);
  assert.equal(serenaConfigPath({ SERENA_HOME: serenaHome }, "/unused"), configPath);
  const fallback = join(home, ".serena", "serena_config.yml");
  assert.equal(serenaConfigPath({}, home), fallback);
  assert.equal(serenaConfigPath({ SERENA_HOME: "" }, home), fallback);

  await mkdir(join(home, ".serena"));
  await writeFile(fallback, CONFIG);
  const tree = await worktree(home, "wt");
  await registerSerenaProject(serenaConfigPath({}, home), tree);
  assert.ok(parse(await readFile(fallback, "utf8")).projects.includes(tree));
  assert.ok(!parse(await readFile(configPath, "utf8")).projects.includes(tree));
});

test("preparing a new worktree registers it in Serena's saved form (a list of resolved paths) before returning", async (t) => {
  const { home, serenaHome, configPath } = await setup(t);
  const tree = await worktree(home, "wt");
  const tooling = new WorkspaceTooling({
    run: async () => ({ exit_code: 0, timed_out: false, stdout: "", stderr: "" }),
    env: () => ({ SERENA_HOME: serenaHome }),
    harnesses: () => [],
    home,
  });
  await tooling.prepareNewWorktree({ projectKey: "p", sourceRoot: home, worktree: tree, commands: { setup: null, refresh: null } });
  assert.deepEqual(parse(await readFile(configPath, "utf8")).projects, ["/other/one", "/other/two", tree]);
});

test("removing a worktree through Core's pre-removal hook unregisters it", async (t) => {
  const { home, serenaHome, configPath } = await setup(t);
  const tree = await worktree(home, "wt");
  const { core } = await createTestCore(t, { workspaceTooling: { env: () => ({ SERENA_HOME: serenaHome }), home } });
  await registerSerenaProject(configPath, tree);
  await core.git.removalHook(tree);
  assert.equal(await readFile(configPath, "utf8"), CONFIG);
});

test("pruning removes only registrations whose path is gone, and only when applied; nothing to remove leaves the file alone", async (t) => {
  const { home, configPath } = await setup(t, { config: null });
  const alive = await worktree(home, "alive");
  const gone = join(home, "gone");
  const config = `# keep\nlanguage_backend: LSP\nprojects:\n- ${gone}\n- ${alive}\nline_ending: native\n`;
  await writeFile(configPath, config);

  assert.deepEqual(await pruneMissingSerenaProjects(configPath, false), [gone]);
  assert.equal(await readFile(configPath, "utf8"), config);

  assert.deepEqual(await pruneMissingSerenaProjects(configPath, true), [gone]);
  assert.equal(await readFile(configPath, "utf8"), config.replace(`- ${gone}\n`, ""));

  const before = await digest(configPath);
  const { mtimeMs } = await stat(configPath);
  assert.deepEqual(await pruneMissingSerenaProjects(configPath, true), []);
  assert.equal(await digest(configPath), before);
  assert.equal((await stat(configPath)).mtimeMs, mtimeMs);
  await assert.rejects(access(`${configPath}.lock`));
});

test("pruning aborts without writing when a registered path cannot be inspected", async (t) => {
  const { home, configPath } = await setup(t, { config: null });
  const locked = join(home, "locked");
  await mkdir(locked);
  const config = `projects:\n- ${join(locked, "child")}\n- ${join(home, "gone")}\n`;
  await writeFile(configPath, config);
  if (process.getuid?.() === 0) return t.skip("root can inspect any path");
  await chmod(locked, 0o000);
  try {
    await assert.rejects(pruneMissingSerenaProjects(configPath, true), { code: "EACCES" });
  } finally {
    await chmod(locked, 0o700);
  }
  assert.equal(await readFile(configPath, "utf8"), config);
  await assert.rejects(access(`${configPath}.lock`));
});

test("the prune command lists by default and rewrites the config only with --apply, using SERENA_HOME", async (t) => {
  const { home, serenaHome, configPath } = await setup(t, { config: null });
  const gone = join(home, "gone");
  await writeFile(configPath, `projects:\n- ${gone}\n- /\n`);
  const script = new URL("../../scripts/serena-prune-missing.mjs", import.meta.url).pathname;
  const env = { ...process.env, SERENA_HOME: serenaHome };

  const listed = await promisify(execFile)(process.execPath, [script], { env });
  assert.ok(listed.stdout.includes(gone));
  assert.equal(await readFile(configPath, "utf8"), `projects:\n- ${gone}\n- /\n`);

  await promisify(execFile)(process.execPath, [script, "--apply"], { env });
  assert.equal(await readFile(configPath, "utf8"), "projects:\n- /\n");
});
