import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Core } from "../../packages/core/dist/index.js";
import { createTestDatabase } from "./db.mjs";

/**
 * Remove a directory tree, retrying only on ENOTEMPTY. Core.stop() does not await its
 * fire-and-forget worktree reconcile, so it can still write under the root for a moment after
 * stop; any other error, or ENOTEMPTY that persists past the retries, is thrown.
 * @param {string} path
 * @param {{ retries?: number, delayMs?: number }} [options]
 */
export async function removeTree(path, { retries = 50, delayMs = 100 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Like createTestCore, but the root removal retries while Core's background worktree reconcile
 * is still writing. One t.after runs core.stop({ force }) -> close the DB -> removeTree(root).
 * @param {import("node:test").TestContext} t
 * @param {object} [coreOptions] passed to new Core (db and owlRoot are created here)
 * @param {{ prefix?: string, start?: boolean }} [options]
 */
export async function createRetryingTestCore(t, coreOptions = {}, { prefix = "owl-test-", start = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const db = createTestDatabase(root);
  const core = new Core({ agentRunner: {}, version: "test", ...coreOptions, db, owlRoot: root });
  t.after(async () => {
    try {
      await core.stop({ force: true });
    } finally {
      try {
        db.close();
      } finally {
        await removeTree(root);
      }
    }
  });
  if (start) await core.start();
  return { root, db, core };
}
