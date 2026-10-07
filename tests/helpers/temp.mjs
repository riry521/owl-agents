import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTree } from "./cleanup.mjs";

/**
 * Create a temp directory (realpath, so macOS /var vs /private/var does not differ)
 * and remove it in t.after.
 * @param {import("node:test").TestContext} t
 * @param {string} [prefix]
 * @returns {Promise<string>}
 */
export async function tempDir(t, prefix = "owl-test-") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => removeTree(dir));
  return dir;
}
