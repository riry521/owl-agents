import { clip } from "../helpers/seed-knowledge.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

test("removed default and custom knowledge roots fail immediately and recover after restoration", async (t) => {
  for (const custom of [false, true]) {
    await t.test(custom ? "custom storage" : "default storage", async (t) => {
      const root = await tempDir(t, "owl-knowledge-root-loss-");
      const dataDir = join(root, "data");
      const webOut = join(root, "web");
      const knowledgeDir = custom ? join(root, "custom-store") : join(root, "knowledge");
      await mkdir(dataDir, { recursive: true });
      await mkdir(webOut, { recursive: true });
      if (custom) {
        await mkdir(knowledgeDir, { recursive: true });
        await writeFile(join(knowledgeDir, ".owl-knowledge"), "{}");
      }

      const stored = { value: custom ? knowledgeDir : "" };
      const { core, db } = await createTestCore(t, {
        agentRunner: {},
        version: "knowledge-root-loss-test",
        owlRoot: root,
        dataDir,
        knowledgeStorage: {
          read: () => stored.value,
          write: (value) => { stored.value = value; },
        },
      });
      const adapter = new ExternalCoreAdapter(core, db, root, dataDir);
      const token = randomBytes(32).toString("hex");

      await core.start();
      await core.knowledge.create({ folder: "global", filename: "present.md", tags: [], ...clip("the root is in use") });
      const api = await startTestHttpServer(t, { core: adapter, db, webOut, owlRoot: root, dataDir }, { token });
      if (!api) return t.skip("localhost listen is unavailable");
      const requestKnowledge = () => api.request("GET", "/api/v1/knowledge");
      const detached = join(root, "detached-store");
      await rename(knowledgeDir, detached);

      const results = await Promise.allSettled([
        core.knowledge.list(),
        core.knowledge.search("present"),
      ]);
      assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
      for (const result of results) assert.equal(result.reason.code, "knowledge_storage_unavailable");
      assert.equal(core.getKnowledgeStorage().state, "unavailable");

      const response = await requestKnowledge();
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "knowledge_storage_unavailable");
      await assert.rejects(stat(knowledgeDir), { code: "ENOENT" });

      await rename(detached, knowledgeDir);
      assert.equal((await core.checkKnowledgeStorage()).state, "available");
      assert.equal((await core.knowledge.list()).length, 1);
      const recovered = await requestKnowledge();
      assert.equal(recovered.status, 200);
    });
  }
});
