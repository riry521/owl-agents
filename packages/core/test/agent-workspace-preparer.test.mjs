import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentWorkspacePreparer } from "../dist/index.js";

function preparer({ onRefresh = async () => null, onSetup = async () => ({ setup: null, tool_state_paths: [] }) } = {}) {
  let refreshCalls = 0;
  return {
    instance: new AgentWorkspacePreparer({
      db: { get: () => ({ id: "project", canonical_path: "/source", worktree_prepare_argv_json: null, worktree_refresh_argv_json: null }) },
      writeLane: { transact: async () => {} },
      tooling: {
        refreshBeforeRun: async (...args) => { refreshCalls += 1; return onRefresh(...args); },
        prepareNewWorktree: (...args) => onSetup(...args),
        alertFor: () => null,
      },
      emitAlert: async () => {},
      language: () => "ja",
    }),
    refreshCalls: () => refreshCalls,
  };
}

test("rejects worktree venv symlinks to an external Python environment", async (t) => {
  for (const name of [".venv", "venv"]) {
    await t.test(name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "owl-agent-workspace-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const worktree = join(root, "worktree");
      const sharedVenv = join(root, "shared-venv");
      await mkdir(worktree);
      await mkdir(sharedVenv);
      await writeFile(join(sharedVenv, "pyvenv.cfg"), "home = /usr/bin\n");
      await symlink(sharedVenv, join(worktree, name));
      const { instance, refreshCalls } = preparer();

      await assert.rejects(instance.beforeAgentRun("work", worktree), /outside the worktree/);
      assert.equal(refreshCalls(), 0);
    });
  }
});

test("allows worktree venvs whose resolved paths stay inside the worktree", async (t) => {
  for (const name of [".venv", "venv"]) {
    await t.test(name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "owl-agent-workspace-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const worktree = join(root, "worktree");
      const localVenv = join(worktree, "..python-env");
      await mkdir(localVenv, { recursive: true });
      await writeFile(join(localVenv, "pyvenv.cfg"), "home = /usr/bin\n");
      await symlink(localVenv, join(worktree, name));
      const { instance, refreshCalls } = preparer();

      await assert.doesNotReject(instance.beforeAgentRun("work", worktree));
      assert.equal(refreshCalls(), 1);
    });
  }
});

test("rejects an external Python environment created while preparing the worktree", async (t) => {
  for (const phase of ["setup", "refresh", "refresh-error"]) {
    await t.test(phase, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "owl-agent-workspace-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const worktree = join(root, "worktree");
      const sharedVenv = join(root, "shared-venv");
      await mkdir(worktree);
      await mkdir(sharedVenv);
      await writeFile(join(sharedVenv, "pyvenv.cfg"), "home = /usr/bin\n");
      const createSymlink = async () => symlink(sharedVenv, join(worktree, ".venv"));
      const { instance } = preparer({
        onSetup: phase === "setup" ? async () => { await createSymlink(); return { setup: null, tool_state_paths: [] }; } : undefined,
        onRefresh: async () => {
          if (phase !== "setup") await createSymlink();
          if (phase === "refresh-error") throw new Error("refresh failed");
          return null;
        },
      });
      if (phase === "setup") instance.markCreated(worktree);

      await assert.rejects(instance.beforeAgentRun("work", worktree), /outside the worktree/);
    });
  }
});
