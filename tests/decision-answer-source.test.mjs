import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DecisionService } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function openDb(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-decision-answer-source-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  t.after(() => db.close());
  return db;
}

async function seedWork(db, workId) {
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      "INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      "owner:default",
      "Test owner",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    transaction.run(
      `INSERT INTO works
         (id, owner_id, title, summary, size, state, state_version, plan_revision,
          rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'small', 'running', 0, 0, ?, ?, ?, ?)`,
      workId,
      "owner:default",
      "Decision source test",
      "Decision source test",
      JSON.stringify({ schema_version: "1.0.0", rules: [] }),
      JSON.stringify([]),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  });
}

async function openDecision(service, workId, suffix) {
  const opened = await service.open({
    request_id: createUlid(),
    idempotency_key: `decision-open-${suffix}`,
    expected_version: 0,
    payload: {
      work_id: workId,
      scope: "work",
      blocked_task_ids: [],
      reason: "Need an owner choice",
      question: "Proceed?",
      tried: "Nothing yet",
      current_state: "judgement_waiting",
      options: [
        { key: "approve", label: "承認", description: "Proceed." },
        { key: "reject", label: "却下", description: "Stop." },
      ],
      recommended: null,
      allow_free_text: true,
      issuer_role: "manager",
    },
  });
  return opened.data.decision_id;
}

test("resolving a Decision records the answer's source", async (t) => {
  const db = await openDb(t);
  const service = new DecisionService(db);
  const workId = "work-decision-source-web";
  await seedWork(db, workId);
  const decisionId = await openDecision(service, workId, "web");

  await service.resolve({
    request_id: createUlid(),
    idempotency_key: "decision-resolve-web",
    expected_version: 0,
    payload: {
      decision_id: decisionId,
      answer: "承認",
      option_key: "approve",
      source_message_id: null,
      source: "web",
    },
  });

  const stored = db.get("SELECT source FROM decision_answers WHERE decision_id = ?", decisionId);
  assert.equal(stored.source, "web");
});

test("resolving a Decision from Slack, Discord, or the Advisor records that source", async (t) => {
  const db = await openDb(t);
  const service = new DecisionService(db);
  const cases = [
    ["slack", "slack-msg-1"],
    ["discord", "discord-msg-1"],
    ["advisor", null],
  ];
  for (const [source, sourceMessageId] of cases) {
    const workId = `work-decision-source-${source}`;
    await seedWork(db, workId);
    const decisionId = await openDecision(service, workId, source);

    await service.resolve({
      request_id: createUlid(),
      idempotency_key: `decision-resolve-${source}`,
      expected_version: 0,
      payload: {
        decision_id: decisionId,
        answer: "承認",
        option_key: "approve",
        source_message_id: sourceMessageId,
        source,
      },
    });

    const stored = db.get("SELECT source, source_message_id FROM decision_answers WHERE decision_id = ?", decisionId);
    assert.equal(stored.source, source);
    assert.equal(stored.source_message_id, sourceMessageId);
  }
});

test("an answer that does not match the selected option's label is rejected", async (t) => {
  const db = await openDb(t);
  const service = new DecisionService(db);
  const workId = "work-decision-source-label-mismatch";
  await seedWork(db, workId);
  const decisionId = await openDecision(service, workId, "label-mismatch");

  await assert.rejects(
    () => service.resolve({
      request_id: createUlid(),
      idempotency_key: "decision-resolve-mismatch",
      expected_version: 0,
      payload: {
        decision_id: decisionId,
        answer: "approve",
        option_key: "approve",
        source_message_id: null,
        source: "web",
      },
    }),
    (error) => error?.code === "validation_error" && /label/u.test(error.message),
  );
  assert.equal(db.get("SELECT status FROM decisions WHERE id = ?", decisionId).status, "open");
});

test("a resolve request without a source still commits, defaulting to web", async (t) => {
  const db = await openDb(t);
  const service = new DecisionService(db);
  const workId = "work-decision-source-default";
  await seedWork(db, workId);
  const decisionId = await openDecision(service, workId, "default");

  await service.resolve({
    request_id: createUlid(),
    idempotency_key: "decision-resolve-default",
    expected_version: 0,
    payload: {
      decision_id: decisionId,
      answer: "承認",
      option_key: "approve",
      source_message_id: null,
    },
  });

  const stored = db.get("SELECT source FROM decision_answers WHERE decision_id = ?", decisionId);
  assert.equal(stored.source, "web");
});
