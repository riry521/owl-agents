import assert from "node:assert/strict";
import { test } from "node:test";

import { SkillBox } from "../../packages/core/dist/skill-box.js";
import { SkillCurator } from "../../packages/core/dist/skill-curator.js";
import { renderSkillMd } from "../../packages/core/dist/skill-files.js";
import { openTestDatabase } from "../helpers/db.mjs";

const DAY = 24 * 60 * 60 * 1000;

async function setup(t, initialTime = "2026-01-01T00:00:00.000Z") {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-skill-lifecycle-" });
  let time = initialTime;
  const now = () => time;
  const advance = (days) => { time = new Date(Date.parse(time) + days * DAY).toISOString(); };
  const skillBox = new SkillBox({ db, owlRoot: root, now });
  const curator = new SkillCurator({ db, skillBox, agentRunner: {}, now });
  return { root, db, now, advance, skillBox, curator };
}

function files(body) {
  return { "SKILL.md": renderSkillMd({ name: "release-procedure", description: "Release steps.", tags: ["release"], scope: "global" }, body) };
}

async function addSkill(skillBox, name, body, { scope = "global", trial = false, action = "create" } = {}) {
  const content = { "SKILL.md": renderSkillMd({ name, description: "Release steps.", tags: ["release"], scope }, body) };
  return skillBox.applyRevision({ name, files: content, meta: { description: "Release steps.", tags: ["release"], scope }, actor: "user", action, reason: "seed", trial });
}

async function addUsage(db, name, revision, verdict, note, id, at) {
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO skill_usages (agent_run_id, skill_name, revision, verdict, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, id, name, revision, verdict, note, at, at,
  ));
}

async function addPending(db, id) {
  const payload = { kind: "new", target: null, summary: `Procedure ${id}`, steps_or_diff: "Review the source, run the required checks, and preserve the verified result for the next release.", evidence: "The same procedure was repeated in separate tasks." };
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO skill_proposals (id, kind, payload_json, status, attempts, created_at, updated_at)
     VALUES (?, 'new', ?, 'pending', 0, ?, ?)`, id, JSON.stringify(payload), now, now,
  ));
}

function rejectionFor(proposal) {
  return {
    proposal_id: proposal.id,
    decision: "reject",
    judgement: { reusable: 0, work_specific: 0, relation: "different", confidence: 0.9 },
    skill: null,
    archive: [],
    reason: "This is not reusable.",
  };
}

test("trial ends after three current revision verdicts when no more than one is misleading", async (t) => {
  const { db, now, skillBox, curator } = await setup(t);
  await addSkill(skillBox, "release-procedure", "# Version one", { trial: true });
  await addUsage(db, "release-procedure", 1, "helpful", "Clear ordering.", "trial-1", now());
  await addUsage(db, "release-procedure", 1, "irrelevant", "Not used here.", "trial-2", now());
  await addUsage(db, "release-procedure", 1, "helpful", "The checks helped.", "trial-3", now());
  await curator.evaluateLifecycle();
  assert.equal(skillBox.getSkill("release-procedure").trial, 0);
  assert.equal(skillBox.getSkill("release-procedure").state, "active");
});

test("misleading trial feedback rolls an update back and archives a new skill", async (t) => {
  const { db, now, skillBox, curator } = await setup(t);
  await addSkill(skillBox, "release-procedure", "# Version one");
  await skillBox.applyRevision({ name: "release-procedure", files: files("# Version two"), meta: { description: "Release steps.", tags: ["release"], scope: "global" }, actor: "curator", action: "update", reason: "trial revision", trial: true });
  await addUsage(db, "release-procedure", 2, "misleading", "The command was wrong.", "bad-1", now());
  await addUsage(db, "release-procedure", 2, "misleading", "This skipped a required check.", "bad-2", now());
  await addSkill(skillBox, "new-release-flow", "# New release flow", { trial: true });
  await addUsage(db, "new-release-flow", 1, "misleading", "Incorrect order.", "new-bad-1", now());
  await addUsage(db, "new-release-flow", 1, "misleading", "The instructions were unsafe.", "new-bad-2", now());

  await curator.evaluateLifecycle();
  assert.match(await skillBox.readFile("release-procedure", "SKILL.md"), /Version one/u);
  assert.equal(skillBox.getSkill("release-procedure").current_revision, 3);
  assert.equal(skillBox.listRevisions("release-procedure")[0].action, "rollback");
  assert.equal(skillBox.getSkill("release-procedure").trial, 0);
  assert.equal(skillBox.getSkill("new-release-flow").state, "archived");

  await addUsage(db, "release-procedure", 2, "misleading", "A verdict arrived late.", "late-old-verdict", now());
  const currentRevision = skillBox.getSkill("release-procedure").current_revision;
  await curator.evaluateLifecycle();
  assert.equal(skillBox.getSkill("release-procedure").current_revision, currentRevision);
  assert.equal(skillBox.getSkill("release-procedure").state, "active");
});

test("recent current revision feedback creates one automatic update proposal", async (t) => {
  const { db, now, skillBox, curator } = await setup(t);
  await addSkill(skillBox, "release-procedure", "# Version one");
  const verdicts = ["misleading", "misleading", "irrelevant", "irrelevant", "irrelevant"];
  for (let index = 0; index < verdicts.length; index += 1) {
    await addUsage(db, "release-procedure", 1, verdicts[index], `Feedback note ${index + 1}.`, `auto-${index}`, now());
  }
  await curator.evaluateLifecycle();
  await curator.evaluateLifecycle();
  let proposals = db.all("SELECT * FROM skill_proposals WHERE target_skill = 'release-procedure'");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "update");
  assert.equal(proposals[0].status, "pending");
  await db.createWriteLane().transact((tx) => tx.run("UPDATE skill_proposals SET status = 'rejected' WHERE id = ?", proposals[0].id));
  await curator.evaluateLifecycle();
  proposals = db.all("SELECT * FROM skill_proposals WHERE target_skill = 'release-procedure'");
  assert.equal(proposals.length, 1, "a rejected automatic proposal is not regenerated for the same revision");
});

test("a proposal matching a project skill from another or no project promotes it to global", async (t) => {
  const { root, db, skillBox, now } = await setup(t);
  await addSkill(skillBox, "release-procedure", "# Existing release process", { scope: "project:project-one" });
  await addSkill(skillBox, "release-null", "# Existing null project process", { scope: "project:project-one" });
  const nowText = now();
  const payload = { kind: "new", target: null, summary: "Release procedure", steps_or_diff: "Review the release, run the required checks, and publish the verified result.", evidence: "This same workflow appeared in another project." };
  const nullPayload = { ...payload, kind: "update", target: "release-null", summary: "Release null procedure" };
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO skill_proposals (id, kind, payload_json, project_id, status, attempts, created_at, updated_at)
     VALUES ('promotion-b', 'new', ?, 'project-two', 'pending', 0, ?, ?)`, JSON.stringify(payload), nowText, nowText,
  ));
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, project_id, status, attempts, created_at, updated_at)
     VALUES ('promotion-null', 'update', 'release-null', ?, NULL, 'pending', 0, ?, ?)`, JSON.stringify(nullPayload), nowText, nowText,
  ));
  const agentRunner = { runCurator: async () => ({ ok: true, results: [
    {
      proposal_id: "promotion-b", decision: "update", judgement: { reusable: 1.5, work_specific: 0.1, relation: "same", confidence: 0.9 },
      skill: { name: "release-procedure", description: "Release steps.", tags: ["release"], files: [{ path: "SKILL.md", content: "# Improved release process\n\nRun the checks before publishing." }] },
      archive: [], reason: "The same steps were independently proposed.",
    },
    {
      proposal_id: "promotion-null", decision: "update", judgement: { reusable: 1.5, work_specific: 0.1, relation: "extends", confidence: 0.9 },
      skill: { name: "release-null", description: "Release steps.", tags: ["release"], files: [{ path: "SKILL.md", content: "# Improved null project process\n\nRun the checks before publishing." }] },
      archive: [], reason: "The same steps were independently proposed.",
    },
  ] }) };
  const curator = new SkillCurator({ db, skillBox, agentRunner, now });
  await curator.processPending();
  assert.equal(skillBox.getSkill("release-procedure").scope, "global");
  assert.deepEqual(skillBox.listRevisions("release-procedure").slice(0, 2).map((entry) => entry.action), ["update", "scope_change"]);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = 'promotion-b'").status, "applied");
  assert.equal(skillBox.getSkill("release-null").scope, "global");
  assert.deepEqual(skillBox.listRevisions("release-null").slice(0, 2).map((entry) => entry.action), ["update", "scope_change"]);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = 'promotion-null'").status, "applied");
  void root;
});

test("active skills become stale after inactivity, stale skills archive later, and helpful use revives them", async (t) => {
  const { db, now, advance, skillBox, curator } = await setup(t);
  await addSkill(skillBox, "release-procedure", "# Release procedure");
  await addSkill(skillBox, "release-revival", "# Revival procedure");
  advance(61);
  await curator.evaluateLifecycle();
  assert.equal(skillBox.getSkill("release-procedure").state, "stale");
  assert.equal(skillBox.getSkill("release-revival").state, "stale");
  await addUsage(db, "release-revival", 1, "helpful", "Useful again.", "revive-1", now());
  await curator.evaluateLifecycle();
  assert.equal(skillBox.getSkill("release-revival").state, "active");
  advance(30);
  await curator.evaluateLifecycle();
  assert.equal(skillBox.getSkill("release-procedure").state, "archived");
  assert.equal(skillBox.getSkill("release-revival").state, "active");
});

test("pending reservations during a Curator run collapse into one follow-up", async (t) => {
  const { root, db, skillBox } = await setup(t);
  await addPending(db, "queued-one");
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const agentRunner = { runCurator: async (request) => {
    calls.push(request.proposals.map((proposal) => proposal.id));
    if (calls.length === 1) { started(); await gate; }
    return { ok: true, results: request.proposals.map(rejectionFor) };
  } };
  const curator = new SkillCurator({ db, skillBox, agentRunner });
  const first = curator.processPending();
  await startedPromise;
  await addPending(db, "queued-two");
  const second = curator.processPending();
  const third = curator.processPending();
  assert.strictEqual(second, third);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [["queued-one"], ["queued-two"]]);
});

test("attempts persist before the LLM call and failed pending proposals are picked up again", async (t) => {
  const { root, db, skillBox } = await setup(t);
  await addPending(db, "retry-proposal");
  let started;
  let release;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const agentRunner = { runCurator: async () => {
    calls += 1;
    if (calls === 1) { started(); await gate; }
    return { ok: false, error: "provider stopped" };
  } };
  const curator = new SkillCurator({ db, skillBox, agentRunner });
  const first = curator.processPending();
  await startedPromise;
  assert.equal(db.get("SELECT attempts FROM skill_proposals WHERE id = 'retry-proposal'").attempts, 1);
  release();
  await first;
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = 'retry-proposal'").status, "pending");
  await curator.processPending();
  assert.equal(db.get("SELECT attempts FROM skill_proposals WHERE id = 'retry-proposal'").attempts, 2);
  await curator.processPending();
  assert.equal(db.get("SELECT attempts, status FROM skill_proposals WHERE id = 'retry-proposal'").attempts, 3);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = 'retry-proposal'").status, "rejected");
  assert.equal(calls, 3);
});

test("a runner without runCurator leaves pending proposals untouched", async (t) => {
  const { db, skillBox } = await setup(t);
  await addPending(db, "stub-pending");
  const warnings = [];
  const curator = new SkillCurator({ db, skillBox, agentRunner: {}, logger: { warn: (message) => warnings.push(message), error() {} } });
  await curator.processPending();
  assert.equal(db.get("SELECT attempts FROM skill_proposals WHERE id = 'stub-pending'").attempts, 0);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = 'stub-pending'").status, "pending");
  assert.equal(warnings.length, 1);
});

test("a crashed third attempt is rejected without a fourth Curator call", async (t) => {
  const { db, skillBox } = await setup(t);
  await addPending(db, "crashed-third-attempt");
  await db.createWriteLane().transact((tx) => tx.run("UPDATE skill_proposals SET attempts = 3 WHERE id = 'crashed-third-attempt'"));
  let calls = 0;
  const curator = new SkillCurator({ db, skillBox, agentRunner: { runCurator: async () => { calls += 1; return { ok: false, error: "unexpected" }; } } });
  await curator.processPending();
  assert.equal(calls, 0);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = 'crashed-third-attempt'").status, "rejected");
});

test("the periodic tick reconciles, evaluates lifecycle rules, and retries pending proposals", async (t) => {
  const { db, now, advance, skillBox } = await setup(t);
  await addSkill(skillBox, "release-procedure", "# Release procedure");
  await addPending(db, "tick-pending");
  advance(61);
  let calls = 0;
  const curator = new SkillCurator({
    db,
    skillBox,
    now,
    agentRunner: { runCurator: async (request) => {
      calls += 1;
      return { ok: true, results: request.proposals.map(rejectionFor) };
    } },
  });
  await curator.tick();
  assert.equal(skillBox.getSkill("release-procedure").state, "stale");
  assert.equal(db.get("SELECT status, attempts FROM skill_proposals WHERE id = 'tick-pending'").status, "rejected");
  assert.equal(db.get("SELECT attempts FROM skill_proposals WHERE id = 'tick-pending'").attempts, 1);
  assert.equal(calls, 1);
});

test("unused trial skills go stale after trial_unused_days and archive later, without being reported as graduated", async (t) => {
  const { db, now, advance, skillBox, curator } = await setup(t);
  await addSkill(skillBox, "unused-trial", "# Unused", { trial: true });
  await addSkill(skillBox, "used-trial", "# Used", { trial: true });
  await addUsage(db, "used-trial", 1, "helpful", "Fine.", "used-1", now());
  advance(10);
  await addSkill(skillBox, "fresh-trial", "# Fresh", { trial: true });
  advance(5);
  const result = await curator.curate();
  assert.equal(skillBox.getSkill("unused-trial").state, "stale");
  assert.equal(skillBox.getSkill("used-trial").state, "active");
  assert.equal(skillBox.getSkill("fresh-trial").state, "active");
  assert.equal(result.trial_results.find((r) => r.skill === "unused-trial").result, "continuing");
  advance(31);
  await curator.evaluateLifecycle();
  assert.equal(skillBox.getSkill("unused-trial").state, "archived");
});
