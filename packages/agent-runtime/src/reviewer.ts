import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { AgentRuntimeError, reviewInvalid } from "./errors";
import { readStoredReport } from "./protocol";
import { ACCEPTANCE_DEFECT_VERDICT, DEFAULT_OWNER_LANGUAGE, normalizeAcceptanceDefects, renderWorkspaceToolsNote, type OwnerLanguage } from "@owl/shared";
import {
  extractRoleOutputObject,
  objectSchema,
  prepareLegacySkillOutput,
  renderRolePrompt,
  skillFeedbackFromOutput,
  SKILL_PROPOSALS_SCHEMA,
  SKILLS_USED_SCHEMA,
  validateRoleOutput,
  type RolePromptSlots,
  type RoleSchema,
} from "./role-contract";
import {
  type ProviderResponse,
  type LegacyReportEnvelope,
  type ReportEnvelope,
  type ReviewResult,
  type ReviewerRequest,
} from "./types";

const REVIEW_SCOPE_INSTRUCTION = "Give every finding a scope. in_scope: it breaks an acceptance criterion, a rule, behavior or security. beyond_acceptance: it asks for a test, check, feature or improvement that no acceptance criterion or rule requires; Core always stores it as minor, so it never sends the Task back. overbuilt: the delivered work adds code, tests, dependencies or checks the criteria and context do not need; it is minor unless the excess adds a heavy or slow check (real model or paid API calls, production-size data, long runs), a new dependency, or risk to existing behavior, and then it is major and its fix is to remove the excess. Judge necessity from task.acceptance_criteria (each criterion's serves, if_omitted, check_weight and weight_reason) and task.necessity, not from what you would have liked to see.";

/** The one definition of the Reviewer output. */
export const REVIEW_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  verdict: {
    type: "string",
    enum: ["pass", "fix_required", "replan_required", ACCEPTANCE_DEFECT_VERDICT],
    description: "pass (work is acceptable; findings that are only minor require pass), fix_required (needs changes), replan_required (task needs redesign), or acceptance_defect (a criterion cannot be proven inside the Task)",
  },
  acceptance_defects: {
    type: "array",
    items: objectSchema({
      criterion_id: { type: "string", minLength: 1, description: "id of the defective acceptance criterion (the id given in task.acceptance_criteria); do not quote the criterion text" },
      reason: { type: "string", description: "why nothing this Task can run proves it" },
      suggestion: { type: "string", description: "a provable check that could replace it, or empty string" },
    }),
    description: "the unprovable criteria; non-empty only with verdict acceptance_defect, otherwise []",
  },
  summary: { type: "string", description: "one sentence review summary" },
  findings: {
    type: "array",
    items: objectSchema({
      severity: { type: "string", enum: ["major", "minor"], description: "major = behavior failure, acceptance-criteria violation, rule violation, or security issue in the delivered work; otherwise minor. Never report the format, omissions, or wording of the report itself as a finding. If findings are only minor, the verdict must be pass." },
      target: { type: "string", enum: ["deliverable", "report"], description: "deliverable = a finding about the deliverable (code, design document, or workspace state); report = a finding only about how the report is written. A report finding is always minor and is not registered in the backlog" },
      scope: { type: "string", enum: ["in_scope", "beyond_acceptance", "overbuilt"], description: "in_scope = breaks an acceptance criterion, a rule, behavior or security; beyond_acceptance = asks for a test, check, feature or improvement no acceptance criterion or rule requires (Core always treats it as minor); overbuilt = the delivered work adds code, tests, dependencies or checks the criteria do not need" },
      subject: { type: "string", enum: ["test_result", "other"], description: "test_result = the finding is about a test or check failing, passing or not having been run (including anything in Review.core_tests); other = anything else. Core never registers a test_result finding in the backlog" },
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

/** The fixed Reviewer input: the same slots and keys every time, null when absent. */
export function reviewerPromptInputs(request: ReviewerRequest): RolePromptSlots["inputs"] {
  const task = request.task;
  return [
    { name: "Project", value: { rules: request.context ?? null, skills: request.skills ?? null, knowledge: request.knowledge ?? null } },
    {
      name: "Task",
      value: {
        id: task.id ?? null,
        title: task.title ?? null,
        type: task.type ?? null,
        acceptance_criteria: task.acceptance_criteria ?? [],
        context: task.context ?? null,
        manager_notes: task.manager_notes ?? null,
        necessity: task.necessity ?? null,
        ...(task.plan_context_legacy ? { plan_context_legacy: true } : {}),
        depends_on: task.depends_on ?? [],
        ...(task.review === undefined ? {} : { review: task.review }),
      },
    },
    {
      name: "Review",
      value: {
        review_round: request.review_round ?? task.review_round,
        report: request.report,
        changed_files: request.changed_files ?? null,
        unreported_new_files: unreportedNewFiles(request),
        design_document: request.design_document ?? null,
        previous_minor_findings: request.previous_minor_findings ?? null,
        core_tests: request.core_tests ?? null,
        core_checks: request.core_checks ?? null,
        owner_guidance: request.owner_guidance ?? [],
      },
    },
  ];
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
      `Use verdict "${ACCEPTANCE_DEFECT_VERDICT}" (with acceptance_defects, each pointing at its criterion by criterion_id) only when a criterion cannot be proven by anything this Task can run, for example it compares a live server, live data or another Work before and after. Do not use it for code that fails a provable criterion; that is fix_required. This verdict sends the criteria back to the Manager to rewrite and does not count as a review attempt. With any other verdict, acceptance_defects must be []. A criterion that is missing cannot be pointed at by id; report it as a finding instead.`,
      "Classify findings as major for behavior failures, acceptance-criteria violations, rule violations, or security issues in the delivered work; everything else is minor. A problem that is only naming or style in the code is minor. If findings are only minor, the verdict must be pass.",
      REVIEW_SCOPE_INSTRUCTION,
      `Do not report the format, omissions, or wording of the ${reviewedRole} report as findings, not even as minor (for example, the report does not list a command or does not include output). Judge anything the report leaves out yourself by reading the workspace; run commands only for what Review.core_checks and Review.core_tests do not cover. Exception: when the report states something that is not true (it says tests passed but they fail, or it claims a verification that was not performed), treat it as a problem in verifying the deliverable: set target to deliverable and decide severity by the usual criteria.`,
      "Do not run the Project's tests; the hook denies the Project's test commands. Building is allowed. Judge tests only from Review.core_tests, the result of Core's test run for this Task (failed test names and error messages). Failures listed under core_tests.pre_existing already fail on the base branch and are quarantined by Core; never report them. Set subject to test_result on any finding about a test or check result. Never send the Task back, and never report a finding, because of a test the Worker added only to check its own work or because a test asserts a hardcoded value: Core removes test files that no criterion asked for, and the Project's check commands catch hardcoded expectations. A test file named in the report but missing from the workspace was removed by Core and is not a finding.",
      "A failed entry in Review.core_checks means Core has already sent the Task back; concentrate on meaning, design and rules.",
      "Never send the Worker back, and never report a finding (not even a minor one for the backlog), because of where a test file is placed or because a test duplicates another; test placement and duplication are not review findings.",
      "When an acceptance criterion covers every occurrence of something, check the Worker's enumeration instead of hunting for occurrences one at a time: read the search named in verification.method and its hits, confirm each hit was handled, and judge whether that search could miss occurrences; re-run the search only when the report's evidence and the workspace disagree. Report every missed occurrence together in one finding.",
      ...(designer ? [] : [
        "The verification in the report (report.verification, passed to you as written) is the Worker's evidence. It is a claim to check, not a fact to trust. Verify it independently: (1) compare every criterion in task.acceptance_criteria (a criterion with legacy true holds the whole free-text acceptance as one criterion) with report.verification.acceptance and make sure each criterion is covered; (2) compare each piece of evidence with the workspace (the files, diffs and results it names); (3) Review.core_checks holds the deterministic checks Core already ran (check_commands, policy_checks, type_policy): do not repeat a passed check, and re-run the commands or searches the evidence names only when the report's evidence and the workspace disagree; (4) check the evidence for integration_check (required only when work was delegated to children) against the combined result; (5) if the report marks something passed that was not actually verified, report a major finding; (6) if the only evidence for a criterion is a child agent's report, with no check by the Worker itself, report a major finding. Do not copy secrets or long logs into your findings.",
      ]),
      "previous_minor_findings lists the minor findings of the previous review round (null when there are none). For each one that still applies, report it again with the same file and the same problem wording; drop the ones that no longer apply.",
      "If Review.owner_guidance is non-empty, the Owner answered earlier Decisions for this Work (newest first). Those answers take priority over the Task's context, acceptance criteria and manager_notes: never report a finding, and never send the Task back, because a change follows the Owner's guidance instead of the Task text.",
      "Project.rules holds the review rules you must apply (null if none).",
      "Rules are binding; Project.knowledge is reference information: an excerpt of relevant knowledge collected from past Works (null if none). It does not override rules, the Task, or acceptance criteria. Report knowledge that seems incorrect or outdated in findings.",
      "Project.skills is an index of reusable procedures. Read a relevant skill before reviewing, and read only the supplemental references you need. A skill marked [trial] is being validated, so check that it fits the situation. A skill never overrides rules, the Task, or acceptance criteria; report a contradictory skill as misleading and follow the Task.",
      "List each skill you actually used in skills_used, with helpful, misleading, or irrelevant and a short note. Only list Skill Box skills that appear in the Project.skills index; never list plugin or process skills (e.g. superpowers:*) there. Propose a skill only when a multi-step procedure can be reused, a reusable fix came from an error or dead end, Owner or Reviewer feedback shows a lasting approach, or an existing skill has a mistake or gap. Leave skill_proposals empty otherwise.",
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
    inputs: reviewerPromptInputs(request),
  });
}

/** Validate the Reviewer's answer strictly against REVIEW_OUTPUT_SCHEMA. */
export function parseReviewResult(response: Pick<ProviderResponse, "adapter" | "stdout" | "format">, task?: ReviewerRequest["task"]): ReviewResult {
  return parseReviewResultWithFeedback(response, task).review;
}

export function parseReviewResultWithFeedback(
  response: Pick<ProviderResponse, "adapter" | "stdout" | "format">,
  task?: ReviewerRequest["task"],
): { readonly review: ReviewResult; readonly skill_feedback: import("@owl/shared").SkillFeedback | null } {
  let payload: Record<string, unknown>;
  try {
    payload = extractRoleOutputObject(response, "reviewer_stdout_not_single_json_object");
  } catch (error) {
    if (error instanceof AgentRuntimeError && error.code === "provider_failed") throw error;
    throw reviewInvalid("reviewer_stdout_not_single_json_object", error);
  }
  if (Array.isArray(payload.findings)) {
    payload = {
      ...payload,
      findings: payload.findings.map((finding) =>
        finding !== null && typeof finding === "object" && !Array.isArray(finding) && !Array.isArray(finding)
          ? { ...finding, ...("target" in finding ? {} : { target: "deliverable" }), ...("scope" in finding ? {} : { scope: "in_scope" }) }
          : finding),
    };
  }
  // Strict providers need every property required; older outputs without acceptance_defects stay valid.
  if (!("acceptance_defects" in payload)) payload = { ...payload, acceptance_defects: [] };
  const prepared = prepareLegacySkillOutput(REVIEW_OUTPUT_SCHEMA, payload);
  payload = prepared.payload;
  const problem = validateRoleOutput(REVIEW_OUTPUT_SCHEMA, payload);
  if (problem) {
    throw reviewInvalid(`review_output_schema:${problem}`);
  }
  if ((payload.findings as ReviewResult["findings"]).some((finding) => finding.target === "report" && finding.severity === "major")) {
    throw reviewInvalid("report_major");
  }
  // The template shows one example element, so defects that come with any other verdict are dropped, not rejected.
  // Defects point at a criterion by id; the stored quote comes from the Task, never from the Reviewer's wording.
  const raw = payload.verdict === ACCEPTANCE_DEFECT_VERDICT ? payload.acceptance_defects as Record<string, unknown>[] : [];
  const texts = new Map((task?.acceptance_criteria ?? []).map((criterion) => [criterion.id, criterion.text]));
  if (task?.acceptance_criteria !== undefined) {
    const unknown = raw.filter((defect) => !texts.has(String(defect.criterion_id))).map((defect) => String(defect.criterion_id));
    if (unknown.length > 0) throw reviewInvalid(`acceptance_defect_unknown_criterion_id:${unknown}`);
    const ids = raw.map((defect) => String(defect.criterion_id));
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicated.length > 0) throw reviewInvalid(`acceptance_defect_duplicate_criterion_id:${duplicated}`);
  }
  const defects = normalizeAcceptanceDefects(raw.map((defect) => ({ ...defect, criterion: texts.get(String(defect.criterion_id)) ?? String(defect.criterion_id) })));
  if (payload.verdict === ACCEPTANCE_DEFECT_VERDICT && defects.length === 0) {
    throw reviewInvalid("acceptance_defect_without_defects");
  }
  payload = { ...payload, acceptance_defects: defects };
  const { skills_used: _skillsUsed, skill_proposals: _skillProposals, ...reviewPayload } = payload;
  return {
    review: reviewPayload as unknown as ReviewResult,
    skill_feedback: skillFeedbackFromOutput(payload, prepared.hasSkillFields),
  };
}

export function validateReviewInput(report: ReportEnvelope | LegacyReportEnvelope): ReportEnvelope | LegacyReportEnvelope {
  return readStoredReport(report);
}
