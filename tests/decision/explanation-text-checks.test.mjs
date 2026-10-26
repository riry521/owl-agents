import assert from "node:assert/strict";
import { test } from "node:test";

import { DecisionExplainer, toDecisionExplanation } from "../../packages/core/dist/decision-explainer.js";
import { coreTaskDecisionBrief } from "../../packages/core/dist/decision-brief.js";
import { plainDecisionExplanation } from "../../packages/core/dist/decision-plain-explanation.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const TASK_ID = "01TASKAAAAAAAAAAAAAAAAAAAA";
const TASK_TITLE = "Build the export page";
const PARTIAL = { report: { kind: "report", result: "partial", work_done: "Built half of the page." }, verification: { checked: "partial check" } };

/** An answer that follows the rules; a partial_limit one carries a fix option that rewrites AC1. */
function answerFor(request, { summary = "The work stopped before it could be finished.", after = "The page exports a CSV file." } = {}) {
  const fix = request.kind === "partial_limit";
  return {
    ok: true,
    explanation: {
      summary,
      cause_kind: fix ? "criteria" : "work",
      next_steps: "Pick one of the choices below to go on.",
      option_notes: request.decision.options.map((option) => ({ key: option.key, note: "Carries on with this choice." })),
      options: fix ? [{ label: "Narrow the goal", description: "Rewrites the goal.", instruction: "Rewrite AC1.", criteria_rewrites: [{ criterion_id: "AC1", after, check: "Open the page and export." }] }] : [],
      recommended_option_key: request.decision.recommended ?? (fix ? "fix_1" : request.decision.options[0].key),
    },
  };
}

/** A stopped Task and its open Decision with a pending explanation; the explainer is driven directly, with no dispatcher. */
async function openDecision(t, { kind, textChecks, runner, timeoutSeconds = 30, rewritesMax = 1, noRunner = false, title = TASK_TITLE, partial = PARTIAL }) {
  const { db, core } = await createTestCore(t, {}, { prefix: "owl-text-checks-" });
  const workId = (await core.createWork(command({ title: "Export", summary: "x", size: "normal", project_id: null }, `create-${createUlid()}`))).data.work_id;
  const now = new Date().toISOString();
  // A kind without fix options (merge_failed) is carried by a task_failed brief with its kind swapped.
  const brief = kind === "partial_limit"
    ? coreTaskDecisionBrief(title, { report: { result: "partial" } }, "en")
    : { ...coreTaskDecisionBrief(TASK_TITLE, { error_key: "worker_crashed" }, "en"), explanation: { kind, status: "pending" } };
  const id = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'judgement_waiting' WHERE id = ?", workId);
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, ?, 'code', 'judgement_waiting', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      TASK_ID, workId, title, now, now,
    );
    const eventId = createUlid();
    tx.run(
      "INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at) VALUES (?, 9000, ?, 'task.failure.classified', ?, ?, ?, 'handled', ?)",
      eventId, eventId, workId, TASK_ID, JSON.stringify(partial), now,
    );
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at, explanation_json)
       VALUES (?, ?, 'task', 'open', ?, ?, ?, ?, ?, ?, ?, 1, 'core', 0, ?, ?)`,
      id, workId, JSON.stringify([TASK_ID]), brief.reason, brief.question, brief.tried, brief.current_state, JSON.stringify(brief.options), brief.recommended, now, JSON.stringify(brief.explanation),
    );
  });
  const requests = [];
  const explainer = new DecisionExplainer({
    db,
    writeLane: db.createWriteLane(),
    runner: () => (noRunner ? {} : { runDecisionExplanation: async (request) => { requests.push(request); return runner(request, requests.length); } }),
    roleModel: () => undefined,
    rules: () => null,
    language: () => "en",
    timeoutSeconds: () => timeoutSeconds,
    rewritesMax: () => rewritesMax,
    textChecks: () => textChecks,
    announce: async () => undefined,
  });
  explainer.schedule(id, workId);
  const row = () => db.get("SELECT explanation_json, options_json FROM decisions WHERE id = ?", id);
  await waitFor(() => JSON.parse(row().explanation_json).status !== "pending", { message: "the explanation was written" });
  return { requests, explanation: JSON.parse(row().explanation_json), options: JSON.parse(row().options_json) };
}

const check = (name, run) => ({ name, run });
const quiet = (t) => t.mock.method(console, "error", () => undefined);

test("with no text check the explanation is written as before", async (t) => {
  const { explanation, requests } = await openDecision(t, { kind: "merge_failed", textChecks: [], runner: (request) => answerFor(request) });
  assert.equal(explanation.status, "ready");
  assert.equal(explanation.summary, "The work stopped before it could be finished.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].revision, null);
});

test("ok keeps the texts, and the check receives the language, the kind and the texts without ids", async (t) => {
  const inputs = [];
  const { explanation } = await openDecision(t, {
    kind: "merge_failed",
    textChecks: [check("lint", async (input) => { inputs.push(input); return { ok: true }; })],
    runner: (request) => answerFor(request),
  });
  assert.equal(explanation.status, "ready");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].language, "en");
  assert.equal(inputs[0].kind, "merge_failed");
  assert.equal(inputs[0].texts.summary, "The work stopped before it could be finished.");
  assert.deepEqual(inputs[0].texts.options.map((option) => option.generated), inputs[0].texts.options.map(() => false));
});

test("fixed texts are stored, and a fixed text with an id asks the model to rewrite", async (t) => {
  const fixed = await openDecision(t, {
    kind: "merge_failed",
    textChecks: [check("lint", async ({ texts }) => ({ ok: true, fixed: { ...texts, summary: "Fixed summary." } }))],
    runner: (request) => answerFor(request),
  });
  assert.equal(fixed.explanation.status, "ready");
  assert.equal(fixed.explanation.summary, "Fixed summary.");

  let calls = 0;
  const rewritten = await openDecision(t, {
    kind: "merge_failed",
    textChecks: [check("lint", async ({ texts }) => ({ ok: true, fixed: { ...texts, summary: calls++ === 0 ? `Stopped at ${TASK_ID}.` : "Clean summary." } }))],
    runner: (request) => answerFor(request),
  });
  assert.equal(rewritten.requests.length, 2);
  assert.ok(rewritten.requests[1].revision.problems.length > 0);
  assert.equal(rewritten.requests[1].revision.texts.summary, `Stopped at ${TASK_ID}.`);
  assert.equal(rewritten.explanation.summary, "Clean summary.");
});

test("a check that fixes the rewrite of a criterion changes after and check in the stored option and keeps criterion_id and before", async (t) => {
  const seen = [];
  const fixedRun = await openDecision(t, {
    kind: "partial_limit",
    textChecks: [check("lint", async ({ texts }) => {
      seen.push(texts.options[0]);
      return { ok: true, fixed: { ...texts, options: texts.options.map((option) => (option.generated
        ? { ...option, label: "Narrow the goal now", criteria_rewrites: option.criteria_rewrites.map((rewrite) => ({ ...rewrite, after: "Fixed goal.", check: "Fixed check." })) }
        : option)) } };
    })],
    runner: (request) => answerFor(request),
  });
  assert.deepEqual(seen[0].criteria_rewrites, [{ criterion_id: "AC1", after: "The page exports a CSV file.", check: "Open the page and export." }]);
  assert.equal(seen[0].generated, true);
  assert.equal(fixedRun.explanation.status, "ready");
  assert.equal(fixedRun.options[0].label, "Narrow the goal now");
  assert.deepEqual(fixedRun.options[0].criteria_rewrites, [{ criterion_id: "AC1", before: "Done.", after: "Fixed goal.", check: "Fixed check." }]);

  let calls = 0;
  const rewritten = await openDecision(t, {
    kind: "partial_limit",
    textChecks: [check("lint", async ({ texts }) => ({ ok: true, fixed: { ...texts, options: texts.options.map((option) => (option.generated
      ? { ...option, criteria_rewrites: option.criteria_rewrites.map((rewrite) => ({ ...rewrite, after: calls++ === 0 ? `Done for ${TASK_ID}.` : "Clean goal." })) }
      : option)) } }))],
    runner: (request) => answerFor(request),
  });
  assert.equal(rewritten.requests.length, 2);
  assert.equal(rewritten.options[0].criteria_rewrites[0].after, "Clean goal.");
});

test("a fixed output that breaks the shape fails as text_check_invalid, except a fixed label of a generated option", async (t) => {
  quiet(t);
  const broken = [
    ({ texts }) => ({ ok: true, fixed: { ...texts, options: texts.options.map((option) => (option.generated ? { ...option, criteria_rewrites: option.criteria_rewrites.map((r) => ({ ...r, criterion_id: "AC9" })) } : option)) } }),
    ({ texts }) => ({ ok: true, fixed: { ...texts, options: texts.options.map((option) => (option.generated ? option : { ...option, label: "Another label" })) } }),
    ({ texts }) => ({ ok: true, fixed: { ...texts, summary: "" } }),
    () => ({ ok: "yes" }),
    () => ({ ok: false, problems: [] }),
  ];
  for (const run of broken) {
    const { explanation } = await openDecision(t, { kind: "partial_limit", textChecks: [check("lint", async (input) => run(input))], runner: (request) => answerFor(request) });
    assert.deepEqual([explanation.status, explanation.error], ["ready", "text_check_invalid:lint"]);
    assert.equal(explanation.plain, true);
  }
});

test("problems ask for one rewrite with the problems in the revision; a second rejection fails", async (t) => {
  let calls = 0;
  const second = await openDecision(t, {
    kind: "merge_failed",
    textChecks: [check("lint", async () => (calls++ === 0 ? { ok: false, problems: ["Use plain words."] } : { ok: true }))],
    runner: (request, n) => answerFor(request, { summary: `Attempt ${n}.` }),
  });
  assert.equal(second.requests.length, 2);
  assert.deepEqual(second.requests[1].revision.problems, ["Use plain words."]);
  assert.equal(second.requests[1].revision.texts.summary, "Attempt 1.");
  assert.equal(second.explanation.summary, "Attempt 2.");

  const never = await openDecision(t, {
    kind: "merge_failed",
    textChecks: [check("lint", async () => ({ ok: false, problems: ["Still wrong."] }))],
    runner: (request) => answerFor(request),
  });
  assert.equal(never.requests.length, 2);
  assert.deepEqual([never.explanation.status, never.explanation.error], ["ready", "text_check_rejected:lint"]);
});

test("a rejecting check fails as text_check_failed, and the deadline aborts the signal and fails as timeout", async (t) => {
  quiet(t);
  const rejected = await openDecision(t, { kind: "merge_failed", textChecks: [check("lint", async () => { throw new Error("exit 2"); })], runner: (request) => answerFor(request) });
  assert.deepEqual([rejected.explanation.status, rejected.explanation.error], ["ready", "text_check_failed:lint"]);

  let signal;
  const late = await openDecision(t, {
    kind: "merge_failed",
    timeoutSeconds: 0.2,
    textChecks: [check("lint", (_input, abort) => { signal = abort; return new Promise(() => undefined); })],
    runner: (request) => answerFor(request),
  });
  assert.deepEqual([late.explanation.status, late.explanation.error], ["ready", "timeout"]);
  assert.equal(signal.aborted, true);
});

test("an answer that fails the common checks never reaches a check, and checks run in the configured order, each on the previous fix", async (t) => {
  let reached = false;
  const leaky = await openDecision(t, {
    kind: "merge_failed",
    textChecks: [check("lint", async () => { reached = true; return { ok: true }; })],
    runner: (request) => answerFor(request, { summary: `Stopped at ${TASK_ID}.` }),
  });
  assert.deepEqual([leaky.explanation.status, leaky.explanation.error], ["ready", "internal_terms"]);
  assert.equal(reached, false);

  const order = [];
  const { explanation } = await openDecision(t, {
    kind: "merge_failed",
    textChecks: [
      check("first", async ({ texts }) => { order.push(["first", texts.summary]); return { ok: true, fixed: { ...texts, summary: "From the first." } }; }),
      check("second", async ({ texts }) => { order.push(["second", texts.summary]); return { ok: true }; }),
    ],
    runner: (request) => answerFor(request),
  });
  assert.deepEqual(order, [["first", "The work stopped before it could be finished."], ["second", "From the first."]]);
  assert.equal(explanation.summary, "From the first.");
});

test("an answer that fails the common checks is rewritten with the reason, as many times as the setting allows", async (t) => {
  quiet(t);
  const leak = (request) => answerFor(request, { summary: "Stopped at " + TASK_ID + "." });
  const once = await openDecision(t, { kind: "merge_failed", textChecks: [], rewritesMax: 1, runner: (request, n) => (n === 1 ? leak(request) : answerFor(request, { summary: "Fixed." })) });
  assert.equal(once.requests.length, 2);
  assert.match(once.requests[1].revision.problems[0], /internal terms/);
  assert.equal(once.requests[1].revision.texts.summary, "Stopped at " + TASK_ID + ".");
  assert.deepEqual([once.explanation.status, once.explanation.summary, once.explanation.plain], ["ready", "Fixed.", undefined]);

  const none = await openDecision(t, { kind: "merge_failed", textChecks: [], rewritesMax: 0, runner: leak });
  assert.equal(none.requests.length, 1);
  const three = await openDecision(t, { kind: "merge_failed", textChecks: [], rewritesMax: 3, runner: leak });
  assert.equal(three.requests.length, 4);
  assert.deepEqual([three.explanation.error, three.explanation.plain], ["internal_terms", true]);
});

test("a rewrite limit, an AI error, a timeout and a missing runner each store a fixed-form explanation with a summary and next_steps", async (t) => {
  quiet(t);
  const cases = [
    { name: "limit", options: { textChecks: [check("lint", async () => ({ ok: false, problems: ["Still wrong."] }))], runner: (request) => answerFor(request) }, error: "text_check_rejected:lint" },
    { name: "error", options: { textChecks: [], runner: () => ({ ok: false, error: "provider failed: boom" }) }, error: "provider failed: boom" },
    { name: "timeout", options: { textChecks: [], timeoutSeconds: 0.2, runner: () => new Promise(() => undefined) }, error: "timeout" },
    { name: "no runner", options: { textChecks: [], noRunner: true, runner: () => undefined }, error: "runner_unavailable" },
  ];
  for (const { name, options, error } of cases) {
    const { explanation } = await openDecision(t, { kind: "merge_failed", ...options });
    assert.deepEqual([explanation.status, explanation.plain, explanation.error], ["ready", true, error], name);
    assert.ok(explanation.summary.trim() !== "" && explanation.next_steps.trim() !== "", name);
    // DecisionView shows summary and next_steps of a ready explanation, so a fixed-form one reaches the screen like the AI's.
    const shown = toDecisionExplanation(JSON.stringify(explanation));
    assert.deepEqual([shown.status, shown.summary, shown.next_steps], ["ready", explanation.summary, explanation.next_steps], name);
    assert.doesNotMatch(explanation.summary + explanation.next_steps, /provider failed|text_check|runner_unavailable|timeout/, name);
  }
});

test("a fixed-form explanation leaves out English validation messages, also on a Japanese line and in English", () => {
  const request = (language, remaining) => ({
    language,
    forbidden_terms: [],
    decision: { reason: "", tried: "", question: "どちらにしますか？" },
    reports: [{ remaining_issues: remaining.map((issue) => ({ issue })) }],
  });
  const ja = plainDecisionExplanation(request("ja", ["検証結果: Validation failed: unknown property.", "レイアウトが登録一覧にありません。"]));
  assert.equal(ja.summary, "レイアウトが登録一覧にありません。");
  const en = plainDecisionExplanation(request("en", ["Validation failed: unknown property foo.", "The layout is not in the list."]));
  assert.equal(en.summary, "The layout is not in the list.");
});

const fixChoice = (label) => ({ label, description: "Carries out the choice.", instruction: "Do it.", criteria_rewrites: [] });
const withFixes = (request, changes) => ({ ok: true, explanation: { ...answerFor(request).explanation, cause_kind: "work", ...changes } });

test("an answer that asks the Owner for the Manager's work, or has only the fixed choices, is rewritten once and the passing answer is stored (ops-dashboard #14)", async (t) => {
  quiet(t);
  const asked = [
    { next_steps: "中止してから条件を書き直した Task を作り直してください。" },
    { summary: "Please recreate the Task with reworded criteria." },
    { options: [] },
    { next_steps: "受け入れ条件を書き直しましょう。" },
    { next_steps: "Please run `pnpm build`." },
    { options: [fixChoice("もう一度実行しますか？")] },
    { options: [fixChoice("中止しますか？"), fixChoice("Retry the work?")] },
    { next_steps: "Run `pnpm build`." },
    { next_steps: "Rewrite the acceptance criteria." },
    { next_steps: "計画を修正してもらえますか？" },
    { options: [fixChoice("もう一度実行することにしますか？")] },
    { options: [fixChoice("中止することにしますか？")] },
    { options: [fixChoice("Do you want to retry?")] },
    { next_steps: "計画を直してもらえますか？" },
    { options: [fixChoice("やり直すことにしますか？"), fixChoice("今回は見送りにしますか？")] },
    { options: [{ ...fixChoice("ビルドを通して進めることにしますか？"), description: "Run `pnpm build`." }] },
    { options: [{ ...fixChoice("条件を現状に合わせることにしますか？"), description: "Rewrite the acceptance criteria." }] },
    { options: [fixChoice("Rewrite the acceptance criteria.")] },
  ];
  const partial = {
    report: {
      kind: "report",
      result: "partial",
      work_done: "承認の API と画面のボタンを実装した。",
      remaining_issues: [{ issue: "本物の CLI で確かめる条件を書き換える理由が記入されておらず、計画がはじかれた。" }],
    },
    verification: { checked: "approve API and button" },
  };
  for (const changes of asked) {
    const { requests, explanation, options } = await openDecision(t, {
      kind: "partial_limit",
      title: "承認の API と画面のボタンを実装する",
      partial,
      textChecks: [],
      runner: (request, count) => withFixes(request, count === 1
        ? changes
        : { summary: "承認の API とボタンの実装は終わっていますが、本物の CLI で確かめる条件を書き換える理由が抜けています。", next_steps: "どれにも当てはまらないときは、回答欄に一言書くと Manager がそれに従って直します。", options: [fixChoice("条件を現状に合わせることにしますか？")], recommended_option_key: "fix_1" }),
    });
    assert.equal(requests.length, 2, JSON.stringify(changes));
    assert.equal(requests[1].revision.problems.length, 1);
    assert.equal(requests[0].task.title, "承認の API と画面のボタンを実装する");
    assert.match(JSON.stringify(requests[0].reports), /本物の CLI.*記入されて/u);
    assert.equal(explanation.status, "ready");
    assert.doesNotMatch(JSON.stringify(explanation), /作り直してください|recreate the Task/u);
    assert.equal(options[0].label, "条件を現状に合わせることにしますか？");
  }
});

test("choices written for the Owner pass on the first answer, also when they say the Manager will rewrite the criteria or run a command", async (t) => {
  quiet(t);
  const { requests, explanation } = await openDecision(t, {
    kind: "partial_limit",
    textChecks: [],
    runner: (request) => withFixes(request, {
      next_steps: "どれにも当てはまらないときは、回答欄に一言書くと Manager がそれに従って直します。",
      options: [
        { ...fixChoice("条件を書き直して進めることにしますか？"), description: "Manager が受け入れ条件を書き直し、`pnpm build` を実行して確かめます。" },
        { ...fixChoice("Do you want to rewrite the criteria and go on?"), description: "The Manager rewrites the acceptance criteria and runs `pnpm build`." },
        fixChoice("Manager に計画を直してもらいますか？"),
      ],
      recommended_option_key: "fix_1",
    }),
  });
  assert.equal(requests.length, 1);
  assert.equal(explanation.status, "ready");
});

test("a long neck, long option notes and more than three choices pass and are stored as written", async (t) => {
  const { requests, explanation, options } = await openDecision(t, {
    kind: "partial_limit",
    textChecks: [],
    runner: (request) => withFixes(request, {
      summary: "One. Two. Three. Four.",
      next_steps: "One. Two. Three.",
      option_notes: request.decision.options.map((option) => ({ key: option.key, note: "First. Second." })),
      options: [1, 2, 3, 4].map((n) => ({ ...fixChoice(`Choice ${n}?`), description: "First. Second." })),
      recommended_option_key: "fix_4",
    }),
  });
  assert.equal(requests.length, 1);
  assert.equal(explanation.summary, "One. Two. Three. Four.");
  assert.equal(options.filter((option) => option.key.startsWith("fix_")).length, 4);
});

test("a fixed-form explanation does not ask the Owner for the Manager's work and tells them a word in the answer field is enough", () => {
  const request = (language) => ({
    language,
    forbidden_terms: [],
    decision: { reason: "", tried: "", question: "Task を作り直してください。どちらにしますか？" },
    reports: [],
  });
  assert.doesNotMatch(plainDecisionExplanation(request("ja")).next_steps, /作り直/u);
  assert.match(plainDecisionExplanation(request("ja")).next_steps, /回答欄に一言書くと/u);
  assert.match(plainDecisionExplanation(request("en")).next_steps, /word in the answer field/u);

  const withQuestion = { ...request("ja"), decision: { reason: "", tried: "", question: "別の設定を使うことにしますか？" } };
  const kept = plainDecisionExplanation(withQuestion).next_steps;
  assert.match(kept, /別の設定を使うことにしますか？/u);
  assert.match(kept, /回答欄に一言書くと/u);
});
