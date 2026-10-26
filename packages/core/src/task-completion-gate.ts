/**
 * Worker completion gate: decides from the Worker's own report whether a
 * "success" claim may move the Task on to Core verification and review.
 * Pure: no I/O, no events. A passing gate does not replace verification.
 */

import { isNonBlankReason } from "../../shared/dist/acceptance-criteria.js";
import { UNVERIFIABLE_STATUS } from "../../shared/dist/acceptance-defect.js";

const GOAL_UNMET = "goal_unmet";

export type WorkerCompletionErrorKey =
  | "worker_completion_gate_failed"
  | "worker_verification_failed"
  | "worker_verification_blocked"
  | "worker_acceptance_unverifiable"
  | "worker_verification_incomplete"
  | "hybrid_integration_verification_missing"
  | "worker_children_incomplete";

/** A child of the Worker run: a dispatched child run or a subagent/fork detected by hook. */
export interface WorkerChild {
  readonly id: string;
  readonly kind: "dispatched" | "observed";
  readonly status: string;
}

/** Terminal states that let the parent move on; anything else (running, queued, unknown) holds it back. */
export const CHILD_TERMINAL_STATUSES: Readonly<Record<WorkerChild["kind"], readonly string[]>> = {
  dispatched: ["completed", "failed", "cancelled"],
  observed: ["exited", "completed", "failed", "cancelled"],
};

export interface WorkerCompletionOptions {
  readonly hybrid: boolean;
  /** Subagents were observed under this run. Observation only; never the sole proof of correctness. */
  readonly delegated_work_detected: boolean;
  /** Children recorded under this run; every one must be terminal (and dispatched ones reported). */
  readonly children?: readonly WorkerChild[];
  /** Ids of the Task's goal criteria, read from the stored criteria. The report's own requirement is never trusted. */
  readonly goal_criterion_ids?: readonly string[];
}

export interface WorkerCompletionVerdict {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  /** Stable key for the failure event; null when passed. */
  readonly error_key: WorkerCompletionErrorKey | null;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function evaluateWorkerCompletion(report: unknown, options: WorkerCompletionOptions): WorkerCompletionVerdict {
  const reasons: string[] = [];
  const keys = new Set<WorkerCompletionErrorKey>();
  const fail = (key: WorkerCompletionErrorKey, reason: string): void => {
    keys.add(key);
    reasons.push(reason);
  };
  const body: Obj = isObj(report) ? report : {};
  const verification: Obj = isObj(body.verification) ? body.verification : {};

  if (body.result !== "success") fail("worker_completion_gate_failed", `report result is ${String(body.result)}, not success`);
  if (body.needs_replanning === true) fail("worker_completion_gate_failed", "report sets needs_replanning");
  if (typeof body.question_for_manager === "string" && body.question_for_manager.trim().length > 0) {
    fail("worker_completion_gate_failed", "report asks the Manager a question");
  }

  const status = verification.status ?? (typeof verification.passed === "boolean" ? (verification.passed ? "passed" : "failed") : undefined);
  const statusKey = (value: unknown): WorkerCompletionErrorKey | null =>
    value === "passed" ? null : value === UNVERIFIABLE_STATUS ? "worker_acceptance_unverifiable" : value === "blocked" ? "worker_verification_blocked" : value === "failed" ? "worker_verification_failed" : "worker_verification_incomplete";
  const overall = statusKey(status);
  if (overall) fail(overall, `verification.status is ${String(status)}`);

  // A legacy 1.0.0 report has no per-criterion detail to check.
  if (verification.status !== undefined) {
    const acceptance = Array.isArray(verification.acceptance) ? verification.acceptance : [];
    if (acceptance.length === 0) fail("worker_verification_incomplete", "verification.acceptance is empty");
    const checks = Array.isArray(verification.checks) ? verification.checks : [];
    const goalIds = new Set(options.goal_criterion_ids ?? []);
    for (const item of [...acceptance, ...checks]) {
      const itemStatus = isObj(item) ? item.status : undefined;
      if (itemStatus === GOAL_UNMET && acceptance.includes(item)) {
        const id = String((item as Obj).criterion_id);
        if (!goalIds.has(id)) fail("worker_verification_failed", `${id} is goal_unmet on a required criterion`);
        else if (!isNonBlankReason((item as Obj).shortfall_reason)) fail("worker_verification_failed", `${id} is goal_unmet without shortfall_reason`);
        continue;
      }
      const key = statusKey(itemStatus);
      if (key) fail(key, `${isObj(item) ? String(item.criterion_id ?? item.name ?? "item") : "item"} is ${String(itemStatus)}`);
    }
  }

  const delegation: Obj = isObj(body.delegation) ? body.delegation : {};
  const reportedIds = new Set(Array.isArray(delegation.delegated) ? delegation.delegated.map((item) => isObj(item) ? item.child_id : undefined) : []);
  for (const child of options.children ?? []) {
    if (!CHILD_TERMINAL_STATUSES[child.kind].includes(child.status)) {
      fail("worker_children_incomplete", `child ${child.id} is ${child.status}, not finished`);
    } else if (child.kind === "dispatched" && !reportedIds.has(child.id)) {
      fail("worker_children_incomplete", `child ${child.id} is not reported in delegation.delegated`);
    }
  }

  const delegated = Array.isArray(delegation.delegated) && delegation.delegated.length > 0;
  const declared = delegation.own_subagents_used === true;
  if (delegated || declared || options.delegated_work_detected) {
    const integration = isObj(verification.integration_check) ? verification.integration_check : null;
    if (integration === null) {
      fail("hybrid_integration_verification_missing", delegated
        ? "delegated work needs integration_check"
        : "subagents were declared or observed but integration_check is not present");
    } else {
      if (integration.status !== "passed") fail("hybrid_integration_verification_missing", `integration_check.status is ${String(integration.status)}`);
    }
  }

  // The first recorded key wins as the failure key, in the order the checks ran.
  const order: readonly WorkerCompletionErrorKey[] = [
    "worker_acceptance_unverifiable",
    "hybrid_integration_verification_missing",
    "worker_children_incomplete",
    "worker_verification_blocked",
    "worker_verification_failed",
    "worker_verification_incomplete",
    "worker_completion_gate_failed",
  ];
  return { passed: reasons.length === 0, reasons, error_key: order.find((key) => keys.has(key)) ?? null };
}

/**
 * True when a partial or failed report stops only because of goal criteria: every required criterion and every check
 * passed, nothing else holds the Task (a running process, a question, a replan request, a blocker), and at least one
 * goal criterion is goal_unmet with a reason. A partial without a stated goal shortfall is read as work left unfinished.
 */
export function goalOnlyShortfallReport(report: unknown, options: Pick<WorkerCompletionOptions, "goal_criterion_ids">): boolean {
  const body: Obj = isObj(report) ? report : {};
  if (body.result !== "partial" && body.result !== "failed") return false;
  if (body.pending_process || body.needs_replanning === true || body.external_blocker || body.design_blocked) return false;
  if (typeof body.question_for_manager === "string" && body.question_for_manager.trim().length > 0) return false;
  const verification: Obj = isObj(body.verification) ? body.verification : {};
  const acceptance = Array.isArray(verification.acceptance) ? verification.acceptance : [];
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  if (acceptance.length === 0 || checks.some((item) => !isObj(item) || item.status !== "passed")) return false;
  const goalIds = new Set(options.goal_criterion_ids ?? []);
  let unmet = 0;
  for (const item of acceptance) {
    if (!isObj(item)) return false;
    if (item.status === "passed") continue;
    if (item.status !== GOAL_UNMET || !goalIds.has(String(item.criterion_id)) || !isNonBlankReason(item.shortfall_reason)) return false;
    unmet++;
  }
  if (unmet === 0) return false;
  const delegation: Obj = isObj(body.delegation) ? body.delegation : {};
  const delegated = (Array.isArray(delegation.delegated) && delegation.delegated.length > 0) || delegation.own_subagents_used === true;
  const integration = isObj(verification.integration_check) ? verification.integration_check : null;
  return !delegated || integration?.status === "passed";
}
