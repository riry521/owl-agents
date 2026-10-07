import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeLocation } from "../../packages/core/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

test("initialize does not recreate a confirmed default root that was renamed", async (t) => {
  const root = await tempDir(t, "owl-kb-confirmed-default-");
  const knowledge = join(root, "knowledge");
  const detached = join(root, "detached");
  const location = new KnowledgeLocation({
    owlRoot: root,
    dataDir: join(root, "data"),
    persistence: { read: () => "", write: () => undefined },
  });
  t.after(() => location.stop());

  assert.equal((await location.initialize()).state, "available");
  await fs.rename(knowledge, detached);

  assert.equal((await location.initialize()).state, "unavailable");
  await assert.rejects(fs.stat(knowledge), { code: "ENOENT" });

  await fs.rename(detached, knowledge);
  assert.equal((await location.check()).state, "available");
});
