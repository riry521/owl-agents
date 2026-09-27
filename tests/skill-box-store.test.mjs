import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../packages/db/dist/index.js";
import { SkillBox } from "../packages/core/dist/skill-box.js";
import { Core } from "../packages/core/dist/index.js";
import { hashSkillFiles, parseSkillMd, renderSkillMd, validateSkillFilePath, validateSkillName } from "../packages/core/dist/skill-files.js";

const migrations = join(process.cwd(), "packages/db/migrations");

async function openMigratedDatabase(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-skill-box-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  t.after(() => {
    db.close();
    return rm(root, { recursive: true, force: true });
  });
  return { db, root };
}

test("skill storage migration creates the required tables, columns, indexes, and enum checks", async (t) => {
  const { db } = await openMigratedDatabase(t);
  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
  for (const name of ["skills", "skill_revisions", "skill_usages", "skill_proposals"]) {
    assert.ok(tables.has(name), `${name} exists`);
  }

  const expectedColumns = {
    skills: ["name", "description", "tags_json", "scope", "project_id", "state", "trial", "content_hash", "current_revision", "use_count", "last_used_at", "state_changed_at", "created_at", "updated_at", "broken_reason"],
    skill_revisions: ["id", "skill_name", "revision", "actor", "action", "snapshot_json", "content_hash", "source_proposal_id", "source_work_id", "source_agent_run_id", "reason", "created_at"],
    skill_usages: ["agent_run_id", "skill_name", "work_id", "project_id", "role", "revision", "read_detected", "verdict", "note", "created_at", "updated_at"],
    skill_proposals: ["id", "kind", "target_skill", "payload_json", "source_work_id", "source_agent_run_id", "project_id", "status", "decision_json", "attempts", "last_error", "applied_revision_id", "created_at", "updated_at"],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = new Set(db.all(`PRAGMA table_info('${table}')`).map((column) => column.name));
    for (const column of expected) assert.ok(actual.has(column), `${table}.${column} exists`);
  }

  const indexes = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name));
  assert.ok(indexes.has("skill_usages_skill_name_revision"));
  assert.ok(indexes.has("skill_proposals_status"));

  const lane = db.createWriteLane();
  await lane.transact((tx) => {
    const now = new Date().toISOString();
    const insertSkill = (state) => tx.run(
      `INSERT INTO skills (name, description, tags_json, scope, state, trial, content_hash, current_revision, use_count, state_changed_at, created_at, updated_at)
       VALUES (?, '', '[]', 'global', ?, 0, '', 0, 0, ?, ?, ?)`,
      `skill-${state}`,
      state,
      now,
      now,
      now,
    );
    assert.throws(() => insertSkill("invalid"), /CHECK constraint failed/u);

    assert.throws(() => tx.run(
      `INSERT INTO skill_revisions (id, skill_name, revision, actor, action, content_hash, reason, created_at)
       VALUES ('r1', 'missing', 1, 'robot', 'create', '', '', ?)`, now,
    ), /CHECK constraint failed/u);
    assert.throws(() => tx.run(
      `INSERT INTO skill_revisions (id, skill_name, revision, actor, action, content_hash, reason, created_at)
       VALUES ('r2', 'missing', 1, 'user', 'delete', '', '', ?)`, now,
    ), /CHECK constraint failed/u);
    assert.throws(() => tx.run(
      `INSERT INTO skill_usages (agent_run_id, skill_name, revision, read_detected, verdict, created_at, updated_at)
       VALUES ('run', 'missing', 1, 0, 'unknown', ?, ?)`, now, now,
    ), /CHECK constraint failed/u);
    assert.throws(() => tx.run(
      `INSERT INTO skill_proposals (id, kind, payload_json, status, attempts, created_at, updated_at)
       VALUES ('p1', 'other', '{}', 'pending', 0, ?, ?)`, now, now,
    ), /CHECK constraint failed/u);
    assert.throws(() => tx.run(
      `INSERT INTO skill_proposals (id, kind, payload_json, status, attempts, created_at, updated_at)
       VALUES ('p2', 'new', '{}', 'processing', 0, ?, ?)`, now, now,
    ), /CHECK constraint failed/u);
  });

  assert.equal(db.get("SELECT version FROM schema_migrations WHERE version = '015'")?.version, "015");
});

async function openSkillBox(t) {
  const { db, root } = await openMigratedDatabase(t);
  const skillBox = new SkillBox({ db, owlRoot: root, logger: { warn() {}, error() {} } });
  return { db, root, skillBox };
}

const meta = { description: "A reusable release procedure.", tags: ["release", "git"], scope: "global" };

function skillFiles(body, extra = {}) {
  return { "SKILL.md": renderSkillMd({ name: "release-procedure", ...meta }, body), ...extra };
}

test("skill names, file paths, frontmatter, and hashes follow the storage format", () => {
  assert.equal(validateSkillName("release-procedure"), true);
  for (const name of ["Release", "a", "x_y", "-a", "a".repeat(64)]) assert.equal(validateSkillName(name), false);

  for (const path of ["SKILL.md", "references/a.md", "scripts/x.sh", "templates/form.md"]) {
    assert.deepEqual(validateSkillFilePath(path), { ok: true });
  }
  for (const path of ["../x", "/etc/passwd", "references//a", "other/a.md", "references/../../x", "references\\x"]) {
    assert.equal(validateSkillFilePath(path).ok, false, path);
  }

  const rendered = renderSkillMd({ name: "release-procedure", ...meta }, "# Release\n\n1. Tag the release.");
  assert.deepEqual(parseSkillMd(rendered), {
    name: "release-procedure",
    description: meta.description,
    scope: meta.scope,
    tags: meta.tags,
    body: "# Release\n\n1. Tag the release.",
  });
  assert.deepEqual(parseSkillMd("---\nbroken\n---\ntext").error.length > 0, true);
  const commented = parseSkillMd("---\nname: release-procedure   # skill id\ndescription: Release steps # short\nscope: global   # comment\ntags:\n  - release # main\n---\nbody");
  assert.equal(commented.name, "release-procedure");
  assert.equal(commented.description, "Release steps");
  assert.equal(commented.scope, "global");
  assert.deepEqual(commented.tags, ["release"]);
  assert.equal(parseSkillMd("---\nname: release-procedure\ndescription: \"Use C# daily\"\nscope: global\ntags: []\n---\n").description, "Use C# daily");
  assert.equal(hashSkillFiles({ "b.txt": "two", "a.txt": "one" }), hashSkillFiles({ "a.txt": "one", "b.txt": "two" }));
});

test("skill revisions write files and snapshots, remove stale files, and restore as a new revision", async (t) => {
  const { db, root, skillBox } = await openSkillBox(t);
  const first = await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("first"), meta, actor: "user", action: "create", reason: "initial", trial: false });
  assert.equal(first.revision, 1);
  assert.equal(await readFile(join(root, "skills/release-procedure/SKILL.md"), "utf8"), skillFiles("first")["SKILL.md"]);
  assert.deepEqual(JSON.parse(db.get("SELECT snapshot_json FROM skill_revisions WHERE id = ?", first.revision_id).snapshot_json), skillFiles("first"));

  const second = await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("second", { "references/old.md": "stale" }), meta, actor: "user", action: "update", reason: "changed", trial: true });
  assert.equal(second.revision, 2);
  await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("third"), meta, actor: "user", action: "update", reason: "removed reference", trial: true });
  await assert.rejects(readFile(join(root, "skills/release-procedure/references/old.md"), "utf8"), { code: "ENOENT" });

  const restored = await skillBox.restore("release-procedure", first.revision_id, "user");
  assert.equal(restored.revision, 4);
  assert.equal(await skillBox.readFile("release-procedure", "SKILL.md"), skillFiles("first")["SKILL.md"]);
  assert.equal(db.get("SELECT current_revision FROM skills WHERE name = 'release-procedure'").current_revision, 4);

  await skillBox.setScope("release-procedure", "project:project-1", "user", "limited scope");
  const scoped = parseSkillMd(await skillBox.readFile("release-procedure", "SKILL.md"));
  assert.equal(scoped.scope, "project:project-1");
  assert.equal(db.get("SELECT project_id FROM skills WHERE name = 'release-procedure'").project_id, "project-1");
  assert.equal(db.get("SELECT action FROM skill_revisions WHERE skill_name = 'release-procedure' ORDER BY revision DESC LIMIT 1").action, "scope_change");

  const contentRevision = db.get("SELECT current_revision FROM skills WHERE name = 'release-procedure'").current_revision;
  await skillBox.setState("release-procedure", "archived", "user", "retired");
  const stateRevision = db.get("SELECT * FROM skill_revisions WHERE skill_name = 'release-procedure' ORDER BY revision DESC LIMIT 1");
  assert.equal(stateRevision.action, "state_change");
  assert.equal(stateRevision.snapshot_json, null);
  assert.equal(db.get("SELECT current_revision FROM skills WHERE name = 'release-procedure'").current_revision, contentRevision);
  const stateEvent = JSON.parse(db.get("SELECT payload_json FROM events WHERE type = 'skill.revised' ORDER BY sequence DESC LIMIT 1").payload_json);
  assert.equal(stateEvent.revision, stateRevision.revision);
  assert.equal(stateEvent.current_revision, contentRevision);
  const unarchived = await skillBox.restore("release-procedure", first.revision_id, "user");
  assert.equal(unarchived.revision, 7);
  assert.equal(db.get("SELECT state FROM skills WHERE name = 'release-procedure'").state, "active");
});

test("skill writes replace files that together exceed the size limit and clear stray files", async (t) => {
  const { db, root, skillBox } = await openSkillBox(t);
  const large = "x".repeat(200 * 1024);
  await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("first", { "references/a.md": large }), meta, actor: "user", action: "create", reason: "initial", trial: false });
  await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("second", { "references/b.md": large }), meta, actor: "user", action: "update", reason: "replaced", trial: false });
  await assert.rejects(readFile(join(root, "skills/release-procedure/references/a.md"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "skills/release-procedure/references/b.md"), "utf8"), large);

  await writeFile(join(root, "skills/release-procedure/.DS_Store"), Buffer.from([0, 1, 2, 255]));
  await mkdir(join(root, "skills/release-procedure/notes"), { recursive: true });
  await writeFile(join(root, "skills/release-procedure/notes/draft.md"), "draft");
  await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("third"), meta, actor: "user", action: "update", reason: "cleanup", trial: false });
  await assert.rejects(readFile(join(root, "skills/release-procedure/.DS_Store")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "skills/release-procedure/notes/draft.md")), { code: "ENOENT" });
  assert.equal(await skillBox.readFile("release-procedure", "SKILL.md"), skillFiles("third")["SKILL.md"]);

  await writeFile(join(root, "skills/release-procedure/.DS_Store"), Buffer.from([0, 1, 2, 255]));
  const revisionsBefore = db.get("SELECT COUNT(*) AS count FROM skill_revisions WHERE skill_name = 'release-procedure'").count;
  await skillBox.reconcileFiles();
  assert.equal(db.get("SELECT broken_reason FROM skills WHERE name = 'release-procedure'").broken_reason, null);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM skill_revisions WHERE skill_name = 'release-procedure'").count, revisionsBefore);
});

test("skill writes reject oversized, non-text, and symlink-targeted files", async (t) => {
  const { root, skillBox } = await openSkillBox(t);
  await assert.rejects(
    skillBox.applyRevision({ name: "release-procedure", files: skillFiles("x".repeat(256 * 1024)), meta, actor: "user", action: "create", reason: "large", trial: false }),
    /256KB/u,
  );
  await assert.rejects(
    skillBox.applyRevision({ name: "release-procedure", files: { ...skillFiles("valid"), "references/bad.md": "bad\u0000text" }, meta, actor: "user", action: "create", reason: "nul", trial: false }),
    /NUL/u,
  );

  const outside = join(root, "outside");
  await mkdir(outside);
  await mkdir(join(root, "skills/release-procedure"), { recursive: true });
  await symlink(outside, join(root, "skills/release-procedure/references"));
  await assert.rejects(
    skillBox.applyRevision({ name: "release-procedure", files: skillFiles("safe", { "references/a.md": "target" }), meta, actor: "user", action: "create", reason: "link", trial: false }),
    /symbolic_link/u,
  );
});

test("file reconciliation records external edits, imports new skills, and excludes broken metadata", async (t) => {
  const { db, root, skillBox } = await openSkillBox(t);
  await skillBox.applyRevision({ name: "release-procedure", files: skillFiles("first"), meta, actor: "user", action: "create", reason: "initial", trial: false });
  await writeFile(join(root, "skills/release-procedure/SKILL.md"), skillFiles("edited")["SKILL.md"]);

  await mkdir(join(root, "skills/manual-skill"), { recursive: true });
  await writeFile(join(root, "skills/manual-skill/SKILL.md"), renderSkillMd({ name: "manual-skill", description: "A manually added skill.", scope: "global", tags: ["manual"] }, "# Manual"));
  await skillBox.reconcileFiles();
  assert.equal(db.get("SELECT action FROM skill_revisions WHERE skill_name = 'release-procedure' ORDER BY created_at DESC LIMIT 1").action, "external_edit");
  assert.equal(db.get("SELECT actor FROM skill_revisions WHERE skill_name = 'release-procedure' ORDER BY created_at DESC LIMIT 1").actor, "user");
  assert.equal(db.get("SELECT state FROM skills WHERE name = 'manual-skill'").state, "active");

  await writeFile(join(root, "skills/release-procedure/SKILL.md"), "---\nname: broken\n---\nBad metadata");
  await skillBox.reconcileFiles();
  assert.ok(db.get("SELECT broken_reason FROM skills WHERE name = 'release-procedure'").broken_reason);
  assert.equal(db.get("SELECT state FROM skills WHERE name = 'release-procedure'").state, "active");
});

test("concurrent skill writes receive distinct revision numbers", async (t) => {
  const { db, skillBox } = await openSkillBox(t);
  const revisions = await Promise.all(Array.from({ length: 10 }, (_, index) => skillBox.applyRevision({
    name: "release-procedure",
    files: skillFiles(`revision ${index}`),
    meta,
    actor: "user",
    action: index === 0 ? "create" : "update",
    reason: `revision ${index}`,
    trial: false,
  })));
  assert.deepEqual(revisions.map((entry) => entry.revision).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM skill_revisions WHERE skill_name = 'release-procedure'").count, 10);
});

test("Core reconciles hand-added skills on startup and stops the reconciliation timer", async (t) => {
  const { db, root } = await openMigratedDatabase(t);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)",
    now,
    now,
  ));
  await mkdir(join(root, "skills/manual-skill"), { recursive: true });
  await writeFile(join(root, "skills/manual-skill/SKILL.md"), renderSkillMd({
    name: "manual-skill",
    description: "A manually added procedure.",
    scope: "global",
    tags: ["manual"],
  }, "# Manual skill"));
  const core = new Core({
    db,
    agentRunner: { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) },
    version: "test",
    owlRoot: root,
  });
  core.ruleStore.startWatching = async () => {};
  try {
    await core.start();
    const deadline = Date.now() + 3000;
    while (!core.skillBox.getSkill("manual-skill") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(core.skillBox.getSkill("manual-skill"));
    assert.ok(core.skillTimer);
    await core.stop({ force: true });
    assert.equal(core.skillTimer, null);
  } finally {
    await core.stop({ force: true }).catch(() => {});
  }
});
