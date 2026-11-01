import {
  readDecisionAnswerTriage,
  type DecisionAnswerTriageRequest,
  type DecisionAnswerTriageRunResult,
  type DecisionCriterionRewrite,
  type StoredDecisionExplanation,
} from "../../shared/dist/index.js";
import { readStoredAcceptanceCriteria } from "../../shared/dist/acceptance-criteria.js";
import type { CoreDatabase } from "./types";

type Reader = Pick<CoreDatabase, "get">;
type Criteria = { id: string; text: string; check?: string }[];

export interface AnswerTriageTarget {
  readonly decision: DecisionAnswerTriageRequest["decision"];
  readonly taskId: string;
  readonly taskTitle: string;
  readonly criteria: Criteria;
  readonly retryLabel: string | null;
}

/**
 * Whether the answer to this Decision can be read by the model at all: an open Decision Core issued, answered with
 * "retry" or in the answer field, in a Work that runs or waits on this Decision, whose first blocked Task waits for the judgement. The answer text
 * is not looked at, so the explanation can use it to say where an answer would go.
 * Outside this, a manager-bound answer would leave the Task failed with no replan to receive it.
 */
export function answerTriageTarget(reader: Reader, decisionId: string, optionKey: string | null): AnswerTriageTarget | null {
  if (optionKey !== null && optionKey !== "retry") return null;
  const row = reader.get<{
    work_id: string; blocked_task_ids_json: string; reason: string; question: string; current_state: string;
    options_json: string; allow_free_text: number; explanation_json: string | null;
  }>(
    "SELECT work_id, blocked_task_ids_json, reason, question, current_state, options_json, allow_free_text, explanation_json FROM decisions WHERE id = ? AND status = 'open' AND issuer_role = 'core'",
    decisionId,
  );
  if (!row) return null;
  const options = JSON.parse(row.options_json) as { key: string; label: string; description: string }[];
  const retry = options.find((option) => option.key === "retry");
  if (optionKey === "retry" ? !retry : row.allow_free_text !== 1) return null;
  // A Work-scope Decision holds its Work in judgement_waiting until the answer returns it to running (state-reducer row 7).
  const workState = reader.get<{ state: string }>("SELECT state FROM works WHERE id = ?", row.work_id)?.state;
  if (workState !== "running" && workState !== "judgement_waiting") return null;
  const taskId = (JSON.parse(row.blocked_task_ids_json) as string[])[0];
  const task = taskId === undefined ? undefined : reader.get<{ title: string; status: string; acceptance: string; acceptance_criteria_json: string | null }>(
    "SELECT title, status, acceptance, acceptance_criteria_json FROM tasks WHERE id = ?", taskId,
  );
  if (!task || task.status !== "judgement_waiting") return null;
  const explanation = row.explanation_json ? JSON.parse(row.explanation_json) as StoredDecisionExplanation : null;
  return {
    decision: {
      reason: row.reason,
      question: row.question,
      current_state: row.current_state,
      options: options.map(({ key, label, description }) => ({ key, label, description })),
      chosen_option_key: optionKey,
      explanation_summary: explanation?.status === "ready" ? explanation.summary ?? null : null,
    },
    taskId: taskId as string,
    taskTitle: task.title,
    criteria: readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance),
    retryLabel: retry?.label ?? null,
  };
}

export type DecisionAnswerTriageOutcome =
  | { readonly route: "worker" }
  | { readonly route: "manager"; readonly criteria_rewrites: readonly DecisionCriterionRewrite[]; readonly error: string | null };

export interface DecisionAnswerTriageDeps {
  readonly db: CoreDatabase;
  readonly runner: () => {
    runDecisionAnswerTriage?: (request: DecisionAnswerTriageRequest) => Promise<DecisionAnswerTriageRunResult>;
    decisionAnswerTriageAvailable?: () => Promise<boolean>;
  };
  readonly roleModel: (role: string) => { model: string; provider: string; effort?: string } | undefined;
  readonly language: () => "ja" | "en";
  readonly timeoutSeconds: () => number;
}

export class DecisionAnswerTriage {
  public constructor(private readonly deps: DecisionAnswerTriageDeps) {}

  /** The explanation and the answer both ask this, so what the explanation says matches where the answer goes. Asked each time: a wrapper's delegate never changes, so the repeat is cheap. */
  public async available(): Promise<boolean> {
    const runner = this.deps.runner();
    if (typeof runner.runDecisionAnswerTriage !== "function") return false;
    if (typeof runner.decisionAnswerTriageAvailable !== "function") return true;
    try {
      return await runner.decisionAnswerTriageAvailable();
    } catch (error) {
      // True: the call itself then fails and the answer goes to the Manager, which "judged" already says.
      console.error(`[owl-core] Decision answer triage availability check failed: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }

  /** null: keep the usual route (the Worker). */
  public async judge(decisionId: string, optionKey: string | null, answer: string): Promise<DecisionAnswerTriageOutcome | null> {
    const target = answerTriageTarget(this.deps.db, decisionId, optionKey);
    if (!target) return null;
    // The Web sends the label of the picked option when the Owner adds nothing.
    if (answer.trim().length === 0 || (optionKey === "retry" && answer.trim() === target.retryLabel)) return null;
    if (!(await this.available())) return null;
    const failure = (error: string): DecisionAnswerTriageOutcome => {
      console.error(`[owl-core] Decision answer triage failed for ${decisionId}: ${error}`);
      return { route: "manager", criteria_rewrites: [], error };
    };
    const runner = this.deps.runner();
    const model = this.deps.roleModel("manager");
    const timeoutMs = this.deps.timeoutSeconds() * 1000;
    const request: DecisionAnswerTriageRequest = {
      language: this.deps.language(),
      decision: target.decision,
      task: { title: target.taskTitle, acceptance_criteria: target.criteria.map((c) => ({ id: c.id, text: c.text, check: c.check ?? "" })) },
      answer,
      ...(model ? { provider: model.provider, model: model.model, ...(model.effort ? { effort: model.effort } : {}) } : {}),
      timeout_ms: timeoutMs,
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
      const result = await Promise.race([runner.runDecisionAnswerTriage!(request), timeout]);
      if (result === "timeout") return failure("timeout");
      if (!result.ok) return failure(result.error);
      const read = readDecisionAnswerTriage(result.triage, target.criteria.map((c) => c.id));
      if (!read.ok) return failure(read.problem);
      if (read.value.route === "worker") return { route: "worker" };
      const rewrites = read.value.criteria_rewrites.map((rewrite): DecisionCriterionRewrite => ({
        ...rewrite,
        before: target.criteria.find((c) => c.id === rewrite.criterion_id)?.text ?? "",
      }));
      return { route: "manager", criteria_rewrites: rewrites, error: null };
    } catch (error) {
      return failure(error instanceof Error ? error.message : "triage_failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
