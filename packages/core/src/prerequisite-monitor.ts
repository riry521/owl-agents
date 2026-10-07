import type { PrerequisiteCondition, PrerequisiteSpec } from "../../shared/dist/prerequisite.js";

export type ConditionVerdict = "satisfied" | "pending" | "unreachable";

/** What the evaluator may look at; Core supplies these from the database and git. */
export interface PrerequisiteFacts {
  taskStatus(id: string): string | undefined;
  workState(id: string): string | undefined;
  /** The base branch head and the paths missing from it; null when git could not be read. */
  baseBranch(): { head: string; missing_paths: readonly string[] } | null;
  /** Whether the process (group) with this pid is still running. */
  processAlive(pid: number): boolean;
  /** Whether a worktree-relative file of the Task exists. */
  taskFileExists(taskId: string, path: string): boolean;
}

export type PrerequisiteVerdict = "satisfied" | "pending" | "unreachable" | "expired";

function terminalVerdict(status: string | undefined, done: string): ConditionVerdict {
  if (status === done) return "satisfied";
  return status === undefined || status === "cancelled" ? "unreachable" : "pending";
}

export function evaluateCondition(condition: PrerequisiteCondition, spec: PrerequisiteSpec, facts: PrerequisiteFacts, taskId: string): ConditionVerdict {
  switch (condition.kind) {
    case "task":
      return terminalVerdict(facts.taskStatus(condition.task_id), "completed");
    case "work":
      return terminalVerdict(facts.workState(condition.work_id), "completed");
    case "base_branch": {
      const base = facts.baseBranch();
      if (base === null) return "pending";
      if (condition.paths.length > 0) return condition.paths.some((path) => base.missing_paths.includes(path)) ? "pending" : "satisfied";
      return base.head !== spec.base_head ? "satisfied" : "pending";
    }
    case "owner":
      return "pending";
    case "process":
      // Done file first; a process that ended without one releases the Worker too, to check the log.
      if (condition.done_path !== null && facts.taskFileExists(taskId, condition.done_path)) return "satisfied";
      return condition.pid !== null && !facts.processAlive(condition.pid) ? "satisfied" : "pending";
  }
}

/** Deadline first, then unreachable, then all-satisfied (AND); anything else keeps waiting. */
export function evaluatePrerequisite(spec: PrerequisiteSpec, facts: PrerequisiteFacts, now: string, taskId: string): { verdict: PrerequisiteVerdict; detail: string } {
  if (Date.parse(now) >= Date.parse(spec.deadline_at)) {
    return { verdict: "expired", detail: `The wait passed its deadline ${spec.deadline_at}.` };
  }
  const verdicts = spec.conditions.map((condition) => ({ condition, verdict: evaluateCondition(condition, spec, facts, taskId) }));
  const unreachable = verdicts.find((item) => item.verdict === "unreachable");
  if (unreachable) return { verdict: "unreachable", detail: `Cannot be met: ${unreachable.condition.description}` };
  if (verdicts.every((item) => item.verdict === "satisfied")) return { verdict: "satisfied", detail: "Every condition holds." };
  const pending = verdicts.find((item) => item.verdict === "pending");
  return { verdict: "pending", detail: `Still waiting: ${pending?.condition.description ?? ""}` };
}
