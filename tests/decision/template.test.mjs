import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { DecisionService } from "../../packages/core/dist/index.js";
import { coreTaskDecisionBrief, coreWorkDecisionBrief } from "../../packages/core/dist/decision-brief.js";
import { openDatabase } from "../../packages/db/dist/index.js";
import { formatDecisionText, answerGuideHint } from "../../packages/plugin-sdk/dist/shared/index.js";
import { openTestDatabase } from "../helpers/db.mjs";
import { migrationsDir } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const now = "2026-09-24T09:27:21.477Z";

async function seedWork(db) {
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    transaction.run(
      `INSERT INTO works
         (id, owner_id, title, summary, size, state, state_version, plan_revision,
          rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W', 'owner:default', 'Archive', 'x', 'small', 'running', 0, 0, '{"schema_version":"1.0.0","rules":[]}', '[]', ?, ?)`,
      now,
      now,
    );
  });
}

const complete = {
  work_id: "W",
  scope: "work",
  blocked_task_ids: [],
  reason: "The Work stopped.",
  question: "Continue?",
  tried: "Nothing yet.",
  current_state: "Stopped.",
  options: [{ key: "go", label: "Continue", description: "The Work resumes." }],
  recommended: "go",
  allow_free_text: false,
  issuer_role: "manager",
};

test("a Decision that leaves a template field empty is rejected", async (t) => {
  const { db } = await openTestDatabase(t, { prefix: "owl-decision-template-" });
  await seedWork(db);
  const service = new DecisionService(db);
  const open = (payload, key) => service.open({ request_id: key, idempotency_key: key, expected_version: 0, payload });

  await assert.rejects(open({ ...complete, question: " " }, "no-question"), /requires question/);
  await assert.rejects(open({ ...complete, options: [{ key: "go", label: "Continue" }] }, "no-effect"), /requires description/);
  await assert.rejects(open({ ...complete, recommended: "other" }, "bad-recommended"), /recommended option/);
  const opened = await open(complete, "complete");
  const listed = service.list("open").find((decision) => decision.id === opened.data.decision_id);
  assert.equal(listed.question, "Continue?");
  assert.equal(listed.current_state, "Stopped.");
  assert.equal(listed.tried, "Nothing yet.");
  assert.deepEqual(listed.options, complete.options);
});

test("an incomplete final verdict asks what to do about the missing points", () => {
  const brief = coreWorkDecisionBrief({
    kind: "final_manager_incomplete",
    summary: "Migration numbers clash.",
    missing: ["Renumber the migration.", " ", "Test reopening."],
  }, "ja");
  assert.match(brief.reason, /最終チェック/);
  assert.match(brief.reason, /Migration numbers clash\./);
  assert.match(brief.question, /追加のタスクで直しますか/);
  assert.equal(brief.tried, "足りないと判定された点:\n- Renumber the migration.\n- Test reopening.");
  assert.deepEqual(brief.options.map((option) => option.key), ["retry", "cancel"]);
  assert.equal(brief.recommended, "retry");
  for (const option of brief.options) assert.ok(option.description.length > 0);
});

test("structured missing points render with their reason and fix, in the Owner's language", () => {
  const missing = [{ item: "Renumber the migration.", reason: "007 is taken.", fix: "Use 010." }];
  const ja = coreWorkDecisionBrief({ kind: "final_manager_incomplete", summary: "Clash.", missing }, "ja");
  assert.equal(ja.tried, "足りないと判定された点:\n- Renumber the migration.\n  理由: 007 is taken.\n  直し方: Use 010.");
  const en = coreWorkDecisionBrief({ kind: "final_manager_incomplete", summary: "Clash.", missing }, "en");
  assert.match(en.question, /^[\x00-\x7F]+$/, "the English brief has no Japanese text");
  assert.match(en.tried, /- Renumber the migration\.\n  Why: 007 is taken\.\n  How to fix: Use 010\./);
  for (const option of en.options) assert.match(`${option.label}${option.description}`, /^[\x00-\x7F]+$/);
});

test("a work cleanup alert appears in the Work Decision brief", () => {
  const message = "Could not remove worktree /repo/.owl-workspaces/W/__work__: git reported busy.";
  const brief = coreWorkDecisionBrief({ kind: "work_merge_branch_cleanup_failed", message }, "en");

  assert.match(brief.reason, /Could not remove worktree \/repo\/\.owl-workspaces\/W\/__work__: git reported busy\./);
});

test("a conflict Decision names the automatic rounds already tried, in both languages", () => {
  const payload = { kind: "work_merge_failed", merge_kind: "conflict", conflicting_files: ["a.ts"], auto_resolve_attempts: 2 };

  assert.match(coreWorkDecisionBrief(payload, "en").reason, /Automatic conflict resolution by the Manager was already tried twice/);
  assert.match(coreWorkDecisionBrief(payload, "ja").reason, /自動解消を2回試しました/);
  assert.doesNotMatch(coreWorkDecisionBrief({ ...payload, auto_resolve_attempts: undefined }, "en").reason, /already tried/);
});

test("the migration rewrites Decisions opened before the template", async (t) => {
  // Apply every migration before 009, store Decisions the old way, then migrate.
  let db;
  // Registered before the temp dir hook so the DB closes before its directory is removed.
  t.after(() => db?.close());
  const root = await tempDir(t, "owl-decision-template-");
  const before = join(root, "migrations-before");
  await mkdir(before, { recursive: true });
  for (const file of await readdir(migrationsDir)) {
    if (file < "009") await copyFile(join(migrationsDir, file), join(before, file));
  }
  db = openDatabase(join(root, "owl.db")); // helpers-exempt: migrates only part of the migrations first, then the rest
  db.migrate(before);
  await seedWork(db);
  const legacyOptions = '[{"key":"retry","label":"再試行"},{"key":"cancel","label":"キャンセル"}]';
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, created_at)
       VALUES ('E1', 1, 'alert', 'system.alert', 'W', ?, 'handled', ?)`,
      JSON.stringify({ kind: "final_manager_incomplete", missing: ["Renumber the migration.", "Test reopening."] }),
      now,
    );
    const insert = (id, scope, reason, tried, options) => transaction.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state,
          options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, 'W', ?, 'open', '[]', ?, ?, 'judgement_waiting', ?, NULL, 1, 'core', 0, ?)`,
      id, scope, reason, tried, options, now,
    );
    insert("D1", "work", "Final Managerがincompleteと判定しました: Migration numbers clash.", "Core reconciliation/failure handling", legacyOptions);
    insert("D2", "task", "Claudeの実行設定が不正です。", "Core reconciliation/failure handling", "[]");
  });
  db.migrate(migrationsDir);

  const rows = Object.fromEntries(db.all("SELECT id, reason, question, current_state, tried, options_json, recommended FROM decisions").map((row) => [row.id, row]));
  assert.equal(rows.D1.reason, "最終チェックで「まだ完了していない」と判定され、Workが止まりました。\n判定の内容: Migration numbers clash.");
  assert.match(rows.D1.question, /追加のタスクで直しますか/);
  assert.equal(rows.D1.tried, "足りないと判定された点:\n- Renumber the migration.\n- Test reopening.");
  assert.equal(rows.D1.recommended, "retry");
  assert.equal(rows.D2.reason, "Claudeの実行設定が不正です。");
  assert.equal(rows.D2.question, "このタスクをもう一度実行しますか？");
  assert.equal(rows.D2.tried, "自動での復旧はできませんでした。");
  for (const row of Object.values(rows)) {
    assert.doesNotMatch(row.current_state, /judgement_waiting/);
    const options = JSON.parse(row.options_json);
    assert.deepEqual(options.map((option) => option.key), ["retry", "cancel"]);
    for (const option of options) assert.ok(option.description.length > 0, JSON.stringify(option));
  }
});

test("notifications render a Decision as the template, in order", () => {
  const body = formatDecisionText({
    reason: "The Work stopped.",
    question: "Continue?",
    options: [
      { key: "go", label: "Continue", description: "The Work resumes." },
      { key: "cancel", label: "Cancel" },
    ],
    recommended: "go",
    current_state: "Stopped.",
    tried: "",
  });
  assert.equal(body, [
    "■ なぜ止まったか\nThe Work stopped.",
    "■ 判断してほしいこと\nContinue?",
    "■ 選択肢と、選ぶとどうなるか\nA. Continue（おすすめ） — The Work resumes.\nB. Cancel",
    "■ 今の状態\nStopped.",
  ].join("\n\n"));
});

test("notifications use English headings when the Decision carries language en", () => {
  const body = formatDecisionText({
    language: "en",
    reason: "The Work stopped.",
    question: "Continue?",
    options: [{ key: "go", label: "Continue", description: "The Work resumes." }],
    recommended: "go",
    current_state: "Stopped.",
    tried: "Nothing yet.",
  });
  assert.equal(body, [
    "■ Why it stopped\nThe Work stopped.",
    "■ What to decide\nContinue?",
    "■ Options and what each one does\nA. Continue (recommended) — The Work resumes.",
    "■ Current state\nStopped.",
    "■ What happened so far\nNothing yet.",
  ].join("\n\n"));
  assert.match(answerGuideHint("01ABCDEFGHJKMNPQRSTVWXYZ00", "en"), /"answer WXYZ00: your answer"/);
  assert.match(answerGuideHint("01ABCDEFGHJKMNPQRSTVWXYZ00", "en", true), /buttons above/);
});

test("coreTaskDecisionBrief puts a partial report's words and a failed command's output tail in the reason, not only the error key", () => {
  const partial = coreTaskDecisionBrief("T", {
    error_key: "side_effect_failure:report_result:partial",
    report: { result: "partial", work_done: "テスト環境が無く検証できなかった", verification: { method: "pnpm test を実行できず未確認" } },
  }, "ja");
  assert.match(partial.reason, /テスト環境が無く検証できなかった/u);
  assert.match(partial.reason, /pnpm test を実行できず未確認/u);

  const output = `${"x".repeat(5000)}FAILED: expected 1 to equal 2`;
  const failed = coreTaskDecisionBrief("T", {
    error_key: "e",
    verification: { commands: [{ command_id: "c", passed: false, argv: ["node", "--test", "a.mjs"], stdout: output, stderr: "" }] },
  }, "en");
  assert.match(failed.reason, /node --test a\.mjs/u);
  assert.match(failed.reason, /FAILED: expected 1 to equal 2/u);
  assert.ok(failed.reason.length < 1000);

  // Real Core test-run shape: the policy:test command only carries the run id; the failures are in test_run.
  const testRun = coreTaskDecisionBrief("T", {
    error_key: "e",
    verification: {
      commands: [{ command_id: "policy:test", passed: false, detail: "Core test run RUN123", stdout: "", stderr: "" }],
      test_run: { run_id: "RUN123", failures: { failures: [{ file: "tests/a.test.mjs", name: "adds", line: 7, message: "expected 1 to equal 2" }], omitted_count: 0 } },
    },
  }, "en");
  assert.match(testRun.reason, /tests\/a\.test\.mjs:7 adds/u);
  assert.match(testRun.reason, /expected 1 to equal 2/u);
  assert.doesNotMatch(testRun.reason, /RUN123/u);

  const other = coreTaskDecisionBrief("T", {
    error_key: "e",
    verification: { commands: [{ command_id: "ok", passed: true, detail: "" }], error: "No changed file matches a configured checker." },
  }, "en");
  assert.match(other.reason, /No changed file matches a configured checker/u);
});
