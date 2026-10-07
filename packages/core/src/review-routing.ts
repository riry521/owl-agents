import { matchesAnyGlob } from "../../shared/dist/glob.js";
import type { ReviewRoutingSettings } from "../../shared/dist/review-routing-settings.js";
import type { ChangedFile, TaskRow } from "./types.js";

export type ReviewForcedCode =
  | "changed_lines_over"
  | "changed_files_over"
  | "sensitive_path"
  | "hybrid_delegation"
  | "gate_failure_history"
  | "rejection_history";

export interface ReviewForcedReason {
  code: ReviewForcedCode;
  detail: string;
  measured: number | string[];
  threshold: number | null;
  /** The sensitive_paths group, for sensitive_path. */
  group?: string;
}

export type ReviewRoutingBase = "override_true" | "override_false" | "type_default_required" | "type_default_not_required" | "sticky_required" | "design_default";

export interface ReviewRoutingDecision {
  required: boolean;
  base: ReviewRoutingBase;
  forced_reasons: ReviewForcedReason[];
  /** Why the Reviewer was skipped; null when required. */
  skip_reason: string | null;
  /** changed_files, added_lines and deleted_lines are null when the change could not be measured. */
  measured: { changed_files: number | null; added_lines: number | null; deleted_lines: number | null; matched_paths: string[]; line_counts_approximate: boolean };
  thresholds: { max_changed_lines: number; max_changed_files: number };
}

type RoutedTask = Pick<TaskRow, "type" | "review_override" | "review_decision">;

export interface ReviewRoutingInput {
  task: RoutedTask;
  /** null when what the Task changed cannot be measured completely: the Reviewer is then required. */
  files: readonly ChangedFile[] | null;
  /** Why `files` is null; recorded as the forcing reason. */
  unmeasured_reason?: string;
  line_counts_approximate: boolean;
  delegated: boolean;
  /** Hybrid Mode was on when the Worker started, whether or not it delegated. */
  hybrid_at_launch?: boolean;
  gate_failures: number;
  rejections: number;
  /** Paths of the Task's durable artifacts (the shared area), which the measured repository changes do not cover. */
  artifact_paths?: readonly string[];
  settings: ReviewRoutingSettings;
}

/** The review a Task gets before any forcing: a recorded decision, the Manager's `review`, then the type default. a design is required by default, because Tasks are planned from it after it completes; unknown types are not reviewed. */
function baseDecision(task: RoutedTask, settings: ReviewRoutingSettings): ReviewRoutingBase {
  if (task.review_decision === "required") return "sticky_required";
  if (task.review_override === "true") return "override_true";
  if (task.review_override === "false") return "override_false";
  if (task.type === "design") return "design_default";
  if (!Object.hasOwn(settings.type_defaults, task.type)) return "type_default_not_required";
  return settings.type_defaults[task.type as keyof typeof settings.type_defaults] === "required" ? "type_default_required" : "type_default_not_required";
}

const isRequiredBase = (base: ReviewRoutingBase): boolean => base !== "override_false" && base !== "type_default_not_required";

/**
 * Core raises "not required" to required when an objective condition holds;
 * it never lowers a required review. Once required, a Task stays required.
 */
export function decideReviewRouting(input: ReviewRoutingInput): ReviewRoutingDecision {
  const { settings, files } = input;
  const base = baseDecision(input.task, settings);
  // A research result is checked by the design or implementation that uses it, or read by the Owner as the final output, so no condition sends it to review.
  if (input.task.type === "research") return { required: false, base, forced_reasons: [], skip_reason: `${base}; research Task is never reviewed`, measured: { changed_files: null, added_lines: null, deleted_lines: null, matched_paths: [], line_counts_approximate: input.line_counts_approximate }, thresholds: { max_changed_lines: settings.max_changed_lines, max_changed_files: settings.max_changed_files } };
  const list = files ?? [];
  const added = list.reduce((sum, file) => sum + file.added_lines, 0);
  const deleted = list.reduce((sum, file) => sum + file.deleted_lines, 0);
  const matched = new Set<string>();
  const forced: ReviewForcedReason[] = [];
  const measured: ReviewRoutingDecision["measured"] = { changed_files: files ? list.length : null, added_lines: files ? added : null, deleted_lines: files ? deleted : null, matched_paths: [] as string[], line_counts_approximate: input.line_counts_approximate };
  const thresholds = { max_changed_lines: settings.max_changed_lines, max_changed_files: settings.max_changed_files };
  if (files === null) {
    forced.push({ code: "changed_files_over", detail: input.unmeasured_reason ?? "diff unavailable", measured: [], threshold: settings.max_changed_files });
  }
  if (isRequiredBase(base)) return { required: true, base, forced_reasons: forced, skip_reason: null, measured, thresholds };
  // A design Task changes no code, so no objective condition raises its review; only a recorded decision or the Manager's `review` does.
  if (input.task.type === "design") return { required: false, base, forced_reasons: [], skip_reason: `${base}; design Task changes no code`, measured, thresholds };
  if (files !== null) {
    if (added + deleted > settings.max_changed_lines) {
      forced.push({ code: "changed_lines_over", detail: `${added + deleted} changed lines exceed ${settings.max_changed_lines}`, measured: added + deleted, threshold: settings.max_changed_lines });
    }
    if (list.length > settings.max_changed_files) {
      forced.push({ code: "changed_files_over", detail: `${list.length} changed files exceed ${settings.max_changed_files}`, measured: list.length, threshold: settings.max_changed_files });
    }
    for (const [group, patterns] of Object.entries(settings.sensitive_paths)) {
      const paths = list.map((file) => file.path).filter((path) => matchesAnyGlob(path, patterns));
      if (paths.length === 0) continue;
      paths.forEach((path) => matched.add(path));
      forced.push({ code: "sensitive_path", detail: `touches ${group} paths: ${paths.join(", ")}`, measured: paths, threshold: null, group });
    }
  }
  if (settings.force_on_hybrid_delegation && (input.delegated || input.hybrid_at_launch)) {
    forced.push({
      code: "hybrid_delegation",
      detail: input.delegated ? "the Worker delegated part of this Task" : "the Worker ran with Hybrid Mode on",
      measured: 1,
      threshold: null,
    });
  }
  if (settings.force_on_gate_failure_history && input.gate_failures > 0) {
    forced.push({ code: "gate_failure_history", detail: `${input.gate_failures} completion gate failure(s)`, measured: input.gate_failures, threshold: null });
  }
  if (settings.force_on_rejection_history && input.rejections > 0) {
    forced.push({ code: "rejection_history", detail: `${input.rejections} earlier review rejection(s)`, measured: input.rejections, threshold: null });
  }
  measured.matched_paths = [...matched];
  if (forced.length > 0) return { required: true, base, forced_reasons: forced, skip_reason: null, measured, thresholds };
  const approx = input.line_counts_approximate ? ", approximate" : "";
  return {
    required: false,
    base,
    forced_reasons: [],
    skip_reason: `${base}; within thresholds (${list.length} files, ${added + deleted} lines${approx})`,
    measured,
    thresholds,
  };
}

/** The recorded routing if there is one, otherwise the plan-only decision. For paths that run without a fresh routing (recovery, Worker exception). */
export function effectiveReviewRequired(task: RoutedTask, settings: ReviewRoutingSettings): boolean {
  if (task.type === "research") return false;
  if (task.review_decision === "required" || task.review_decision === "not_required") return task.review_decision === "required";
  return isRequiredBase(baseDecision(task, settings));
}

/** Paths of the durable artifacts recorded for the Task. */
export function taskArtifactPaths(db: { all<T extends object>(sql: string, ...params: string[]): T[] }, taskId: string): string[] {
  return db.all<{ path: string }>("SELECT path FROM artifacts WHERE task_id = ?", taskId).map((row) => row.path);
}
