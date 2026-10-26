import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { DecisionService } from "../../packages/core/dist/index.js";
import { coreTaskDecisionBrief, coreWorkDecisionBrief, managerReplanFailureBrief } from "../../packages/core/dist/decision-brief.js";
import { recordAutoRecoveryInTransaction, withAutoRecoveryTried } from "../../packages/core/dist/auto-recovery.js";
import { openDatabase } from "../../packages/db/dist/index.js";
import { findManagerWorkRequests } from "../../packages/shared/dist/decision-explanation.js";
import { applyDecisionTexts, decisionTextsOf, findDecisionTextProblems, findInternalTerms, readDecisionExplanation } from "../../packages/shared/dist/index.js";
import { formatDecisionText, formatDecisionNextSteps, answerGuideHint } from "../../packages/plugin-sdk/dist/shared/index.js";
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
    "■ ネックになっている部分\nThe Work stopped.",
    "■ 選択肢\nContinue?\n\nA. Continue（おすすめ） — The Work resumes.\nB. Cancel",
    "■ 今の状態\nStopped.",
  ].join("\n\n"));
});

test("a Decision with an explanation renders why, what to do, then the records; notes replace option descriptions", () => {
  const body = formatDecisionText({
    reason: "The Work stopped.",
    question: "Continue?",
    current_state: "Stopped.",
    tried: "Retried twice.",
    explanation: {
      summary: "A short summary.",
      cause_kind: "work",
      next_steps: "Retry once more.",
      option_notes: [{ key: "go", note: "Resumes the Work." }],
    },
    options: [
      { key: "go", label: "Continue", description: "Long internal description." },
      { key: "fix_1", label: "Fix it", description: "Own description." },
    ],
    recommended: "go",
  });
  assert.equal(body, [
    "■ ネックになっている部分\nA short summary.（原因: 作業の問題）",
    "■ 選択肢\nRetry once more.\n\nA. Continue（おすすめ） — Resumes the Work.\nB. Fix it — Own description.",
    "■ 詳しい記録\nThe Work stopped.\nStopped.\nRetried twice.",
  ].join("\n\n"));
  assert.equal(formatDecisionNextSteps({ explanation: { next_steps: " Do X. " } }), "Do X.");
  assert.equal(formatDecisionNextSteps({ explanation: { summary: "s", cause_kind: "work" } }), null);
  assert.equal(formatDecisionNextSteps({}), null);
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
    "■ The bottleneck\nThe Work stopped.",
    "■ Options\nContinue?\n\nA. Continue (recommended) — The Work resumes.",
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

  // Past partial_limit the Decision says the Task keeps ending partially, not that an error stopped it.
  for (const [language, wording] of [["ja", /一部完了/u], ["en", /partial/u]]) {
    const limit = coreTaskDecisionBrief("T", { error_key: "side_effect_failure:report_result:partial", report: { result: "partial", work_done: "half" } }, language);
    assert.match(limit.reason, wording);
    assert.match(limit.reason, /half/u);
    assert.doesNotMatch(`${limit.reason}${limit.tried}`, /エラーの種類|Error kind|自動ではやり直せない|must not retry/u);
    // Core adds the explanation after the Decision opens; this branch is the one that may add fix options.
    assert.deepEqual(limit.explanation, { kind: "partial_limit", status: "pending" });
  }
  assert.deepEqual(coreTaskDecisionBrief("T", { error_key: "e" }, "en").explanation, { kind: "task_failed", status: "pending" });

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

const TASK_ID = "01M5BGJJVBAN42ZCPPFANNMSN9";
const OWN_OPTIONS = [{ key: "retry", label: "Retry" }, { key: "cancel", label: "Cancel" }];
const fixOption = (rewrites = []) => ({ label: "Reword it", description: "Retry with a reworded criterion.", instruction: "Retry AC1 reworded.", criteria_rewrites: rewrites });
const REWRITE = { criterion_id: "AC1", after: "Time without startup is shorter.", check: "Measure three runs after startup." };
const explanationContext = (changes = {}) => ({ kind: "partial_limit", options: OWN_OPTIONS, recommended: null, criterion_ids: ["AC1"], forbidden_terms: [TASK_ID], ...changes });
const explanationReport = (changes = {}) => ({
  summary: "The measuring method cannot pass. The work itself is done.",
  cause_kind: "work",
  next_steps: "Pick a fix. Or run it again.",
  option_notes: [{ key: "retry", note: "The Task runs again." }, { key: "cancel", note: "The Task stops for good." }],
  options: [fixOption()],
  recommended_option_key: "fix_1",
  ...changes,
});
const readExplanation = (changes, context) => readDecisionExplanation(explanationReport(changes), explanationContext(context));

test("readDecisionExplanation checks the shape, option notes, recommendation and no length limits, and requests for internal work (rules 1-5)", () => {
  assert.equal(readExplanation().ok, true);
  assert.equal(readDecisionExplanation({ summary: "x" }, explanationContext()).ok, false, "rule 1: schema");
  assert.equal(readExplanation({ summary: "One. Two. Three." }).ok, true, "rule 2: summary has no length limit");
  assert.equal(readExplanation({ next_steps: "One. Two. Three." }).ok, true, "rule 2: next_steps has no length limit");
  assert.equal(readExplanation({ option_notes: [{ key: "retry", note: "One. Two." }, { key: "cancel", note: "Stops." }] }).ok, true, "rule 2: note has no length limit");
  assert.equal(readExplanation({ options: [{ ...fixOption(), description: "One. Two." }] }).ok, true, "rule 2: fix description has no length limit");
  assert.equal(readExplanation({ next_steps: "Please recreate the Task with reworded criteria." }).ok, false, "rule 2: no work for the Manager");
  assert.equal(readExplanation({ options: [{ ...fixOption(), instruction: "Please recreate the Task and rewrite AC1." }] }).ok, true, "rule 2: the instruction is the Manager's");
  assert.equal(readExplanation({ option_notes: [{ key: "retry", note: "Runs." }] }).ok, false, "rule 3: missing key");
  assert.equal(readExplanation({ option_notes: [...explanationReport().option_notes, { key: "other", note: "Extra." }] }).ok, false, "rule 3: extra key");
  assert.equal(readExplanation({ option_notes: [{ key: "retry", note: "A." }, { key: "retry", note: "B." }, { key: "cancel", note: "C." }] }).ok, false, "rule 3: duplicate key");
  assert.equal(readExplanation({ options: [] }).ok, false, "rule 4: partial_limit needs fix options");
  assert.equal(readExplanation({ options: [fixOption(), fixOption(), fixOption(), fixOption()], recommended_option_key: "fix_4" }).ok, true, "rule 4: no upper limit");
  assert.equal(readExplanation({ options: [fixOption()] }, { kind: "merge_failed" }).ok, false, "rule 4: other kinds have none");
  assert.equal(readExplanation({ options: [], recommended_option_key: "retry" }, { kind: "merge_failed" }).ok, true);
  assert.equal(readExplanation({ recommended_option_key: "fix_2" }).ok, false, "rule 5: fix key out of range");
  assert.equal(readExplanation({ recommended_option_key: "retry" }).ok, false, "rule 5: partial_limit recommends a fix");
  assert.equal(readExplanation({ options: [], recommended_option_key: "other" }, { kind: "merge_failed" }).ok, false, "rule 5: unknown key");
  assert.equal(readExplanation({ options: [], recommended_option_key: "cancel" }, { kind: "merge_failed", recommended: "retry" }).ok, false, "rule 5: Core's recommendation is fixed");
  assert.equal(readExplanation({ options: [], recommended_option_key: "retry" }, { kind: "merge_failed", recommended: "retry" }).ok, true);
});

test("readDecisionExplanation checks criteria rewrites and internal terms (rules 6-7)", () => {
  assert.equal(readExplanation({ cause_kind: "criteria", options: [fixOption([REWRITE])] }).ok, true);
  assert.equal(readExplanation({ options: [fixOption([{ ...REWRITE, criterion_id: "AC9" }])] }).ok, false, "rule 6: unknown criterion");
  assert.equal(readExplanation({ options: [fixOption([REWRITE, REWRITE])] }).ok, false, "rule 6: repeated criterion");
  assert.equal(readExplanation({ cause_kind: "criteria" }).ok, false, "rule 6: partial_limit with a criteria cause needs a rewrite");
  const unverifiable = { kind: "merge_failed" };
  assert.equal(readExplanation({ cause_kind: "criteria", options: [], recommended_option_key: "retry" }, unverifiable).ok, true, "rule 6: other kinds may name the criteria without rewrites");
  for (const summary of ["It ended as a partial result.", "AC1 failed.", "Task 01ARZ3NDEKTSV4RRFFQ69G5FAV stopped.", `Task ${TASK_ID} stopped.`]) {
    assert.equal(readExplanation({ summary }).ok, false, summary);
  }
  for (const changes of [
    { next_steps: `Ask about ${TASK_ID}.` },
    { option_notes: [{ key: "retry", note: "Runs judgement_waiting again." }, { key: "cancel", note: "Stops." }] },
    { options: [{ ...fixOption(), label: "Fix AC1" }] },
    { options: [{ ...fixOption(), description: "Fixes partial work." }] },
    { cause_kind: "criteria", options: [fixOption([{ ...REWRITE, after: "Check AC1 again." }])] },
    { cause_kind: "criteria", options: [fixOption([{ ...REWRITE, check: `Run for ${TASK_ID}.` }])] },
  ]) {
    assert.equal(readExplanation(changes).ok, false, JSON.stringify(changes));
  }
});

test("findInternalTerms finds IDs, AC numbers, partial, snake_case names, worktree and lineage but not screen names", () => {
  const sentences = {
    "26-character id": "Task 01ARZ3NDEKTSV4RRFFQ69G5FAV stopped.",
    "AC number": "AC12 failed.",
    partial: "It was a partial run.",
    "snake_case": "The state is core_decision_required.",
    "new snake_case": "The kind is some_new_kind.",
    worktree: "The worktree is dirty.",
    lineage: "The lineage is long.",
  };
  const template = { summary: "Done.", next_steps: "Retry.", options: [] };
  for (const [name, text] of Object.entries(sentences)) {
    assert.ok(findInternalTerms(text, []).length > 0, name);
    assert.ok(findDecisionTextProblems({ ...template, summary: text }, []).length > 0, name);
  }
  const screenNames = "The Work and the Task wait for the Owner, the Manager, the Worker, the Reviewer, the Designer and the Project.";
  assert.deepEqual(findInternalTerms(screenNames, []), []);
  assert.deepEqual(findDecisionTextProblems({ ...template, summary: screenNames }, []), []);
  assert.deepEqual(findInternalTerms("The work was partially done.", []), []);
});

test("findDecisionTextProblems covers after and check of rewrites, and Core's labels are not checked", () => {
  const texts = decisionTextsOf(explanationReport({ cause_kind: "criteria", options: [fixOption([REWRITE])] }), OWN_OPTIONS);
  assert.deepEqual(findDecisionTextProblems(texts, [TASK_ID]), []);
  const withRewrite = (rewrite) => ({ ...texts, options: texts.options.map((o) => (o.generated ? { ...o, criteria_rewrites: [rewrite] } : o)) });
  assert.ok(findDecisionTextProblems(withRewrite({ ...REWRITE, after: "Reword AC1." }), []).length > 0, "after");
  assert.ok(findDecisionTextProblems(withRewrite({ ...REWRITE, check: `Run ${TASK_ID}.` }), [TASK_ID]).length > 0, "check");
  const coreLabel = { ...texts, options: texts.options.map((o) => (o.generated ? o : { ...o, label: "retry_task" })) };
  assert.deepEqual(findDecisionTextProblems(coreLabel, []), [], "a label Core wrote is not checked");
});

test("decisionTextsOf and applyDecisionTexts round-trip the report and put edits back by id and key", () => {
  const report = explanationReport({ cause_kind: "criteria", options: [fixOption([REWRITE]), fixOption()] });
  const texts = decisionTextsOf(report, OWN_OPTIONS);
  assert.deepEqual(texts.options.map((o) => [o.key, o.generated]), [["fix_1", true], ["fix_2", true], ["retry", false], ["cancel", false]]);
  assert.deepEqual(texts.options[0].criteria_rewrites, [REWRITE]);
  assert.deepEqual(applyDecisionTexts(report, texts), report);

  const edited = {
    ...texts,
    summary: "New summary.",
    next_steps: "New steps.",
    options: texts.options.map((o) => ({
      ...o,
      note: o.key === "retry" || o.key === "fix_1" ? `${o.key} note.` : o.note,
      label: o.generated ? `${o.label}!` : o.label,
      criteria_rewrites: o.criteria_rewrites.map((r) => ({ ...r, after: "New after.", check: "New check." })),
    })),
  };
  const applied = applyDecisionTexts(report, edited);
  assert.equal(applied.summary, "New summary.");
  assert.equal(applied.next_steps, "New steps.");
  assert.deepEqual(applied.option_notes, [{ key: "retry", note: "retry note." }, { key: "cancel", note: "The Task stops for good." }]);
  assert.deepEqual(applied.options[0].criteria_rewrites, [{ criterion_id: "AC1", after: "New after.", check: "New check." }]);
  assert.equal(applied.options[0].description, "fix_1 note.");
  assert.equal(applied.options[0].label, "Reword it!");
  assert.equal(applied.options[0].instruction, report.options[0].instruction, "the instruction is never edited");
  assert.equal(applied.recommended_option_key, "fix_1");
});

test("withAutoRecoveryTried puts the automatic attempts first, capped per line and by the limit", async (t) => {
  const { db } = await openTestDatabase(t, { prefix: "owl-auto-tried-" });
  await seedWork(db);
  const target = { kind: "work", id: "W" };
  const long = "x".repeat(400);
  for (const n of [1, 2, 3, 4]) {
    await db.createWriteLane().transact((tx) =>
      recordAutoRecoveryInTransaction(tx, {
        kind: "integration_conflict",
        target,
        workId: "W",
        action: "add_conflict_task",
        sourceEventId: `E${n}`,
        previousFailure: { summary: n === 1 ? long : `failure ${n}`, error_key: "k", detail: "d" },
      }),
    );
  }
  const brief = { reason: "Still conflicting.", question: "q", tried: "Existing tried text.", current_state: "s", options: [], recommended: null };
  const ja = withAutoRecoveryTried(db, brief, { workId: "W", taskIds: [] }, "ja");
  const lines = ja.tried.split("\n");
  assert.match(lines[0], /^自動で試したこと: \d+回（上限 \d+回）。直りませんでした。$/u);
  assert.match(lines[1], /^\d+回目: /u);
  assert.ok(lines.every((line) => line === "Existing tried text." || [...line].length <= 200));
  assert.equal(lines.at(-1), "Existing tried text.");
  const limit = Number(/上限 (\d+)回/u.exec(lines[0])[1]);
  assert.ok(lines.filter((line) => /^\d+回目: /u.test(line)).length <= limit);
  const en = withAutoRecoveryTried(db, brief, { workId: "W", taskIds: [] }, "en");
  assert.match(en.tried.split("\n")[0], /^Tried automatically: /u);
  assert.match(en.tried, /\nAttempt \d+: .*Result: /u);
  assert.ok(withAutoRecoveryTried(db, brief, { workId: "W", taskIds: [] }, "ja", "design_decision").tried.startsWith("自動では試していません（理由: "));
});

test("Decision briefs name the cause in the reason, in both languages", () => {
  const failure = { tasks: [{ title: "T3 layout", cause: "mikata_long is missing from the registry" }, { title: "T4", cause: null }] };
  const ja = managerReplanFailureBrief("task", "Task T3: Criterion AC2 was changed", "ja", undefined, undefined, undefined, { ...failure, rejectedAttempts: 2 });
  assert.match(ja.reason, /タスク「T3 layout」が失敗しました。理由: mikata_long is missing/);
  assert.match(ja.reason, /タスク「T4」が失敗しました。失敗の理由は記録されていません/);
  assert.match(ja.tried, /検証ではじかれました（2回）/);
  assert.doesNotMatch(Object.values(ja).join("\n"), /Criterion AC2/);
  const en = managerReplanFailureBrief("task", "internal", "en", undefined, undefined, undefined, { ...failure, rejectedAttempts: 2 });
  assert.match(en.reason, /Task "T3 layout" failed\. Reason: mikata_long is missing/);
  assert.match(en.tried, /rejected by validation \(2 times\)/);
  assert.doesNotMatch(String(en.tried), /internal/);
  assert.match(managerReplanFailureBrief("task", "boom", "ja").tried, /boom/);

  for (const language of ["ja", "en"]) {
    assert.match(coreWorkDecisionBrief({ kind: "final_manager_failed", failure: "provider timed out" }, language).reason, /provider timed out/);
    assert.match(coreWorkDecisionBrief({ kind: "work_integration_verification_failed", command: ["pnpm", "test"], output_tail: "1 failed" }, language).reason, /pnpm test/);
  }
});

test("the Manager's replan failure brief is written as the Owner's choice and says a word in the answer field is followed", () => {
  for (const [language, guide] of [["ja", /回答欄に一言書くと、Managerがそれに従って直します/u], ["en", /write a word in the answer field below and the Manager will follow it/u]]) {
    for (const scope of ["task", "work"]) {
      const brief = managerReplanFailureBrief(scope, "The plan was rejected.", language);
      assert.match(brief.current_state, guide, `${language} ${scope}`);
      assert.match(brief.question, /[？?]$/u);
      assert.equal(findManagerWorkRequests([brief.question, brief.current_state, ...brief.options.map((option) => option.description)].join("\n")).length, 0);
    }
  }
});
