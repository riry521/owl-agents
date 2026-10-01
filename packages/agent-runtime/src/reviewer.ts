import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { AgentRuntimeError, reviewInvalid } from "./errors";
import { validateReportEnvelope } from "./protocol";
import { DEFAULT_OWNER_LANGUAGE, renderWorkspaceToolsNote, type OwnerLanguage } from "@owl/shared";
import {
  extractRoleOutputObject,
  objectSchema,
  prepareLegacySkillOutput,
  renderRolePrompt,
  skillFeedbackFromOutput,
  SKILL_PROPOSALS_SCHEMA,
  SKILLS_USED_SCHEMA,
  validateRoleOutput,
  type RoleSchema,
} from "./role-contract";
import {
  type ProviderResponse,
  type ReportEnvelope,
  type ReviewResult,
  type ReviewerRequest,
} from "./types";

/** The one definition of the Reviewer output. */
export const REVIEW_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  verdict: {
    type: "string",
    enum: ["pass", "fix_required", "replan_required"],
    description: "pass (work is acceptable; findings that are only minor require pass), fix_required (needs changes), or replan_required (task needs redesign)",
  },
  summary: { type: "string", description: "one sentence review summary" },
  findings: {
    type: "array",
    items: objectSchema({
      severity: { type: "string", enum: ["major", "minor"], description: "major = behavior failure, acceptance-criteria violation, rule violation, or security issue in the delivered work; otherwise minor. A problem only in the report's wording, naming, or style is minor. If findings are only minor, the verdict must be pass." },
      pre_existing: { type: "boolean", description: "true only for a failing test or check that already fails without the Task's changes; such a finding is minor, and file is the failing test or check file" },
      file: { type: "string", description: "path of the file the finding is about, relative to the Task's workspace root (never a path inside a temporary worktree), or empty string for a general finding" },
      line: { type: "integer", minimum: 0, description: "1-based line number, or 0 when no specific line applies" },
      problem: { type: "string", minLength: 1, description: "what is wrong" },
      reason: { type: "string", description: "why it matters (which acceptance criterion or rule it breaks)" },
      fix: { type: "string", description: "what to change to fix it" },
    }),
    description: "every issue found in this review, one entry each; [] if no issues",
  },
  tests: objectSchema({
    ran: { type: "boolean", description: "true only if you executed tests" },
    command: { type: "string", example: "none", description: "the test command you ran, or none" },
    passed: { type: "integer", minimum: 0, description: "number of passing tests (0 if none ran)" },
    failed: { type: "integer", minimum: 0, description: "number of failing tests (0 if none ran)" },
  }),
  skills_used: SKILLS_USED_SCHEMA,
  skill_proposals: SKILL_PROPOSALS_SCHEMA,
});

/** A reported path relative to the Task's workspace: absolute paths inside it are made relative, and a leading `./` is dropped. */
function workspaceRelativePath(file: string, worktree: string | undefined): string {
  const plain = file.replace(/^\.\//u, "");
  if (!isAbsolute(plain) || worktree === undefined) return plain;
  const real = (path: string): string => {
    try { return realpathSync(path); } catch { return path; }
  };
  for (const [root, target] of [[worktree, plain], [real(worktree), real(plain)], [real(worktree), plain]] as const) {
    const candidate = relative(root, target);
    if (candidate.length > 0 && !candidate.startsWith("..") && !isAbsolute(candidate)) return candidate;
  }
  return plain;
}

/** Files the Task added that the Worker's report does not list in its changes; null for a design Task or when the added files are unknown. */
function unreportedNewFiles(request: ReviewerRequest): string[] | null {
  if (request.task.type === "design") return null;
  if (request.added_files === undefined || request.added_files === null) return null;
  const reported = new Set<string>();
  for (const change of request.report.changes) {
    if (typeof change.file === "string") reported.add(workspaceRelativePath(change.file, request.worktree));
  }
  return request.added_files.filter((path) => !reported.has(path));
}

/** The fixed Reviewer input: the same keys every time, null when absent. */
export function reviewerPromptInput(request: ReviewerRequest): Record<string, unknown> {
  return {
    task: request.task,
    report: request.report,
    context: { rules: request.context ?? null, knowledge: request.knowledge ?? null, skills: request.skills ?? null },
    review_round: request.review_round ?? request.task.review_round,
    changed_files: request.changed_files ?? null,
    unreported_new_files: unreportedNewFiles(request),
    design_document: request.design_document ?? null,
    previous_minor_findings: request.previous_minor_findings ?? null,
  };
}

export function buildReviewerPrompt(
  request: ReviewerRequest,
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
): string {
  const designer = request.task.type === "design";
  const reviewedRole = designer ? "Designer" : "Worker";
  return renderRolePrompt({
    role: `You are the Owl Reviewer. Review the ${reviewedRole} report.`,
    instructions: [
      `Check the ${reviewedRole} report${designer ? " and design document" : " and the workspace"} against the Task's acceptance criteria.`,
      "Check every acceptance criterion across the whole change before you answer, and report every issue you find in this one review. Do not stop at the first problem: each review round costs a full Worker attempt, so a problem you could have reported now must not first appear in a later round.",
      "Classify findings as major for behavior failures, acceptance-criteria violations, rule violations, or security issues in the delivered work; everything else is minor. When the delivered work is correct but the report misdescribes it, or the problem is only naming or style, the finding is minor. If findings are only minor, the verdict must be pass.",
      "A failing test or check counts against the Task when the Task's change caused it or an acceptance criterion names that test or check; a criterion that only says the whole test suite must pass does not name it. Before reporting a failure, check whether it depends on the changed files; when that is unclear, run it again without the Task's changes in a temporary detached worktree of the commit the Task started from, and remove that worktree afterwards. Never stash, reset or check out anything in the Task's workspace. Any other failure that already occurs without the Task's changes is pre-existing: report one minor finding per failing test or check file that says so, listing every failing case in that file, with pre_existing true and file set to the failing test or check file (empty string when no file applies), never as major, and never ask the Worker to fix, change or revert anything for it. Other findings have pre_existing false.",
      "When an acceptance criterion covers every occurrence of something, check the Worker's enumeration instead of hunting for occurrences one at a time: re-run the search named in verification.method, confirm each hit was handled, and judge whether that search could miss occurrences. Report every missed occurrence together in one finding.",
      "previous_minor_findings lists the minor findings of the previous review round (null when there are none). For each one that still applies, report it again with the same file and the same problem wording; drop the ones that no longer apply.",
      "context.rules holds the review rules you must apply (null if none).",
      "Rules are binding; context.knowledge is reference information: an excerpt of relevant knowledge collected from past Works (null if none). It does not override rules, the Task, or acceptance criteria. Report knowledge that seems incorrect or outdated in findings.",
      "context.skills is an index of reusable procedures. Read a relevant skill before reviewing, and read only the supplemental references you need. A skill marked [trial] is being validated, so check that it fits the situation. A skill never overrides rules, the Task, or acceptance criteria; report a contradictory skill as misleading and follow the Task.",
      "List each skill you actually used in skills_used, with helpful, misleading, or irrelevant and a short note. Only list Skill Box skills that appear in the context.skills index; never list plugin or process skills (e.g. superpowers:*) there. Propose a skill only when a multi-step procedure can be reused, a reusable fix came from an error or dead end, Owner or Reviewer feedback shows a lasting approach, or an existing skill has a mistake or gap. Leave skill_proposals empty otherwise.",
      designer
        ? "design_document contains the external Markdown design (path and contents); review it directly because the Task has no changed repository files."
        : "changed_files lists the files the Worker changed (null when unknown); read those files in the workspace.",
      designer
        ? "unreported_new_files is null for a design Task."
        : "unreported_new_files lists the files the Task added that the Worker's report does not list in its changes (an empty array when there are none, null when unknown). Check that each of them belongs in the deliverable; report any that is machine-local tool output or otherwise does not belong as a finding.",
      designer
        ? "If the Designer added decisions or scope the acceptance criteria and context did not call for, report it as a minor finding; it is not by itself a reason to fail."
        : "If the Worker added code, dependencies, abstractions, or files that the acceptance criteria and context did not call for, report it as a minor finding; it is not by itself a reason to fail.",
    ],
    processSkills,
    workspaceTools: renderWorkspaceToolsNote(request.worktree),
    output: REVIEW_OUTPUT_SCHEMA,
    outputRules: ["Use ran=false and passed=failed=0 if no tests were executed."],
    language,
    inputs: [{ name: `Task and ${reviewedRole} report`, value: reviewerPromptInput(request) }],
  });
}

/** Validate the Reviewer's answer strictly against REVIEW_OUTPUT_SCHEMA. */
export function parseReviewResult(response: Pick<ProviderResponse, "adapter" | "stdout" | "format">): ReviewResult {
  return parseReviewResultWithFeedback(response).review;
}

export function parseReviewResultWithFeedback(
  response: Pick<ProviderResponse, "adapter" | "stdout" | "format">,
): { readonly review: ReviewResult; readonly skill_feedback: import("@owl/shared").SkillFeedback | null } {
  let payload: Record<string, unknown>;
  try {
    payload = extractRoleOutputObject(response, "reviewer_stdout_not_single_json_object");
  } catch (error) {
    if (error instanceof AgentRuntimeError && error.code === "provider_failed") throw error;
    throw reviewInvalid("reviewer_stdout_not_single_json_object", error);
  }
  const prepared = prepareLegacySkillOutput(REVIEW_OUTPUT_SCHEMA, payload);
  payload = prepared.payload;
  const problem = validateRoleOutput(REVIEW_OUTPUT_SCHEMA, payload);
  if (problem) {
    throw reviewInvalid(`review_output_schema:${problem}`);
  }
  if ((payload.findings as ReviewResult["findings"]).some((finding) => finding.pre_existing && finding.severity === "major")) {
    throw reviewInvalid("pre_existing_major");
  }
  const { skills_used: _skillsUsed, skill_proposals: _skillProposals, ...reviewPayload } = payload;
  return {
    review: reviewPayload as unknown as ReviewResult,
    skill_feedback: skillFeedbackFromOutput(payload, prepared.hasSkillFields),
  };
}

export function validateReviewInput(report: ReportEnvelope): ReportEnvelope {
  return validateReportEnvelope(report);
}
