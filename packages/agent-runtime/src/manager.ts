import { managerPlanInvalid } from "./errors";
import { isRecord } from "./protocol";
import {
  objectSchema,
  prepareLegacySkillOutput,
  renderRolePrompt,
  skillFeedbackFromOutput,
  SKILL_PROPOSALS_SCHEMA,
  SKILLS_USED_SCHEMA,
  validateRoleOutput,
  type RoleSchema,
} from "./role-contract";
import { ACCEPTANCE_CRITERION_ID_PREFIX, CHECK_WEIGHTS, CRITERION_KINDS, DEFAULT_OWNER_LANGUAGE, KNOWLEDGE_EXTERNAL_COMMAND_RULE, renderAcceptanceCriteria, validateAcceptanceCriteria, type AcceptanceCriterion, type OwnerLanguage, type TaskNecessity } from "@owl/shared";
import type { PlanWaitFor } from "../../shared/dist/prerequisite.js";
import {
  type ManagerPlanRequest,
  type ManagerPlanResult,
  type ManagerVerdict,
  type TaskDetail,
  type WorkContext,
} from "./types";

const TASK_TYPE_VALUES = ["research", "design", "code", "config", "doc", "test"] as const;

/** The one definition of a Manager plan/replan Task. */
const MANAGER_TASK_SCHEMA: RoleSchema = objectSchema({
  id: { type: "string", minLength: 1, description: "Task id such as T1" },
  title: { type: "string", minLength: 1, description: "short Task title" },
  type: { type: "string", enum: TASK_TYPE_VALUES, description: "kind of work" },
  acceptance_criteria: {
    type: "array",
    minItems: 1,
    description: `the checkable success criteria the Worker must meet, one object per criterion; ids are ${ACCEPTANCE_CRITERION_ID_PREFIX}1, ${ACCEPTANCE_CRITERION_ID_PREFIX}2, ... in array order; a criterion over every occurrence names its concrete scope; written as deliverable behavior and checks to run, never as report-format requirements`,
    items: objectSchema({
      id: { type: "string", minLength: 1, description: `${ACCEPTANCE_CRITERION_ID_PREFIX}<position>, e.g. ${ACCEPTANCE_CRITERION_ID_PREFIX}1` },
      text: { type: "string", minLength: 1, description: "what must be true (the content of the criterion)" },
      check: { type: "string", minLength: 1, description: "how to check it: a command, test or evidence that can run inside this Task" },
      serves: { type: "string", minLength: 1, description: "the part of the request this criterion serves" },
      if_omitted: { type: "string", minLength: 1, description: "what goes wrong for the request without this criterion" },
      check_weight: { type: "string", enum: CHECK_WEIGHTS, description: "light: reading files, unit tests, typecheck, building the touched package; medium: the full test suite, an integration run or a local server or browser on temporary data; heavy: real model or paid API calls, production-size data or copies of it, every item of a large set, or runs of about ten minutes or more" },
      kind: { type: "string", enum: CRITERION_KINDS, description: "spec_test: asks to add or change a test that pins the specification; work_check: anything else (confirming the work is right)" },
      weight_reason: { type: "string", description: "for heavy only: why no lighter check can prove what the request needs; empty string otherwise" },
    }),
  },
  depends_on: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "ids of Tasks that must complete first; [] if none",
  },
  context: { type: "string", description: "background the Worker needs; empty string if none" },
  notes: { type: "string", description: "extra notes for the Worker; empty string if none" },
  review: {
    type: ["boolean", "null"],
    description: "true requires the Reviewer, false skips the Reviewer, null keeps the Work default",
  },
  required_sections: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "for a doc Task: headings the deliverable must contain (at most 20), checked by Core; [] if none",
  },
  required_tests: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "for a test Task: worktree-relative test files Core must run and see pass (at most 20); [] if none",
  },
  replaces: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "ids of failed Tasks in current_plan that this NEW Task replaces; [] for a retried Task or a Task that replaces nothing",
  },
  wait_for: {
    type: ["object", "null"],
    description: "replan only, on a retried Task: hold it until prerequisites outside this Work are met, then run it again; null otherwise (always null in a plan)",
    properties: {
      reason: { type: "string", minLength: 1, description: "why the Task must wait" },
      conditions: {
        type: "array",
        description: "all must hold before the Task runs again",
        items: objectSchema({
          kind: { type: "string", enum: ["task", "work", "base_branch", "owner"], description: "task: a Task of another Work completes; work: another Work completes; base_branch: the base branch has the given paths (or moves on, when paths is []); owner: only the Owner's resume releases it" },
          target: { type: "string", description: "task: the Task id; work: the Work id or display number such as \"#51\"; base_branch and owner: empty string" },
          paths: { type: "array", items: { type: "string", minLength: 1 }, description: "base_branch only: repository-relative paths that must exist on the base branch; [] for every other kind" },
          description: { type: "string", minLength: 1, description: "what is awaited, in words the Owner can read" },
        }),
      },
    },
    required: ["reason", "conditions"],
    additionalProperties: false,
  },
  base_sync_only: {
    type: ["boolean", "null"],
    description: "true when this Task or attempt's only purpose is to bring the base branch into the Task's branch and make its existing checks pass again; in a replan only on a retried Task or a NEW Task with replaces; null otherwise",
  },
  necessity: objectSchema({
    serves: { type: "string", minLength: 1, description: "the part of the Owner's request this Task serves" },
    if_omitted: { type: "string", minLength: 1, description: "what goes wrong for the request if this Task is not done" },
  }),
});

/** Manager output for mode "plan": at least one Task. */
export const MANAGER_PLAN_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  tasks: {
    type: "array",
    minItems: 1,
    items: MANAGER_TASK_SCHEMA,
    description: "the Tasks of the plan (at least one)",
  },
  skills_used: SKILLS_USED_SCHEMA,
});

/** Manager output for mode "replan": [] means nothing is needed. */
/** Upper bounds shared with Core's updateWork validation. */
export const WORK_TITLE_MAX_LENGTH = 500;
export const WORK_SUMMARY_MAX_LENGTH = 20_000;

/** A replan result may revise the Work's title/summary; null or absent means unchanged. */
export type ManagerPlan = ManagerPlanResult & {
  readonly updated_title?: string | null;
  readonly updated_summary?: string | null;
};

export const MANAGER_REPLAN_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  tasks: {
    type: "array",
    items: MANAGER_TASK_SCHEMA,
    description: "Tasks to retry or add; [] when nothing is missing and no failed Task remains",
  },
  updated_title: {
    type: ["string", "null"],
    minLength: 1,
    description: "the Work's full new title (1-500 characters) when the Owner's request changes it; null otherwise",
  },
  updated_summary: {
    type: ["string", "null"],
    minLength: 1,
    description: "the Work's full revised summary (at most 20,000 characters) reflecting only what the Owner's request changed; null when the request does not affect the summary",
  },
  task_actions: {
    type: "array",
    items: objectSchema({
      task_id: { type: "string", minLength: 1, description: "id of an open Task in current_plan (waiting, ready, running, verifying, paused or blocked)" },
      action: { type: "string", enum: ["cancel", "complete"], description: "cancel: the Task is no longer needed and its Agent is stopped; complete: treat the Task as done and stop its Agent (its worktree is not merged)" },
      reason: { type: "string", minLength: 1, description: "why, in one sentence" },
    }),
    description: "replan after an Owner request only: cancel or complete open Tasks; [] to leave every open Task as it is",
  },
  skills_used: SKILLS_USED_SCHEMA,
});

/** Lesson keys for routing facts, decisions and pitfalls to theme pages. */
const PAGES_LESSON_PROPERTIES = {
  theme: { type: "string", description: "for kind fact, decision or pitfall: choose one title from the `## テーマ` / `## 共通テーマ` list of the injected index; if none fits, give a new short theme title; empty only if it cannot be classified, or for other kinds" },
  cross_project: { type: "boolean", description: "true only if the lesson applies across Projects, not just this one; otherwise false" },
} as const;

function finalizeOutputSchema(pages: boolean): RoleSchema {
  return objectSchema({
  skills_used: SKILLS_USED_SCHEMA,
  skill_proposals: SKILL_PROPOSALS_SCHEMA,
  verdict: objectSchema({
    verdict: {
      type: "string",
      enum: ["complete", "incomplete"],
      description: "complete if the reports show the Work's goal was achieved, otherwise incomplete",
    },
    summary: { type: "string", description: "one sentence describing what the Work accomplished" },
    missing: {
      type: "array",
      items: objectSchema({
        item: { type: "string", minLength: 1, description: "what is left undone" },
        reason: { type: "string", description: "why it counts as missing, citing the reports" },
        fix: { type: "string", description: "what should be done to complete it" },
      }),
      example: [],
      description: "one entry per missing point; [] if complete",
    },
    unaddressed_backlog_items: {
      type: "array",
      items: objectSchema({
        item_id: { type: "string", minLength: 1, description: "id of an item in context.backlog_items" },
        reason: { type: "string", description: "why the completed Tasks did not address it" },
      }),
      example: [],
      description: "backlog items this Work did not address; [] if all were addressed or there are none",
    },
    lessons: {
      type: "array",
      items: objectSchema({
        lesson: { type: "string", minLength: 1, description: "what was learned in 1–2 sentences" },
        basis: { type: "string", description: "what in this Work shows it" },
        applies_to: { type: "string", description: "which future Work or situations it applies to" },
        kind: {
          type: "string",
          enum: ["procedure", "fact", "decision", "pitfall", "rule_candidate"],
          description: "reusable lesson kind; omit lessons with no reuse value",
        },
        topic: { type: "string", description: "short topic for fact, decision, or pitfall; otherwise empty" },
        procedure: { type: "string", description: "numbered procedure of at least 40 characters for procedure; otherwise empty" },
        rule_text: { type: "string", description: "one-line imperative rule of at most 300 characters for rule_candidate, in general wording with no file names, Project names, Task or Work numbers; otherwise empty" },
        rule_scope: {
          type: "string",
          enum: ["all", "manager", "designer", "worker", "reviewer", "advisor"],
          description: "scope for rule_candidate; all other lesson kinds use all",
        },
        keywords: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "3-5 short noun keywords (topic words, product/tool names) for kind fact, decision or pitfall; [] for other kinds. No sentences, no particles or verb endings.",
        },
        ...(pages ? PAGES_LESSON_PROPERTIES : {}),
      }),
      example: [],
      description: `lessons learned for future Work; may be []. ${KNOWLEDGE_EXTERNAL_COMMAND_RULE}`,
    },
  }),
  });
}

/** Manager output for mode "finalize". */
export const MANAGER_FINALIZE_OUTPUT_SCHEMA: RoleSchema = finalizeOutputSchema(false);
/** The finalize output when memory_mode is "pages": lessons also carry theme and cross_project. */
export const MANAGER_FINALIZE_PAGES_OUTPUT_SCHEMA: RoleSchema = finalizeOutputSchema(true);

export function managerOutputSchema(request: Pick<ManagerPlanRequest, "mode" | "memory_mode">): RoleSchema {
  return request.mode === "finalize"
    ? request.memory_mode === "pages" ? MANAGER_FINALIZE_PAGES_OUTPUT_SCHEMA : MANAGER_FINALIZE_OUTPUT_SCHEMA
    : request.mode === "replan"
      ? MANAGER_REPLAN_OUTPUT_SCHEMA
      : MANAGER_PLAN_OUTPUT_SCHEMA;
}

/**
 * The fixed Manager input: the same keys for every mode and call site, with
 * null or [] for anything the caller did not supply.
 */
export function managerPromptInput(request: ManagerPlanRequest): Record<string, unknown> {
  const context = request.context ?? {};
  return {
    mode: request.mode ?? "plan",
    work: request.work,
    tasks: request.tasks ?? [],
    reports: request.reports ?? [],
    notes: request.notes ?? [],
    trigger: request.trigger ?? null,
    context: {
      start_mode: typeof context.start_mode === "string" ? context.start_mode : null,
      failed_task_ids: Array.isArray(context.failed_task_ids) ? context.failed_task_ids : [],
      current_plan: Array.isArray(context.current_plan) ? context.current_plan : [],
      worker_questions: Array.isArray(context.worker_questions) ? context.worker_questions : [],
      base_merge_conflict: isRecord(context.base_merge_conflict) ? context.base_merge_conflict : null,
      owner_requests: Array.isArray(context.owner_requests) ? context.owner_requests : [],
      previous_output_feedback: isRecord(context.previous_output_feedback) ? context.previous_output_feedback : null,
      failed_tasks: Array.isArray(context.failed_tasks) ? context.failed_tasks : [],
      final_verdict: isRecord(context.final_verdict) ? context.final_verdict : null,
      work_verification: isRecord(context.work_verification) ? context.work_verification : null,
      backlog_items: Array.isArray(context.backlog_items) ? context.backlog_items : [],
      rules: typeof context.rules === "string" ? context.rules : null,
      knowledge: typeof context.knowledge === "string" ? context.knowledge : null,
      skills: typeof context.skills === "string" ? context.skills : null,
      design_documents: Array.isArray(context.design_documents) ? context.design_documents : [],
      owner_replan_kind: typeof context.owner_replan_kind === "string" ? context.owner_replan_kind : null,
    },
  };
}

function taskFromOutput(value: Record<string, unknown>): TaskDetail {
  const task: {
    id: string;
    work_id: string;
    title: string;
    status: string;
    type: TaskDetail["type"];
    state_version: number;
    updated_at: string;
    parent_task_id: string | null;
    acceptance: string;
    acceptance_criteria: readonly AcceptanceCriterion[];
    review_round: number;
    failure_count: number;
    worker_generation: number;
    depends_on: readonly string[];
    context?: string;
    review?: boolean;
    notes?: string;
    replaces: readonly string[];
    required_sections?: readonly string[];
    required_tests?: readonly string[];
    wait_for?: PlanWaitFor;
    base_sync_only?: boolean;
    necessity?: TaskNecessity;
  } = {
    id: value.id as string,
    work_id: "",
    title: value.title as string,
    status: "ready",
    type: value.type as string,
    state_version: 0,
    updated_at: new Date().toISOString(),
    parent_task_id: null,
    acceptance: renderAcceptanceCriteria(value.acceptance_criteria as readonly AcceptanceCriterion[]),
    acceptance_criteria: value.acceptance_criteria as readonly AcceptanceCriterion[],
    review_round: 0,
    failure_count: 0,
    worker_generation: 0,
    depends_on: value.depends_on as readonly string[],
    replaces: value.replaces as readonly string[],
  };
  // Empty strings and null are the template's "not supplied" values; Core
  // treats an absent field as "use the default".
  if (value.context !== "") task.context = value.context as string;
  if (value.notes !== "") task.notes = value.notes as string;
  if (typeof value.review === "boolean") task.review = value.review;
  if (Array.isArray(value.required_sections)) task.required_sections = value.required_sections as readonly string[];
  if (Array.isArray(value.required_tests)) task.required_tests = value.required_tests as readonly string[];
  if (isRecord(value.wait_for)) task.wait_for = value.wait_for as unknown as PlanWaitFor;
  if (typeof value.base_sync_only === "boolean") task.base_sync_only = value.base_sync_only;
  if (isRecord(value.necessity)) task.necessity = value.necessity as unknown as TaskNecessity;
  return task;
}

const TEST_PLACEMENT_GUIDANCE = "When a Task adds tests, tell the Worker to add them to the existing feature test file or fix the existing test that checks the same thing; a new test file only for a new feature.";

const SMALL_TASK_BATCHING_GUIDANCE = [
  "Task granularity: give a Task of its own when it is heavy, needs a spec decision, or is risky (changes behavior, touches a wide area). Bundle small, mutually unrelated, low-risk items (doc fixes, removing stale comments or unused imports, single-place fixes) into ONE Task instead of one Task per item; its Worker handles them in parallel with subagents, each given a disjoint write scope.",
  "For a bundled Task, write acceptance criteria at bundle granularity, not one per item: for example \"the report lists which items were fixed and how\" and \"the build and tests pass\". Do not turn each small item into its own criterion, so the plan stays within max_acceptance_items.",
].join("\n");

const MODE_INSTRUCTIONS: Readonly<Record<"plan" | "replan", readonly string[]>> = {
  plan: [
    "Plan the Work in the input below as Tasks. The Worker runs every Task except type design Tasks, which the Designer runs. Give each Task a unique id, and use depends_on to order Tasks that need earlier results. Every Task's replaces is [] in a plan. For a doc Task list the headings it must contain in required_sections, and for a test Task the test files Core must run in required_tests; otherwise both are [].",
    "Maximize safe parallelism across the Work: put substantial (not small, see the Task granularity rule) independent outcomes in sibling Tasks with no depends_on, and add a dependency only when a Task needs another Task's output, files, or decision. When Hybrid Mode is enabled, a Worker can also use Owl's dispatch tool to run independent parts of its assigned Task concurrently, then wait for the results and integrate and verify the whole Task. Do not serialize independent work just to impose an order: never add an unnecessary depends_on between independent Tasks, so they can run in parallel.",
    "If work.owner_guidance is present, the Owner's answers take priority.",
    "context.previous_output_feedback is null unless your previous plan was rejected or needs repair; then kind says which (plan_rejected, fields_missing: return the same plan with only those fields fixed, quality_rejected, quality_repair), errors lists the validator's problems (one sentence each) and warnings lists the plan quality findings (task_ref, title, code, detail, measured, threshold): fix exactly those. context.rules holds the rules every plan must follow (null if none).",
  ],
  replan: [
    "This is a REPLAN. \"tasks\" lists the root failed Tasks (may be empty). context.current_plan lists every Task in the Work with id, manager_task_id, status, depends_on, required_sections / required_tests (only when stored) and failed_by_dependency (true = it failed only because a dependency failed; do not retry or replace it, it resumes on its own).",
    [
      "Replan protocol:",
      "- To retry a failed Task, include it with its existing id and replaces: [] (you may revise title, acceptance_criteria, context, type, review, required_sections and required_tests; restate the last two, [] clears them). Its depends_on replaces the Task's current dependencies: copy them from current_plan to keep them, or change them (existing Task ids or ids of new Tasks in this replan; not itself and not a cancelled Task).",
      "- A failed task with failure.kind \"acceptance_defect\" has criteria that cannot be proven inside the Task (listed in acceptance_defects). Retry that same Task with its existing id and replaces: [], rewrite only those criteria into checks the Task itself can run (text and check of each), keep the other criteria (restate the whole acceptance_criteria array, ids AC1, AC2, ... in order), and do not set wait_for or supersede it.",
      "- A failed task with failure.kind \"external_blocker\" stopped on a problem outside its own scope: one that already exists on the base branch (cause pre_existing) or a gap in the Project environment (cause environment); see its summary, evidence and suggested_fix. Fix it inside this Work: add a NEW Task that removes the cause (suggested_fix is a starting point, not a requirement) and retry the failed Task with its existing id, replaces: [] and depends_on including the new Task's id. Do not use wait_for for it. Do not change its acceptance criteria to hide the problem.",
      "- If a Task failed because of a prerequisite this Work cannot meet itself (another Work's completion, a merge into the base branch, an Owner decision), do not retry it unchanged: retry it with wait_for {reason, conditions[{kind, target, paths, description}]}. Core watches the conditions and runs the Task again once they hold. Use depends_on, not wait_for, to wait for a Task of this Work. context.failed_tasks[].no_progress holds the count of consecutive no-progress results and the limit; at the limit the Work goes to the Owner. Use wait_for only on a retried Task (replaces: []); everywhere else it is null.",
      "- base_sync_only: set true only on a Task in a plan, a retried Task (replaces: []) or a NEW Task with replaces (in a replan) whose only purpose is to merge the base branch into the Task's branch and make its existing checks pass again (resolving conflicts and fixing what the merge broke). Leave it null when the attempt also changes what the Task delivers or addresses review findings about the Task's own work. The mark applies to this attempt only: restate it on every retry. Core counts marked attempts against separate limits (remake_limits.base_sync_lineage_*) and shows them to the Owner apart from the main work.",
      "- To replace a failed Task, add a NEW Task whose id does not appear in current_plan and list the replaced ids in replaces. Tasks that depended on a replaced Task will depend on the Tasks that replace it.",
      "- Every root failed Task must be either retried or replaced. Do not include completed or cancelled Tasks, do not reuse their ids, and do not depend on cancelled Tasks.",
      "- Preserve or improve safe parallelism: make independent retried/replacement/new Tasks siblings without depends_on; keep a dependency only when the work requires another Task's result, files, or decision.",
      "- Return {\"tasks\": []} only when no root failed Task remains and nothing needs to be added (reopen, or a final check that judged the Work incomplete but the Owner says it is done).",
      "- Before adding or changing any acceptance criterion because of a rejection or failure, re-examine each criterion against the Work's purpose and the original Task's purpose, and do not add a criterion that does not serve them; do not copy review findings into criteria verbatim.",
      "- For every retried or replacement Task, write necessity and the acceptance_criteria fields again from the Work's request and the failure instead of copying them: drop criteria whose if_omitted you cannot state, and make heavy checks lighter before you keep them.",
      "- If work.owner_guidance is present, the Owner's answers take priority.",
    ].join("\n"),
    [
      "Open Tasks (only when context.owner_replan_kind is instruction, reopen, decision, work_update or auto_conflict):",
      "- The Owner's request can arrive while Tasks are still running or blocked. Core does not stop them; you decide for each open Task in current_plan (status waiting, ready, running, verifying, review_fix_waiting, paused or judgement_waiting).",
      "- Continue: leave it out of tasks and task_actions.",
      "- Replace: add a NEW Task and list the open Task's id in replaces; its Agent is stopped and Tasks that depended on it depend on the new Task.",
      "- Cancel: add {task_id, action: \"cancel\", reason} to task_actions. Every Task that stays must not depend on a cancelled Task: cancel or replace such dependents too.",
      "- Treat as done: add {task_id, action: \"complete\", reason} to task_actions when the Owner says the Task's result is not needed or already exists. Its Agent is stopped and its worktree is not merged.",
      "- Use [] for task_actions in every other replan.",
    ].join("\n"),
    [
      "Work title and summary (updated_title, updated_summary):",
      "- Set them only when context.owner_replan_kind is instruction, reopen, decision or auto_conflict and an Owner's request in context.owner_requests changes the Work's goal, scope or constraints. When context.owner_replan_kind is null or work_update, both are null.",
      "- Reflect only what the Owner's request changed; keep every other sentence of work.summary exactly as it is, in its original language and formatting. Return the whole revised text, not a diff.",
      "- When the request does not concern the title or the summary, leave that field null (null means unchanged). updated_title is 1-500 characters; updated_summary is at most 20,000 characters.",
    ].join("\n"),
    "context.failed_tasks gives, per root failed Task, why it failed (failure.kind with its fields: reason, question, work_done, verdict, merge_conflict_files; for verification_failed see verification_failure, for external_blocker see cause, summary, evidence and suggested_fix, for acceptance_defect see acceptance_defects, whose criterion_id points at an entry of acceptance_criteria), its last report (last_report, null if none) and the reviewer_findings or verification_failure of its latest attempt. Change what caused the failure; do not repeat the same plan.",
    "trigger says why the Manager is called, as fields only; each kind is explained below. initial_plan: plan the Work from the request. task_failed: trigger.tasks[] has one entry per Task that needs you, and its kind says why: launch_conflict (its worktree could not be set up because of merge conflicts in merge_conflict_files), verification_error (verification could not run; message is the error), failure_threshold (the Worker failed repeatedly; error_key, reason and question are the Worker's own), verification_exhausted (verification kept failing; see that Task's failure.verification_failure), reviewer_error (the Reviewer could not finish; message is the error), design_document_missing (the Task needs a design document that does not exist), review_budget_exhausted (attempts reached limit review rounds), reviewer_replan_requested (the Reviewer asked for a replan; summary is its own), review_exhausted (the Reviewer found defects and no review rounds remain), external_blocker (the Worker reported a pre-existing problem or an environment gap; cause is pre_existing or environment, details in that Task's failure), task_integration_failed (the Task passed after verification or review, but merging it into the Work branch work_branch failed: failure_kind merge_conflict with merge_conflict_files, or commit_failure; message is the error). queued_failed_tasks: Tasks failed earlier without a replan; retry or replace each. work_verification_failed: the integrated Work branch failed verification; context.work_verification has the failing command and output; when core_tests_failed is true, add fix Tasks only for the failing tests in work_verification.core_tests and do not redo completed Tasks. owner_request: the Owner (or Core, when automatic is true) asks for a change; owner_replan_kind is decision, reopen, instruction, work_update, auto_conflict or auto_final, and situation says what was open: failed_tasks (context.failed_tasks), base_merge_conflict (context.base_merge_conflict: add one Task that merges the latest base_branch into the Work in its worktree, resolves the conflict in files keeping both sides' intent, and commits; base_branch null means the Project base branch), final_incomplete (context.final_verdict), integration_verification (context.work_verification), other. design_completed: trigger.design_task_ids are the ids of the design Tasks that just completed; read the matching design documents in context.design_documents and add new implementation Tasks that depend on those design Tasks (this also applies to a Work with work.design_mode lead); do not redo completed Tasks. final_check: all Tasks completed; give the final verdict. When context.previous_output_feedback is not null, your previous replan was rejected or needs repair: fix the problems it lists (errors, warnings; kind fields_missing means return the same replan with only those fields fixed). context.owner_requests lists the Owner's requests to act on, oldest first; each entry's text is the Owner's own words, kept whole (kind decision, reopen or instruction), or {kind: work_update, changed_fields, previous_title, previous_summary} when the Owner rewrote work.title or work.summary (the new values are in work; [] if none). context.worker_questions holds the Workers' questions to answer, one {task_id, question} each ([] if none). context.final_verdict holds the final check's summary and missing items when this replan follows an incomplete final check (null otherwise). context.rules holds the rules every plan must follow (null if none).",
    "context.work_verification is set when the Project's checks failed on the Work branch with every Task merged (failed_command_id and the output of each command); add or change Tasks so that the failing command passes (null otherwise).",
  ],
};

const ACCEPTANCE_GUIDANCE =
  "Write acceptance criteria a Reviewer can check in one pass. When a criterion covers every occurrence of something (\"all\", \"every\", \"each\"), name its concrete scope: the directories or files, the identifiers, event types or UI surfaces it includes, and what it excludes, such as historical data or tests. Make the acceptance criteria require the build and the tests related to what the Task changes, and name those specific tests or checks. Do not require the whole test suite to pass, and do not plan a Task (such as a final finishing Task) whose job is to run it: Core runs the whole suite on the integrated Work branch and re-checks the failed and related tests after a fix, and do not require comparing failures with the base branch (main) or checking whether a test also fails there. Plan a Task to fix an already failing test only when the Work asks for it; the Reviewer sends such failures to the backlog. A test that this same Work's changes broke (for example a test still asserting behavior an earlier Task changed on purpose) is not an already failing test: have the Task that finds it fix or update that test in the same Task, and do not defer it to the backlog or to a later Task. Do not put report-format requirements in acceptance criteria, such as \"state X in the report\", \"paste the command output verbatim\" or \"list Y in the report\"; write criteria about the deliverable's behavior and about verification that can be run and checked (tests, commands, file state). Write each criterion as what must work correctly (behavior and result). Do not make the verification procedure, the way to prove it, or the details of the scripts to use into a criterion unless the Owner explicitly specified them.";

const NECESSITY_GUIDANCE =
  "Plan only what the Work needs. Every Task and every acceptance criterion must serve a part of the Owner's request; a Task, criterion, test or check whose absence would harm nothing does not belong in the plan. Give every Task a necessity: serves (the part of the request it serves) and if_omitted (what goes wrong for the request without it). Give every acceptance criterion its own fields in acceptance_criteria: id (AC1, AC2, ... in array order), text (what must be true), check (how to check it, runnable inside the Task), serves, if_omitted, check_weight, weight_reason and kind. Set each criterion's kind: spec_test only when the criterion asks to add or change a test that pins the specification; otherwise work_check. Core deletes test files added by any Task with no spec_test criterion, test-type Tasks included. Choose the lightest check that proves each criterion: a small sample, a stub provider, a temporary copy with a few items. Use check_weight heavy (real model or paid API calls, production-size data or copies of it, every item of a large set, runs of about ten minutes or more) only when no lighter check can prove what the request needs, and then give the reason in weight_reason; otherwise weight_reason is an empty string. Core reads these fields as they are, so put each fact in its own field; an output with missing fields is returned to you to fix the format only. Core rejects heavy checks without a reason.";

const DESIGN_TASK_GUIDANCE: readonly string[] = [
  "Use type design for a Task whose deliverable is a design: architecture, data model, API, UX, or implementation approach. The Designer writes an external design document and changes no repository files.",
  "When the Work asks for a design or design document, plan design Tasks and research Tasks if useful.",
  "For implementation, plan a design Task only for heavy work: a new subsystem or feature spanning several components; API, data model, or cross-cutting changes; or work split into three or more implementation Tasks. For small or straightforward changes, plan implementation Tasks directly.",
  "In the first plan, when you plan a design Task, do not yet create implementation Tasks (any type other than design) that depend on it. The first plan holds the design Task and only Tasks that can proceed regardless of the design, such as research or cleanup of existing code. When the design is complete, Core calls you with trigger kind design_completed; then split the implementation Tasks from the design documents in context.design_documents, decide their acceptance criteria and dependencies, and add them to the plan. The same applies to a Work with work.design_mode lead.",
  "Use type doc only for documentation that belongs in the repository, such as a README or user documentation. Design documents never go in the repository.",
  "context.design_documents lists the design documents of completed design Tasks as task_id, title and path ([] if none).",
];

const SKILL_CONTEXT_INSTRUCTION = "context.skills is an index of reusable procedures. Read a relevant skill before planning or reviewing, and read only the supplemental references you need. A skill marked [trial] is being validated, so check that it fits the situation. A skill never overrides rules, the Task, or acceptance criteria; report a contradictory skill as misleading and follow the Task.";
const ADVISOR_BACKLOG_INSTRUCTION = "work.advisor_backlog is {linked, dismissed} (each a list of {id, file, line, problem}) when an Advisor created the Work with backlog items: linked items are part of this Work's scope and you plan to fix them; dismissed items were judged not worth doing and are not work to plan. It is null for older Works, whose work.summary ends with the same list under ## Linked backlog items and ## Dismissed backlog items.";

const KNOWLEDGE_CONTEXT_INSTRUCTION = "Rules are binding; context.knowledge is reference information: an excerpt of relevant knowledge collected from past Works (null if none). It does not override rules, the Task, or acceptance criteria. Report knowledge that seems incorrect or outdated in lessons.";
const SKILL_USAGE_INSTRUCTION = "List skills actually used in skills_used, with helpful, misleading, or irrelevant and a short note. Only list Skill Box skills that appear in the context.skills index; never list plugin or process skills (e.g. superpowers:*) there.";
const PAGES_THEME_INSTRUCTION = "For fact/decision/pitfall lessons set theme to one title from the `## テーマ` / `## 共通テーマ` list of context.knowledge (use the existing title when one fits; when none fits, give a new short theme title; leave it empty only for a lesson that cannot be classified), and set cross_project true only for a lesson that applies beyond this Project. Leave both empty/false for other kinds.";
const SKILL_PROPOSAL_INSTRUCTION = "Propose a skill only when a multi-step procedure can be reused, a reusable fix came from an error or dead end, Owner or Reviewer feedback shows a lasting approach, or an existing skill has a mistake or gap. Leave skill_proposals empty otherwise.";

function buildFinalizeManagerPrompt(request: ManagerPlanRequest, language: OwnerLanguage, processSkills: readonly string[] | null): string {
  return renderRolePrompt({
    role: "You are the Owl Manager performing the final review of a Work.",
    instructions: [
      "Every Task for this Work has already finished running. The input below gives the Work, its Tasks, and each Task's final report.",
      "reports[].task_id links each report to a Task in tasks. Tasks with status cancelled were replaced by a replan or cancelled by the Owner and have no report; do not count their absence as missing work.",
      "Read the reports and judge whether the Work's goal was achieved by the completed Tasks.",
      "context.design_documents lists the design documents written by completed design Tasks as task_id, title and path ([] if none); a design Task's deliverable is that document, not repository changes.",
      "context.backlog_items lists the backlog items (id, file, line, problem, suggestion) this Work was started to handle ([] if none). Put in unaddressed_backlog_items (item_id and reason) every item the completed Tasks did not actually address; those items return to the backlog. Use only ids from context.backlog_items; every other item is treated as done. This does not affect verdict.",
      "context.work_verification is the result of the Project's checks run on the Work branch with every Task merged (status, commands, failed_command_id). Do not judge the Work complete unless status is passed; when status is not_applicable, judge from the Task reports.",
      SKILL_CONTEXT_INSTRUCTION,
      KNOWLEDGE_CONTEXT_INSTRUCTION,
      ADVISOR_BACKLOG_INSTRUCTION,
      SKILL_USAGE_INSTRUCTION,
      SKILL_PROPOSAL_INSTRUCTION,
      "Include in lessons only insights reusable in future Works. Exclude one-off circumstances, facts unique to this Work, and points that can be readily derived again.",
      "Use kind=procedure with procedure text for reusable steps. Use fact/decision/pitfall with topic for durable facts, reasoned decisions, and failure patterns. Use rule_candidate with rule_text/rule_scope only for short binding instructions; a rule_candidate becomes a rule only after Owner approval. Write rule_text in general wording that applies to any Project and Work: never put file names, paths, Project names, Task numbers (T3) or Work numbers (#12) in it. If the lesson cannot be stated without them, use pitfall or decision instead of rule_candidate.",
      ...(request.memory_mode === "pages" ? [PAGES_THEME_INSTRUCTION] : []),
    ],
    processSkills,
    output: managerOutputSchema(request),
    outputRules: ["missing is [] exactly when verdict is complete.", "Every item_id in unaddressed_backlog_items is an id from context.backlog_items."],
    language,
    inputs: [{ name: "Manager input", value: managerPromptInput({ ...request, mode: "finalize" }) }],
  });
}

export function buildManagerPrompt(
  request: ManagerPlanRequest,
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
): string {
  const mode = request.mode ?? "plan";
  if (mode === "finalize") {
    return buildFinalizeManagerPrompt(request, language, processSkills);
  }
  return renderRolePrompt({
    role: "You are the Owl Manager.",
    instructions: [...MODE_INSTRUCTIONS[mode], TEST_PLACEMENT_GUIDANCE, SMALL_TASK_BATCHING_GUIDANCE, ACCEPTANCE_GUIDANCE, NECESSITY_GUIDANCE, ...DESIGN_TASK_GUIDANCE, SKILL_CONTEXT_INSTRUCTION, KNOWLEDGE_CONTEXT_INSTRUCTION, ADVISOR_BACKLOG_INSTRUCTION, SKILL_USAGE_INSTRUCTION],
    processSkills,
    output: managerOutputSchema({ mode }),
    outputRules: [],
    language,
    inputs: [{ name: "Manager input", value: managerPromptInput({ ...request, mode }) }],
  });
}

/** Validate the Manager's JSON object strictly against the schema for its mode. */
export function parseManagerPlan(
  payload: Record<string, unknown>,
  request: ManagerPlanRequest,
): ManagerPlanResult {
  return parseManagerPlanWithFeedback(payload, request).result;
}

/** The schema accepts whitespace-only text; a Task necessity with a blank field is a format error. */
function blankNecessity(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return ["serves", "if_omitted"].find((key) => typeof value[key] !== "string" || value[key].trim() === "") ? "necessity:blank" : null;
}

/** The schema cannot express "required for this kind": a procedure needs its steps and a rule candidate its rule text. */
function blankLessonField(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const blank = (lesson: Record<string, unknown>, key: string) => typeof lesson[key] !== "string" || lesson[key].trim() === "";
  for (const lesson of value) {
    if (!isRecord(lesson)) continue;
    if (lesson.kind === "procedure" && blank(lesson, "procedure")) return "lessons:procedure:blank";
    if (lesson.kind === "rule_candidate" && blank(lesson, "rule_text")) return "lessons:rule_text:blank";
  }
  return null;
}

export function parseManagerPlanWithFeedback(
  payload: Record<string, unknown>,
  request: ManagerPlanRequest,
): { readonly result: ManagerPlan; readonly skill_feedback: import("@owl/shared").SkillFeedback | null } {
  const schema = managerOutputSchema(request);
  const prepared = prepareLegacySkillOutput(schema, payload);
  payload = prepared.payload;
  // Verdicts from before backlog items were tied to Works lack the field; malformed entries are ignored.
  if (request.mode === "finalize" && isRecord(payload.verdict)) {
    const raw = payload.verdict.unaddressed_backlog_items;
    const items = raw === undefined ? [] : Array.isArray(raw)
      ? raw.filter((entry) => isRecord(entry) && typeof entry.item_id === "string" && entry.item_id !== "" && typeof entry.reason === "string")
      : raw;
    payload = { ...payload, verdict: { ...payload.verdict, unaddressed_backlog_items: items } };
  }
  if (request.mode === "finalize" && request.memory_mode === "pages" && isRecord(payload.verdict) && Array.isArray(payload.verdict.lessons)) {
    // theme and cross_project are optional for the model; absent means no theme and not cross-project.
    const lessons = payload.verdict.lessons.map((lesson) =>
      isRecord(lesson) ? { ...lesson, theme: lesson.theme ?? "", cross_project: lesson.cross_project ?? false } : lesson);
    payload = { ...payload, verdict: { ...payload.verdict, lessons } };
  }
  if ((request.mode === "plan" || request.mode === "replan") && Array.isArray(payload.tasks)) {
  }
  if (request.mode === "replan") {
    // Answers from before the title/summary fields lack them; absent means unchanged.
    payload = { ...payload, updated_title: payload.updated_title ?? null, updated_summary: payload.updated_summary ?? null, task_actions: payload.task_actions ?? [] };
  }
  const problem = validateRoleOutput(schema, payload)
    // The schema cannot express the id sequence or "heavy needs a reason"; a violation is a format error, not a reason to redo the plan.
    ?? ((request.mode === "plan" || request.mode === "replan") && Array.isArray(payload.tasks)
      ? payload.tasks.map((task) => validateAcceptanceCriteria((task as Record<string, unknown>).acceptance_criteria) ?? blankNecessity((task as Record<string, unknown>).necessity)).find((message) => message !== null) ?? null
      : request.mode === "finalize" && isRecord(payload.verdict) ? blankLessonField(payload.verdict.lessons) : null);
  if (problem) {
    throw managerPlanInvalid(`manager_output_schema:${problem}`);
  }
  if (request.mode === "replan") {
    if (typeof payload.updated_title === "string" && payload.updated_title.length > WORK_TITLE_MAX_LENGTH) {
      throw managerPlanInvalid("manager_output_schema:updated_title:too_long");
    }
    if (typeof payload.updated_summary === "string" && payload.updated_summary.length > WORK_SUMMARY_MAX_LENGTH) {
      throw managerPlanInvalid("manager_output_schema:updated_summary:too_long");
    }
  }
  const skill_feedback = skillFeedbackFromOutput(payload, prepared.hasSkillFields);
  const { skills_used: _skillsUsed, skill_proposals: _skillProposals, ...managerPayload } = payload;
  if (request.mode === "finalize") {
    // Finalization controls the Work terminal state. A missing or malformed
    // verdict is a provider protocol failure, never an implicit incomplete
    // verdict that hides the cause from the operator.
    const verdict = managerPayload.verdict as unknown as ManagerVerdict;
    // The one check of the rule "missing is [] exactly when verdict is
    // complete" (the schema cannot express it).
    if ((verdict.verdict === "complete") !== (verdict.missing.length === 0)) {
      throw managerPlanInvalid("manager_output_schema:verdict.missing:inconsistent_with_verdict");
    }
    return { result: { tasks: request.tasks ?? [], event: null, verdict }, skill_feedback };
  }
  const tasks = (managerPayload.tasks as readonly Record<string, unknown>[]).map(taskFromOutput);
  // The event follows the requested mode; the schema has no event field.
  return {
    result: {
      tasks,
      event: request.mode === "replan" ? "task.replanned" : "work.planned",
      verdict: null,
      ...(request.mode === "replan"
        ? {
          updated_title: managerPayload.updated_title as string | null,
          updated_summary: managerPayload.updated_summary as string | null,
          task_actions: managerPayload.task_actions as ManagerPlanResult["task_actions"],
        }
        : {}),
    },
    skill_feedback,
  };
}

export function asManagerRequest(
  input: ManagerPlanRequest | WorkContext,
): ManagerPlanRequest {
  if (isRecord(input) && isRecord(input.work)) {
    const request = input as unknown as ManagerPlanRequest;
    return { ...request, context: managerAdditionalContext(isRecord(request.context) ? request.context : {}) };
  }
  return { work: input as WorkContext };
}

function managerAdditionalContext(value: Record<string, unknown>): Readonly<Record<string, unknown>> | undefined {
  const excluded = new Set(["mode", "work", "work_id", "tasks", "reports", "notes", "trigger"]);
  const entries = Object.entries(value).filter(([key]) => !excluded.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
