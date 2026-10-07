import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Core } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestDatabase } from "./db.mjs";

/**
 * Build a Core on a migrated temp DB. Cleanup (in t.after): core.stop({ force }) -> close the DB
 * -> remove the root. A db / owlRoot passed in coreOptions is not closed or removed, so a
 * restart test can build a second Core on the same db and root after core.stop().
 * @param {import("node:test").TestContext} t
 * @param {object} [coreOptions] passed to new Core (db and owlRoot override the defaults)
 * @param {{ prefix?: string, start?: boolean }} [options]
 */
export async function createTestCore(t, coreOptions = {}, { prefix = "owl-test-", start = false } = {}) {
  const ownsRoot = coreOptions.owlRoot === undefined;
  const root = ownsRoot ? await realpath(await mkdtemp(join(tmpdir(), prefix))) : coreOptions.owlRoot;
  const ownsDb = coreOptions.db === undefined;
  const db = ownsDb ? createTestDatabase(root) : coreOptions.db;
  const core = new Core({ agentRunner: {}, version: "test", ...coreOptions, db, owlRoot: root });
  t.after(async () => {
    try {
      await core.stop({ force: true });
    } finally {
      try {
        if (ownsDb) db.close();
      } finally {
        if (ownsRoot) await rm(root, { recursive: true, force: true });
      }
    }
  });
  if (start) await core.start();
  return { root, db, core };
}

/**
 * Core command envelope.
 * @param {unknown} payload
 * @param {string} idempotencyKey
 * @param {number} [expectedVersion]
 */
export function command(payload, idempotencyKey, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: idempotencyKey, expected_version: expectedVersion, payload };
}
