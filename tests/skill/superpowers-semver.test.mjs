import assert from "node:assert/strict";
import { mkdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { detectProcessSkillsPack } from "../../packages/core/dist/process-skills-pack.js";
import { buildAgentPermissionArgs } from "../../packages/shared/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

const REQUIRED_SKILLS = ["brainstorming", "test-driven-development", "verification-before-completion"];

async function makePlugin(root, version) {
  const installPath = join(root, "cache", version);
  await mkdir(join(installPath, ".claude-plugin"), { recursive: true });
  await writeFile(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superpowers", version }));
  for (const skill of REQUIRED_SKILLS) {
    await mkdir(join(installPath, "skills", skill), { recursive: true });
    await writeFile(join(installPath, "skills", skill, "SKILL.md"), `# ${skill}\n`);
  }
  return { scope: "user", installPath, version };
}

test("superpowers --plugin-dir picks the same version as process-skills with stable and prerelease mixed", async (t) => {
  const home = await tempDir(t, "owl-superpowers-semver-");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const versions = ["6.4.1-beta.1", "6.4.1", "6.4.0"];
    const entries = [];
    for (const version of versions) entries.push(await makePlugin(home, version));
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "superpowers@m": entries } }),
    );
    await mkdir(join(home, "apps", "server", "dist"), { recursive: true });
    await writeFile(join(home, "apps", "server", "dist", "permission-hook.js"), "");
    const env = { HOME: home };

    const pack = detectProcessSkillsPack({ settings: { enabled: true, path: null }, env, homedir: home });
    const args = buildAgentPermissionArgs("executor", "claude", { owlRoot: home, env, cwd: home });
    const view = args[args.indexOf("--plugin-dir") + 1];

    assert.equal(pack.version, "6.4.1");
    assert.equal(await readlink(join(view, "skills")), join(home, "cache", pack.version, "skills"));

  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
