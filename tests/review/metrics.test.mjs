import assert from "node:assert/strict";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { PROVIDER_FAILED_ERROR_PREFIX } from "../../packages/core/dist/attempt-policy.js";
import { reviewMetrics } from "../../packages/core/dist/review-metrics.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { buildReviewerPrompt, reviewerPromptInputs } from "../../packages/agent-runtime/dist/reviewer.js";
import { createTestCore } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const token = "review-metrics-owner-token";

const noRunner = {
  runManagerPlan: async () => ({ outcome: "failed" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
  runCurator: async () => ({ ok: false, error: "curator_unavailable" }),
};

async function seed(db) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO works (id, title, summary, size, state, state_version, owner_id, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('w1', 'W', '', 'small', 'running', 1, 'owner:default', '{}', '[]', ?, ?)", now, now);
    const verdicts = { t1: ["pass"], t2: ["fix_required", "pass"], t3: ["fix_required", "fix_required", "replan_required"], t4: ["replan_required", "pass"] };
    let seq = 0;
    for (const [taskId, list] of Object.entries(verdicts)) {
      tx.run("INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, total_review_attempts, created_at, updated_at) VALUES (?, 'w1', 'T', 'code', 'completed', 'normal', '', '', ?, ?, ?)", taskId, list.length, now, now);
      list.forEach((verdict, round) => {
        tx.run("INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at) VALUES (?, ?, ?, ?, '[]', '{}', ?)", createUlid(), taskId, round, verdict, now);
      });
      for (const role of ["worker", "reviewer"]) {
        tx.run(
          "INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, usage_json, created_at, updated_at) VALUES (?, 'w1', ?, ?, 'p', 'm', 'completed', ?, ?, ?)",
          createUlid(), taskId, role, JSON.stringify({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 1 }), now, now,
        );
      }
    }
    // routing decisions: t1 skipped, t2 forced by two reasons, t3 required without force, t4 undecided
    const routing = (required, forced) => JSON.stringify({ required, base: "type_default_not_required", forced_reasons: forced.map((code) => ({ code })) });
    tx.run("UPDATE tasks SET review_decision='not_required', review_decision_json=? WHERE id='t1'", routing(false, []));
    tx.run("UPDATE tasks SET review_decision='required', review_decision_json=? WHERE id='t2'", routing(true, ["sensitive_path", "changed_lines_over"]));
    tx.run("UPDATE tasks SET review_decision='required', review_decision_json=? WHERE id='t3'", routing(true, []));
    // a Task that was never reviewed still counts in tokens_per_task_any_review
    tx.run("INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, total_review_attempts, review_decision, review_decision_json, created_at, updated_at) VALUES ('t5', 'w1', 'T', 'code', 'completed', 'normal', '', '', 0, 'not_required', ?, ?, ?)", routing(false, []), now, now);
    tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, usage_json, created_at, updated_at) VALUES (?, 'w1', 't5', 'worker', 'p', 'm', 'completed', ?, ?, ?)", createUlid(), JSON.stringify({ input_tokens: 1000 }), now, now);
    // forced Tasks are counted from verification.completed events: t2 was forced, then re-verified as sticky_required without reasons;
    // t3 was required by type default and merely could not be measured, so it is not forced
    const verified = (taskId, decision) => tx.run(
      "INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at) VALUES (?, ?, ?, 'verification.completed', 'w1', ?, ?, 'handled', ?)",
      createUlid(), ++seq, createUlid(), taskId, JSON.stringify({ outcome: "pass", review_routing: decision }), now,
    );
    verified("t2", { required: true, base: "type_default_not_required", forced_reasons: [{ code: "sensitive_path" }, { code: "changed_lines_over" }] });
    verified("t2", { required: true, base: "sticky_required", forced_reasons: [] });
    verified("t3", { required: true, base: "type_default_required", forced_reasons: [{ code: "changed_files_over" }] });
    for (const errorKey of ["worker_verification_failed", "worker_verification_failed", "hybrid_integration_verification_missing"]) {
      tx.run(
        "INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at) VALUES (?, ?, ?, 'task.failure.classified', 'w1', 't1', ?, 'handled', ?)",
        createUlid(), ++seq, createUlid(), JSON.stringify({ error_key: errorKey, gate_reasons: ["x"] }), now,
      );
    }
    // not a gate failure: no gate_reasons
    tx.run(
      "INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at) VALUES (?, ?, ?, 'task.failure.classified', 'w1', 't1', '{\"error_key\":\"other\"}', 'handled', ?)",
      createUlid(), ++seq, createUlid(), now,
    );
    for (const [type, taskId, payload] of retryEvents) {
      tx.run(
        "INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'w1', ?, ?, 'handled', ?)",
        createUlid(), ++seq, createUlid(), type, taskId, JSON.stringify(payload), now,
      );
    }
    tx.run("UPDATE agent_runs SET ended_at = ? WHERE role = 'worker'", now);
  });
}

// Each group is seeded with its own size so the expected counts come from the seed.
const classified = (failure_class, extra = {}) => ["task.failure.classified", "t1", { failure_class, ...extra }];
const retryEvents = [
  ...Array(2).fill(classified("transient")),
  ...Array(3).fill(classified("deterministic")),
  classified("deterministic", { escalated_from: "transient" }),
  classified("deterministic", { error_key: `${PROVIDER_FAILED_ERROR_PREFIX}legacy` }),
  ["task.rate_limited", "t1", {}],
  ["agent.crashed", "t1", { role: "worker" }],
  ["agent.crashed", "t1", { role: "reviewer" }],
  ["verification.completed", "t1", { outcome: "fail" }],
  ["verification.completed", "t1", { outcome: "pass", merge_exit_code: 1 }],
  ["review.failed", "t1", { review: { verdict: "fix_required" } }],
  ["review.failed", "t1", { error: "reviewer crashed" }],
  ["task.replan_requested", "t3", {}],
  ["task.acceptance_defect_reported", "t3", {}],
  ["task.conflict", "t4", {}],
  ["review.passed", "t4", { merge_exit_code: 2 }],
  ["task.started", "t3", {}],
  ["task.started", "t3", {}],
  ["task.started", "t4", {}],
  ["task.replanned", "t3", {}],
];
const countOf = (predicate) => retryEvents.filter(([type, , payload]) => predicate(type, payload)).length;

test("review metrics return the specified values for the seeded database", async (t) => {
  const { db } = await openTestDatabase(t, { prefix: "owl-review-metrics-" });
  await seed(db);

  const metrics = reviewMetrics(db);
  assert.deepEqual(metrics.first_review_pass_rate, { numerator: 1, denominator: 4, value: 0.25 });
  assert.equal(metrics.reviews_per_task.value, 2);
  assert.deepEqual([metrics.two_plus_roundtrip_rate.numerator, metrics.two_plus_roundtrip_rate.max_roundtrips], [1, 3]);
  assert.deepEqual(metrics.tokens_per_task.worker, { tasks: 4, sum: 464, mean: 116 });
  assert.deepEqual(metrics.tokens_per_task.all_agent_runs, { tasks: 4, sum: 928, mean: 232 });
  assert.deepEqual(metrics.tokens_per_task_any_review.worker, { tasks: 5, sum: 1464, mean: 293 });
  assert.deepEqual(metrics.tokens_per_task_any_review.all_agent_runs, { tasks: 5, sum: 1928, mean: 386 });
  assert.deepEqual(metrics.review_routing, { decided: 4, skipped: 2, forced: { tasks: 1, by_reason: { changed_lines_over: 1, sensitive_path: 1 } } });
  assert.deepEqual(metrics.total_review_attempts, { tasks: 5, sum: 8, max: 3 });
  assert.deepEqual(metrics.completion_gate_failures, {
    total: 3,
    by_reason: { hybrid_integration_verification_missing: 1, worker_verification_failed: 2 },
  });
});

test("review metrics split retries into semantic, infrastructure and integration", async (t) => {
  const { db } = await openTestDatabase(t, { prefix: "owl-review-metrics-retries-" });
  await seed(db);
  const { retries, verification_pass_rate, replan_rate, infrastructure_failure_rate } = reviewMetrics(db);

  const transient = countOf((type, p) => type === "task.failure.classified" && p.failure_class === "transient");
  const escalated = countOf((type, p) => type === "task.failure.classified" && p.failure_class === "deterministic"
    && (p.escalated_from !== undefined || p.error_key?.startsWith(PROVIDER_FAILED_ERROR_PREFIX)));
  const deterministic = countOf((type, p) => type === "task.failure.classified" && p.failure_class === "deterministic") - escalated;
  assert.equal(retries.semantic.by_kind.deterministic_failure, deterministic);
  assert.equal(retries.infrastructure.by_kind.transient, transient);
  // escalated_from and the legacy provider_failed: error_key both land in transient_budget_exhausted
  assert.equal(retries.infrastructure.by_kind.transient_budget_exhausted, escalated);
  assert.equal(retries.infrastructure.by_kind.transient_budget_exhausted, 2);

  // a Reviewer crash's review.failed has no review object: it is infrastructure (agent.crashed), not semantic
  assert.equal(retries.semantic.by_kind.review_failed, countOf((type, p) => type === "review.failed" && p.review !== undefined));
  assert.equal(retries.infrastructure.by_kind.reviewer_crash, countOf((type, p) => type === "agent.crashed" && p.role === "reviewer"));
  assert.equal(retries.infrastructure.by_kind.crash, countOf((type, p) => type === "agent.crashed" && p.role !== "reviewer"));

  for (const bucket of [retries.semantic, retries.infrastructure, retries.integration]) {
    assert.equal(bucket.total, Object.values(bucket.by_kind).reduce((sum, n) => sum + n, 0));
  }
  assert.equal(retries.integration.by_kind.conflict, countOf((type) => type === "task.conflict"));
  assert.equal(retries.integration.by_kind.merge_failed, countOf((type, p) => p.merge_exit_code > 0));

  const completed = (await db.all("SELECT COUNT(*) AS n FROM tasks WHERE status = 'completed'"))[0].n;
  assert.equal(retries.per_completed_task.semantic, Math.round((10000 * retries.semantic.total) / completed) / 10000);
  assert.equal(retries.per_completed_task.infrastructure, Math.round((10000 * retries.infrastructure.total) / completed) / 10000);

  // 3 seeded passes (t2 twice, t3) plus the retryEvents ones
  const passes = 3 + countOf((type, p) => type === "verification.completed" && p.outcome === "pass");
  const fails = countOf((type, p) => type === "verification.completed" && p.outcome === "fail");
  assert.deepEqual([verification_pass_rate.numerator, verification_pass_rate.denominator], [passes, passes + fails]);
  assert.deepEqual([replan_rate.numerator, replan_rate.denominator], [1, 2]);
  const finished = (await db.all("SELECT COUNT(*) AS n FROM agent_runs WHERE ended_at IS NOT NULL"))[0].n;
  assert.deepEqual([infrastructure_failure_rate.numerator, infrastructure_failure_rate.denominator], [retries.infrastructure.total, finished]);
});

test("GET /metrics/review works through the production adapter and returns 503 without the API", async (t) => {
  const { root, db, core: durableCore } = await createTestCore(t, { agentRunner: noRunner }, { prefix: "owl-review-metrics-http-" });
  await seed(db);
  await durableCore.start();
  const serve = (core) => startTestHttpServer(t, { core, db, webOut: root, owlRoot: root }, { token });
  const route = "/api/v1/metrics/review";

  const wrapped = await (await serve(new ExternalCoreAdapter(durableCore, db, root, root))).request("GET", route);
  assert.equal(wrapped.status, 200);
  const body = await wrapped.json();
  assert.deepEqual(body.data, JSON.parse(JSON.stringify(reviewMetrics(db))));
  assert.equal(body.data.completion_gate_failures.total, 3);

  const bare = await (await serve({})).request("GET", route);
  assert.equal(bare.status, 503);
});

test("scheduler_ready_delay_ms and attempt_decisions are counted from events by sequence", async (t) => {
  const { db } = await createTestCore(t, { agentRunner: noRunner }, { prefix: "owl-review-metrics-delay-" });
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (offsetMs) => new Date(base + offsetMs).toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", at(0), at(0));
    tx.run("INSERT INTO works (id, title, summary, size, state, state_version, owner_id, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('w1', 'W', '', 'small', 'running', 1, 'owner:default', '{}', '[]', ?, ?)", at(0), at(0));
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) {
      tx.run("INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at) VALUES (?, 'w1', 'T', 'code', 'ready', 'normal', '', '', ?, ?)", id, at(0), at(0));
    }
    let seq = 0;
    const event = (type, taskId, offsetMs, payload = {}) => tx.run(
      "INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'w1', ?, ?, 'handled', ?)",
      createUlid(), ++seq, createUlid(), type, taskId, JSON.stringify(payload), at(offsetMs),
    );
    event("task.started", "f", 1000); // (6) no origin: not counted
    event("task.ready", "a", 0); event("task.started", "a", 5000); // (1) 5s
    event("task.attempt_decided", "b", 0, { to: "ready", action: "retry", reason: "transient", next_attempt_at: at(30000) });
    event("task.started", "b", 40000); // (2) 10s from next_attempt_at
    event("task.ready", "c", 0); event("work.resumed", null, 60000); event("task.started", "c", 63000); // (3) 3s
    event("work.resumed", null, 70000); event("task.started", "e", 75000); // (5) from work.resumed, no task.ready: 5s
    event("task.ready", "g", 90000); event("task.started", "g", 90000); // (7) same created_at: 0
    event("work.resumed", null, 200000); // (4) after every task.started: changes nothing
    event("task.attempt_decided", "d", 0, { to: "ready", action: "retry", reason: "transient" });
    event("task.attempt_decided", "d", 0, { to: "review_fix_waiting", action: "fix", reason: "review_fix_required" });
  });
  const metrics = reviewMetrics(db);
  // a 5000, b 10000, c 3000, e 5000, g 0
  assert.deepEqual(metrics.scheduler_ready_delay_ms, { launches: 5, mean: 4600, max: 10000 });
  assert.deepEqual(metrics.attempt_decisions, { total: 3, by_action: { fix: 1, retry: 2 }, by_reason: { review_fix_required: 1, transient: 2 } });
});

test("the Reviewer prompt treats the Worker's verification as a claim and carries it unchanged", () => {
  const verification = { status: "passed", acceptance: [{ criterion_id: "AC1", status: "passed", evidence: "ran X" }], checks: [], integration_check: { required: true, status: "passed" } };
  const request = {
    task: { id: "t", work_id: "w", title: "T", status: "reviewing", type: "code", state_version: 1, updated_at: "", parent_task_id: null, acceptance: "AC1", review_round: 0, failure_count: 0, worker_generation: 1, depends_on: [] },
    report: { kind: "report", schema_version: "2.0.0", invocation_id: "i", result: "success", work_done: "d", delegation: {}, changes: [], verification, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null },
  };
  const prompt = buildReviewerPrompt(request, "en");
  assert.deepEqual(reviewerPromptInputs(request).find((slot) => slot.name === "Review").value.report.verification, verification);
  assert.match(prompt, /ran X/u);
  assert.match(prompt, /claim to check, not a fact to trust/u);
  for (const phrase of [/every criterion in task\.acceptance_criteria/u, /compare each piece of evidence with the workspace/u, /re-run the commands or searches/u, /integration_check/u, /not actually verified, report a major finding/u, /child agent's report/u]) assert.match(prompt, phrase);
});
