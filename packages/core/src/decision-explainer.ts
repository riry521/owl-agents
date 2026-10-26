import {
  DECISION_FIX_OPTION_PREFIX,
  applyDecisionTexts,
  decisionTextsOf,
  findDecisionTextProblems,
  readDecisionExplanation,
  readDecisionTextCheckOutput,
  type DecisionTexts,
  type DecisionExplanationCheckContext,
  type DecisionExplanationKind,
  type DecisionExplanationReport,
  type DecisionExplanationRequest,
  type DecisionExplanationRunResult,
  type DecisionFixOption,
  type StoredDecisionExplanation,
} from "../../shared/dist/decision-explanation.js";
import { readStoredAcceptanceCriteria } from "../../shared/dist/acceptance-criteria.js";
import { assertDecisionBrief } from "./decision-brief";
import { plainDecisionExplanation, type PlainExplanation } from "./decision-plain-explanation";
import { lineagePartialReportPayloads, type LineageReader } from "./task-lineage";
import { progressGuard } from "./progress-guard";
import type { CoreDatabase, CoreWriteLaneTransaction, Decision, DecisionTextCheck } from "./types";

type WriteLaneLike = { transact<T>(callback: (transaction: CoreWriteLaneTransaction) => T): Promise<T> };

export interface DecisionExplainerDeps {
  readonly db: CoreDatabase;
  readonly writeLane: WriteLaneLike;
  readonly runner: () => { runDecisionExplanation?: (request: DecisionExplanationRequest) => Promise<DecisionExplanationRunResult> };
  readonly roleModel: (role: string) => { model: string; provider: string; effort?: string } | undefined;
  readonly rules: (workId: string) => string | null;
  readonly language: () => "ja" | "en";
  readonly timeoutSeconds: () => number;
  /** Rewrites asked for after a failed check before the fixed-form explanation is stored. */
  readonly rewritesMax: () => number;
  /** Called in order on the texts of each explanation; none means the common checks decide. */
  readonly textChecks: () => readonly DecisionTextCheck[];
  readonly announce: (workId: string) => Promise<void>;
}

type Outcome = { readonly report: DecisionExplanationReport } | { readonly error: string; readonly plain?: PlainExplanation };

/** Decision.explanation from the stored explanation_json. */
export function toDecisionExplanation(json: string | null | undefined): Decision["explanation"] {
  if (!json) return null;
  const stored = JSON.parse(json) as StoredDecisionExplanation;
  // Rows written before next_steps and option_notes existed have neither.
  return {
    kind: stored.kind,
    status: stored.status,
    summary: stored.summary ?? null,
    cause_kind: stored.cause_kind ?? null,
    next_steps: stored.next_steps ?? null,
    option_notes: [...(stored.option_notes ?? [])],
  };
}

/** The check context of a request: what readDecisionExplanation needs from it. */
function checkContextOf(request: Pick<DecisionExplanationRequest, "kind" | "decision" | "task" | "forbidden_terms">): DecisionExplanationCheckContext {
  return {
    kind: request.kind,
    options: request.decision.options,
    recommended: request.decision.recommended,
    criterion_ids: request.task?.acceptance_criteria.map((c) => c.id) ?? [],
    forbidden_terms: request.forbidden_terms,
  };
}

interface TaskRow { id: string; title: string; manager_task_id: string | null; acceptance: string; acceptance_criteria_json: string | null }
type StoredCriterion = { id: string; text: string; check?: string };

/** Kinds whose Decision stops a Task: the first blocked Task's title and criteria (T) go into the request. */
const KINDS_WITH_TASK: ReadonlySet<DecisionExplanationKind> = new Set([
  "report_format", "review_format", "partial_limit", "review_budget", "task_failed", "test_environment", "remake_limit",
  "design_blocked", "no_progress", "prerequisite_wait", "criteria_unverifiable", "replan_failed",
]);
/** Of those, the kinds that also send the Task's latest Worker report and its verification (R). */
const KINDS_WITH_REPORT: ReadonlySet<DecisionExplanationKind> = new Set([
  "report_format", "review_format", "review_budget", "task_failed", "test_environment", "remake_limit", "no_progress", "replan_failed",
]);

function readTask(reader: LineageReader, taskId: string | undefined): { task: TaskRow; criteria: StoredCriterion[] } | null {
  if (taskId === undefined) return null;
  const task = reader.get<TaskRow>("SELECT id, title, manager_task_id, acceptance, acceptance_criteria_json FROM tasks WHERE id = ?", taskId);
  // A Task planned without structured criteria keeps its text in `acceptance`.
  return task ? { task, criteria: readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance) } : null;
}

type ExplanationBase = Omit<DecisionExplanationRequest, "provider" | "model" | "effort" | "timeout_ms">;

/**
 * Inputs for one Decision's explanation, by the kind stored in its explanation_json.
 * null when the Decision is gone, or a partial_limit Decision lost its Task (without the reports no fix option can be written).
 * Another kind whose Task is gone asks with the Decision's own texts only.
 */
export function buildExplanationRequest(
  reader: LineageReader,
  decisionId: string,
  language: "ja" | "en",
  rules: string | null,
): ExplanationBase | null {
  const decision = reader.get<{ work_id: string; blocked_task_ids_json: string; reason: string; question: string; current_state: string; tried: string; options_json: string; recommended: string | null; explanation_json: string | null }>(
    "SELECT work_id, blocked_task_ids_json, reason, question, current_state, tried, options_json, recommended, explanation_json FROM decisions WHERE id = ?",
    decisionId,
  );
  if (!decision?.explanation_json) return null;
  const kind = (JSON.parse(decision.explanation_json) as StoredDecisionExplanation).kind;
  const blockedTaskIds = JSON.parse(decision.blocked_task_ids_json) as string[];
  const found = KINDS_WITH_TASK.has(kind) ? readTask(reader, blockedTaskIds[0]) : null;
  if (kind === "partial_limit" && !found) return null;
  // Every blocked Task is named in the Decision's texts, so all of their ids are internal terms, not only the first Task's.
  const blocked = blockedTaskIds.flatMap((id) => {
    const row = reader.get<{ manager_task_id: string | null }>("SELECT manager_task_id FROM tasks WHERE id = ?", id);
    return [id, ...(row?.manager_task_id ? [row.manager_task_id] : [])];
  });
  let reports: DecisionExplanationRequest["reports"] = [];
  let verification: DecisionExplanationRequest["verification"] = null;
  if (found && kind === "partial_limit") {
    const payloads = lineagePartialReportPayloads(reader, found.task.id, progressGuard(reader).partial_limit + 1).reverse();
    const latest = payloads.at(-1);
    reports = payloads.map((payload) => payload.report as DecisionExplanationRequest["reports"][number]);
    // The event's own record when Core wrote one, else what the Worker reported.
    verification = (latest?.verification ?? (latest?.report.verification as Record<string, unknown> | null | undefined) ?? null) as DecisionExplanationRequest["verification"];
  } else if (found && KINDS_WITH_REPORT.has(kind)) {
    const row = reader.get<{ payload_json: string }>(
      `SELECT reports.payload_json FROM reports JOIN agent_runs ON agent_runs.id = reports.agent_run_id
        WHERE agent_runs.task_id = ? ORDER BY reports.created_at DESC LIMIT 1`,
      found.task.id,
    );
    if (row) {
      const report = JSON.parse(row.payload_json) as DecisionExplanationRequest["reports"][number];
      reports = [report];
      verification = (report.verification ?? null) as DecisionExplanationRequest["verification"];
    }
  }
  return {
    kind,
    language,
    decision: {
      reason: decision.reason,
      question: decision.question,
      current_state: decision.current_state,
      tried: decision.tried,
      options: (JSON.parse(decision.options_json) as { key: string; label: string; description: string }[]).map(({ key, label, description }) => ({ key, label, description })),
      recommended: decision.recommended,
    },
    revision: null,
    task: found ? { title: found.task.title, acceptance_criteria: found.criteria.map((c) => ({ id: c.id, text: c.text, ...(c.check ? { check: c.check } : {}) })) } : null,
    reports,
    verification,
    rules,
    forbidden_terms: [...new Set([decisionId, decision.work_id, ...blocked, ...(found?.criteria.map((c) => c.id) ?? [])])],
  };
}

/** Write the result onto the still-open Decision; returns false when the Decision was answered meanwhile. */
export function writeDecisionExplanationInTransaction(transaction: CoreWriteLaneTransaction, decisionId: string, outcome: Outcome): boolean {
  const row = transaction.get<{ kind_json: string; options_json: string }>(
    `SELECT explanation_json AS kind_json, options_json FROM decisions
      WHERE id = ? AND status = 'open' AND json_extract(explanation_json, '$.status') = 'pending'`,
    decisionId,
  );
  if (!row) return false;
  const kind = (JSON.parse(row.kind_json) as StoredDecisionExplanation).kind;
  // No state_version bump: retry and cancel stay in options_json, so an answer composed before this write still wins the CAS.
  if ("error" in outcome) {
    // Core's own summary and next_steps stand in, so the Owner never sees an empty explanation.
    const stored: StoredDecisionExplanation = outcome.plain
      ? { kind, status: "ready", summary: outcome.plain.summary, next_steps: outcome.plain.next_steps, option_notes: [], error: outcome.error, plain: true }
      : { kind, status: "failed", error: outcome.error };
    transaction.run("UPDATE decisions SET explanation_json = ? WHERE id = ?", JSON.stringify(stored), decisionId);
    return true;
  }
  const { report } = outcome;
  const blockedIds = JSON.parse(transaction.get<{ blocked_task_ids_json: string }>("SELECT blocked_task_ids_json FROM decisions WHERE id = ?", decisionId)?.blocked_task_ids_json ?? "[]") as string[];
  const criteria = readTask(transaction, blockedIds[0])?.criteria ?? [];
  const fixes: DecisionFixOption[] = report.options.map((option, index) => ({
    key: `${DECISION_FIX_OPTION_PREFIX}${index + 1}`,
    label: option.label,
    description: option.description,
    instruction: option.instruction,
    criteria_rewrites: option.criteria_rewrites.map((rewrite) => ({
      criterion_id: rewrite.criterion_id,
      before: criteria.find((c) => c.id === rewrite.criterion_id)?.text ?? "",
      after: rewrite.after,
      check: rewrite.check,
    })),
  }));
  const options = [...fixes, ...(JSON.parse(row.options_json) as Record<string, unknown>[])];
  const recommended = report.recommended_option_key;
  const decision = transaction.get<{ reason: string; question: string; current_state: string; tried: string }>(
    "SELECT reason, question, current_state, tried FROM decisions WHERE id = ?",
    decisionId,
  );
  assertDecisionBrief({ ...decision!, options: options as never, recommended, allow_free_text: true });
  const ready: StoredDecisionExplanation = { kind, status: "ready", summary: report.summary, cause_kind: report.cause_kind, next_steps: report.next_steps, option_notes: report.option_notes };
  transaction.run(
    "UPDATE decisions SET explanation_json = ?, options_json = ?, recommended = ? WHERE id = ?",
    JSON.stringify(ready),
    JSON.stringify(options),
    recommended,
    decisionId,
  );
  return true;
}

interface CheckRun {
  readonly decisionId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly running: { name: string | null };
}

export class DecisionExplainer {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly triedIds = new Set<string>();

  public constructor(private readonly deps: DecisionExplainerDeps) {}

  /** Start one explanation job for an open Decision whose explanation is pending; a second call for the same id does nothing. */
  public schedule(decisionId: string, workId: string): void {
    if (this.jobs.has(decisionId) || this.triedIds.has(decisionId)) return;
    this.jobs.set(decisionId, this.run(decisionId, workId).finally(() => this.jobs.delete(decisionId)));
  }

  /** Whether this Core run already tried the Decision; a pending row it tried is announced with the plain text. */
  public tried(decisionId: string): boolean {
    return this.triedIds.has(decisionId);
  }

  private async run(decisionId: string, workId: string): Promise<void> {
    // The id is marked tried only after the attempt ends, so announce skips the pending row while the job runs.
    // A write that throws leaves the row pending; remembering the id keeps every tick from calling the model again.
    try {
      const outcome = await this.explain(decisionId);
      if (outcome === null) {
        this.triedIds.add(decisionId);
        return;
      }
      if ("error" in outcome) console.error(`[owl-core] Decision explanation failed for ${decisionId}: ${outcome.error}`);
      await this.deps.writeLane.transact((transaction) => writeDecisionExplanationInTransaction(transaction, decisionId, outcome));
    } catch (error) {
      console.error(`[owl-core] Decision explanation failed for ${decisionId}`, error);
    }
    this.triedIds.add(decisionId);
    await this.deps.announce(workId).catch((error: unknown) => console.error(`[owl-core] Failed to announce Decision ${decisionId}`, error));
  }

  /** null when there is nothing to explain (the Decision was answered, or is not pending). */
  private async explain(decisionId: string): Promise<Outcome | null> {
    const { db } = this.deps;
    const row = db.get<{ work_id: string; explanation_json: string | null }>(
      "SELECT work_id, explanation_json FROM decisions WHERE id = ? AND status = 'open'",
      decisionId,
    );
    if (!row?.explanation_json || (JSON.parse(row.explanation_json) as StoredDecisionExplanation).status !== "pending") return null;
    const base = buildExplanationRequest(db, decisionId, this.deps.language(), this.deps.rules(row.work_id));
    if (!base) return null;
    const outcome = await this.attempt(decisionId, base);
    return "error" in outcome ? { ...outcome, plain: plainDecisionExplanation(base) } : outcome;
  }

  private async attempt(decisionId: string, base: ExplanationBase): Promise<Outcome> {
    const runner = this.deps.runner();
    if (typeof runner.runDecisionExplanation !== "function") return { error: "runner_unavailable" };
    const model = this.deps.roleModel("manager");
    const timeoutMs = this.deps.timeoutSeconds() * 1000;
    const request: DecisionExplanationRequest = { ...base, ...(model ? { provider: model.provider, model: model.model, ...(model.effort ? { effort: model.effort } : {}) } : {}), timeout_ms: timeoutMs };
    let timer: NodeJS.Timeout | undefined;
    const deadline = Date.now() + timeoutMs;
    const running: { name: string | null } = { name: null };
    // One deadline covers the runner, every text check and the rewrite; aborting it stops a running checker.
    const controller = new AbortController();
    try {
      const timeout = new Promise<Outcome>((resolve) => { timer = setTimeout(() => {
        controller.abort();
        if (running.name) console.error(`[owl-core] Decision text check ${running.name} failed for ${decisionId}: timeout`);
        resolve({ error: "timeout" });
      }, timeoutMs); });
      return await Promise.race([this.produce(runner.runDecisionExplanation.bind(runner), request, base, { decisionId, signal: controller.signal, deadline, running }), timeout]);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "explanation_failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The runner's answer through the common checks and the text checks; asks the runner again, up to rewritesMax times, when a check reports problems. */
  private async produce(
    run: (request: DecisionExplanationRequest) => Promise<DecisionExplanationRunResult>,
    first: DecisionExplanationRequest,
    base: ExplanationBase,
    ctx: CheckRun,
  ): Promise<Outcome> {
    const checks = this.deps.textChecks();
    const rewritesMax = this.deps.rewritesMax();
    let request = first;
    for (let rewrites = 0; ; rewrites += 1) {
      const result = await run(request);
      if (ctx.signal.aborted) return { error: "timeout" };
      if (!result.ok) return { error: result.error };
      // The runner may be another implementation; only text that passes the same check reaches the Owner.
      const checked = readDecisionExplanation(result.explanation, checkContextOf(base));
      let rejected: { readonly texts: DecisionTexts; readonly problems: readonly string[] };
      if (!checked.ok) {
        if (rewrites >= rewritesMax) return { error: checked.problem.startsWith("Rephrase without the internal terms") ? "internal_terms" : checked.problem };
        rejected = { texts: this.textsOfAnswer(result.explanation, base), problems: [checked.problem] };
      } else {
        if (checks.length === 0) return { report: checked.value };
        const outcome = await this.runTextChecks(checked.value, base, checks, ctx);
        if ("report" in outcome || "error" in outcome) return outcome;
        if (rewrites >= rewritesMax) {
          console.error(`[owl-core] Decision text check ${outcome.name} failed for ${ctx.decisionId}: ${outcome.problems.join(" / ")}`);
          return { error: `text_check_rejected:${outcome.name}` };
        }
        rejected = outcome;
      }
      // The rewrite gets what is left of the shared deadline, not a fresh timeout.
      request = { ...first, timeout_ms: Math.max(1, ctx.deadline - Date.now()), revision: rejected };
    }
  }

  /** The texts of an answer that failed the common checks, for the revision; an answer too broken to read gives empty texts. */
  private textsOfAnswer(answer: DecisionExplanationReport, base: ExplanationBase): DecisionTexts {
    try {
      return decisionTextsOf({ ...answer, options: answer.options ?? [], option_notes: answer.option_notes ?? [] }, base.decision.options);
    } catch {
      return { summary: "", next_steps: "", options: [] };
    }
  }

  private async runTextChecks(
    report: DecisionExplanationReport,
    base: ExplanationBase,
    checks: readonly DecisionTextCheck[],
    ctx: CheckRun,
  ): Promise<Outcome | { readonly name: string; readonly texts: DecisionTexts; readonly problems: readonly string[] }> {
    const context = checkContextOf(base);
    let texts = decisionTextsOf(report, base.decision.options);
    let fixer: string | null = null;
    for (const check of checks) {
      if (ctx.signal.aborted) return { error: "timeout" };
      const input = { language: base.language, kind: base.kind, texts };
      let raw: unknown;
      ctx.running.name = check.name;
      try {
        raw = await check.run(input, ctx.signal);
      } catch (error) {
        return this.checkFailed(ctx.decisionId, check.name, "text_check_failed", error);
      } finally {
        ctx.running.name = null;
      }
      if (ctx.signal.aborted) return { error: "timeout" };
      const output = readDecisionTextCheckOutput(raw, input);
      if (!output.ok) return this.checkFailed(ctx.decisionId, check.name, "text_check_invalid", output.problem);
      if (!output.value.ok) return { name: check.name, texts, problems: output.value.problems };
      if (output.value.fixed) {
        const problems = findDecisionTextProblems(output.value.fixed, context.forbidden_terms);
        if (problems.length > 0) return { name: check.name, texts: output.value.fixed, problems };
        texts = output.value.fixed;
        fixer = check.name;
      }
    }
    // The stored form itself goes through the common check once more.
    const applied = readDecisionExplanation(applyDecisionTexts(report, texts), context);
    if (applied.ok) return { report: applied.value };
    return this.checkFailed(ctx.decisionId, fixer ?? checks[checks.length - 1]!.name, "text_check_invalid", applied.problem);
  }

  private checkFailed(decisionId: string, name: string, error: string, cause: unknown): { readonly error: string } {
    console.error(`[owl-core] Decision text check ${name} failed for ${decisionId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { error: `${error}:${name}` };
  }
}
