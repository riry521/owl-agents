import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { createUlid, openDatabase } from "../packages/db/dist/index.js";
import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";
import { fingerprint } from "../packages/core/dist/learning-fingerprint.js";
import { RuleProposals } from "../packages/core/dist/rule-proposals.js";
import { slugifyKnowledgeName } from "../packages/core/dist/knowledge-naming.js";
import { Core } from "../packages/core/dist/core.js";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const migrations = join(repoRoot, "packages/db/migrations");
const migrationModule = await import("../packages/core/dist/knowledge-migration.js").catch(() => ({}));

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "owl-legacy-migration-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const owlRoot = join(parent, "owl");
  const dataDir = join(parent, "data");
  await mkdir(join(owlRoot, "knowledge", "works"), { recursive: true });
  await mkdir(join(owlRoot, "knowledge", "policies"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.sqlite"));
  t.after(() => db.close());
  db.migrate(migrations);
  const writeLane = db.createWriteLane();
  const knowledge = new KnowledgeBase(owlRoot);
  const notes = new KnowledgeNotes(knowledge, { now: () => "2026-09-27T00:00:00.000Z" });
  const ruleStore = { rules: { promptRules: [] } };
  const ruleProposals = new RuleProposals({
    db,
    writeLane,
    ruleStore,
    ruleWriter: { apply: async ({ level, role }) => ({ path: level === "system" ? "rules/system/test.yaml" : `rules/role/test-${role}.yaml`, generation: 1 }) },
    notes,
  });
  assert.equal(typeof migrationModule.migrateLegacyKnowledge, "function", "knowledge-migration must export migrateLegacyKnowledge");
  const migrate = (dry_run = false) => migrationModule.migrateLegacyKnowledge({ knowledge, notes, ruleProposals, dry_run });
  return { parent, owlRoot, knowledge, notes, ruleProposals, ruleStore, db, migrate };
}

async function legacyFile(root, folder, filename, body, frontmatter = "") {
  const header = frontmatter ? `---\n${frontmatter.trim()}\n---\n\n` : "";
  await writeFile(join(root, "knowledge", folder, filename), `${header}${body}`, "utf8");
}

async function seedNote(notes, owlRoot, { title, tags = [], text = "Existing release deployment note.", links = [] }) {
  const now = "2026-09-26T00:00:00.000Z";
  const source = createUlid();
  const note = {
    id: createUlid(), title, slug: slugifyKnowledgeName(title), tags, sources: [source], links,
    project_ids: [], created: now, updated: now, summary: text,
    claims: [{ fingerprint: fingerprint(text), kind: "fact", text, sources: [source] }], promotions: [],
  };
  const dir = join(owlRoot, "knowledge", "notes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${note.id}.md`), notes.render(note), "utf8");
  return note;
}

test("legacy migration preserves work sources and is idempotent", async (t) => {
  const f = await fixture(t);
  const workId = "01M3F67FGFW0HZZAE2RM7CN5X5";
  const sourcePath = join(f.owlRoot, "knowledge", "works", "01M3C9K2H57SXKKCM839ZGNMHC-Release-process.md");
  await legacyFile(f.owlRoot, "works", "01M3C9K2H57SXKKCM839ZGNMHC-Release-process.md", "- Validate the release before publishing.\n  根拠: A partial release was published.\n  当てはまる場面: Release work", `work_id: ${workId}\ntags: [auto-saved, work-lessons]`);
  const sourceBefore = await readFile(sourcePath, "utf8");

  const first = await f.migrate();
  assert.equal(first.works_files, 1);
  assert.equal(first.claims_added, 1);
  assert.equal(first.notes_created, 1);
  assert.deepEqual(first.link_check.dangling, []);
  assert.deepEqual(first.link_check.one_way, []);
  const note = (await f.notes.list())[0];
  assert.ok(note.claims[0].text.includes("当てはまる場面: Release work"));
  assert.deepEqual(note.claims[0].sources, [workId]);
  assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);

  const second = await f.migrate();
  assert.equal(second.notes_created, 0);
  assert.equal(second.claims_added, 0);
  assert.equal(second.rule_proposals_created, 0);
  assert.equal((await f.notes.list()).length, 1);
});

test("a work without a ULID uses the legacy-unknown fallback", async (t) => {
  const f = await fixture(t);
  await legacyFile(f.owlRoot, "works", "run.md", "- Record the run result before closing the work.");
  const filenameWorkId = "01M3C9K2H57SXKKCM839ZGNMHC";
  await legacyFile(f.owlRoot, "works", `${filenameWorkId}-Filename-source.md`, "- Preserve the filename source identity.");
  await f.migrate();
  const manifest = JSON.parse(await readFile(join(f.owlRoot, "knowledge", "notes", ".migration.json"), "utf8"));
  assert.equal(manifest["works/run.md"].work_id, "legacy-unknown");
  assert.equal(manifest[`works/${filenameWorkId}-Filename-source.md`].work_id, filenameWorkId);
  const notes = await f.notes.list();
  assert.equal(notes.length, 2);
  assert.ok(notes.some((note) => note.claims.some((claim) => claim.sources.includes(filenameWorkId))));
});

test("numbered legacy work lessons are preserved as separate claims", async (t) => {
  const f = await fixture(t);
  await legacyFile(f.owlRoot, "works", "numbered.md", "1. Preserve the first lesson.\n\n2. Preserve the second lesson.");
  const result = await f.migrate();
  assert.equal(result.claims_added, 2);
  assert.deepEqual((await f.notes.list())[0].claims.map((claim) => claim.text.split("\n", 1)[0]), [
    "Preserve the first lesson.",
    "Preserve the second lesson.",
  ]);
});

test("ambiguous topic links are mutual and pass link_check (a)", async (t) => {
  const f = await fixture(t);
  const one = await seedNote(f.notes, f.owlRoot, { title: "Release deployment alpha", tags: ["release", "deployment", "validate"] });
  const two = await seedNote(f.notes, f.owlRoot, { title: "Release deployment beta", tags: ["release", "deployment", "validate"] });
  await legacyFile(f.owlRoot, "works", "Release-deployment.md", "- Validate release deployment state before publishing.");

  const result = await f.migrate();
  const migrated = (await f.notes.list()).find((note) => note.claims.some((claim) => claim.text.startsWith("Validate release deployment")));
  assert.ok(migrated);
  assert.deepEqual([...migrated.links].sort(), [one.id, two.id].sort());
  assert.ok((await f.notes.get(one.id)).links.includes(migrated.id));
  assert.ok((await f.notes.get(two.id)).links.includes(migrated.id));
  assert.deepEqual(result.link_check.dangling, []);
  assert.deepEqual(result.link_check.one_way, []);
});

test("link_check reports preexisting one-way and dangling links without repairing them (b)", async (t) => {
  const f = await fixture(t);
  const target = await seedNote(f.notes, f.owlRoot, { title: "Target note" });
  const missing = createUlid();
  const source = await seedNote(f.notes, f.owlRoot, { title: "Source note", links: [target.id, missing] });
  await legacyFile(f.owlRoot, "works", "Unrelated.md", "- Preserve the unrelated source record.");
  const sourcePath = join(f.owlRoot, "knowledge", "notes", `${source.id}.md`);
  const before = await readFile(sourcePath, "utf8");

  const result = await f.migrate();
  assert.deepEqual(result.link_check.one_way, [{ from: source.id, to: target.id }]);
  assert.deepEqual(result.link_check.dangling, [{ note_id: source.id, target: missing }]);
  assert.equal(await readFile(sourcePath, "utf8"), before);
  assert.deepEqual((await f.notes.get(target.id)).links, []);
});

test("dry_run returns link_check and counts without writing notes or a manifest (c)", async (t) => {
  const f = await fixture(t);
  await seedNote(f.notes, f.owlRoot, { title: "Unrelated note" });
  await legacyFile(f.owlRoot, "works", "dry-run.md", "- Record this source without writing in dry run.");
  const notesDir = join(f.owlRoot, "knowledge", "notes");
  const before = (await readdir(notesDir)).sort();
  const beforeContents = await Promise.all(before.map((name) => readFile(join(notesDir, name), "utf8")));

  const result = await f.migrate(true);
  assert.equal(result.works_files, 1);
  assert.equal(result.claims_added, 1);
  assert.ok(result.link_check);
  assert.deepEqual((await readdir(notesDir)).sort(), before);
  const afterContents = await Promise.all(before.map((name) => readFile(join(notesDir, name), "utf8")));
  assert.deepEqual(afterContents, beforeContents);
  const actual = await f.migrate();
  for (const field of ["notes_created", "notes_updated", "claims_added", "rule_proposals_created"]) {
    assert.equal(result[field], actual[field], `${field} dry-run count matches the migration`);
  }
});

test("Core exposes migrateLegacyKnowledge for the server API", async (t) => {
  const f = await fixture(t);
  await legacyFile(f.owlRoot, "works", "core-api.md", "- Preserve this through the Core method.");
  const core = new Core({ db: f.db, agentRunner: {}, version: "migration-test", owlRoot: f.owlRoot, dataDir: join(f.parent, "data") });

  const result = await core.migrateLegacyKnowledge({ dry_run: true });
  assert.equal(result.works_files, 1);
  assert.equal(result.claims_added, 1);
});

test("each policy block gets a path#n source and owner-approved still requires approval", async (t) => {
  const f = await fixture(t);
  await legacyFile(f.owlRoot, "policies", "two-rules.md", "- Validate deployment input before writing.\n  根拠: First source.\n  適用範囲: all\n\n- Keep deployment output immutable.\n  根拠: Second source.\n  適用範囲: all", "work_id: 01M3F67FGFW0HZZAE2RM7CN5X5\ntags: [owner-approved]");

  const result = await f.migrate();
  assert.equal(result.rule_proposals_created, 2);
  const sources = f.db.all("SELECT source_ref, proposal_id FROM rule_proposal_sources WHERE source_kind='legacy_policy' ORDER BY source_ref");
  assert.deepEqual(sources.map((row) => row.source_ref), ["policies/two-rules.md#1", "policies/two-rules.md#2"]);
  assert.notEqual(sources[0].proposal_id, sources[1].proposal_id);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposals WHERE status='awaiting_approval'").n, 2);
});

test("equal policy text with all and worker scopes creates distinct proposals", async (t) => {
  const f = await fixture(t);
  await legacyFile(f.owlRoot, "policies", "scopes.md", "- Validate deployment input before writing.\n  適用範囲: all\n\n- Validate deployment input before writing.\n  適用範囲: worker", "work_id: 01M3F67FGFW0HZZAE2RM7CN5X5");

  await f.migrate();
  const rows = f.db.all("SELECT p.level, p.role, s.source_ref, s.proposal_id FROM rule_proposal_sources s JOIN rule_proposals p ON p.id=s.proposal_id WHERE s.source_kind='legacy_policy' ORDER BY s.source_ref");
  assert.deepEqual(rows.map(({ level, role, source_ref }) => [level, role, source_ref]), [
    ["system", null, "policies/scopes.md#1"],
    ["role", "worker", "policies/scopes.md#2"],
  ]);
  assert.notEqual(rows[0].proposal_id, rows[1].proposal_id);
});

test("dry_run counts only policies not merged into an existing pending proposal", async (t) => {
  const f = await fixture(t);
  const text = "Validate deployment input before writing.";
  const existing = await f.ruleProposals.create({
    origin: "legacy_policy",
    source: { kind: "legacy_policy", ref: "existing-policy.md#1" },
    level: "system",
    text,
    rationale: "Existing proposal.",
    applies_to: "deployment",
  });
  assert.equal(existing.status, "awaiting_approval");
  await legacyFile(f.owlRoot, "policies", "same-rule.md", `- ${text}\n  適用範囲: all`);

  const dryRun = await f.migrate(true);
  const actual = await f.migrate();
  assert.equal(dryRun.rule_proposals_created, actual.rule_proposals_created);
  assert.equal(actual.rule_proposals_created, 0);
});

test("dry_run and execution count zero when an identical scoped proposal was rejected", async (t) => {
  const f = await fixture(t);
  const text = "Validate deployment input before writing.";
  const proposal = await f.ruleProposals.create({
    origin: "legacy_policy",
    source: { kind: "legacy_policy", ref: "rejected-policy.md#1" },
    level: "system",
    text,
    rationale: "Rejected proposal.",
    applies_to: "deployment",
  });
  await f.ruleProposals.reject(proposal.proposal_id);
  await legacyFile(f.owlRoot, "policies", "same-rule.md", `- ${text}\n  適用範囲: all`);

  const dryRun = await f.migrate(true);
  const actual = await f.migrate();
  assert.equal(dryRun.rule_proposals_created, 0);
  assert.equal(actual.rule_proposals_created, 0);
});

test("dry_run and execution count one rejection for a matching existing rule", async (t) => {
  const f = await fixture(t);
  const text = "Validate deployment input before writing.";
  f.ruleStore.rules.promptRules.push({ id: "existing-rule", level: "system", text, kind: "instruction" });
  await legacyFile(f.owlRoot, "policies", "same-rule.md", `- ${text}\n  適用範囲: all`);

  const dryRun = await f.migrate(true);
  const actual = await f.migrate();
  assert.equal(dryRun.rule_proposals_created, 1);
  assert.equal(actual.rule_proposals_created, 1);
  assert.equal(f.ruleProposals.list("rejected").length, 1);
});

test("dry_run and execution count zero when a matching applied proposal already exists", async (t) => {
  const f = await fixture(t);
  const text = "Validate deployment input before writing.";
  const proposal = await f.ruleProposals.create({
    origin: "legacy_policy",
    source: { kind: "legacy_policy", ref: "approved-policy.md#1" },
    level: "system",
    text,
    rationale: "Approved proposal.",
    applies_to: "deployment",
  });
  await f.ruleProposals.approve(proposal.proposal_id);
  f.ruleStore.rules.promptRules.push({ id: "applied-rule", level: "system", text, kind: "instruction" });
  await legacyFile(f.owlRoot, "policies", "same-rule.md", `- ${text}\n  適用範囲: all`);

  const dryRun = await f.migrate(true);
  const actual = await f.migrate();
  assert.equal(dryRun.rule_proposals_created, 0);
  assert.equal(actual.rule_proposals_created, 0);
});

test("dry_run counts one proposal for duplicate same-scope blocks in a policy file", async (t) => {
  const f = await fixture(t);
  const text = "Validate deployment input before writing.";
  await legacyFile(f.owlRoot, "policies", "duplicate-rules.md", `- ${text}\n  適用範囲: all\n\n- ${text}\n  適用範囲: all`);

  const dryRun = await f.migrate(true);
  const actual = await f.migrate();
  assert.equal(dryRun.rule_proposals_created, actual.rule_proposals_created);
  assert.equal(actual.rule_proposals_created, 1);
});
