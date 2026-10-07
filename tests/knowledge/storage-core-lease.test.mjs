import { clip } from "../helpers/seed-knowledge.mjs";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("Core can prepare the default knowledge storage before start without recreating it after loss", async (t) => {
  const base = await tempDir(t, "owl-core-kb-init-");
  const owlRoot = join(base, "root");
  const knowledgeDir = join(owlRoot, "knowledge");
  const db = createTestDatabase(base);
  const { core } = await createTestCore(t, { db, agentRunner, version: "kb-init-test", owlRoot, dataDir: join(owlRoot, "data") });
  t.after(() => db.close());

  await core.knowledge.ensureDirectories();
  assert.ok((await readdir(knowledgeDir)).includes("global"));
  await core.start();
  await rm(knowledgeDir, { recursive: true, force: true });

  await assert.rejects(core.knowledge.ensureDirectories(), (error) => error.code === "knowledge_storage_unavailable");
  await assert.rejects(readdir(knowledgeDir), { code: "ENOENT" });
});

test("Core allows its first default knowledge write before start", async (t) => {
  const base = await tempDir(t, "owl-core-kb-first-write-");
  const owlRoot = join(base, "root");
  const db = createTestDatabase(base);
  const { core } = await createTestCore(t, { db, agentRunner, version: "kb-first-write-test", owlRoot, dataDir: join(owlRoot, "data") });
  t.after(() => db.close());

  const note = await core.knowledge.create({ folder: "global", filename: "initial.md", tags: [], ...clip("initial storage") });

  assert.equal(note.path, "global/initial.md");
  assert.equal((await readdir(join(owlRoot, "knowledge", "global"))).includes("initial.md"), true);
});

test("Core list and search detect a removed default or custom root before polling", async (t) => {
  for (const custom of [false, true]) {
    await t.test(custom ? "custom storage" : "default storage", async (t) => {
      const base = await tempDir(t, "owl-core-kb-root-loss-");
      const owlRoot = join(base, "root");
      const knowledgeDir = custom ? join(base, "custom-store") : join(owlRoot, "knowledge");
      if (custom) {
        await mkdir(knowledgeDir, { recursive: true });
        await writeFile(join(knowledgeDir, ".owl-knowledge"), "{}");
      }
      const db = createTestDatabase(base);
      const stored = { value: custom ? knowledgeDir : "" };
      const { core } = await createTestCore(t, {
        db,
        agentRunner,
        version: "kb-root-loss-test",
        owlRoot,
        dataDir: join(owlRoot, "data"),
        knowledgeStorage: { read: () => stored.value, write: (value) => { stored.value = value; } },
      });
      t.after(() => db.close());

      await core.start();
      const detached = join(base, "detached-store");
      await rename(knowledgeDir, detached);

      const results = await Promise.allSettled([
        core.knowledge.list(),
        core.knowledge.search("missing"),
      ]);
      assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
      for (const result of results) {
        assert.equal(result.reason.code, "knowledge_storage_unavailable");
      }
      assert.equal(core.getKnowledgeStorage().state, "unavailable");
      await assert.rejects(readdir(knowledgeDir), { code: "ENOENT" });

      await rename(detached, knowledgeDir);
      assert.equal((await core.checkKnowledgeStorage()).state, "available");
    });
  }
});

test("Core knowledge reads hold the source through a move and writes wait for the destination", async (t) => {
  const base = await tempDir(t, "owl-core-kb-lease-");
  const source = join(base, "storage");
  const target = join(base, "moved-storage");
  const owlRoot = join(base, "root");
  const dataDir = join(owlRoot, "data");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, ".owl-knowledge"), "{}");

  const db = createTestDatabase(base);
  const stored = { value: source };
  const { core } = await createTestCore(t, {
    db,
    agentRunner,
    version: "kb-lease-test",
    owlRoot,
    dataDir,
    knowledgeStorage: { read: () => stored.value, write: (value) => { stored.value = value; } },
  });
  t.after(() => db.close());
  await core.start();
  await core.knowledge.create({ folder: "global", filename: "seed.md", tags: [], ...clip("before move") });

  const actualList = core.knowledge.list.bind(core.knowledge);
  let startRead;
  const readStarted = new Promise((resolve) => { startRead = resolve; });
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  core.knowledge.list = async (...args) => {
    startRead();
    await readGate;
    return actualList(...args);
  };

  const reading = core.knowledge.list();
  await readStarted;
  let movementSettled = false;
  const movement = core.moveKnowledgeStorage({ path: target });
  movement.then(() => { movementSettled = true; }, () => { movementSettled = true; });

  let stage = "timeout";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (core.getKnowledgeStorage().move?.stage === "switching") {
      stage = "switching";
      break;
    }
    if (movementSettled) {
      stage = "completed";
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  try {
    assert.equal(stage, "switching", "the move waits for the in-flight public read before changing paths");
    assert.equal(movementSettled, false);

    let writeSettled = false;
    const writing = core.knowledge.create({ folder: "global", filename: "during-move.md", tags: [], ...clip("after move") })
      .then((entry) => {
        writeSettled = true;
        return entry;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writeSettled, false, "a public write waits while the storage is switching");

    releaseRead();
    const [readEntries, moveResult, created] = await Promise.all([reading, movement, writing]);
    assert.deepEqual(readEntries.map((entry) => entry.path), ["global/seed.md"]);
    assert.equal(moveResult.status.path, target);
    assert.equal(created.path, "global/during-move.md");
    assert.equal(await readFile(join(target, created.path), "utf8").then((text) => text.includes("after move")), true);
    await assert.rejects(readdir(source), /ENOENT/u);

    const unavailable = join(base, "temporarily-unavailable");
    await rename(target, unavailable);
    assert.equal((await core.checkKnowledgeStorage()).state, "unavailable");
    await assert.rejects(core.knowledge.list(), (error) => error.code === "knowledge_storage_unavailable");
    await assert.rejects(
      core.knowledge.create({ folder: "global", filename: "unavailable.md", tags: [], ...clip("no write") }),
      (error) => error.code === "knowledge_storage_unavailable",
    );
  } finally {
    releaseRead();
  }
});

test("start finishes a project overview scheduled before start before archiving legacy knowledge", async (t) => {
  const { core } = await createTestCore(t, { agentRunner, version: "kb-overview-before-start" }, { prefix: "owl-core-kb-overview-" });
  const base = await tempDir(t, "owl-core-kb-overview-project-");
  // Hold every knowledge write open briefly and count the writes still open when the archive's write begins.
  const location = core.knowledgeLocation;
  const withWrite = location.withWrite.bind(location);
  const inside = new AsyncLocalStorage();
  let open = 0;
  let openAtArchive = -1;
  location.withWrite = (fn) => {
    if (inside.getStore()) return withWrite(fn);
    if (new Error().stack.includes("archiveLegacyKnowledgeOnFirstOpen")) openAtArchive = open;
    return withWrite(() => inside.run(true, async () => {
      open += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return await fn();
      } finally {
        open -= 1;
      }
    }));
  };

  await core.createProject({
    request_id: "req-overview",
    idempotency_key: "test:overview-before-start",
    expected_version: 0,
    payload: { name: "Overview", canonical_path: join(base, "repo"), base_branch: "main", allowed_roots: [base], verification_plan: [] },
  });
  await core.start();

  assert.equal(openAtArchive, 0);
});
