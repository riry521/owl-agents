import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { buildArgv } from "../../packages/agent-runtime/dist/provider.js";
import { buildStartArgv } from "../../packages/agent-runtime/dist/advisor-session-driver.js";
import { buildWorkArgv } from "../../packages/providers/dist/argv.js";
import { argv as executorArgv } from "../../packages/core/dist/executor.js";
import { tempDir } from "../helpers/temp.mjs";

const CWD = "/work/a";

async function withInstalled(t, entries, run) {
  const home = await tempDir(t, "owl-sp-launch-");
  {
    const plugins = {};
    for (const [name, scope, projectPath, version] of entries) {
      const path = join(home, ".claude", "plugins", "cache", name, version);
      await mkdir(join(path, ".claude-plugin"), { recursive: true });
      await mkdir(join(path, "skills"), { recursive: true });
      await writeFile(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superpowers" }));
      await writeFile(join(path, "skills", "marker.md"), name);
      (plugins[`superpowers@${name}`] ??= []).push({ scope, ...(projectPath ? { projectPath } : {}), installPath: path, version });
    }
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
    return await run({ CLAUDE_CONFIG_DIR: join(home, ".claude"), HOME: home, OWL_CLAUDE_EXECUTABLE: "/bin/claude" });
  }
}

const launches = {
  provider: (env) => buildArgv({ adapter: "claude-cli/v1", role: "worker", model: "m", cwd: CWD, env }),
  advisor: (env) => buildStartArgv({ cwd: CWD, env, model: "m", system_prompt: "s" }, "/bin/claude", "id"),
  providers: (env) => buildWorkArgv({ adapter: "claude-cli/v1", executablePath: "/bin/claude" }, "m", "p", { env, cwd: CWD }),
  executor: (env) => executorArgv({ provider: "claude", model: "m" }, { owlRoot: process.cwd(), env, executables: {} }, CWD),
};

async function marker(args) {
  const i = args.indexOf("--plugin-dir");
  return i < 0 ? null : readFile(join(args[i + 1], "skills", "marker.md"), "utf8");
}

for (const [name, launch] of Object.entries(launches)) {
  test(`${name} launch skips superpowers installed for another project`, async (t) => {
    const other = ["other", "project", "/work/other", "9.0.0"];
    const mine = ["mine", "project", CWD, "7.0.0"];
    const user = ["user", "user", undefined, "6.0.0"];
    assert.equal(await withInstalled(t, [other, mine, user], async (env) => marker(launch(env))), "user");
    assert.equal(await withInstalled(t, [other, mine], async (env) => marker(launch(env))), "mine");
    assert.equal(await withInstalled(t, [other, user], async (env) => marker(launch(env))), "user");
    assert.equal(await withInstalled(t, [other], async (env) => marker(launch(env))), null);
  });
}
