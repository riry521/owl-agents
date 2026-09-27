import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}:${createUlid()}`,
    expected_version: expectedVersion,
    payload,
  };
}

async function openLegacyPolicyDecision(core, workId, tried) {
  return core.openDecision({ ...commandEnvelope({
    work_id: workId,
    scope: "work",
    blocked_task_ids: [],
    reason: "A legacy policy proposal was made.",
    question: "Save these as rule proposals?",
    current_state: "The Work is complete.",
    tried,
    options: [
      { key: "approve", label: "Save", description: "Save the policy lessons as proposals." },
      { key: "skip", label: "Skip", description: "Do not save the policy lessons." },
    ],
    recommended: "approve",
    allow_free_text: false,
    issuer_role: "core",
    blocks_work: false,
  }, "legacy-policy-open"), idempotency_key: `kb-policy-${workId}` });
}

async function makeCore(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({
    db,
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
    },
    version: "test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 25 },
  });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  return { root, db, core };
}

test("an approved legacy policy Decision creates one rule proposal per lesson and is idempotent", async (t) => {
  const { root, db, core } = await makeCore(t, "owl-legacy-policy-");
  const created = await core.createWork(commandEnvelope({ title: "Legacy policy", summary: "x", size: "normal", project_id: null }, "legacy-create"));
  const workId = created.data.work_id;
  const tried = [
    "- Reuse a validated result.",
    "  Basis: The review found this was reliable.",
    "  Applies to: Repeated checks.",
    "",
    "- Reuse a validated result.",
    "  Basis: A second lesson with the same rule text.",
    "  Applies to: Repeated checks.",
    "",
    "- Keep source files intact.",
    "  Basis: Cleanup must preserve recoverability.",
    "  Applies to: Repository maintenance.",
  ].join("\n");
  const opened = await openLegacyPolicyDecision(core, workId, tried);

  await core.answerDecision(opened.data.decision_id, commandEnvelope(
    { answer: "Save", option_key: "approve", source_message_id: null },
    "legacy-policy-answer",
    opened.version,
  ));

  const proposals = db.all("SELECT id, text, rationale, origin, status FROM rule_proposals ORDER BY created_at, id");
  assert.equal(proposals.length, 2, "same text and scope merge into one proposal");
  assert.deepEqual(proposals.map(({ text }) => text), ["Reuse a validated result.", "Keep source files intact."]);
  assert.ok(proposals.every((proposal) => proposal.origin === "legacy_policy" && proposal.status === "awaiting_approval"));
  assert.equal(proposals[0].rationale, "The review found this was reliable.");

  const sources = db.all(
    "SELECT source_kind, source_ref, proposal_id FROM rule_proposal_sources WHERE source_kind = 'decision' ORDER BY source_ref",
  );
  assert.deepEqual(sources.map(({ source_ref }) => source_ref), [
    `${opened.data.decision_id}#1`,
    `${opened.data.decision_id}#2`,
    `${opened.data.decision_id}#3`,
  ]);
  assert.equal(sources[0].proposal_id, sources[1].proposal_id);
  assert.notEqual(sources[1].proposal_id, sources[2].proposal_id);

  await core.handlePolicyDecisionResolved(opened.data.decision_id, "approve");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources WHERE source_kind = 'decision'").n, 3);
  await assert.rejects(readdir(join(root, "knowledge", "policies")), { code: "ENOENT" });
});

test("an invalid legacy Decision block is rejected without blocking valid blocks", async (t) => {
  const { db, core } = await makeCore(t, "owl-legacy-policy-invalid-");
  const created = await core.createWork(commandEnvelope({ title: "Legacy policy", summary: "x", size: "normal", project_id: null }, "invalid-create"));
  const workId = created.data.work_id;
  const tried = [
    "- Keep the first valid rule.",
    "  Basis: Evidence.",
    "",
    `- ${"x".repeat(301)}`,
    "  Basis: Too long.",
    "",
    "- Keep the final valid rule.",
    "  Basis: Evidence.",
  ].join("\n");
  const opened = await openLegacyPolicyDecision(core, workId, tried);

  await core.answerDecision(opened.data.decision_id, commandEnvelope(
    { answer: "Save", option_key: "approve", source_message_id: null },
    "invalid-legacy-policy-answer",
    opened.version,
  ));

  const proposals = db.all("SELECT text, status, last_error FROM rule_proposals ORDER BY created_at, id");
  assert.equal(proposals.length, 3);
  assert.equal(proposals.find((proposal) => proposal.text === "Keep the first valid rule.").status, "awaiting_approval");
  const invalid = proposals.find((proposal) => proposal.text === "x".repeat(301));
  assert.equal(invalid.status, "rejected");
  assert.ok(invalid.last_error);
  assert.equal(proposals.find((proposal) => proposal.text === "Keep the final valid rule.").status, "awaiting_approval");
});

test("learning job enqueue rolls back with Work completion and commits atomically", async (t) => {
  const { db, core } = await makeCore(t, "owl-learning-completion-transaction-");
  const created = await core.createWork(commandEnvelope({ title: "Atomic learning", summary: "x", size: "normal", project_id: null }, "atomic-create"));
  const workId = created.data.work_id;
  const now = new Date().toISOString();
  const fixtureLane = db.createWriteLane();
  await fixtureLane.transact((tx) => {
    tx.run("UPDATE works SET state='running', state_version=state_version+1 WHERE id=?", workId);
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES ('task-learning-atomic', ?, 'Done', 'test', 'completed', 'normal', '', '', ?, ?)`,
      workId, now, now,
    );
    tx.run("CREATE TRIGGER reject_learning_job BEFORE INSERT ON learning_jobs BEGIN SELECT RAISE(ABORT, 'enqueue blocked'); END");
  });

  await assert.rejects(core.workflowEngine().completeWorkIfReady(workId, "complete", undefined, {
    agent_run_id: createUlid(),
    project_id: null,
    lessons: [{ lesson: "A durable lesson", basis: "Evidence", applies_to: "future", kind: "fact", topic: "queue", procedure: "", rule_text: "", rule_scope: "all" }],
  }), /enqueue blocked/u);
  assert.equal(db.get("SELECT state FROM works WHERE id=?", workId).state, "running");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id=? AND type='work.completed'", workId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM learning_jobs WHERE work_id=?", workId).n, 0);

  await fixtureLane.transact((tx) => tx.run("DROP TRIGGER reject_learning_job"));
  assert.equal(await core.workflowEngine().completeWorkIfReady(workId, "complete", undefined, {
    agent_run_id: createUlid(),
    project_id: null,
    lessons: [{ lesson: "A durable lesson", basis: "Evidence", applies_to: "future", kind: "fact", topic: "queue", procedure: "", rule_text: "", rule_scope: "all" }],
  }), true);
  assert.equal(db.get("SELECT state FROM works WHERE id=?", workId).state, "completed");
  const payload = JSON.parse(db.get("SELECT payload_json FROM learning_jobs WHERE work_id=?", workId).payload_json);
  assert.deepEqual(payload.lessons.map((lesson) => lesson.lesson), ["A durable lesson"]);
});
