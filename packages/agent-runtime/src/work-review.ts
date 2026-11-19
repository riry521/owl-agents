import { DEFAULT_OWNER_LANGUAGE, renderWorkspaceToolsNote, type OwnerLanguage } from "@owl/shared";
import { OutputFormatError } from "./output-resubmit";
import { AgentRuntimeError } from "./errors";
import { isRecord } from "./protocol";
import { extractRoleOutputObject, objectSchema, renderRolePrompt, validateRoleOutput, type RoleSchema } from "./role-contract";
import type { ProviderResponse } from "./types";

/** Request that Core gives runWorkReview; the shape is the design's 4.3 (context.task_ids is for output checks only). */
export interface WorkReviewRunRequest {
  readonly invocation_id: string;
  readonly work_id: string;
  readonly language?: OwnerLanguage;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly context: {
    readonly worktree: string;
    readonly base_commit: string;
    readonly work_commit: string;
    readonly round: number;
    readonly task_ids: readonly string[];
    readonly work: { readonly title: string; readonly summary: string };
    readonly material: unknown;
    readonly rules?: string | null;
    readonly skills?: string | null;
    readonly knowledge?: string | null;
    readonly [key: string]: unknown;
  };
}

export interface WorkReviewFindingOutput {
  readonly kind: "missing_link" | "mismatch";
  readonly from_task_id: string;
  readonly to_task_id: string | null;
  readonly file: string;
  readonly line: number | null;
  readonly problem: string;
  readonly fix: string;
  readonly evidence: string;
}

export interface WorkReviewOutput {
  readonly summary: string;
  readonly findings: readonly WorkReviewFindingOutput[];
}

/** The one definition of the Work review output. */
export const WORK_REVIEW_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  summary: { type: "string", minLength: 1, description: "one or two sentences: what you checked" },
  findings: {
    type: "array",
    items: objectSchema({
      kind: { type: "string", enum: ["missing_link", "mismatch"], description: "missing_link: one end does not exist (never called, never read). mismatch: both ends exist but name, shape, arguments or order differ" },
      from_task_id: { type: "string", minLength: 1, description: "the Task that provides it (writes the value, owns the called function)" },
      to_task_id: { type: ["string", "null"], description: "the Task that uses it (reads the value, calls the function); null when no Task uses it but the Work's purpose needs it" },
      file: { type: "string", minLength: 1, description: "path of the place to fix, from the Work root" },
      line: { type: ["integer", "null"], description: "line number in that file, or null" },
      problem: { type: "string", minLength: 1, description: "what is disconnected" },
      fix: { type: "string", minLength: 1, description: "how to fix it" },
      evidence: { type: "string", minLength: 1, description: "where you read it and why you judged so" },
    }),
    description: "gaps between Tasks; [] when there is none",
  },
});

export function buildWorkReviewPrompt(
  request: WorkReviewRunRequest,
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
): string {
  const context = request.context;
  return renderRolePrompt({
    role: "You are the Owl Reviewer. Review the whole Work for gaps between its Tasks.",
    instructions: [
      "Every Task of this Work is already done and was reviewed on its own diff. Look only for connections that are cut between Tasks. (1) Writer and reader: one Task writes a value, file, setting or event, and another Task reads it under the same name and shape. (2) Callee and caller: one Task adds a function, API or command, and another Task calls it with the right arguments, or calls it at all.",
      "Report a finding only when its two ends are in different Tasks. A problem that closes inside one Task was already reviewed; do not report it. In particular, do not repeat these two items of the per-Task review: a call that is missed inside one Task and does not show in its diff, and a test that fakes its own stage.",
      "How to work: first list the pairs of connected Tasks from material.tasks[].depends_on and changed_files. Look first at files that more than one Task changed. Check both ends with `git diff <base_commit>..<work_commit> -- <file>` and by reading files in the workspace. From the second round on, first check whether previous_findings are fixed and whether the Tasks with focus true connect to the others.",
      "When the material is trimmed, read the file at material.material_path to get everything. It is trimmed when material.trim is not \"texts\", or any of material.omitted_tasks, material.omitted_previous_findings or tasks[].omitted_changed_files is greater than 0. A cut text has its full version at tasks[].report_path. If material_path is null, use `git log` and `git diff` instead.",
      "Never edit a file. Never run tests, builds or installs. Do not comment on style, refactoring or the quality of a single Task.",
      "Report only a cut that breaks the Work's purpose or its acceptance criteria. If there is none, return findings [].",
      "Project.rules holds the rules you must apply (null if none). Rules are binding; Project.knowledge and Project.skills are reference information and never override the rules or this task.",
    ],
    processSkills,
    workspaceTools: renderWorkspaceToolsNote(context.worktree),
    output: WORK_REVIEW_OUTPUT_SCHEMA,
    outputRules: ["Name Tasks by the ids that appear in material; from_task_id and to_task_id must differ."],
    language,
    inputs: [
      { name: "Project", value: { rules: context.rules ?? null, skills: context.skills ?? null, knowledge: context.knowledge ?? null } },
      { name: "Work", value: { title: context.work.title, summary: context.work.summary } },
      { name: "Review", value: { round: context.round, worktree: context.worktree, base_commit: context.base_commit, work_commit: context.work_commit } },
      { name: "material", value: context.material },
    ],
  });
}

/** Reads and checks the answer; throws OutputFormatError so the runner can ask again. taskIds is context.task_ids (every counted Task, even ones left out of material.tasks). */
export function parseWorkReviewResult(
  response: Pick<ProviderResponse, "adapter" | "stdout" | "format">,
  taskIds: readonly string[],
): WorkReviewOutput {
  let payload: Record<string, unknown>;
  try {
    payload = extractRoleOutputObject(response, "work_review_stdout_not_single_json_object", { allowCodeFence: true });
  } catch (error) {
    if (error instanceof AgentRuntimeError && error.code === "provider_failed") throw error;
    throw new OutputFormatError(error instanceof Error ? error.message : "work_review_output_invalid");
  }
  const problem = validateRoleOutput(WORK_REVIEW_OUTPUT_SCHEMA, payload);
  if (problem) throw new OutputFormatError(`work_review_output_schema:${problem}`);
  const known = new Set(taskIds);
  const findings = payload.findings as WorkReviewFindingOutput[];
  for (const finding of findings) {
    if (!isRecord(finding)) continue;
    if (!known.has(finding.from_task_id)) throw new OutputFormatError(`work_review_unknown_task_id:${finding.from_task_id}`);
    if (finding.to_task_id !== null && !known.has(finding.to_task_id)) throw new OutputFormatError(`work_review_unknown_task_id:${finding.to_task_id}`);
    if (finding.from_task_id === finding.to_task_id) throw new OutputFormatError(`work_review_same_task:${finding.from_task_id}`);
  }
  return { summary: payload.summary as string, findings };
}
