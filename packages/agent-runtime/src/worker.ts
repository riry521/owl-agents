import { extractReportPayload, validateReportEnvelope, validateReportSemantics } from "./protocol";
import { AgentRuntimeError, reportInvalid } from "./errors";
import {
  extractRoleOutputObject,
  objectSchema,
  prepareLegacySkillOutput,
  providerSchema,
  renderRolePrompt,
  skillFeedbackFromOutput,
  SKILL_PROPOSALS_SCHEMA,
  SKILLS_USED_SCHEMA,
  validateRoleOutput,
  type RolePromptSlots,
  type RoleSchema,
} from "./role-contract";
import { DESIGN_BLOCKED_SCHEMA, DEFAULT_OWNER_LANGUAGE, EXTERNAL_BLOCKER_SCHEMA, MINIMAL_CODE_RULES, UNVERIFIABLE_STATUS, renderWorkspaceToolsNote, WORKER_OWN_SUBAGENT_RULES, WORKER_SUBAGENT_RULES, type OwnerLanguage } from "@owl/shared";
import {
  type ProviderResponse,
  type ReportEnvelope,
  type TaskDetail,
  type VerificationFailure,
  type WorkerContext,
  type WorkerRequest,
} from "./types";

/** A long process the Worker left running; Core keeps the Task waiting for it instead of counting a failure. */
const PENDING_PROCESS_SCHEMA: RoleSchema = {
  ...objectSchema({
    description: { type: "string", description: "what the process is" },
    command: { type: "string", description: "the command that was started" },
    log_path: { type: "string", description: "its log, relative to the worktree" },
    done_path: { type: ["string", "null"], description: "a file (relative to the worktree) created when it finishes; null if none" },
    pid: { type: ["integer", "null"], description: "pid of the process (group); null if unknown" },
    expected_minutes: { type: "integer", description: "how long it is expected to run" },
  }),
  type: ["object", "null"],
  example: null,
  description: "set only with result \"partial\" when a long process is still running; null or omitted otherwise",
};

/** The report fields shared by the Worker and Designer. */
const WORKER_REPORT_PROPERTIES: Readonly<Record<string, RoleSchema>> = {
  kind: { type: "string", enum: ["report"] },
  schema_version: { type: "string", enum: ["1.1.0"] },
  invocation_id: { type: "string", minLength: 1, description: "will be filled" },
  result: { type: "string", enum: ["success", "partial", "failed"], description: "see the result rules below" },
  work_done: {
    type: "string",
    description: "at most 3 short bullet lines describing the key action and outcome; do not narrate every step",
  },
  delegation: {
    ...objectSchema({
    decomposition: { type: "string", minLength: 1, description: "how the Task was divided (including work given to your own subagents), or why it was kept together" },
    delegated: {
      type: "array",
      items: objectSchema({
        child_id: { type: "string", minLength: 1, description: "child_id returned by dispatch (never an id of your own subagent)" },
        instruction: { type: "string", minLength: 1, description: "instruction given to this dispatched child" },
        provider: { type: "string", minLength: 1, description: "provider selected for this child" },
        model: { type: "string", minLength: 1, description: "model selected for this child" },
      }),
      example: [],
      description: "each Owl-dispatched child only, its instruction, provider, and model; [] if none",
    },
    own_subagents_used: { type: "boolean", description: "true if you used your own provider built-in subagents or forks (not Owl dispatch); then write integration_check with its status and evidence (required true only for Owl-dispatched children)" },
    retained: {
      type: "array",
      items: objectSchema({
        part: { type: "string", minLength: 1, description: "part of the Task kept by the Worker" },
        reason: { type: "string", minLength: 1, description: "why this part was not delegated" },
      }),
      description: "parts kept by the Worker and why; [] if none",
    },
    }),
    // `own_subagents_used` is optional so reports that omit it stay valid.
    required: ["decomposition", "delegated", "retained"],
  },
  changes: {
    type: "array",
    items: objectSchema({
      file: { type: "string", description: "path of the changed file" },
      action: { type: "string", description: "what was changed in that file" },
    }),
    description: "one concise entry per changed file, with a short action; [] if none",
  },
  verification: objectSchema({
    status: { type: "string", enum: ["passed", "failed", "blocked"], description: "overall verification status; see the verification rule below" },
    method: {
      type: "string",
      minLength: 1,
      description: "one short sentence naming the checks and result, or why it could not be checked; no command output. When the acceptance criteria cover every occurrence of something, also name the search that enumerated them and how many it found",
    },
    acceptance: {
      type: "array",
      minItems: 1,
      items: {
        ...objectSchema({
          criterion_id: { type: "string", minLength: 1, example: "AC1", description: "id of a Task acceptance criterion (the id given in task.acceptance_criteria); do not restate the criterion text" },
          status: { type: "string", enum: ["passed", "failed", "blocked", UNVERIFIABLE_STATUS], description: "passed only if you verified it in the final workspace; blocked if it could not be checked; unverifiable if nothing this Task can run could ever prove it (see the unverifiable rule below)" },
          evidence: { type: "string", minLength: 1, description: "what you ran or inspected and what it showed" },
          unverifiable_reason: { type: ["string", "null"], description: "only for status unverifiable: why this criterion cannot be proven inside the Task and what provable check would replace it; null otherwise" },
        }),
        // `unverifiable_reason` is optional so reports that omit it stay valid.
        required: ["criterion_id", "status", "evidence"],
      },
      description: "one entry per numbered acceptance criterion",
    },
    checks: {
      type: "array",
      items: objectSchema({
        name: { type: "string", minLength: 1, description: "the check (test, typecheck, build, search)" },
        status: { type: "string", enum: ["passed", "failed", "blocked"], description: "outcome of the check" },
        evidence: { type: "string", minLength: 1, description: "result of the check, without raw logs" },
      }),
      example: [],
      description: "the checks you ran; [] if none",
    },
    integration_check: {
      ...objectSchema({
        status: { type: "string", enum: ["passed", "failed", "blocked"], description: "outcome of the integration check" },
        evidence: { type: "string", minLength: 1, description: "what the integration check exercised and showed" },
        required: { type: "boolean", description: "true when you delegated children, so the integrated result had to be checked" },
      }),
      type: ["object", "null"],
      // `required` is optional so reports that omit it stay valid; the Core gate does not require it.
      required: ["status", "evidence"],
      description: "the check of the integrated result after children returned; null only if you neither dispatched children through Owl nor used your own subagents",
    },
  }),
  remaining_issues: {
    type: "array",
    items: objectSchema({
      issue: { type: "string", minLength: 1, description: "what is still unresolved" },
      impact: { type: "string", description: "what it affects if left as is" },
      next_step: { type: "string", description: "what should be done about it" },
    }),
    example: [],
    description: "one entry per unresolved issue; [] if none",
  },
  next_action: { type: "string", example: "none", description: "recommended next step, or none" },
  needs_replanning: { type: "boolean", description: "true only if the Task itself must be redesigned by the Manager" },
  question_for_manager: { type: ["string", "null"], description: "a question for the Manager, or null" },
  skills_used: SKILLS_USED_SCHEMA,
  skill_proposals: SKILL_PROPOSALS_SCHEMA,
  pending_process: PENDING_PROCESS_SCHEMA,
};

/** Normal Worker output. */
// external_blocker is not in WORKER_REPORT_PROPERTIES: the Designer spreads those and must not get it.
export const WORKER_REPORT_SCHEMA: RoleSchema = objectSchema({ ...WORKER_REPORT_PROPERTIES, external_blocker: EXTERNAL_BLOCKER_SCHEMA });

/** Designer output: the Worker report plus an optional design_blocked (null unless the design cannot be produced). */
export const DESIGNER_REPORT_SCHEMA: RoleSchema = {
  ...WORKER_REPORT_SCHEMA,
  properties: {
    ...WORKER_REPORT_PROPERTIES,
    design_blocked: {
      ...DESIGN_BLOCKED_SCHEMA,
      type: ["object", "null"],
      example: null,
      description: "set only when the design cannot be produced (see the instructions); null otherwise",
    },
  },
  required: objectSchema(WORKER_REPORT_PROPERTIES).required,
};

/** Longest error summary per failed test that reaches the Worker. */
export const DEFAULT_FAILURE_MESSAGE_CHARS = 300;

interface TestFailureBrief { readonly file?: unknown; readonly name?: unknown; readonly line?: unknown; readonly message?: unknown }

/**
 * Core's test failure as the Worker sees it: failed test names and a capped
 * error summary only. Raw test output (commands, stdout/stderr, passed tests) stays out.
 */
export function workerVerificationFailure(
  failure: VerificationFailure | null | undefined,
  messageChars = DEFAULT_FAILURE_MESSAGE_CHARS,
): unknown {
  const raw = failure as unknown as { source?: unknown; error?: unknown; test_failures?: { failures?: unknown; omitted_count?: unknown } } | null | undefined;
  if (!raw) return null;
  const brief = raw.test_failures;
  if (raw.source !== "core_test_run" && !brief) return failure;
  const cap = (text: unknown): string => { const t = String(text ?? ""); return t.length > messageChars ? `${t.slice(0, messageChars)}…` : t; };
  return {
    source: raw.source ?? null,
    error: raw.error == null ? null : cap(raw.error),
    test_failures: {
      failures: (Array.isArray(brief?.failures) ? (brief.failures as TestFailureBrief[]) : []).map((f) => ({ file: f.file, name: f.name, line: f.line ?? null, message: cap(f.message) })),
      omitted_count: brief?.omitted_count ?? 0,
    },
  };
}

/**
 * The fixed Worker input for every mode: the same slots and keys every time,
 * with null or [] when Core did not supply a value. Project and Task hold what
 * stays the same across attempts; Dependencies and Attempt hold what changes.
 * The worktree is the process cwd, not prompt content.
 */
export function workerPromptInputs(request: WorkerRequest): RolePromptSlots["inputs"] {
  const context = request.context ?? {};
  const task: Partial<TaskDetail> = request.task ?? {};
  return [
    { name: "Project", value: { rules: context.rules ?? null, skills: context.skills ?? null, knowledge: context.knowledge ?? null, check_commands: context.check_commands ?? [] } },
    {
      name: "Task",
      value: {
        id: task.id ?? null,
        work_id: task.work_id ?? null,
        title: task.title ?? null,
        type: task.type ?? null,
        acceptance_criteria: task.acceptance_criteria ?? [],
        context: task.context ?? null,
        manager_notes: task.manager_notes ?? null,
        necessity: task.necessity ?? null,
        ...(task.plan_context_legacy ? { plan_context_legacy: true } : {}),
        parent_task_id: task.parent_task_id ?? null,
        depends_on: task.depends_on ?? [],
        ...(task.review === undefined ? {} : { review: task.review }),
      },
    },
    { name: "Dependencies", value: { dependencies: context.dependency_reports ?? [], artifact_paths: context.artifact_paths ?? [] } },
    {
      name: "Attempt",
      value: {
        review_round: task.review_round ?? 0,
        owner_guidance: context.owner_guidance ?? [],
        ...attemptFix(context),
      },
    },
  ];
}

/** design_stop for the Designer: review_history findings use the fix-packet formatting. */
function designStopView(stop: WorkerContext["design_stop"]): Record<string, unknown> | null {
  if (!stop) return null;
  const history = Array.isArray(stop.review_history) ? stop.review_history : [];
  return {
    ...stop,
    review_history: history.map((entry) => {
      if (entry === null || typeof entry !== "object" || !Array.isArray((entry as { findings?: unknown }).findings)) return entry;
      const findings = (entry as { findings: NonNullable<WorkerContext["reviewer_findings"]> }).findings;
      return { ...entry, findings: fixPacket({ reviewer_findings: findings }).reviewer_findings };
    }),
  };
}

/** The Attempt-field view of a fix: findings with ids and no scoring, and only the previous report's essentials. */
export interface FixPacket {
  readonly reviewer_findings: readonly { id: string; target: string; file: string; line: number | null; problem: string; reason: string; fix: string }[];
  readonly previous_report: {
    readonly result: string;
    readonly work_done: string;
    readonly changes: readonly { file: unknown; action: unknown }[];
    readonly remaining_issues: readonly unknown[];
  } | null;
  readonly verification_failure: VerificationFailure | null;
  readonly process_wait: Readonly<Record<string, unknown>> | null;
}

/** Shapes loadFixContext's result for the Worker; it selects nothing and drops no finding. */
export function fixPacket(context: Pick<WorkerContext, "reviewer_findings"> & Partial<Pick<WorkerContext, "previous_report" | "verification_failure" | "process_wait">>): FixPacket {
  const report = context.previous_report ?? null;
  return {
    reviewer_findings: (context.reviewer_findings ?? []).map((finding, index) => ({
      id: `F${index + 1}`,
      target: finding.target,
      file: finding.file,
      line: finding.line ? finding.line : null,
      problem: finding.problem,
      reason: finding.reason,
      fix: finding.fix,
    })),
    previous_report: report === null ? null : {
      result: report.result,
      work_done: report.work_done,
      changes: report.changes.map((change) => ({ file: change.file, action: change.action })),
      remaining_issues: report.remaining_issues.map((item) => {
        const { issue, impact, next_step } = item as unknown as Record<string, unknown>;
        return { issue, impact, next_step };
      }),
    },
    verification_failure: context.verification_failure ?? null,
    process_wait: context.process_wait ?? null,
  };
}

function attemptFix(context: WorkerContext) {
  const packet = fixPacket(context);
  return { ...packet, verification_failure: workerVerificationFailure(packet.verification_failure) };
}

const WORKER_CONTEXT_INSTRUCTIONS: readonly string[] = [
  "Project.rules holds the rules you must follow (null if none). Dependencies.dependencies lists, per completed Task this one depends on, what it did (work_done), the files it changed (changed_files) and what it left open (open_issues), as a summary; read the file at report_path only when you need the full report. Dependencies.artifact_paths lists their recorded artifact paths. Build on them; do not redo their work. When an entry has a design_document_path, read that design document and follow it.",
  "Do not change tests, checks or code outside the Task's scope to make a failure go away. Run only the specific test files you changed or need to fix, one file at a time, and the build. Never run the whole test suite, a test directory or a glob of test files: Core runs the tests related to your changes after your report and records the results. Do not compare results with the base branch. When a test or check you ran fails for a reason unrelated to this Task, leave it as is, report it in remaining_issues as pre-existing and say so in verification.method. A failure that bears on an acceptance criterion counts as failed.",
  "Rules are binding; Project.knowledge is reference information: an excerpt of relevant knowledge collected from past Works (null if none). It does not override rules, the Task, or acceptance criteria. Report knowledge that seems incorrect or outdated in remaining_issues.",
  "Project.skills is an index of reusable procedures. Read a relevant skill before working, and read only the supplemental references you need. A skill marked [trial] is being validated, so check that it fits the situation. A skill never overrides rules, the Task, or acceptance criteria; report a contradictory skill as misleading and follow the Task.",
  "If Attempt.verification_failure is non-null, the previous attempt failed Core verification: read source, commands and error and fix the cause. If Attempt.reviewer_findings is non-empty, it contains only major findings, each with an id (F1, F2, ...), and every one must be fixed; address all of them. The findings are a list of places to fix, not the scope of your verification: after fixing them, still verify the whole Task against its acceptance criteria. Minor findings are not passed to the Worker. When Attempt.verification_failure.test_failures is present, it lists the failed tests (file, name, line, message summary) from Core's test run; fix those failures, then run each failing file alone to confirm. Do not try to fix failures that are not listed. Only one of the two describes the latest attempt; Attempt.previous_report is that attempt's report (null if none).",
  "Keep a new test file only when a criterion's kind is spec_test; otherwise Core deletes the test files you add before merge, so check your work without leaving new test files. Before reporting, run every command in Project.check_commands and fix violations by comparing properties instead of copying current values; never delete or skip a test to pass them.",
  "If Attempt.owner_guidance is non-empty, the Owner answered earlier Decisions for this Work (newest first). Follow that guidance.",
  "If Attempt.process_wait is non-null, you started that process in an earlier run and Core relaunched you because its done_path appeared or it exited: check its log_path and done_path first, then continue from Attempt.previous_report.",
];

/** Acceptance criteria over "every occurrence" are met by enumeration, not by spot fixes. */
const WORKER_NECESSITY_INSTRUCTION =
  "Do only what the Task's acceptance criteria and context need: no features, tests, refactors or checks they do not call for. Run each check at the weight the Task asks for (each criterion in task.acceptance_criteria has check_weight and weight_reason; task.necessity and each criterion's serves and if_omitted say why it is needed); do not make real model or paid API calls, use production-size data or run long full passes unless a criterion requires it. When you notice an improvement, an extra test or a heavier check that may be worth doing but this Task does not need, do not do it: add it to remaining_issues as an optional proposal (issue: the proposal, saying it is not needed for this Task; impact: what it would improve; next_step: how a later Work could do it).";

const DESIGNER_NECESSITY_INSTRUCTION =
  "Design only what the Task's acceptance criteria and the Work's request need: no options, extension points, settings, phases or tests that nothing in the request uses. In the test strategy, choose the lightest check that proves each criterion; do not plan real model or paid API calls, production-size data or long full runs unless the request needs them, and say why when it does. Put ideas worth considering later in remaining_issues as optional proposals, not in the design.";

const ENUMERATION_INSTRUCTION =
  "When the acceptance criteria cover every occurrence of something (all call sites, every label, each event type), first enumerate the targets with a search (grep, or the semantic and impact-analysis tools when available) before changing anything, then handle every hit. In verification.method, name that search and how many targets it found, so the Reviewer can re-run it.";

const SKILL_FEEDBACK_INSTRUCTION =
"List each skill you actually used in skills_used, with helpful, misleading, or irrelevant and a short note. Only list Skill Box skills that appear in the Project.skills index; never list plugin or process skills (e.g. superpowers:*) there. Propose a skill only when you solved a multi-step procedure that can be reused, found a reusable fix after an error or dead end, learned a lasting approach from Owner or Reviewer feedback, or found a mistake or gap in an existing skill. Leave skill_proposals empty otherwise.";

const RESULT_RULES: readonly string[] = [
  "Fill in result using these exact rules (do not guess or hedge):",
  "- \"success\": only when every acceptance criterion was verified as met in the final workspace. Creating or changing files is not by itself a reason for \"success\".",
  "- \"partial\": the task was cut short (you ran out of time/turns, a required resource was unavailable partway through), or an essential verification could not be run and no alternative evidence shows the criterion is met.",
  "- \"failed\": the task could not be done at all (the requested change is impossible, a hard blocker prevented any progress, or you made no meaningful progress).",
  "verification: give each numbered acceptance criterion its own entry in verification.acceptance with a status and evidence, and use a distinct criterion_id for each. Status \"passed\" only when you verified that criterion in the final workspace; \"failed\" when the check ran and the criterion is not met; \"blocked\" when an essential verification (a test, build, or check the criterion depends on) could not be run and cannot be replaced by other evidence. Never report a check you could not run as passed. verification.status is \"passed\" only when every acceptance entry and every check passed, \"failed\" if any failed, otherwise \"blocked\". Use result \"success\" only with verification.status \"passed\", needs_replanning false and question_for_manager null. A check that fails for a reason unrelated to this Task does not make it failed, but say so in verification.method. If you found a defect during verification, fix it before reporting, then re-verify the whole Task.",
  "verification.integration_check: set it to null unless you delegated children or used your own subagents; when you did, run an integration check on the combined result and report its status and evidence. Set required true only when you dispatched children through Owl.",
];

/** Finalization: what the Worker does between "implementation written" and "report returned". */
const FINALIZATION_INSTRUCTIONS: readonly string[] = [
  "Finalization: do not report until you have done all of the following.",
  "1. Take each criterion in task.acceptance_criteria as one criterion, identified by its id (AC1, AC2, ...); a criterion with legacy true holds the whole free-text acceptance as one criterion, so do not split it or invent other ids. 2. Inspect the final workspace itself (the files as they are now, not your memory of what you wrote) against each criterion. 3. Run the checks that show each criterion is met (tests, typecheck, build, searches). 4. When a check fails or shows a defect, fix the cause. 5. After every fix, re-verify the whole Task, not only the part you touched. 6. If an essential check cannot be run and no alternative evidence replaces it, the work is blocked: report it as not verified (result \"partial\", verification.status \"blocked\") and say what is missing; never present it as passed. 7. For work you delegated, read the integrated final workspace and verify it yourself; a child's report is evidence, not proof. 8. Keep secrets, credentials, environment dumps, and large raw logs out of verification evidence. 9. Report each unresolved issue in remaining_issues.",
  "If the same verification failure is still not fixed after two substantively different fixes, stop trying: report it, set needs_replanning or raise a blocker in question_for_manager, and do not claim success.",
  "If you cannot proceed because of a prerequisite outside this Task (another Work's result, a file not yet on the base branch, an Owner decision), do not build a workaround. Put in question_for_manager what is missing and what would let you proceed (Work number, Task id, or paths on the base branch). Core can hold the Task until the prerequisite is met and then run it again.",
  "If a criterion cannot be proven by anything this Task can run (it compares a live server, live data or another Work before and after, or depends on state outside the worktree), do not try to satisfy it and do not retry. Report result \"partial\", verification.status \"blocked\", and for that criterion status \"unverifiable\" with unverifiable_reason saying why and what provable check would replace it. Core sends it to the Manager to rewrite the criterion; other criteria are reported as usual.",
  "If a check needs a long process (a dry-run, a long build), first decide whether it fits in your remaining time; if it does, run it in the background, poll its log and finish in this run. If it does not fit, start the whole wrapper (the command and the touch of the done file) detached in its own session, because Core ends the agent's process group when your run ends (for example `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); exec @ARGV' sh -c '<command> > <log> 2>&1; touch <done_file>' < /dev/null > /dev/null 2>&1`), write its log and a done file inside the worktree, and report result \"partial\" with pending_process describing it. Core keeps the Task waiting until the done file appears or the process ends and then relaunches you with the previous report; do not report partial just to be relaunched later without pending_process.",
  "If you cannot meet an acceptance criterion because of a problem that already exists on the base branch (pre_existing) or a gap in the Project environment that this Task must not set up (environment) — for example Attempt.verification_failure.error_key is code_unchecked because no checker or test runner is configured for the files you changed — do not work around it: report result \"partial\" with external_blocker {kind, summary, evidence, suggested_fix}, and mark that criterion failed. evidence must show, from what you ran or read, that the problem does not come from this Task's changes. Otherwise external_blocker is null. A failure that does not block any criterion stays in remaining_issues as before.",
];

export function buildWorkerPrompt(
  request: WorkerRequest,
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
  hybridMode = false,
): string {
  return renderRolePrompt({
    role: "You are the Owl Worker. Perform the assigned task.",
    instructions: [
      "Keep the final report concise and scannable: write work_done as at most 3 short bullet lines describing the key action and outcome. Put each changed path and its concise change in changes. Keep verification.method to one short sentence naming the checks and their result. Do not narrate every acceptance criterion or paste raw command logs, full diffs, or full tool output.",
      "Always complete the required delegation field: explain how work was split, list each dispatched child's instruction and provider/model, and name each part kept with its reason. If no work was dispatched, explain why and record what you kept. Work you split among your own subagents (not Owl dispatch) goes in decomposition; delegated holds only child_ids returned by dispatch, never your own subagents.",
      ...(hybridMode ? [
        "Hybrid Mode: before starting, you must consider whether the Task can run in parallel: break it into a few bounded parts and identify which parts are independent of each other. Examples of independent parts: changes in different areas or packages, fixes to unrelated tests, splitting up an investigation.",
        "Hand independent parts to Owl dispatch children (not provider-native subagents) to run in parallel as much as possible: use Owl's dispatch tool to start all ready independent parts at once. Do not split only when the Task is small, or when the parts depend so strongly on each other that splitting would make them disagree. There is no numeric threshold; the judgment is yours, but the consideration is mandatory. Give each child a self-contained instruction and select its provider and model explicitly. Use wait on every dispatched run and receive all results before moving on.",
        "Inspect every child's result against its instruction and the whole Task, integrate the work, and check it together. If something is incomplete, dispatch another focused child or fix it yourself. Do not finish until the full Task is complete and coherent.",
        "A child's success report is evidence, not proof of the Task's correctness: read the integrated final workspace yourself and verify every acceptance criterion. Wait until every dispatched child has finished; never return success while a child is still running or its result is missing.",
        "Hybrid Task Finalization, after the children return: (1) confirm every part you planned has a dispatched child (by child_id) or is listed as retained, and that no part is missing; (2) confirm every child finished and returned a result, and treat a failed, partial, or missing child result as unfinished work; (3) compare the files each child reported with the files actually changed in the final workspace, and investigate any difference; (4) check the interfaces between the children's work (names, types, call sites, data formats) match; (5) resolve conflicts and gaps between children yourself or with a focused child; (6) run the Task-level checks that cover each acceptance criterion against the integrated workspace; (7) when you delegated children or used your own subagents, run an integration check that exercises the combined result (build, typecheck, tests across the parts) and record it in verification.integration_check with its status and evidence, and with required true only when you dispatched children through Owl; when you neither dispatched children through Owl nor used your own subagents, integration_check is not needed; (8) fix any defect found and re-verify the whole Task; (9) never count a child's success report as the Task's correctness; (10) list unverified items and failed checks in remaining_issues; (11) keep secrets and large logs out of the evidence; (12) report success only when all of the above hold, otherwise report partial or failed with the reason.",
        "In the required delegation field, explain how you divided the Task, record each dispatch-returned child_id with a brief summary of the work assigned to that child and its provider and model, and list every part you kept with the reason. If you dispatched nobody, say why the Task stayed together, state whether the reason is that it was small or that its parts depend strongly on each other, and record the work you retained.",
      ] : []),
      ...(hybridMode ? WORKER_SUBAGENT_RULES : WORKER_OWN_SUBAGENT_RULES),
      ...MINIMAL_CODE_RULES,
      "Tests: add them to the existing feature test file, fix an existing test that checks the same thing, and create a new test file only for a new feature. Before you report, run `pnpm test:layout` yourself and fix any violation on the spot.",
      WORKER_NECESSITY_INSTRUCTION,
      ...WORKER_CONTEXT_INSTRUCTIONS,
      ...FINALIZATION_INSTRUCTIONS,
      ENUMERATION_INSTRUCTION,
      SKILL_FEEDBACK_INSTRUCTION,
    ],
    processSkills,
    workspaceTools: renderWorkspaceToolsNote(request.context?.worktree),
    output: WORKER_REPORT_SCHEMA,
    outputRules: RESULT_RULES,
    language,
    inputs: workerPromptInputs(request),
  });
}

/** Designer input mirrors the Worker slots and adds its external document destination to Task. */
export function designerPromptInputs(request: WorkerRequest): RolePromptSlots["inputs"] {
  return workerPromptInputs(request).map((input) => input.name === "Attempt"
    ? { ...input, value: { ...(input.value as Record<string, unknown>), design_stop: designStopView(request.context?.design_stop) } }
    : input.name === "Task"
    ? {
        ...input,
        value: {
          ...(input.value as Record<string, unknown>),
          design_document_path: request.context?.design_document_path ?? null,
          design_tier: request.context?.design_tier ?? "standard",
        },
      }
    : input);
}

/** The Designer shares the Worker's input renderer, schema, and report validation. */
export function buildDesignerRolePrompt(
  request: WorkerRequest,
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
): string {
  return renderRolePrompt({
    role: request.context?.design_tier === "lead" ? "You are the Owl Lead Designer." : "You are the Owl Designer.",
    instructions: [
      "Produce the design the Task asks for, such as architecture, a data model, an API, UX, or an implementation approach. Read the repository to ground the design in the current code.",
      ...(request.context?.design_tier === "lead" ? ["This design was assigned to you explicitly or escalated after two failed reviews. Read the existing design document and every Reviewer finding, then resolve the root problems while preserving valid decisions."] : []),
      "Write the design as Markdown to Task.design_document_path, the absolute path provided in the input, and overwrite the document on a retry.",
      "Do not modify any file in the repository working tree, do not commit, and do not create branches.",
      "The document must let an implementer proceed without asking: state the goal and constraints; the chosen approach and why; components and their interfaces; data and API changes; error handling; the test strategy; and an ordered implementation breakdown.",
      DESIGNER_NECESSITY_INSTRUCTION,
      "In changes, list the design document using its absolute path and action created or modified. In verification.method, state that the document was written and self-reviewed against the Task's acceptance criteria.",
      "Complete delegation by saying the design work stayed with you, leaving delegated empty, and listing each part you retained with its reason.",
      "Use needs_replanning and question_for_manager exactly as the Worker does: set needs_replanning only when the Task itself needs a new plan, and set question_for_manager to null unless the Manager must resolve a blocker.",
      ...WORKER_CONTEXT_INSTRUCTIONS,
      "If the design cannot be produced inside this Task because its premise is wrong, the rules or Owner policy contradict the request, or the acceptance criteria are ambiguous, do not design around it: set design_blocked (cause_kind, cause, repeated_findings, question, options, recommended_option), mark each acceptance criterion failed with evidence pointing to design_blocked, and set result \"failed\". Core then stops the Work and asks the Owner instead of remaking the design. Otherwise set design_blocked to null; never use it for a defect you can fix yourself.",
      ...(request.context?.design_stop ? ["Core has stopped remaking this design: Lead Designer output was rejected Attempt.design_stop.rejections times (limit Attempt.design_stop.limit). Do not rewrite the design document. Read it, Attempt.reviewer_findings and Attempt.design_stop.review_history, then fill design_blocked: classify the cause, list the Reviewer points that keep coming back with how many verdicts raised them, and give the Owner options with a recommendation. design_blocked must not be null in this run."] : []),
      SKILL_FEEDBACK_INSTRUCTION,
    ],
    processSkills,
    workspaceTools: renderWorkspaceToolsNote(request.context?.worktree),
    output: DESIGNER_REPORT_SCHEMA,
    outputRules: RESULT_RULES,
    language,
    inputs: designerPromptInputs(request),
  });
}

function extractWorkerPayload(response: ProviderResponse, invocationId: string): Record<string, unknown> {
  const format = response.format ?? "provider-json";
  if (format === "canonical-jsonl") {
    // A canonical-jsonl harness already split log lines from the one report line.
    return extractReportPayload(response.adapter, response.stdout, invocationId, format);
  }
  return extractRoleOutputObject(response, "worker_stdout_not_single_json_object");
}

type CriteriaTask = Pick<TaskDetail, "acceptance_criteria">;

/**
 * Checks the reported criterion ids against the Task's criteria (every id exactly once, no unknown id) and
 * fills the stored `criterion` text from the id. Without Task criteria the id set is not checked and the id is used.
 */
function withCriterionTexts(payload: Record<string, unknown>, task: CriteriaTask | undefined): Record<string, unknown> {
  const verification = payload.verification as { acceptance?: unknown } | null;
  if (verification === null || typeof verification !== "object" || !Array.isArray(verification.acceptance)) return payload;
  const criteria = task?.acceptance_criteria;
  const texts = new Map((criteria ?? []).map((criterion) => [criterion.id, criterion.text]));
  const items = verification.acceptance as Record<string, unknown>[];
  if (criteria !== undefined) {
    const reported = items.map((item) => item.criterion_id);
    const unknown = reported.filter((id) => typeof id !== "string" || !texts.has(id));
    const missing = [...texts.keys()].filter((id) => !reported.includes(id));
    if (unknown.length > 0 || missing.length > 0 || new Set(reported).size !== reported.length) {
      throw reportInvalid(`worker_acceptance_criterion_ids:unknown=[${unknown.map(String)}],missing=[${missing}]`);
    }
  }
  return {
    ...payload,
    verification: { ...verification, acceptance: items.map((item) => ({ ...item, criterion: texts.get(String(item.criterion_id)) ?? String(item.criterion_id) })) },
  };
}

export function normalizeWorkerResponse(
  response: ProviderResponse,
  invocationId: string,
  task?: CriteriaTask,
): ReportEnvelope {
  return normalizeWorkerResponseWithFeedback(response, invocationId, false, task).report;
}

export function normalizeWorkerResponseWithFeedback(
  response: ProviderResponse,
  invocationId: string,
  hybrid = false,
  task?: CriteriaTask,
  schema: RoleSchema = WORKER_REPORT_SCHEMA,
): { readonly report: ReportEnvelope; readonly skill_feedback: import("@owl/shared").SkillFeedback | null } {
  try {
    const rawPayload = extractWorkerPayload(response, invocationId);
    // The prompt shows a placeholder ("<will be filled>") for invocation_id
    // because the model cannot know it; the runtime's own invocation id is
    // authoritative and is substituted before the schema is checked, so the
    // placeholder in that one field is never itself a validation failure.
    const suppliedPayload = invocationId ? { ...rawPayload, invocation_id: invocationId } : rawPayload;
    const prepared = prepareLegacySkillOutput(schema, suppliedPayload);
    const payload = prepared.payload;
    const problem = validateRoleOutput(schema, payload);
    const { skills_used: _skillsUsed, skill_proposals: _skillProposals, ...reportPayload } = payload;
    if (problem) {
      if (problem.startsWith("delegation.delegated")) validateReportEnvelope(reportPayload);
      throw reportInvalid(`worker_output_schema:${problem}`);
    }
    const report = validateReportEnvelope(withCriterionTexts(reportPayload, task));
    // A Hybrid success is an "ok" verdict and needs a passed integration check.
    validateReportSemantics(report, hybrid && report.result === "success" ? { verdict: "ok", retry_subtasks: [] } : undefined);
    return {
      report,
      skill_feedback: skillFeedbackFromOutput(payload, prepared.hasSkillFields),
    };
  } catch (error) {
    // Malformed provider output is a protocol failure, not a synthetic
    // Worker report. Returning raw stdout here could both hide the cause and
    // persist credentials that a harness accidentally printed.
    if (error instanceof AgentRuntimeError) throw error;
    throw reportInvalid("worker_output_invalid", error);
  }
}
