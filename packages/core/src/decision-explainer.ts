import {
  DECISION_FIX_OPTION_PREFIX,
  readDecisionExplanation,
  type DecisionExplanationReport,
  type DecisionExplanationRequest,
  type DecisionExplanationRunResult,
  type DecisionFixOption,
  type StoredDecisionExplanation,
} from "../../shared/dist/decision-explanation.js";
import { readStoredAcceptanceCriteria } from "../../shared/dist/acceptance-criteria.js";
import { assertDecisionBrief } from "./decision-brief";
import { lineagePartialReportPayloads, type LineageReader } from "./task-lineage";
import { progressGuard } from "./progress-guard";
import type { CoreDatabase, CoreWriteLaneTransaction, Decision } from "./types";

type WriteLaneLike = { transact<T>(callback: (transaction: CoreWriteLaneTransaction) => T): Promise<T> };

export interface DecisionExplainerDeps {
  readonly db: CoreDatabase;
  readonly writeLane: WriteLaneLike;
  readonly runner: () => { runDecisionExplanation?: (request: DecisionExplanationRequest) => Promise<DecisionExplanationRunResult> };
  readonly roleModel: (role: string) => { model: string; provider: string; effort?: string } | undefined;
  readonly rules: (workId: string) => string | null;
  readonly language: () => "ja" | "en";
  readonly timeoutSeconds: () => number;
  readonly announce: (workId: string) => Promise<void>;
}

type Outcome = { readonly report: DecisionExplanationReport } | { readonly error: string };

/** Decision.explanation from the stored explanation_json. */
export function toDecisionExplanation(json: string | null | undefined): Decision["explanation"] {
  if (!json) return null;
  const stored = JSON.parse(json) as StoredDecisionExplanation;
  return { kind: stored.kind, status: stored.status, summary: stored.summary ?? null, cause_kind: stored.cause_kind ?? null };
}

interface TaskRow { id: string; title: string; manager_task_id: string | null; acceptance: string; acceptance_criteria_json: string | null }
type StoredCriterion = { id: string; text: string; check?: string };

function readTask(reader: LineageReader, decisionId: string): { task: TaskRow; workId: string; criteria: StoredCriterion[] } | null {
  const decision = reader.get<{ work_id: string; blocked_task_ids_json: string }>("SELECT work_id, blocked_task_ids_json FROM decisions WHERE id = ?", decisionId);
  const taskId = decision ? (JSON.parse(decision.blocked_task_ids_json) as string[])[0] : undefined;
  if (!decision || taskId === undefined) return null;
  const task = reader.get<TaskRow>("SELECT id, title, manager_task_id, acceptance, acceptance_criteria_json FROM tasks WHERE id = ?", taskId);
  // A Task planned without structured criteria keeps its text in `acceptance`.
  return task ? { task, workId: decision.work_id, criteria: readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance) } : null;
}

/** Inputs for the partial-limit kind; null when the Decision or its Task is gone. */
export function buildPartialLimitExplanationRequest(
  reader: LineageReader,
  decisionId: string,
  language: "ja" | "en",
  rules: string | null,
): Omit<DecisionExplanationRequest, "provider" | "model" | "effort" | "timeout_ms"> | null {
  const found = readTask(reader, decisionId);
  if (!found) return null;
  const { task, workId, criteria } = found;
  const payloads = lineagePartialReportPayloads(reader, task.id, progressGuard(reader).partial_limit + 1).reverse();
  const latest = payloads.at(-1);
  return {
    kind: "partial_limit",
    language,
    task: { title: task.title, acceptance_criteria: criteria.map((c) => ({ id: c.id, text: c.text, ...(c.check ? { check: c.check } : {}) })) },
    reports: payloads.map((payload) => payload.report as DecisionExplanationRequest["reports"][number]),
    // The event's own record when Core wrote one, else what the Worker reported.
    verification: (latest?.verification ?? (latest?.report.verification as Record<string, unknown> | null | undefined) ?? null) as DecisionExplanationRequest["verification"],
    rules,
    forbidden_terms: [task.id, workId, ...(task.manager_task_id ? [task.manager_task_id] : []), ...criteria.map((c) => c.id)],
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
    const failed: StoredDecisionExplanation = { kind, status: "failed", error: outcome.error };
    transaction.run("UPDATE decisions SET explanation_json = ? WHERE id = ?", JSON.stringify(failed), decisionId);
    return true;
  }
  const { report } = outcome;
  const criteria = readTask(transaction, decisionId)?.criteria ?? [];
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
  const recommended = fixes[report.recommended_option]?.key ?? null;
  const decision = transaction.get<{ reason: string; question: string; current_state: string; tried: string }>(
    "SELECT reason, question, current_state, tried FROM decisions WHERE id = ?",
    decisionId,
  );
  assertDecisionBrief({ ...decision!, options: options as never, recommended, allow_free_text: true });
  const ready: StoredDecisionExplanation = { kind, status: "ready", summary: report.summary, cause_kind: report.cause_kind };
  transaction.run(
    "UPDATE decisions SET explanation_json = ?, options_json = ?, recommended = ? WHERE id = ?",
    JSON.stringify(ready),
    JSON.stringify(options),
    recommended,
    decisionId,
  );
  return true;
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
    const base = buildPartialLimitExplanationRequest(db, decisionId, this.deps.language(), this.deps.rules(row.work_id));
    if (!base) return null;
    const runner = this.deps.runner();
    if (typeof runner.runDecisionExplanation !== "function") return { error: "runner_unavailable" };
    const model = this.deps.roleModel("manager");
    const timeoutMs = this.deps.timeoutSeconds() * 1000;
    const request: DecisionExplanationRequest = { ...base, ...(model ? { provider: model.provider, model: model.model, ...(model.effort ? { effort: model.effort } : {}) } : {}), timeout_ms: timeoutMs };
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<DecisionExplanationRunResult>((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs); });
      const result = await Promise.race([runner.runDecisionExplanation(request), timeout]);
      if (!result.ok) return { error: result.error };
      // The runner may be another implementation; only text that passes the same check reaches the Owner.
      const checked = readDecisionExplanation(result.explanation, { criterion_ids: base.task.acceptance_criteria.map((c) => c.id), forbidden_terms: base.forbidden_terms });
      if (checked.ok) return { report: checked.value };
      return { error: checked.problem.startsWith("Rephrase without the internal terms") ? "internal_terms" : checked.problem };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "explanation_failed" };
    } finally {
      clearTimeout(timer);
    }
  }
}
