import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid, openDatabase } from "../../packages/db/dist/index.js";
import { metricsRuleCandidates, proposeFromMetrics } from "../../packages/core/dist/learning-metrics.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const MIGRATION = "057_rule_proposal_origin_metrics.sql";
const INDEXES = ["rule_proposal_sources_proposal", "rule_proposal_sources_text", "rule_proposals_key", "rule_proposals_open_key", "rule_proposals_status"];

test("the origin migration keeps proposals, sources, indexes and foreign keys, and accepts metrics only", async (t) => {
  const root = await tempDir(t, "owl-metrics-origin-migration-");
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: the test applies only the early migrations first
  t.after(() => db.close());
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes(MIGRATION));
  const early = join(root, "early");
  await mkdir(early);
  for (const name of files.filter((file) => file < MIGRATION)) await copyFile(join(migrations, name), join(early, name));
  db.migrate(early);

  const now = new Date().toISOString();
  const proposalId = createUlid();
  const sourceId = createUlid();
  const insertProposal = (tx, id, origin) => tx.run(
    `INSERT INTO rule_proposals (id, fingerprint, origin, level, role, text, rationale, applies_to, source_work_ids_json, status, created_at, updated_at)
     VALUES (?, ?, ?, 'role', 'worker', 'text', 'why', 'code', '[]', 'pending', ?, ?)`, id, `fp:${id}`, origin, now, now);
  const insertSource = (tx, id, proposal) => tx.run(
    `INSERT INTO rule_proposal_sources (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
     VALUES (?, 'work', ?, 'in', 'tx', ?, ?)`, id, `ref:${id}`, proposal, now);
  await db.createWriteLane().transact((tx) => {
    insertProposal(tx, proposalId, "lesson");
    insertSource(tx, sourceId, proposalId);
    return null;
  });
  const before = {
    proposal: db.get("SELECT * FROM rule_proposals WHERE id = ?", proposalId),
    source: db.get("SELECT * FROM rule_proposal_sources WHERE id = ?", sourceId),
  };

  const applied = db.migrate(migrations);
  assert.ok(JSON.stringify(applied).includes("057"));
  assert.deepEqual(db.get("SELECT * FROM rule_proposals WHERE id = ?", proposalId), before.proposal);
  assert.deepEqual(db.get("SELECT * FROM rule_proposal_sources WHERE id = ?", sourceId), before.source);
  assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  const names = db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'rule_proposal%'").map((row) => row.name);
  assert.deepEqual(INDEXES.filter((name) => !names.includes(name)), []);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'rule_proposal_sources_copy'").n, 0);

  const run = (fn) => db.createWriteLane().transact((tx) => { fn(tx); return null; });
  await run((tx) => insertProposal(tx, createUlid(), "metrics"));
  await assert.rejects(run((tx) => insertProposal(tx, createUlid(), "unknown")), /CHECK constraint failed/);
  await assert.rejects(run((tx) => insertSource(tx, createUlid(), createUlid())), /FOREIGN KEY constraint failed/);
});

test("metrics proposals come only from low first-review pass rates, merge per type, stay suppressed after reject and never apply by themselves", async (t) => {
  const { db, core } = await createTestCore(t, {}, { prefix: "owl-metrics-proposals-" });
  const createWork = async (title) => (await core.createWork(command(
    { title, summary: "", size: "small", project_id: null }, `metrics-proposals:${title}`,
  ))).data.work_id;
  const workA = await createWork("A");
  const workB = await createWork("B");
  const now = new Date().toISOString();
  // type -> first-round verdicts. code and docs fall below 0.5; docs has too few Tasks; test passes first time.
  const seeded = { code: ["pass", "pass", ...Array(8).fill("fix_required")], docs: Array(3).fill("fix_required"), test: Array(10).fill("pass") };
  await db.createWriteLane().transact((tx) => {
    tx.run("PRAGMA ignore_check_constraints = ON");
    for (const [type, verdicts] of Object.entries(seeded)) {
      verdicts.forEach((verdict, index) => {
        const taskId = `${type}-${index}`;
        tx.run(
          `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'completed', 'normal', '', '', ?, ?)`, taskId, workA, taskId, type, now, now);
        tx.run(
          `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
           VALUES (?, ?, 0, ?, '[]', '{}', ?)`, `r-${taskId}`, taskId, verdict, now);
        // A later passing round must not change the first-review rate.
        tx.run(
          `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
           VALUES (?, ?, 1, 'pass', '[]', '{}', ?)`, `r2-${taskId}`, taskId, now);
      });
    }
    tx.run("PRAGMA ignore_check_constraints = OFF");
    return null;
  });

  const settings = { enabled: true, min_tasks: 5, first_review_pass_rate_below: 0.5, rationale_max_ids: 3 };
  const candidates = metricsRuleCandidates(db, settings);
  assert.deepEqual(candidates.map((c) => [c.task_type, c.first_review_pass_rate, c.tasks]), [["code", 0.2, 10]]);
  assert.deepEqual(metricsRuleCandidates(db, { ...settings, min_tasks: 3 }).map((c) => c.task_type), ["code", "docs"]);
  assert.deepEqual(metricsRuleCandidates(db, { ...settings, first_review_pass_rate_below: 0.2 }), []);
  assert.deepEqual(metricsRuleCandidates(db, { ...settings, enabled: false }), []);

  const propose = (list = candidates, max_ids = 3) => proposeFromMetrics(core.ruleProposals, list, { project_id: null, language: "en", max_ids });
  const [first] = await propose();
  assert.equal(first.status, "pending", "one snapshot is one source, below the minimum of two");
  const [again] = await propose();
  assert.equal(again.already_recorded, true);

  // The source is the aggregate, not a Work; the rationale keeps scope, count, period and IDs (capped, with the total).
  const sources = db.all("SELECT source_kind, source_ref FROM rule_proposal_sources WHERE proposal_id = ?", first.proposal_id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].source_kind, "metrics_snapshot");
  assert.ok(sources[0].source_ref.startsWith("metrics:code:"));
  assert.ok(![workA, workB].includes(sources[0].source_ref));
  const rationale = db.get("SELECT rationale FROM rule_proposals WHERE id = ?", first.proposal_id).rationale;
  assert.match(rationale, /type=code/);
  assert.match(rationale, /tasks=10/);
  assert.ok(rationale.includes(`${now} .. ${now}`));
  assert.ok(rationale.includes("tasks(10, first 3)=code-0,code-1,code-2"));
  assert.ok(rationale.includes(`works(1)=${workA}`));

  // A changed aggregate is a new source that merges into the same proposal.
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES ('code-x', ?, 'x', 'code', 'completed', 'normal', '', '', ?, ?)`, workB, now, now);
    tx.run(
      `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
       VALUES ('r-code-x', 'code-x', 0, 'fix_required', '[]', '{}', ?)`, now);
    return null;
  });
  const [second] = await propose(metricsRuleCandidates(db, settings));
  assert.equal(second.proposal_id, first.proposal_id);
  assert.equal(second.status, "awaiting_approval");
  const open = core.listRuleProposals("awaiting_approval");
  assert.equal(open.length, 1);
  assert.equal(open[0].origin, "metrics");
  assert.equal(open[0].source_count, 2);
  const merged = db.get("SELECT rationale FROM rule_proposals WHERE id = ?", first.proposal_id).rationale;
  assert.match(merged, /tasks=11/);
  assert.ok(merged.includes("tasks(11, first 3)"));
  assert.ok(merged.includes(`works(2)=${workA},${workB}`));
  assert.notEqual(open[0].status, "applied");
  assert.equal(core.listRuleProposals("applied").length, 0);

  await core.rejectRuleProposal(first.proposal_id);
  await db.createWriteLane().transact((tx) => { tx.run("UPDATE reviews SET verdict='fix_required' WHERE id='r-code-0'"); return null; });
  const [suppressed] = await propose(metricsRuleCandidates(db, settings));
  assert.equal(suppressed.status, "rejected");
  assert.equal(core.listRuleProposals("awaiting_approval").length, 0);
});

test("the snapshot migration keeps proposals and sources and accepts metrics_snapshot", async (t) => {
  const root = await tempDir(t, "owl-metrics-snapshot-migration-");
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: the test applies only the early migrations first
  t.after(() => db.close());
  const name = "059_rule_proposal_source_metrics_snapshot.sql";
  const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort();
  assert.ok(files.includes(name));
  const early = join(root, "early");
  await mkdir(early);
  for (const file of files.filter((f) => f < name)) await copyFile(join(migrations, file), join(early, file));
  db.migrate(early);
  const now = new Date().toISOString();
  const insertSource = (tx, id, kind, proposal) => tx.run(
    `INSERT INTO rule_proposal_sources (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
     VALUES (?, ?, ?, 'in', 'tx', ?, ?)`, id, kind, `ref:${id}`, proposal, now);
  const proposalId = createUlid();
  const sourceId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO rule_proposals (id, fingerprint, origin, level, role, text, rationale, applies_to, source_work_ids_json, status, created_at, updated_at)
       VALUES (?, 'fp', 'metrics', 'role', 'worker', 't', 'why', 'code', '[]', 'pending', ?, ?)`, proposalId, now, now);
    insertSource(tx, sourceId, "work", proposalId);
    return null;
  });
  const before = db.get("SELECT * FROM rule_proposal_sources WHERE id = ?", sourceId);
  const run = (fn) => db.createWriteLane().transact((tx) => { fn(tx); return null; });
  await assert.rejects(run((tx) => insertSource(tx, createUlid(), "metrics_snapshot", proposalId)), /CHECK constraint failed/);

  db.migrate(migrations);
  assert.deepEqual(db.get("SELECT * FROM rule_proposal_sources WHERE id = ?", sourceId), before);
  assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  const names = db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'rule_proposal%'").map((row) => row.name);
  assert.deepEqual(INDEXES.filter((n) => !names.includes(n)), []);
  await run((tx) => insertSource(tx, createUlid(), "metrics_snapshot", proposalId));
  await assert.rejects(run((tx) => insertSource(tx, createUlid(), "bogus", proposalId)), /CHECK constraint failed/);
  await assert.rejects(run((tx) => insertSource(tx, createUlid(), "work", createUlid())), /FOREIGN KEY constraint failed/);
});
