import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../packages/db/dist/index.js";
import { migrationsDir } from "./paths.mjs";

/**
 * Open <dir>/owl.db and apply all migrations. The caller owns closing it.
 * @param {string} dir
 */
export function createTestDatabase(dir) {
  const db = openDatabase(join(dir, "owl.db"));
  db.migrate(migrationsDir);
  return db;
}

/**
 * Create a temp root and a migrated DB in it; t.after closes the DB, then removes the root.
 * @param {import("node:test").TestContext} t
 * @param {{ prefix?: string }} [options]
 */
export async function openTestDatabase(t, { prefix = "owl-test-" } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const db = createTestDatabase(root);
  t.after(async () => {
    try {
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, db };
}
