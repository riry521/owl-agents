import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, readlink, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentUserInstructionEnv, buildAgentPermissionArgs } from "../../packages/shared/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

async function withPermissionHook(t, run) {
  const root = await tempDir(t, "owl-permission-hook-");
  const hookPath = path.join(root, "apps", "server", "dist", "permission-hook.js");
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(hookPath, "", "utf8");
  return await run(root, hookPath);
}

async function withResearchHook(t, run) {
  const root = await tempDir(t, "owl-research-permission-hook-");
  const permissionHook = path.join(root, "apps", "server", "dist", "permission-hook.js");
  const researchHook = path.join(root, "apps", "server", "dist", "research-hook.js");
  await mkdir(path.dirname(permissionHook), { recursive: true });
  await writeFile(permissionHook, "", "utf8");
  await writeFile(researchHook, "", "utf8");
  return await run(root, researchHook);
}

async function withTemporaryHome(t, run) {
  const home = await tempDir(t, "owl-test-home-");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

test("only the Claude worker gets SubagentStart and SubagentStop hooks, next to the existing PreToolUse", async (t) => {
  await withPermissionHook(t, async (root) => {
    const subagentHook = path.join(root, "apps", "server", "dist", "subagent-hook.js");
    await writeFile(subagentHook, "", "utf8");
    const settingsFor = (role) => {
      const args = buildAgentPermissionArgs(role, "claude", { owlRoot: root });
      return JSON.parse(args[args.indexOf("--settings") + 1]);
    };
    const worker = settingsFor("worker");
    for (const name of ["SubagentStart", "SubagentStop"]) {
      const hook = worker.hooks[name][0].hooks[0];
      assert.equal(hook.type, "command");
      assert.ok(hook.command.includes(subagentHook));
      assert.ok(hook.timeout > 0 && hook.timeout <= 10);
    }
    assert.equal(worker.hooks.PreToolUse[0].matcher, "*");
    for (const role of ["advisor", "manager", "designer", "reviewer", "curator", "librarian"]) {
      const hooks = settingsFor(role).hooks;
      assert.equal(hooks.SubagentStart, undefined);
      assert.equal(hooks.SubagentStop, undefined);
    }
    const codex = buildAgentPermissionArgs("worker", "codex", { owlRoot: root });
    assert.ok(!codex.some((arg) => arg.includes("Subagent") || arg.includes("subagent-hook")));
  });
});

test("Claude worker omits the subagent hooks when the script is not built", async (t) => {
  await withPermissionHook(t, (root) => {
    const args = buildAgentPermissionArgs("worker", "claude", { owlRoot: root });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.equal(settings.hooks.SubagentStart, undefined);
  });
});

test("Claude roles use bypassPermissions with the PreToolUse policy hook on every tool", async (t) => {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    await withPermissionHook(t, (root, hookPath) => {
      const args = buildAgentPermissionArgs("advisor", "claude", { owlRoot: root });
      assert.deepEqual(args.slice(0, 2), ["--permission-mode", "bypassPermissions"]);
      assert.equal(args.filter((arg) => arg === "--settings").length, 1);
      const settings = JSON.parse(args[3]);
      assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
      assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(hookPath));
      assert.deepEqual(settings.claudeMdExcludes, [path.join(os.homedir(), ".claude", "CLAUDE.md")]);
      assert.equal(settings.autoMemoryEnabled, false);
    });
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
});

test("Claude settings use CLAUDE_CONFIG_DIR from the child environment for the exclude path", async (t) => {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "owl-process-claude-config");
  try {
    await withPermissionHook(t, (root) => {
      const configDir = path.join(os.tmpdir(), "owl-claude-config");
      const args = buildAgentPermissionArgs("worker", "claude", {
        owlRoot: root,
        env: { CLAUDE_CONFIG_DIR: configDir },
      });
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]);

      assert.deepEqual(settings.claudeMdExcludes, [path.join(configDir, "CLAUDE.md")]);
      assert.ok(settings.hooks.PreToolUse);
      assert.equal(args.filter((arg) => arg === "--settings").length, 1);
    });
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
});

test("Claude excludes the instruction file from the child environment, not the parent process", async (t) => {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "owl-parent-claude-config");
  try {
    await withPermissionHook(t, (root) => {
      const childHome = path.join(root, "agent-home");
      const args = buildAgentPermissionArgs("advisor", "claude", {
        owlRoot: root,
        env: { HOME: childHome },
      });
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]);

      assert.deepEqual(settings.claudeMdExcludes, [path.join(childHome, ".claude", "CLAUDE.md")]);
      assert.ok(settings.hooks.PreToolUse);
    });
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
});

test("Codex roles use full access with the PreToolUse policy hook on every tool", async (t) => {
  await withPermissionHook(t, async (root) => {
    const codexHome = await tempDir(t, "owl-codex-home-");
    const source = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(codexHome, "config.toml"), `[marketplaces.openai-bundled]\nsource = ${JSON.stringify(source)}\n`, "utf8");
    const args = buildAgentPermissionArgs("worker", "codex", {
      owlRoot: root,
      env: { CODEX_HOME: codexHome },
    });
    assert.deepEqual(args.slice(0, 5), ["--dangerously-bypass-hook-trust", "--sandbox", "danger-full-access", "--config", 'approval_policy="never"']);
    assert.ok(args.some((arg) => arg === `marketplaces.openai-bundled.source=${JSON.stringify(source)}`));
    assert.ok(args.includes("features.hooks=true"));
    assert.ok(args.includes("features.memories=false"));
    assert.ok(args.some((arg) => arg.includes("hooks.PreToolUse=[{matcher=\"*\",")));
    assert.ok(args.some((arg) => arg.includes("permission-hook.js")));
  });
});

test("Codex resume permissions set full access through config", async (t) => {
  await withPermissionHook(t, (root) => {
    const args = buildAgentPermissionArgs("worker", "codex", { owlRoot: root, resume: true });

    assert.deepEqual(args.slice(0, 3), [
      "--dangerously-bypass-hook-trust",
      "--config",
      'sandbox_mode="danger-full-access"',
    ]);
    assert.ok(!args.includes("--sandbox"));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes("features.hooks=true"));
    assert.ok(args.includes("features.memories=false"));
    assert.ok(args.some((arg) => arg.includes("hooks.PreToolUse=[{matcher=\"*\",")));
  });
});

test("Curator uses the shared PreToolUse permission hook role", async (t) => {
  await withPermissionHook(t, (root) => {
    for (const adapter of ["claude", "codex"]) {
      assert.doesNotThrow(() => buildAgentPermissionArgs("curator", adapter, { owlRoot: root }));
    }
  });
});

test("agent startup fails closed when Owl's permission hook has not been built", async (t) => {
  const root = await tempDir(t, "owl-missing-hook-");
  assert.throws(
    () => buildAgentPermissionArgs("advisor", "claude", { owlRoot: root }),
    /permission hook is missing/u,
  );
});

test("Codex instruction environment overlays CODEX_HOME while preserving other entries and excluding AGENTS files", async (t) => {
  await withTemporaryHome(t, async () => {
    const codexHome = await tempDir(t, "owl-codex-overlay-source-");
    let overlayHome;
    try {
      await writeFile(path.join(codexHome, "AGENTS.md"), "user instructions", "utf8");
      await writeFile(path.join(codexHome, "AGENTS.override.md"), "override instructions", "utf8");
      await writeFile(path.join(codexHome, "config.toml"), "[model]\nname = \"kept\"\n", "utf8");
      await writeFile(path.join(codexHome, ".hidden-file"), "kept", "utf8");
      await mkdir(path.join(codexHome, ".hidden-directory"));
      await mkdir(path.join(codexHome, "memories"));
      await mkdir(path.join(codexHome, "skills"));

      const childEnv = agentUserInstructionEnv("codex", { CODEX_HOME: codexHome });
      overlayHome = childEnv.CODEX_HOME;
      assert.ok(overlayHome);
      assert.ok(overlayHome.startsWith(path.join(os.homedir(), ".owl", "codex-home-overlays")));
      assert.notEqual(overlayHome, codexHome);

      let entries = await readdir(overlayHome);
      assert.ok(entries.includes("config.toml"));
      assert.ok(entries.includes(".hidden-file"));
      assert.ok(entries.includes(".hidden-directory"));
      assert.ok(!entries.includes("AGENTS.md"));
      assert.ok(!entries.includes("AGENTS.override.md"));
      assert.ok(!entries.includes("memories"));
      assert.ok(entries.includes("skills"));
      for (const name of ["config.toml", ".hidden-file", ".hidden-directory"]) {
        assert.ok((await lstat(path.join(overlayHome, name))).isSymbolicLink());
        assert.equal(await readlink(path.join(overlayHome, name)), path.join(codexHome, name));
      }
      const configLinkBefore = await lstat(path.join(overlayHome, "config.toml"));

      await unlink(path.join(codexHome, ".hidden-file"));
      await writeFile(path.join(codexHome, "new-entry"), "new", "utf8");
      assert.deepEqual(agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }), { CODEX_HOME: overlayHome });
      entries = await readdir(overlayHome);
      assert.ok(!entries.includes(".hidden-file"));
      assert.ok(entries.includes("new-entry"));
      assert.ok(!entries.includes("AGENTS.md"));
      const configLinkAfter = await lstat(path.join(overlayHome, "config.toml"));
      assert.equal(configLinkAfter.ino, configLinkBefore.ino);

      await unlink(path.join(overlayHome, "config.toml"));
      await symlink(path.join(codexHome, "stale-config.toml"), path.join(overlayHome, "config.toml"));
      agentUserInstructionEnv("codex", { CODEX_HOME: codexHome });
      assert.equal(await readlink(path.join(overlayHome, "config.toml")), path.join(codexHome, "config.toml"));
    } finally {
      if (overlayHome) await rm(overlayHome, { recursive: true, force: true });
    }
  });
});

test("Codex instruction overlay preserves auth and session files created inside it", async (t) => {
  await withTemporaryHome(t, async () => {
    const codexHome = await tempDir(t, "owl-codex-overlay-materialized-");
    let overlayHome;
    overlayHome = agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }).CODEX_HOME;
    await writeFile(path.join(overlayHome, "auth.json"), "codex auth", "utf8");
    await mkdir(path.join(overlayHome, "sessions"));
    await writeFile(path.join(overlayHome, "sessions", "new-session.jsonl"), "session data", "utf8");

    assert.deepEqual(agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }), { CODEX_HOME: overlayHome });

    assert.equal(await readFile(path.join(overlayHome, "auth.json"), "utf8"), "codex auth");
    assert.equal(await readFile(path.join(overlayHome, "sessions", "new-session.jsonl"), "utf8"), "session data");
  });
});

test("Codex instruction overlay removes stale AGENTS links and ignores AGENTS files added later", async (t) => {
  await withTemporaryHome(t, async () => {
    const codexHome = await tempDir(t, "owl-codex-overlay-agents-");
    let overlayHome;
    await writeFile(path.join(codexHome, "AGENTS.override.md"), "override", "utf8");
    overlayHome = agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }).CODEX_HOME;
    assert.deepEqual((await readdir(overlayHome)).filter((name) => name.startsWith("AGENTS")), []);

    await writeFile(path.join(codexHome, "AGENTS.md"), "late instructions", "utf8");
    await symlink(path.join(codexHome, "AGENTS.md"), path.join(overlayHome, "AGENTS.md"));
    await symlink(path.join(codexHome, "AGENTS.override.md"), path.join(overlayHome, "AGENTS.override.md"));

    agentUserInstructionEnv("codex", { CODEX_HOME: codexHome });

    assert.deepEqual((await readdir(overlayHome)).filter((name) => name.startsWith("AGENTS")), []);
  });
});

test("Codex overlay switches directories when real excluded files already exist", async (t) => {
  await withTemporaryHome(t, async () => {
    const codexHome = await tempDir(t, "owl-codex-overlay-conflict-");
    const originalOverlay = agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }).CODEX_HOME;
    await writeFile(path.join(originalOverlay, "AGENTS.md"), "preserve agents", "utf8");
    await writeFile(path.join(originalOverlay, "AGENTS.override.md"), "preserve override", "utf8");

    const { CODEX_HOME: cleanOverlay } = agentUserInstructionEnv("codex", { CODEX_HOME: codexHome });
    assert.notEqual(cleanOverlay, originalOverlay);
    assert.deepEqual((await readdir(cleanOverlay)).filter((name) => name.startsWith("AGENTS")), []);
    assert.equal(await readFile(path.join(originalOverlay, "AGENTS.md"), "utf8"), "preserve agents");
    assert.equal(await readFile(path.join(originalOverlay, "AGENTS.override.md"), "utf8"), "preserve override");
    assert.deepEqual(agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }), { CODEX_HOME: cleanOverlay });
  });
});

test("Codex overlays are private and owned by the current user", async (t) => {
  await withTemporaryHome(t, async () => {
    const codexHome = await tempDir(t, "owl-codex-overlay-permissions-");
    const overlayHome = agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }).CODEX_HOME;
    const overlay = await lstat(overlayHome);
    assert.ok(overlay.isDirectory());
    assert.ok(!overlay.isSymbolicLink());
    assert.equal(overlay.mode & 0o777, 0o700);
    if (typeof process.getuid === "function") assert.equal(overlay.uid, process.getuid());
  });
});

test("Codex overlays reject an existing directory with broad permissions", async (t) => {
  await withTemporaryHome(t, async () => {
    const codexHome = await tempDir(t, "owl-codex-overlay-insecure-");
    const overlayHome = agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }).CODEX_HOME;
    await chmod(overlayHome, 0o755);
    assert.throws(
      () => agentUserInstructionEnv("codex", { CODEX_HOME: codexHome }),
      /unsafe.*Codex overlay directory/iu,
    );
  });
});

test("Claude instruction environment does not override the child environment", () => {
  assert.deepEqual(agentUserInstructionEnv("claude", { CLAUDE_CONFIG_DIR: "/tmp/claude" }), {});
});

test("Claude Work roles install the optional Web research PostToolUse hook", async (t) => {
  await withResearchHook(t, (root, researchHook) => {
    for (const role of ["manager", "designer", "worker", "reviewer"]) {
      const args = buildAgentPermissionArgs(role, "claude", { owlRoot: root });
      const settings = JSON.parse(args[3]);
      assert.equal(settings.hooks.PostToolUse[0].matcher, "WebFetch|WebSearch", role);
      assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.includes(researchHook), role);
      assert.equal(settings.hooks.PostToolUse[0].hooks[0].timeout, 10, role);
      assert.deepEqual(settings.claudeMdExcludes, [path.join(os.homedir(), ".claude", "CLAUDE.md")], role);
    }
  });
});

test("Advisor and Curator Claude sessions do not install the research hook", async (t) => {
  await withResearchHook(t, (root) => {
    for (const role of ["advisor", "curator"]) {
      const args = buildAgentPermissionArgs(role, "claude", { owlRoot: root });
      const settings = JSON.parse(args[3]);
      assert.equal(settings.hooks.PostToolUse, undefined, role);
    }
  });
});

test("Codex keeps its existing hook configuration even when the research hook exists", async (t) => {
  await withResearchHook(t, (root) => {
    const args = buildAgentPermissionArgs("worker", "codex", { owlRoot: root });
    assert.ok(args.every((arg) => !arg.includes("PostToolUse")));
    assert.ok(args.every((arg) => !arg.includes("research-hook.js")));
  });
});

test("missing research hook fails open for Claude Work roles", async (t) => {
  await withPermissionHook(t, (root) => {
    const args = buildAgentPermissionArgs("worker", "claude", { owlRoot: root });
    const settings = JSON.parse(args[3]);
    assert.equal(settings.hooks.PostToolUse, undefined);
  });

  await t.test("a Codex Reviewer gets the PreToolUse hook that denies the Project's test commands", async () => {
    await withPermissionHook(t, (root) => {
      const args = buildAgentPermissionArgs("reviewer", "codex", { owlRoot: root });
      assert.ok(args.includes("features.hooks=true"));
      assert.ok(args.some((arg) => arg.startsWith("hooks.PreToolUse=")));
    });
  });
});

test("superpowers isolation: a missing plugin registry launches without it, any other failure throws", async (t) => {
  const config = await tempDir(t, "owl-claude-config-");
  const root = await withPermissionHook(t, async (r) => r);
  const args = () => buildAgentPermissionArgs("worker", "claude", { owlRoot: root, env: { CLAUDE_CONFIG_DIR: config } });
  assert.equal(args().includes("--plugin-dir"), false);
  await mkdir(path.join(config, "plugins"), { recursive: true });
  await writeFile(path.join(config, "plugins", "installed_plugins.json"), "{broken", "utf8");
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  assert.throws(args, (error) => /superpowers isolation setup failed: .+/.test(error.message));
});

test("superpowers isolation: an unreadable settings.json fails the launch", async (t) => {
  const config = await tempDir(t, "owl-claude-config-");
  const root = await withPermissionHook(t, async (r) => r);
  await mkdir(path.join(config, "plugins"), { recursive: true });
  await writeFile(path.join(config, "plugins", "installed_plugins.json"), '{"plugins":{}}', "utf8");
  await writeFile(path.join(config, "settings.json"), "{broken", "utf8");
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  assert.throws(() => buildAgentPermissionArgs("worker", "claude", { owlRoot: root, env: { CLAUDE_CONFIG_DIR: config } }), /superpowers isolation setup failed/);
});
