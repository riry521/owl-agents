import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import * as fingerprints from "../packages/core/dist/learning-fingerprint.js";

const { fingerprint, lessonFingerprint, ruleKeyFingerprint } = fingerprints;

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const migrations = join(repoRoot, "packages/db/migrations");
const pipelineModule = await import("../packages/core/dist/learning-pipeline.js").catch(() => ({}));
const proposalModule = await import("../packages/core/dist/rule-proposals.js").catch(() => ({}));

const lesson = (kind, overrides = {}) => ({
  lesson: `${kind} lesson`, basis: "Observed in this Work", applies_to: "future Work",
  kind, topic: "deployment", procedure: "1. Validate the inputs before writing any deployment state.",
  rule_text: "Do not deploy without checking the release state.", rule_scope: "all", ...overrides,
});

async function fixture(t, { pipelineOptions = {}, skillHook, noteHook } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "owl-learning-pipeline-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const db = openDatabase(join(parent, "owl.db"));
  t.after(() => db.close());
  db.migrate(migrations);
  const writeLane = db.createWriteLane();
  const now = new Date().toISOString();
  const workId = createUlid();
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', NULL, 'Learning fixture', 'x', 'normal', 'completed', '[]', '[]', ?, ?)`,
      workId, now, now,
    );
  });
  assert.equal(typeof pipelineModule.LearningJobs, "function", "learning-pipeline must export LearningJobs");
  assert.equal(typeof pipelineModule.LearningPipeline, "function", "learning-pipeline must export LearningPipeline");
  assert.equal(typeof proposalModule.RuleProposals, "function", "rule-proposals must export RuleProposals");
  const jobs = new pipelineModule.LearningJobs({ db, writeLane });
  const ruleProposals = new proposalModule.RuleProposals({ db, writeLane, ruleStore: { rules: { promptRules: [] } } });
  const skillBox = {
    async insertProposals(agentRunId, sourceWorkId, projectId, proposals) {
      if (skillHook) await skillHook({ agentRunId, sourceWorkId, projectId, proposals, db, writeLane });
      const ids = [];
      for (const proposal of proposals) {
        const rows = db.all("SELECT id, payload_json FROM skill_proposals WHERE source_work_id = ?", sourceWorkId);
        const existing = rows.find((row) => {
          const payload = JSON.parse(row.payload_json);
          return payload.source_fingerprint === proposal.source_fingerprint
            || payload.steps_or_diff === proposal.steps_or_diff;
        });
        if (existing) { ids.push(existing.id); continue; }
        const id = createUlid();
        const now = new Date().toISOString();
        await writeLane.transact((tx) => tx.run(
          `INSERT INTO skill_proposals
            (id, kind, target_skill, payload_json, source_work_id, source_agent_run_id, project_id, status, attempts, created_at, updated_at)
           VALUES (?, 'new', NULL, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          id, JSON.stringify(proposal), sourceWorkId, agentRunId, projectId, now, now,
        ));
        ids.push(id);
      }
      return ids;
    },
  };
  const notes = { records: [], mergeCount: 0,
    async list() { return this.records; },
    async mergeClaim(input) {
      if (noteHook) await noteHook(input);
      this.mergeCount += 1;
      const claimFingerprint = fingerprint(input.text);
      const existing = this.records.find((entry) => entry.claims.some((claim) => claim.fingerprint === claimFingerprint));
      if (existing) {
        const claim = existing.claims.find((item) => item.fingerprint === claimFingerprint);
        claim.sources = [...new Set([...claim.sources, input.work_id])];
        return { note_id: existing.id, created: false, added: false };
      }
      const id = createUlid();
      this.records.push({ id, title: input.topic, claims: [{ fingerprint: claimFingerprint, sources: [input.work_id] }] });
      return { note_id: id, created: true, added: true };
    },
  };
  const pipeline = new pipelineModule.LearningPipeline({
    db, writeLane, skillBox, notes, ruleProposals,
    debounce_ms: 0, ...pipelineOptions,
  });
  const row = () => db.get("SELECT * FROM learning_jobs WHERE work_id = ?", workId);
  return { db, writeLane, workId, jobs, pipeline, ruleProposals, skillBox, notes, row };
}

test("lesson fingerprints include the normalized lesson fields while preserving the existing fingerprint API", () => {
  assert.equal(typeof lessonFingerprint, "function", "lessonFingerprint must be exported");
  const left = lesson("procedure", { lesson: "  Hello   World " });
  const right = lesson("procedure", { lesson: "hello world" });
  assert.equal(lessonFingerprint(left), lessonFingerprint(right));
  assert.notEqual(lessonFingerprint(left), lessonFingerprint(lesson("procedure", { ...right, topic: "another topic" })));
  assert.equal(lessonFingerprint(left), fingerprint([left.kind, left.lesson, left.topic, left.procedure, left.rule_text, left.rule_scope].join("\n")));
  assert.equal(ruleKeyFingerprint("Do not deploy.", "role", "worker"), fingerprint("Do not deploy.\nrole\nworker"));
  assert.notEqual(ruleKeyFingerprint("Do not deploy.", "role", "worker"), ruleKeyFingerprint("Do not deploy.", "role", "reviewer"));
});

test("(a) enqueue unions pending lessons once and increments the payload version only for new fingerprints", async (t) => {
  const f = await fixture(t);
  await f.jobs.enqueue(f.workId, null, null, [lesson("fact", { lesson: "first" })]);
  await f.jobs.enqueue(f.workId, null, null, [lesson("fact", { lesson: "second" }), lesson("fact", { lesson: "first" })]);
  const row = f.row();
  assert.equal(row.status, "pending");
  assert.equal(row.payload_version, 2);
  assert.deepEqual(JSON.parse(row.payload_json).lessons.map((item) => item.lesson), ["first", "second"]);
});

test("(e) a repeated enqueue of identical lessons changes neither payload version nor status", async (t) => {
  const f = await fixture(t);
  const value = lesson("fact", { lesson: "same" });
  await f.jobs.enqueue(f.workId, null, null, [value]);
  await f.jobs.enqueue(f.workId, null, null, [value]);
  const row = f.row();
  assert.equal(row.payload_version, 1);
  assert.equal(row.status, "pending");
});

test("batch_size limits a pass and requestRun uses the configured debounce", async (t) => {
  const f = await fixture(t, { pipelineOptions: { batch_size: 1, debounce_ms: 1 } });
  const anotherWork = createUlid();
  const now = new Date().toISOString();
  await f.writeLane.transact((tx) => tx.run(
    `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
     VALUES (?, 'owner:default', NULL, 'Second Work', 'x', 'normal', 'completed', '[]', '[]', ?, ?)`,
    anotherWork, now, now,
  ));
  await f.jobs.enqueue(f.workId, null, null, [lesson("fact", { lesson: "first work fact" })]);
  await f.jobs.enqueue(anotherWork, null, null, [lesson("fact", { lesson: "second work fact" })]);
  await f.pipeline.processPending();
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM learning_jobs WHERE status='done'").n, 1);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM learning_jobs WHERE status='pending'").n, 1);
  await f.pipeline.requestRun();
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM learning_jobs WHERE status='done'").n, 2);
});

test("(b) a new lesson reopens failed jobs while processed lessons remain idempotent", async (t) => {
  let fail = true;
  const f = await fixture(t, { pipelineOptions: { max_attempts: 1 }, noteHook: (input) => {
    if (fail && input.text.includes("will fail")) throw new Error("note unavailable");
  } });
  const done = lesson("fact", { lesson: "already processed" });
  const retry = lesson("fact", { lesson: "will fail once" });
  await f.jobs.enqueue(f.workId, null, null, [done, retry]);
  await f.pipeline.processPending();
  assert.equal(f.row().status, "failed");
  const processed = JSON.parse(f.row().result_json).processed;
  assert.deepEqual(processed, [lessonFingerprint(done)]);
  fail = false;
  const appended = lesson("fact", { lesson: "arrived after failure" });
  await f.jobs.enqueue(f.workId, null, null, [appended]);
  assert.equal(f.row().status, "pending");
  assert.equal(f.row().attempts, 0);
  await f.pipeline.processPending();
  assert.equal(f.row().status, "done");
  assert.deepEqual(JSON.parse(f.row().result_json).processed.sort(), [lessonFingerprint(done), lessonFingerprint(retry), lessonFingerprint(appended)].sort());
});

test("(c) enqueue on a done job reopens it and processes only the appended lesson", async (t) => {
  const calls = [];
  const f = await fixture(t, { noteHook: (input) => calls.push(input.text) });
  const first = lesson("fact", { lesson: "first note" });
  await f.jobs.enqueue(f.workId, null, null, [first]);
  await f.pipeline.processPending();
  assert.equal(f.row().status, "done");
  const second = lesson("fact", { lesson: "second note" });
  await f.jobs.enqueue(f.workId, null, null, [second]);
  assert.equal(f.row().status, "pending");
  await f.pipeline.processPending();
  assert.equal(f.row().status, "done");
  assert.deepEqual(calls, ["first note", "second note"]);
});

test("(d) enqueue during processing leaves the updated job pending for a second pass", async (t) => {
  let f;
  let nested = false;
  const calls = [];
  f = await fixture(t, { noteHook: async (input) => {
    calls.push(input.text);
    if (!nested) {
      nested = true;
      await f.jobs.enqueue(f.workId, null, null, [lesson("fact", { lesson: "appended while running" })]);
    }
  } });
  await f.jobs.enqueue(f.workId, null, null, [lesson("fact", { lesson: "first during run" })]);
  await f.pipeline.processPending();
  assert.equal(f.row().status, "pending");
  await f.pipeline.processPending();
  assert.equal(f.row().status, "done");
  assert.deepEqual(calls, ["first during run", "appended while running"]);
});

test("(f) stale running jobs are reclaimed to pending", async (t) => {
  const now = () => "2030-01-01T00:00:00.000Z";
  const f = await fixture(t, { pipelineOptions: { now, stale_running_ms: 60_000 } });
  await f.jobs.enqueue(f.workId, null, null, [lesson("fact")]);
  await f.writeLane.transact((tx) => tx.run("UPDATE learning_jobs SET status='running', updated_at='2029-12-31T23:00:00.000Z' WHERE work_id=?", f.workId));
  assert.equal(await f.pipeline.recoverStaleRunning(), 1);
  assert.equal(f.row().status, "pending");
});

test("retryJob resets a failed job and preserves the fingerprints already processed", async (t) => {
  let fail = true;
  const calls = [];
  const f = await fixture(t, { pipelineOptions: { max_attempts: 1 }, noteHook: (input) => {
    calls.push(input.text);
    if (fail && input.text === "transient failure") throw new Error("note unavailable");
  } });
  const done = lesson("fact", { lesson: "safe to keep" });
  const transient = lesson("pitfall", { lesson: "transient failure" });
  await f.jobs.enqueue(f.workId, null, null, [done, transient]);
  await f.pipeline.processPending();
  assert.equal(f.row().status, "failed");
  await f.pipeline.retryJob(f.row().id);
  assert.equal(f.row().status, "pending");
  assert.equal(f.row().attempts, 0);
  assert.deepEqual(JSON.parse(f.row().result_json).processed, [lessonFingerprint(done)]);
  fail = false;
  await f.pipeline.processPending();
  assert.equal(f.row().status, "done");
  assert.deepEqual(calls, ["safe to keep", "transient failure", "transient failure"]);
});

test("a note already sourced by the Work is a no-op after a crash before result_json", async (t) => {
  let crashOnce = true;
  const f = await fixture(t, { pipelineOptions: { afterOutput: () => { if (crashOnce) { crashOnce = false; throw new Error("simulated crash"); } } } });
  const fact = lesson("fact", { lesson: "The source already records this claim." });
  await f.jobs.enqueue(f.workId, null, null, [fact]);
  await assert.rejects(f.pipeline.processPending(), /simulated crash/u);
  assert.equal(f.notes.mergeCount, 1);
  await f.writeLane.transact((tx) => tx.run("UPDATE learning_jobs SET updated_at='2000-01-01T00:00:00.000Z' WHERE work_id=?", f.workId));
  await f.pipeline.recoverStaleRunning();
  await f.pipeline.processPending();
  assert.equal(f.notes.mergeCount, 1);
  assert.deepEqual(JSON.parse(f.row().result_json).note_ids, [f.notes.records[0].id]);
});

test("retrying a note already sourced by the Work does not schedule the Librarian", async (t) => {
  let crashOnce = true;
  let librarianRuns = 0;
  const f = await fixture(t, { pipelineOptions: {
    afterOutput: () => { if (crashOnce) { crashOnce = false; throw new Error("simulated crash"); } },
    onNotesChanged: () => { librarianRuns += 1; },
  } });
  await f.jobs.enqueue(f.workId, null, null, [lesson("fact", { lesson: "The source already records this claim." })]);
  await assert.rejects(f.pipeline.processPending(), /simulated crash/u);
  await f.writeLane.transact((tx) => tx.run("UPDATE learning_jobs SET updated_at='2000-01-01T00:00:00.000Z' WHERE work_id=?", f.workId));
  await f.pipeline.recoverStaleRunning();
  await f.pipeline.processPending();
  assert.equal(f.row().status, "done");
  assert.equal(librarianRuns, 0);
});

test("(g) rule source history prevents duplicate outputs after stale recovery or retry across final statuses", async (t) => {
  for (const [status, recovery] of [["applied", "stale"], ["rejected", "retry"]]) {
    const rule = lesson("rule_candidate", { lesson: `rule evidence ${status}` });
    let crashOnce = true;
    const f = await fixture(t, { pipelineOptions: { afterOutput: () => { if (crashOnce) { crashOnce = false; throw new Error("simulated crash"); } } } });
    await f.jobs.enqueue(f.workId, null, null, [rule]);
    await assert.rejects(f.pipeline.processPending(), /simulated crash/u);
    const proposal = f.db.get("SELECT id FROM rule_proposals");
    assert.ok(proposal);
    await f.writeLane.transact((tx) => tx.run("UPDATE rule_proposals SET status=? WHERE id=?", status, proposal.id));
    if (recovery === "stale") {
      await f.writeLane.transact((tx) => tx.run("UPDATE learning_jobs SET updated_at='2000-01-01T00:00:00.000Z' WHERE work_id=?", f.workId));
      await f.pipeline.recoverStaleRunning();
    } else {
      await f.writeLane.transact((tx) => tx.run("UPDATE learning_jobs SET status='failed', attempts=3 WHERE work_id=?", f.workId));
      await f.pipeline.retryJob(f.row().id);
    }
    await f.pipeline.processPending();
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 1);
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources").n, 1);
    const result = JSON.parse(f.row().result_json);
    assert.deepEqual(result.rule_proposal_ids, [proposal.id]);
    assert.deepEqual(result.processed, [lessonFingerprint(rule)]);
    assert.equal(f.db.get("SELECT state FROM works WHERE id=?", f.workId).state, "completed");
  }
});

test("(h) skill source fingerprints suppress duplicates across applied and rejected statuses", async (t) => {
  for (const status of ["applied", "rejected"]) {
    const procedure = lesson("procedure", { lesson: `procedure ${status}`, rule_text: "", procedure: "1. Validate deployment configuration before changing the system state." });
    let crashOnce = true;
    const f = await fixture(t, { pipelineOptions: { afterOutput: () => { if (crashOnce) { crashOnce = false; throw new Error("simulated crash"); } } } });
    await f.jobs.enqueue(f.workId, null, null, [procedure]);
    await assert.rejects(f.pipeline.processPending(), /simulated crash/u);
    const proposal = f.db.get("SELECT id, payload_json FROM skill_proposals");
    assert.ok(proposal);
    assert.equal(JSON.parse(proposal.payload_json).source_fingerprint, lessonFingerprint(procedure));
    await f.writeLane.transact((tx) => tx.run("UPDATE skill_proposals SET status=? WHERE id=?", status, proposal.id));
    await f.writeLane.transact((tx) => tx.run("UPDATE learning_jobs SET updated_at='2000-01-01T00:00:00.000Z' WHERE work_id=?", f.workId));
    await f.pipeline.recoverStaleRunning();
    await f.pipeline.processPending();
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM skill_proposals").n, 1);
    assert.deepEqual(JSON.parse(f.row().result_json).skill_proposal_ids, [proposal.id]);
  }
});

test("(i) same Work, different lessons, and identical rule text share one proposal but retain both sources", async (t) => {
  const first = lesson("rule_candidate", { lesson: "first evidence" });
  const second = lesson("rule_candidate", { lesson: "second evidence" });
  let outputCount = 0;
  const f = await fixture(t, { pipelineOptions: { afterOutput: () => {
    outputCount += 1;
    if (outputCount === 2) throw new Error("simulated crash after second source");
  } } });
  await f.jobs.enqueue(f.workId, null, null, [first, second]);
  await assert.rejects(f.pipeline.processPending(), /after second source/u);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 1);
  const sources = f.db.all("SELECT input_fingerprint, proposal_id FROM rule_proposal_sources ORDER BY input_fingerprint");
  assert.equal(sources.length, 2);
  assert.deepEqual(new Set(sources.map((source) => source.input_fingerprint)), new Set([lessonFingerprint(first), lessonFingerprint(second)]));
  assert.equal(new Set(sources.map((source) => source.proposal_id)).size, 1);
  const proposal = f.db.get("SELECT id FROM rule_proposals");
  await f.writeLane.transact((tx) => tx.run("UPDATE rule_proposals SET status='applied' WHERE id=?", proposal.id));
  await f.writeLane.transact((tx) => tx.run("UPDATE learning_jobs SET updated_at='2000-01-01T00:00:00.000Z' WHERE work_id=?", f.workId));
  await f.pipeline.recoverStaleRunning();
  await f.pipeline.processPending();
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 1);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources").n, 2);
  assert.equal(JSON.parse(f.row().result_json).rule_proposal_ids.length, 1);
});
