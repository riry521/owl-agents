import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { ExternalCoreAdapter, MemoryCore } from "../apps/server/dist/core.js";
import { Core } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

function command(payload, suffix, expectedVersion = 0) {
  return { request_id: randomUUID(), idempotency_key: `work-display-number:${suffix}`, expected_version: expectedVersion, payload };
}

async function migrationsBefore016() {
  const directory = await mkdtemp(join(tmpdir(), "owl-work-display-migrations-"));
  for (const filename of (await readdir(migrations)).filter((file) => file.endsWith(".sql") && file < "016_work_display_number.sql")) {
    await copyFile(join(migrations, filename), join(directory, filename));
  }
  return directory;
}

test("016 backfills created-order numbers per project, including the NULL project group", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-work-display-legacy-"));
  const oldMigrations = await migrationsBefore016();
  const db = openDatabase(join(root, "owl.db"));
  t.after(() => {
    db.close();
    return Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(oldMigrations, { recursive: true, force: true }),
    ]);
  });

  assert.equal(db.migrate(oldMigrations).applied.at(-1), "015");
  const ownerId = "owner:display-number-test";
  const projectA = createUlid();
  const projectB = createUlid();
  const works = [
    { projectId: projectA, createdAt: "2024-01-02T00:00:00.000Z" },
    { projectId: projectA, createdAt: "2024-01-01T00:00:00.000Z" },
    { projectId: projectA, createdAt: "2024-01-02T00:00:00.000Z" },
    { projectId: projectB, createdAt: "2024-01-03T00:00:00.000Z" },
    { projectId: null, createdAt: "2024-01-04T00:00:00.000Z" },
    { projectId: null, createdAt: "2024-01-01T00:00:00.000Z" },
  ];
  await db.createWriteLane().transact((tx) => {
    const now = "2024-01-01T00:00:00.000Z";
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", ownerId, "Test", now, now);
    for (const [id, name] of [[projectA, "A"], [projectB, "B"]]) {
      tx.run(
        `INSERT INTO projects
           (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
            verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', '[]', '[]', '[]', ?, ?)`,
        id, ownerId, name, join(root, name), now, now,
      );
    }
    for (const work of works) {
      const id = createUlid();
      tx.run(
        `INSERT INTO works
           (id, owner_id, project_id, title, summary, size, state, state_version,
            plan_revision, rules_json, related_work_ids_json, created_at, updated_at,
            completed_at, cancelled_at, archived_at)
         VALUES (?, ?, ?, 'Legacy', '', 'small', 'memo', 0, 0, ?, '[]', ?, ?, NULL, NULL, NULL)`,
        id, ownerId, work.projectId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), work.createdAt, work.createdAt,
      );
      work.id = id;
    }
    return null;
  });

  assert.deepEqual(db.migrate(migrations).applied, ["016", "017", "018", "019", "020", "021", "022", "023", "024", "025", "026", "027", "028", "029"]);
  const rows = db.all("SELECT id, project_id, created_at, display_number FROM works ORDER BY created_at, id");
  for (const projectId of [projectA, projectB, null]) {
    const group = rows.filter((row) => row.project_id === projectId);
    group.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    assert.deepEqual(group.map((row) => row.display_number), group.map((_, index) => index + 1));
  }
  const nextNumbers = new Map(db.all("SELECT id, next_work_number FROM projects").map((row) => [row.id, row.next_work_number]));
  assert.equal(nextNumbers.get(projectA), 4);
  assert.equal(nextNumbers.get(projectB), 2);
  assert.equal(JSON.parse(db.get("SELECT value_json FROM settings WHERE key = 'work_next_display_number'").value_json), 3);
});

async function openCore(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.db"));
  db.migrate(migrations);
  const core = new Core({ db, agentRunner: {}, version: "work-display-number-test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const createProject = async (name) => {
    const canonicalPath = join(root, name);
    await mkdir(canonicalPath, { recursive: true });
    return (await core.createProject(command({
      name,
      canonical_path: canonicalPath,
      base_branch: "main",
      allowed_roots: [canonicalPath],
      verification_plan: [],
    }, `project-${name}`))).data;
  };
  const createWork = async (title, projectId) => (await core.createWork(command({
    title,
    summary: "",
    size: "small",
    project_id: projectId,
  }, title))).data.work_id;
  const number = (workId) => db.get("SELECT display_number FROM works WHERE id = ?", workId)?.display_number;
  const removeWork = async (workId) => {
    await db.createWriteLane().transact((tx) => {
      tx.run("UPDATE works SET state = 'completed', state_version = 1, completed_at = ? WHERE id = ?", new Date().toISOString(), workId);
      return null;
    });
    await core.archiveWork(workId, command({}, `archive-${workId}`, 1));
    await core.deleteWork(workId, command({}, `delete-${workId}`, 1));
  };
  return { root, dataDir, db, core, createProject, createWork, number, removeWork };
}

function legacyCoreFor(stored) {
  return {
    subscribe: () => () => {},
    status: () => ({ services: [], mvp_scope: "test", version: "legacy" }),
    listWorks: () => ({
      data: [{ id: stored.id, title: stored.title, state: stored.state, state_version: stored.state_version, updated_at: stored.updated_at, archived_at: stored.archived_at }],
      cursor: null,
      has_more: false,
    }),
    getWork: () => ({ data: {
      id: stored.id,
      title: stored.title,
      state: stored.state,
      state_version: stored.state_version,
      updated_at: stored.updated_at,
      archived_at: stored.archived_at,
      owner_id: stored.owner_id,
      project_id: stored.project_id,
      summary: stored.summary,
      size: stored.size,
      plan_revision: stored.plan_revision,
      progress: { total_tasks: 0, completed_tasks: 0, percent: 0 },
    } }),
  };
}

test("new Works count per project and never reuse a number, even after the highest one is deleted", async (t) => {
  const { core, createProject, createWork, number, removeWork } = await openCore(t, "owl-work-display-core-");
  const projectA = await createProject("A");
  const projectB = await createProject("B");

  const first = await createWork("First", projectA.id);
  const second = await createWork("Second", projectA.id);
  const third = await createWork("Third", projectA.id);
  const otherProject = await createWork("Other project", projectB.id);
  const projectless = await createWork("No project", null);
  assert.deepEqual([number(first), number(second), number(third)], [1, 2, 3]);
  assert.equal(number(otherProject), 1);
  assert.equal(number(projectless), 1);

  await removeWork(third);
  const fourth = await createWork("Fourth after deleting the highest", projectA.id);
  assert.equal(number(fourth), 4);
  await removeWork(projectless);
  const secondProjectless = await createWork("Second without project", null);
  assert.equal(number(secondProjectless), 2);
  assert.deepEqual([number(first), number(second), number(otherProject)], [1, 2, 1]);
  assert.equal(core.listWorks({ archived: "include" }).data.find((work) => work.id === second)?.project_id, projectA.id);
});

test("concurrent Work creation assigns distinct, contiguous numbers", async (t) => {
  const { createProject, createWork, number } = await openCore(t, "owl-work-display-concurrent-");
  const project = await createProject("Concurrent");
  const ids = await Promise.all(Array.from({ length: 8 }, (_, index) => createWork(`Concurrent ${index}`, project.id)));
  assert.deepEqual(ids.map(number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("display numbers reach the API, and Cores without them report null", async (t) => {
  const memoryCore = new MemoryCore({ version: "work-display-number-memory" });
  const memoryWork = await memoryCore.createWork({ title: "Unnumbered", summary: "", size: "small", project_id: null }, {});
  const memoryId = memoryWork.data.work_id;
  assert.equal((await memoryCore.listWorks({ state: null, archived: "exclude", limit: 10, cursor: null })).data[0].display_number, null);
  assert.equal((await memoryCore.getWork(memoryId)).display_number, null);

  const { root, dataDir, db, core: durableCore, createProject, createWork } = await openCore(t, "owl-work-display-api-");
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const originalToken = process.env.OWL_API_TOKEN;
  const token = randomBytes(32).toString("hex");
  process.env.OWL_API_TOKEN = token;
  const http = createOwlHttpServer({
    core,
    db,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    dataDir,
  });
  t.after(async () => {
    if (http.server.listening) await http.close();
    if (originalToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = originalToken;
  });
  await http.listen();
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const request = (path) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

  const project = await createProject("Numbered Works");
  await createWork("First", project.id);
  const second = await createWork("Second", project.id);

  const listed = (await core.listWorks({ state: null, archived: "include", limit: 10, cursor: null })).data.find((work) => work.id === second);
  assert.equal(listed?.display_number, 2);
  assert.equal(listed?.project_id, project.id);
  assert.equal((await core.getWork(second)).display_number, 2);
  const listResponse = await request("/works");
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).data.find((work) => work.id === second)?.display_number, 2);
  const detailResponse = await request(`/works/${second}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).data.display_number, 2);

  const legacyAdapter = new ExternalCoreAdapter(legacyCoreFor(db.get("SELECT * FROM works WHERE id = ?", second)), db, root, dataDir);
  const legacyListed = (await legacyAdapter.listWorks({ state: null, archived: "exclude", limit: 10, cursor: null })).data[0];
  assert.equal(legacyListed.display_number, null);
  assert.equal(legacyListed.project_id, null);
  assert.equal((await legacyAdapter.getWork(second)).display_number, null);
});
