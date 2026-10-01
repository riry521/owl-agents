import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { Core } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";

const migrations = join(process.cwd(), "packages/db/migrations");

test("removed default and custom knowledge roots fail immediately and recover after restoration", async (t) => {
  for (const custom of [false, true]) {
    await t.test(custom ? "custom storage" : "default storage", async (t) => {
      const root = await mkdtemp(join(tmpdir(), "owl-knowledge-root-loss-"));
      const dataDir = join(root, "data");
      const webOut = join(root, "web");
      const knowledgeDir = custom ? join(root, "custom-store") : join(root, "knowledge");
      await mkdir(dataDir, { recursive: true });
      await mkdir(webOut, { recursive: true });
      if (custom) {
        await mkdir(knowledgeDir, { recursive: true });
        await writeFile(join(knowledgeDir, ".owl-knowledge"), "{}");
      }

      const db = openDatabase(join(dataDir, "owl.db"));
      db.migrate(migrations);
      const stored = { value: custom ? knowledgeDir : "" };
      const core = new Core({
        db,
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
      const previousToken = process.env.OWL_API_TOKEN;
      const token = randomBytes(32).toString("hex");
      process.env.OWL_API_TOKEN = token;
      let http;
      t.after(async () => {
        if (http?.server.listening) await http.close().catch(() => undefined);
        await core.stop({ force: true }).catch(() => undefined);
        db.close();
        await rm(root, { recursive: true, force: true });
        if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
        else process.env.OWL_API_TOKEN = previousToken;
      });

      await core.start();
      await core.knowledge.create({ folder: "global", filename: "present.md", tags: [], body: "the root is in use" });
      http = createOwlHttpServer({
        core: adapter,
        db,
        webOut,
        bind: "127.0.0.1",
        port: 0,
        contract: { contract_version: "1.0.0" },
        owlRoot: root,
        dataDir,
      });
      try {
        await http.listen();
      } catch (error) {
        if (error?.code === "EPERM" || error?.code === "EACCES") {
          t.skip("localhost listen is not permitted in this environment");
          return;
        }
        throw error;
      }

      const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
      const requestKnowledge = () => fetch(`${base}/knowledge`, {
        headers: { authorization: `Bearer ${token}` },
      });
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
