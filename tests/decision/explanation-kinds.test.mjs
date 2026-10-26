import assert from "node:assert/strict";
import { test } from "node:test";

import { criteriaDecisionBrief } from "../../packages/core/dist/auto-recovery.js";
import {
  coreTaskDecisionBrief,
  coreWorkDecisionBrief,
  designBlockedBrief,
  managerReplanFailureBrief,
  noProgressLimitBrief,
  prerequisiteExpiredBrief,
  remakeLimitBrief,
  testEnvironmentBrief,
  workPrerequisiteUnreachableBrief,
} from "../../packages/core/dist/decision-brief.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DECISION_FIX_OPTION_KINDS, findDecisionTextProblems, findInternalTerms, REPORT_FORMAT_INVALID_ERROR_KEY } from "../../packages/shared/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const TASK_ID = "01TASKAAAAAAAAAAAAAAAAAAAA";
const TASK_TITLE = "Build the export page";
const USAGE = {
  generations: 2, main_generations: 2, review_attempts: 3, worker_runs: 3, base_sync_generations: 0, base_sync_review_attempts: 0,
  base_sync_worker_runs: 0, non_functional_streak: 2, last_streak_paths: ["docs/a.md"], history: [],
};
const SETTINGS = { lineage_review_attempts: 3, lineage_worker_runs: 3, non_functional_remakes: 2, base_sync_lineage_review_attempts: 3, base_sync_lineage_worker_runs: 3 };
const ENV_BLOCK = { signal: "missing_tool", evidence: "tool not found", argv: ["make", "test"], explicit: false, tried: ["Checked the setup."], missing: ["make"], outside_installs: [] };
const PREREQUISITE = { taskTitle: TASK_TITLE, detail: "waited", reason: "waiting for the data", conditions: ["data is ready"] };
const DEFECTS = [{ criterion_id: "AC1", criterion: "Done.", reason: "cannot be measured here" }];

/** One row of the design table: how the brief is made, the kind it must carry, and the materials the request must hold. */
const ROWS = [
  { name: "final_manager_incomplete", brief: () => coreWorkDecisionBrief({ kind: "final_manager_incomplete", summary: "Missing parts.", missing: [] }, "en"), kind: "final_incomplete", recommended: "retry", scope: "work" },
  { name: "work_integration_verification_failed", brief: () => coreWorkDecisionBrief({ kind: "work_integration_verification_failed", message: "The check failed." }, "en"), kind: "integration_failed", recommended: "retry", scope: "work" },
  { name: "final_manager_failed", brief: () => coreWorkDecisionBrief({ kind: "final_manager_failed", message: "The final check failed." }, "en"), kind: "final_failed", recommended: "retry", scope: "work" },
  { name: "work_merge_failed conflict", brief: () => coreWorkDecisionBrief({ kind: "work_merge_failed", merge_kind: "conflict", message: "Files collide." }, "en"), kind: "merge_failed", recommended: "resolve_conflict", scope: "work" },
  { name: "work_merge_failed other", brief: () => coreWorkDecisionBrief({ kind: "work_merge_failed", merge_kind: "dirty", message: "Local edits." }, "en"), kind: "merge_failed", recommended: "retry", scope: "work" },
  { name: "workflow_tick_failed", brief: () => coreWorkDecisionBrief({ kind: "workflow_tick_failed", message: "The tick failed." }, "en"), kind: "work_halted", recommended: null, scope: "work" },
  { name: "report format", brief: () => coreTaskDecisionBrief(TASK_TITLE, { error_key: REPORT_FORMAT_INVALID_ERROR_KEY, provider_session_id: "session-1" }, "en"), kind: "report_format", recommended: "resubmit_report", scope: "task", report: true },
  { name: "review format", brief: () => coreTaskDecisionBrief(TASK_TITLE, { error_key: "output_format_invalid", role: "reviewer" }, "en"), kind: "review_format", recommended: "rerun_review", scope: "task", report: true },
  { name: "partial", brief: () => coreTaskDecisionBrief(TASK_TITLE, { report: { result: "partial" } }, "en"), kind: "partial_limit", recommended: null, scope: "task" },
  { name: "review budget", brief: () => coreTaskDecisionBrief(TASK_TITLE, { error_key: "review_budget_exhausted" }, "en"), kind: "review_budget", recommended: null, scope: "task", report: true },
  { name: "task failure", brief: () => coreTaskDecisionBrief(TASK_TITLE, { error_key: "worker_crashed" }, "en"), kind: "task_failed", recommended: null, scope: "task", report: true },
  { name: "test environment of a Task", brief: () => testEnvironmentBrief({ subject: { kind: "task", title: TASK_TITLE }, block: ENV_BLOCK }, "en"), kind: "test_environment", recommended: "retry_test_setup", scope: "task", report: true },
  {
    name: "test environment with an install to approve",
    brief: () => testEnvironmentBrief({ subject: { kind: "task", title: TASK_TITLE }, block: { ...ENV_BLOCK, outside_installs: [{ argv: ["brew", "install", "make"], reason: "make is missing" }] } }, "en"),
    kind: "test_environment", recommended: "approve_test_setup_installs", scope: "task", report: true,
  },
  { name: "test environment of a Work", brief: () => testEnvironmentBrief({ subject: { kind: "work" }, block: ENV_BLOCK }, "en"), kind: "test_environment", recommended: "retry_test_setup", scope: "work" },
  ...["lineage_review_attempts", "lineage_worker_runs", "non_functional_remakes", "base_sync_lineage_review_attempts"].map((reason) => ({
    name: `remake limit ${reason}`, brief: () => remakeLimitBrief({ taskTitle: TASK_TITLE, reason, usage: USAGE, settings: SETTINGS }, "en"), kind: "remake_limit", recommended: null, scope: "task", report: true,
  })),
  { name: "design blocked by rejections", brief: () => designBlockedBrief({ taskTitle: TASK_TITLE, trigger: "lead_review_rejections", rejections: 3, limit: 3, report: null, latestFindings: ["The layout is unclear."] }, "en"), kind: "design_blocked", recommended: null, scope: "task" },
  { name: "design blocked by the Designer", brief: () => designBlockedBrief({ taskTitle: TASK_TITLE, trigger: "designer", rejections: null, limit: null, report: null, latestFindings: [] }, "en"), kind: "design_blocked", recommended: null, scope: "task" },
  { name: "no progress", brief: () => noProgressLimitBrief({ taskId: TASK_ID, taskTitle: TASK_TITLE, count: 3, limit: 3, gate: "worker", recent: ["Nothing changed."] }, "en"), kind: "no_progress", recommended: null, scope: "task", report: true },
  ...["deadline", "unreachable", "sync_conflict", "wait_count", "owner"].map((variant) => ({
    name: `prerequisite ${variant}`, brief: () => prerequisiteExpiredBrief({ ...PREREQUISITE, kind: variant }, "en"), kind: "prerequisite_wait", recommended: null, scope: "task",
  })),
  { name: "Work prerequisite", brief: () => workPrerequisiteUnreachableBrief([{ name: "Site Work #3", title: "Data", state: "cancelled", missing: "cancelled" }], "en"), kind: "work_prerequisite", recommended: null, scope: "work" },
  { name: "criteria owner", brief: () => criteriaDecisionBrief({ taskTitle: TASK_TITLE, variant: "owner", defects: DEFECTS }, "en"), kind: "criteria_unverifiable", recommended: null, scope: "task", cause: "criteria" },
  { name: "criteria exhausted", brief: () => criteriaDecisionBrief({ taskTitle: TASK_TITLE, variant: "exhausted", defects: DEFECTS }, "en"), kind: "criteria_unverifiable", recommended: null, scope: "task", cause: "criteria" },
  { name: "replan failure on Tasks", brief: () => managerReplanFailureBrief("task", "The plan could not be made.", "en"), kind: "replan_failed", recommended: null, scope: "task", report: true, issuer: "manager" },
  { name: "replan failure on the Work", brief: () => managerReplanFailureBrief("work", "The plan could not be made.", "en"), kind: "replan_failed", recommended: null, scope: "work", issuer: "manager" },
];

const REPORT = { kind: "report", result: "success", work_done: "Built the page.", verification: { checked: "ran the page once" } };
/** Two plain partial reports of the Task's lineage, oldest first, each with the verification record Core wrote beside it. */
const PARTIALS = [
  { report: { kind: "report", result: "partial", work_done: "Built half of the page." }, verification: { checked: "first partial check" } },
  { report: { kind: "report", result: "partial", work_done: "Built most of the page." }, verification: { checked: "second partial check" } },
];

/** A Core whose runner answers every explanation request with `explain(request)`; requests are collected. */
async function openCore(t, explain) {
  const requests = [];
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
    runDecisionExplanation: async (request) => {
      requests.push(request);
      return explain(request);
    },
  };
  const opened = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-explanation-kinds-" });
  return { ...opened, requests };
}

/** A Work that waits for the Owner, with the Tasks the Decisions will stop; nothing drives it. */
async function seedWork(core, db, { tasks = 1, report = false, partials = false, firstTaskId = TASK_ID } = {}) {
  const created = await core.createWork(command({ title: "Export", summary: "x", size: "normal", project_id: null }, `create-${createUlid()}`));
  const workId = created.data.work_id;
  const now = new Date().toISOString();
  const taskIds = [];
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'judgement_waiting' WHERE id = ?", workId);
    for (let index = 0; index < tasks; index += 1) {
      const id = index === 0 ? firstTaskId : createUlid();
      taskIds.push(id);
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
         VALUES (?, ?, ?, 'code', 'judgement_waiting', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
        id, workId, index === 0 ? TASK_TITLE : `Second task ${index}`, now, now, `T${index + 1}`,
      );
    }
    if (partials) {
      PARTIALS.forEach(({ report: partial, verification }, index) => {
        const id = createUlid();
        tx.run(
          "INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at) VALUES (?, ?, ?, 'task.failure.classified', ?, ?, ?, 'handled', ?)",
          id, 9000 + index, id, workId, taskIds[0], JSON.stringify({ report: partial, verification }), new Date(Date.now() - 1000 * (PARTIALS.length - index)).toISOString(),
        );
      });
    }
    if (report) {
      const runId = createUlid();
      tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)", runId, workId, taskIds[0], now, now);
      tx.run(
        "INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1', 'success', ?, ?, 0, ?)",
        createUlid(), runId, JSON.stringify(report === true ? REPORT : report), "0".repeat(64), now,
      );
    }
  });
  return { workId, taskIds };
}

/** Open a Decision the way ensureCoreDecision / decisions.open do: the brief's text, options and pending explanation. */
async function insertDecision(db, workId, brief, { blocked = [], issuer = "core" } = {}) {
  const id = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at, explanation_json)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
      id, workId, blocked.length > 0 ? "task" : "work", JSON.stringify(blocked), brief.reason, brief.question, brief.tried, brief.current_state,
      JSON.stringify(brief.options), brief.recommended, issuer, new Date().toISOString(), JSON.stringify(brief.explanation),
    );
  });
  return id;
}

const rowOf = (db, id) => {
  const row = db.get("SELECT explanation_json, options_json, recommended, state_version, status FROM decisions WHERE id = ?", id);
  return { explanation: JSON.parse(row.explanation_json), options: JSON.parse(row.options_json), recommended: row.recommended, stateVersion: row.state_version, status: row.status };
};
const openedEvents = (db, id) => db.all("SELECT payload_json FROM events WHERE type = 'decision.opened'").map((event) => JSON.parse(event.payload_json)).filter((payload) => payload.decision_id === id);

/** What a model that follows the rules would answer: a note for every option, Core's recommendation or the first key, fix options only where allowed. */
function answerFor(request, { cause = "work" } = {}) {
  const fix = DECISION_FIX_OPTION_KINDS.includes(request.kind);
  return {
    ok: true,
    explanation: {
      summary: "The work stopped before it could be finished.",
      cause_kind: cause,
      next_steps: "Pick one of the choices below to go on.",
      option_notes: request.decision.options.map((option) => ({ key: option.key, note: "Carries on with this choice." })),
      options: fix ? [{ label: "Try a smaller step", description: "Splits the work into a smaller step.", instruction: "Do a smaller step and retry the Task.", criteria_rewrites: cause === "criteria" ? [{ criterion_id: "AC1", after: "Done in a smaller step.", check: "Run the page once." }] : [] }] : [],
      recommended_option_key: request.decision.recommended ?? (fix ? "fix_1" : request.decision.options[0].key),
    },
  };
}

test("every row of the stop-kind table gives its kind, its materials, a saved explanation and one opened notice", async (t) => {
  const { db, core, requests } = await openCore(t, (request) => answerFor(request, { cause: request.kind === "criteria_unverifiable" ? "criteria" : "work" }));
  const { workId, taskIds } = await seedWork(core, db, { report: true, partials: true });
  const cases = [];
  for (const row of ROWS) {
    const brief = row.brief();
    assert.deepEqual(brief.explanation, { kind: row.kind, status: "pending" }, `${row.name}: the brief asks for the ${row.kind} explanation`);
    assert.equal(brief.recommended, row.recommended, `${row.name}: Core's recommendation`);
    const id = await insertDecision(db, workId, brief, { blocked: row.scope === "task" ? [taskIds[0]] : [], issuer: row.issuer ?? "core" });
    cases.push({ row, brief, id, before: rowOf(db, id) });
  }

  await core.start();
  await waitFor(() => cases.every(({ id }) => rowOf(db, id).explanation.status === "ready"), { message: "every explanation is ready" });

  for (const { row, brief, id, before } of cases) {
    const request = requests.find((candidate) => candidate.decision.reason === brief.reason && candidate.decision.tried === brief.tried && candidate.kind === row.kind
      && JSON.stringify(candidate.decision.options.map((option) => option.label)) === JSON.stringify(brief.options.map((option) => option.label)));
    assert.ok(request, `${row.name}: a request was made`);
    // Common materials.
    assert.deepEqual(request.decision.options.map((option) => option.key), brief.options.map((option) => option.key), row.name);
    assert.equal(request.decision.recommended, brief.recommended, row.name);
    assert.ok(request.forbidden_terms.includes(id) && request.forbidden_terms.includes(workId), `${row.name}: the Decision and Work ids are forbidden`);
    // T: only for a Decision that stops a Task, and the Task is the first blocked one.
    if (row.scope === "task") {
      assert.equal(request.task?.title, TASK_TITLE, `${row.name}: T`);
      assert.deepEqual(request.task.acceptance_criteria.map((criterion) => criterion.id), ["AC1"], row.name);
    } else {
      assert.equal(request.task, null, `${row.name}: no T for a Work`);
    }
    // R: the latest report and its verification, only for the kinds that carry it.
    if (row.kind === "partial_limit") {
      // RL: the partial reports of the lineage, oldest first, and the newest one's verification record.
      assert.deepEqual(request.reports, PARTIALS.map((partial) => partial.report), `${row.name}: RL`);
      assert.deepEqual(request.verification, PARTIALS.at(-1).verification, row.name);
    } else if (row.report) {
      assert.deepEqual(request.reports, [REPORT], `${row.name}: R`);
      assert.deepEqual(request.verification, REPORT.verification, row.name);
    } else {
      assert.deepEqual(request.reports, [], `${row.name}: no R`);
      assert.equal(request.verification, null, row.name);
    }

    const after = rowOf(db, id);
    assert.equal(after.explanation.kind, row.kind, row.name);
    assert.equal(after.explanation.summary, "The work stopped before it could be finished.", row.name);
    assert.equal(after.explanation.next_steps, "Pick one of the choices below to go on.", row.name);
    assert.deepEqual(after.explanation.option_notes.map((note) => note.key), brief.options.map((option) => option.key), row.name);
    assert.equal(after.stateVersion, before.stateVersion, `${row.name}: state_version does not rise`);
    if (DECISION_FIX_OPTION_KINDS.includes(row.kind)) {
      assert.deepEqual(after.options.slice(1), before.options, `${row.name}: the Decision's own options stay after the fix option`);
      assert.equal(after.options[0].key, "fix_1", row.name);
      assert.equal(after.recommended, brief.recommended ?? "fix_1", row.name);
    } else {
      assert.deepEqual(after.options, before.options, `${row.name}: options_json is unchanged`);
      // Rule 5.3: Core's recommendation stays; without one, the model's choice is one of the Decision's options.
      assert.equal(after.recommended, brief.recommended ?? brief.options[0].key, row.name);
    }
    if (row.cause) assert.equal(after.explanation.cause_kind, row.cause, `${row.name}: a criteria cause with no fix options is ready`);

    const opened = await waitFor(() => openedEvents(db, id).length > 0 && openedEvents(db, id), { message: `${row.name}: decision.opened` });
    assert.equal(opened.length, 1, `${row.name}: one notice`);
    assert.equal(opened[0].explanation.summary, after.explanation.summary, `${row.name}: the notice came after the explanation was ready`);
    assert.equal(opened[0].issuer_role, row.issuer ?? "core", row.name);
  }
});

test("a Task that is gone leaves T empty and the explanation still gets written", async (t) => {
  const { db, core, requests } = await openCore(t, (request) => answerFor(request));
  const { workId } = await seedWork(core, db);
  const id = await insertDecision(db, workId, coreTaskDecisionBrief(TASK_TITLE, { error_key: "worker_crashed" }, "en"), { blocked: [createUlid()] });

  await core.start();
  await waitFor(() => rowOf(db, id).explanation.status === "ready", { message: "the explanation is ready" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].task, null);
  assert.deepEqual(requests[0].reports, []);
});

test("the forbidden terms of a Decision with two stopped Tasks cover the Decision, the Work, both Tasks, their Manager ids and the criteria", async (t) => {
  const { db, core, requests } = await openCore(t, (request) => answerFor(request));
  const { workId, taskIds } = await seedWork(core, db, { tasks: 2 });
  const id = await insertDecision(db, workId, coreTaskDecisionBrief(TASK_TITLE, { error_key: "worker_crashed" }, "en"), { blocked: taskIds });

  await core.start();
  await waitFor(() => rowOf(db, id).explanation.status === "ready", { message: "the explanation is ready" });
  const terms = requests[0].forbidden_terms;
  for (const term of [id, workId, ...taskIds, "T1", "T2", "AC1"]) assert.ok(terms.includes(term), `${term} is forbidden (${JSON.stringify(terms)})`);
  assert.equal(new Set(terms).size, terms.length, "no term is listed twice");
});

test("a pending explanation accepts a retry, a cancel and a free-text answer, and a failed one accepts an answer too; nothing is written or announced afterwards", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { db, core, requests } = await openCore(t, async (request) => {
    await gate;
    return answerFor(request);
  });
  // One Work per Decision: a cancel answer ends its whole Work, which would close the Decisions of the others.
  const stopped = [];
  for (let index = 0; index < 4; index += 1) {
    const { workId, taskIds } = await seedWork(core, db, { firstTaskId: createUlid() });
    stopped.push(await insertDecision(db, workId, coreTaskDecisionBrief(`Stopped ${index}`, { error_key: "worker_crashed" }, "en"), { blocked: [taskIds[0]] }));
  }
  const pendingIds = stopped.slice(0, 3);
  const failedId = stopped[3];
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE decisions SET explanation_json = ? WHERE id = ?", JSON.stringify({ kind: "task_failed", status: "failed", error: "timeout" }), failedId);
  });

  await core.start();
  await waitFor(() => requests.length >= 1, { message: "a pending explanation was asked for" });
  for (const id of pendingIds) assert.equal(rowOf(db, id).explanation.status, "pending");
  await waitFor(() => openedEvents(db, failedId).length === 1, { message: "the failed Decision is announced as it is" });
  for (const id of pendingIds) assert.equal(openedEvents(db, id).length, 0);

  const answers = [
    [pendingIds[0], "retry"],
    [pendingIds[1], "cancel"],
    [pendingIds[2], null],
    [failedId, "cancel"],
  ];
  for (const [id, optionKey] of answers) {
    const version = db.get("SELECT state_version FROM decisions WHERE id = ?", id).state_version;
    const answer = optionKey ? rowOf(db, id).options.find((option) => option.key === optionKey).label : "Please try a different approach.";
    await core.answerDecision(id, command({ answer, option_key: optionKey, source_message_id: null }, `answer-${id}`, version));
    assert.equal(rowOf(db, id).status, "resolved", `${optionKey ?? "free text"} is accepted`);
  }

  release();
  // Let the job finish, then confirm it neither rewrote an answered row nor announced it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const id of pendingIds) {
    assert.equal(rowOf(db, id).explanation.status, "pending", "no explanation is written after the answer");
    assert.equal(openedEvents(db, id).length, 0, "no notice for an answered pending Decision");
  }
  assert.equal(rowOf(db, failedId).explanation.status, "failed", "the failed row stays as it was");
  assert.equal(openedEvents(db, failedId).length, 1, "no second notice after the answer");
});

test("Owner names in backticks pass, Owl's own names and ids do not, and the problem says how to fix", () => {
  const texts = (summary) => ({ summary, next_steps: "Retry.", options: [] });
  for (const text of ["Use `mikata_long` and `duo_wide`.", "Edit `layouts/mikata_long.yaml`."]) {
    assert.deepEqual(findInternalTerms(text, []), [], text);
    assert.deepEqual(findDecisionTextProblems(texts(text), []), [], text);
  }
  for (const text of ["It hit auto_recovery.", "It hit `auto_recovery`.", "Set `criteria_relaxations`.", "Got retry_plan.", "Got `retry_plan` or `wait_rate_limit`.", "Got `integration_conflict`.", "Got `plan_rejected`.", "Uses mikata_long.", "Task 01ARZ3NDEKTSV4RRFFQ69G5FAV, AC1."]) {
    assert.ok(findInternalTerms(text, []).length > 0, text);
  }
  for (const name of ["merge_conflict", "commit_failure", "auto_conflict", "auto_final", "base_merge_conflict", "integration_verification"]) {
    for (const text of [`Got ${name}.`, `Got \`${name}\`.`]) assert.deepEqual(findInternalTerms(text, []), [name], text);
  }
  assert.ok(findInternalTerms("Edit `T-9`.", ["T-9"]).length > 0);
  const [problem] = findDecisionTextProblems(texts("It hit `auto_recovery`."), []);
  assert.match(problem, /auto_recovery/u);
  assert.match(problem, /Owner's words/u);
  assert.match(problem, /in backticks/u);
});

test("the replan_failed Decision of sns-team #8 explains the cause and the Owner's choice, with a model answer or with Core's fixed-form text", async (t) => {
  const stuck = {
    kind: "report", result: "partial", work_done: "Stopped.",
    remaining_issues: [{ issue: "レイアウトが登録一覧になく、リポジトリの外の変更は検証できません。" }],
    question_for_manager: "どちらのレイアウトにしますか: mikata_long か duo_wide か。",
  };
  const tried = "Rejected: Criterion AC1 was changed but has no criteria_relaxations entry.";
  const run = async (explain) => {
    const { db, core, requests } = await openCore(t, explain);
    const { workId, taskIds } = await seedWork(core, db, { report: stuck });
    const brief = { ...managerReplanFailureBrief("task", tried, "en"), tried };
    const id = await insertDecision(db, workId, brief, { blocked: [taskIds[0]], issuer: "manager" });
    await core.start();
    await waitFor(() => rowOf(db, id).explanation.status !== "pending", { message: "the explanation was written" });
    return { explanation: rowOf(db, id).explanation, requests };
  };
  const answer = (request, next_steps) => ({
    ...answerFor(request).explanation,
    summary: "レイアウトが登録一覧になく、リポジトリの外の変更は検証できません。",
    next_steps,
  });

  const passed = await run((request) => ({ ok: true, explanation: answer(request, "`mikata_long` か `duo_wide` を選んでください。") }));
  assert.deepEqual([passed.explanation.status, passed.explanation.plain], ["ready", undefined]);
  assert.match(passed.explanation.next_steps, /`mikata_long` か `duo_wide`/);

  const rejected = await run((request) => ({ ok: true, explanation: answer(request, "mikata_long か duo_wide を選んでください。") }));
  assert.equal(rejected.requests.length, 3, "two rewrites, then Core's own text");
  assert.equal(rejected.explanation.plain, true);
  assert.match(rejected.explanation.summary, /登録一覧になく.*リポジトリの外/);
  assert.match(rejected.explanation.next_steps, /`mikata_long` か `duo_wide`/);

  for (const { explanation } of [passed, rejected]) {
    assert.doesNotMatch(JSON.stringify(explanation), /criteria_relaxations|AC1|Rejected/);
  }
});

test("the stopped layout Decision of sns-team #8 gets the neck and choices phrased as questions, each saying what happens", async (t) => {
  const choice = (label, description) => ({ label, description, instruction: "Carry out the Owner's pick.", criteria_rewrites: [] });
  const { db, core, requests } = await openCore(t, (request) => ({
    ok: true,
    explanation: {
      ...answerFor(request).explanation,
      summary: "長尺動画の見た目の設定 `mikata_long` が今の登録一覧にありません。ほぼ同じ配置の `duo_wide` はテロップ枠が1つ多く、そのままでは先へ進めません。",
      next_steps: "どちらかを選んでください。どちらでもないときは、回答欄に一言書くと Manager がそれに従って直します。",
      options: [
        choice("`duo_wide` を使うことにしますか？", "テロップ枠が1つ増えた見た目で動画が作られます。"),
        choice("`mikata_long` を登録し直すことにしますか？", "元の見た目のまま作れますが、登録の準備が終わるまで待つことになります。"),
      ],
      recommended_option_key: "fix_1",
    },
  }));
  const { workId, taskIds } = await seedWork(core, db, { partials: true });
  const title = "長尺動画を書き出す";
  const partial = {
    report: {
      kind: "report",
      result: "partial",
      work_done: "長尺動画の見た目の設定 mikata_long が今の登録一覧になく、書き出せなかった。",
      remaining_issues: [{ issue: "ほぼ同じ配置の duo_wide はテロップ枠が1つ多く、置き換えると見た目が変わる。" }],
    },
    verification: { checked: "layout list" },
  };
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET title = ? WHERE id = ?", title, taskIds[0]);
    tx.run("UPDATE events SET payload_json = ? WHERE type = 'task.failure.classified' AND task_id = ?", JSON.stringify(partial), taskIds[0]);
  });
  const id = await insertDecision(db, workId, coreTaskDecisionBrief(title, { report: { result: "partial" } }, "en"), { blocked: [taskIds[0]] });
  await core.start();
  await waitFor(() => rowOf(db, id).explanation.status !== "pending", { message: "the explanation was written" });

  const { explanation, options } = rowOf(db, id);
  assert.equal(requests.length, 1, "the first answer passed the checks");
  assert.equal(requests[0].task.title, title);
  assert.match(JSON.stringify(requests[0].reports), /mikata_long.*duo_wide.*テロップ枠が1つ多く/u);
  assert.deepEqual([explanation.status, explanation.plain], ["ready", undefined]);
  assert.match(explanation.summary, /`mikata_long`.*ありません/u);
  const fixes = options.filter((option) => option.key.startsWith("fix_"));
  assert.equal(fixes.length, 2);
  for (const fix of fixes) {
    assert.match(fix.label, /にしますか？$/u);
    assert.ok(fix.description.length > 0);
  }
  assert.match(explanation.next_steps, /回答欄に一言書くと/u);
});
