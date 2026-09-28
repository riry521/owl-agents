import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgentPermissionArgs } from "../packages/shared/dist/index.js";

async function withPermissionHook(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-permission-hook-"));
  const hookPath = path.join(root, "apps", "server", "dist", "permission-hook.js");
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(hookPath, "", "utf8");
  try {
    return await run(root, hookPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withResearchHook(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-research-permission-hook-"));
  const permissionHook = path.join(root, "apps", "server", "dist", "permission-hook.js");
  const researchHook = path.join(root, "apps", "server", "dist", "research-hook.js");
  await mkdir(path.dirname(permissionHook), { recursive: true });
  await writeFile(permissionHook, "", "utf8");
  await writeFile(researchHook, "", "utf8");
  try {
    return await run(root, researchHook);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Claude roles use bypassPermissions with the PreToolUse policy hook on every tool", async () => {
  await withPermissionHook((root, hookPath) => {
    const args = buildAgentPermissionArgs("advisor", "claude", { owlRoot: root });
    assert.deepEqual(args.slice(0, 2), ["--permission-mode", "bypassPermissions"]);
    const settings = JSON.parse(args[3]);
    assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(hookPath));
  });
});

test("Codex roles use full access with the PreToolUse policy hook on every tool", async () => {
  await withPermissionHook((root) => {
    const args = buildAgentPermissionArgs("worker", "codex", { owlRoot: root });
    assert.deepEqual(args.slice(0, 5), ["--dangerously-bypass-hook-trust", "--sandbox", "danger-full-access", "--config", 'approval_policy="never"']);
    assert.ok(args.includes("features.hooks=true"));
    assert.ok(args.some((arg) => arg.includes("hooks.PreToolUse=[{matcher=\"*\",")));
    assert.ok(args.some((arg) => arg.includes("permission-hook.js")));
  });
});

test("Codex resume permissions set full access through config", async () => {
  await withPermissionHook((root) => {
    const args = buildAgentPermissionArgs("worker", "codex", { owlRoot: root, resume: true });

    assert.deepEqual(args.slice(0, 3), [
      "--dangerously-bypass-hook-trust",
      "--config",
      'sandbox_mode="danger-full-access"',
    ]);
    assert.ok(!args.includes("--sandbox"));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes("features.hooks=true"));
    assert.ok(args.some((arg) => arg.includes("hooks.PreToolUse=[{matcher=\"*\",")));
  });
});

test("Curator uses the shared PreToolUse permission hook role", async () => {
  await withPermissionHook((root) => {
    for (const adapter of ["claude", "codex"]) {
      assert.doesNotThrow(() => buildAgentPermissionArgs("curator", adapter, { owlRoot: root }));
    }
  });
});

test("agent startup fails closed when Owl's permission hook has not been built", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-missing-hook-"));
  try {
    assert.throws(
      () => buildAgentPermissionArgs("advisor", "claude", { owlRoot: root }),
      /permission hook is missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Work roles install the optional Web research PostToolUse hook", async () => {
  await withResearchHook((root, researchHook) => {
    for (const role of ["manager", "designer", "worker", "reviewer"]) {
      const args = buildAgentPermissionArgs(role, "claude", { owlRoot: root });
      const settings = JSON.parse(args[3]);
      assert.equal(settings.hooks.PostToolUse[0].matcher, "WebFetch|WebSearch", role);
      assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.includes(researchHook), role);
      assert.equal(settings.hooks.PostToolUse[0].hooks[0].timeout, 10, role);
    }
  });
});

test("Advisor and Curator Claude sessions do not install the research hook", async () => {
  await withResearchHook((root) => {
    for (const role of ["advisor", "curator"]) {
      const args = buildAgentPermissionArgs(role, "claude", { owlRoot: root });
      const settings = JSON.parse(args[3]);
      assert.equal(settings.hooks.PostToolUse, undefined, role);
    }
  });
});

test("Codex keeps its existing hook configuration even when the research hook exists", async () => {
  await withResearchHook((root) => {
    const args = buildAgentPermissionArgs("worker", "codex", { owlRoot: root });
    assert.ok(args.every((arg) => !arg.includes("PostToolUse")));
    assert.ok(args.every((arg) => !arg.includes("research-hook.js")));
  });
});

test("missing research hook fails open for Claude Work roles", async () => {
  await withPermissionHook((root) => {
    const args = buildAgentPermissionArgs("worker", "claude", { owlRoot: root });
    const settings = JSON.parse(args[3]);
    assert.equal(settings.hooks.PostToolUse, undefined);
  });
});
