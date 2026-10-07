import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter, MemoryCore } from "../../apps/server/dist/core.js";
import { createUlid, openDatabase } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function migrationsBefore016(t) {
  const directory = await tempDir(t, "owl-work-display-migrations-");
  for (const filename of (await readdir(migrations)).filter((file) => file.endsWith(".sql") && file < "016_work_display_number.sql")) {
    await copyFile(join(migrations, filename), join(directory, filename));
  }
  return directory;
}

test("the display number migration backfills created-order numbers per project, including the NULL project group", async (t) => {
  const root = await tempDir(t, "owl-work-display-legacy-");
  const oldMigrations = await migrationsBefore016(t);
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: migrates in two steps, old migrations first
  t.after(() => db.close());

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

  assert.equal(db.migrate(migrations).applied[0], "016", "the display number migration is applied");
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
  const { root, db, core } = await createTestCore(t, { version: "work-display-number-test", dispatcher: { tick_interval_ms: 25 } }, { prefix });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
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

test("new Works take the smallest free number per project, reusing numbers freed by deletion", async (t) => {
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
  const reused = await createWork("Reuses the deleted highest", projectA.id);
  assert.equal(number(reused), 3);
  assert.deepEqual([number(first), number(second)], [1, 2]);
  await removeWork(projectless);
  const secondProjectless = await createWork("Second without project", null);
  assert.equal(number(secondProjectless), 1);
  assert.deepEqual([number(first), number(otherProject)], [1, 1]);
  assert.equal(core.listWorks({ archived: "include" }).data.find((work) => work.id === second)?.project_id, projectA.id);
});

test("concurrent Work creation assigns distinct, contiguous numbers", async (t) => {
  const { createProject, createWork, number, removeWork } = await openCore(t, "owl-work-display-concurrent-");
  const project = await createProject("Concurrent");
  const seeded = await Promise.all(Array.from({ length: 4 }, (_, index) => createWork(`Seed ${index}`, project.id)));
  await removeWork(seeded[0]);
  await removeWork(seeded[2]);
  const ids = await Promise.all(Array.from({ length: 6 }, (_, index) => createWork(`Concurrent ${index}`, project.id)));
  assert.deepEqual(ids.map(number).sort((a, b) => a - b), [1, 3, 5, 6, 7, 8]);
});

test("a project with numbers 1, 2 and 4 gets 3 and then 5, independent of other groups", async (t) => {
  const { createProject, createWork, number, removeWork } = await openCore(t, "owl-work-display-gap-");
  const project = await createProject("Gap");
  const other = await createProject("Other");
  const works = [];
  for (let index = 0; index < 4; index++) works.push(await createWork(`Gap ${index}`, project.id));
  const otherWork = await createWork("Other", other.id);
  const projectless = await createWork("Projectless", null);
  await removeWork(works[2]);
  const three = await createWork("Fills 3", project.id);
  const five = await createWork("Takes 5", project.id);
  assert.deepEqual([number(three), number(five)], [3, 5]);
  assert.deepEqual([number(otherWork), number(projectless)], [1, 1]);
});

test("display numbers reach the API, and Cores without them report null", async (t) => {
  const memoryCore = new MemoryCore({ version: "work-display-number-memory" });
  const memoryWork = await memoryCore.createWork({ title: "Unnumbered", summary: "", size: "small", project_id: null }, {});
  const memoryId = memoryWork.data.work_id;
  assert.equal((await memoryCore.listWorks({ state: null, archived: "exclude", limit: 10, cursor: null })).data[0].display_number, null);
  assert.equal((await memoryCore.getWork(memoryId)).display_number, null);

  const { root, dataDir, db, core: durableCore, createProject, createWork } = await openCore(t, "owl-work-display-api-");
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const token = randomBytes(32).toString("hex");
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  const request = (path) => api.request("GET", `/api/v1${path}`);

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
