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
import { DEFAULT_OWNER_LANGUAGE, type OwnerLanguage } from "@owl/shared";
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
  acceptance: { type: "string", minLength: 1, description: "checkable success criteria the Worker must meet; a criterion over every occurrence names its concrete scope" },
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
  replaces: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "ids of failed Tasks in current_plan that this NEW Task replaces; [] for a retried Task or a Task that replaces nothing",
  },
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
export const MANAGER_REPLAN_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  tasks: {
    type: "array",
    items: MANAGER_TASK_SCHEMA,
    description: "Tasks to retry or add; [] when nothing is missing and no failed Task remains",
  },
  skills_used: SKILLS_USED_SCHEMA,
});

/** Manager output for mode "finalize". */
export const MANAGER_FINALIZE_OUTPUT_SCHEMA: RoleSchema = objectSchema({
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
        rule_text: { type: "string", description: "one-line imperative rule of at most 300 characters for rule_candidate; otherwise empty" },
        rule_scope: {
          type: "string",
          enum: ["all", "manager", "designer", "worker", "reviewer", "advisor"],
          description: "scope for rule_candidate; all other lesson kinds use all",
        },
      }),
      example: [],
      description: "lessons learned for future Work; may be []",
    },
  }),
});

export function managerOutputSchema(request: Pick<ManagerPlanRequest, "mode">): RoleSchema {
  return request.mode === "finalize"
    ? MANAGER_FINALIZE_OUTPUT_SCHEMA
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
    reason: request.reason ?? null,
    context: {
      start_mode: typeof context.start_mode === "string" ? context.start_mode : null,
      failed_task_ids: Array.isArray(context.failed_task_ids) ? context.failed_task_ids : [],
      current_plan: Array.isArray(context.current_plan) ? context.current_plan : [],
      question: typeof context.question === "string" ? context.question : null,
      failed_tasks: Array.isArray(context.failed_tasks) ? context.failed_tasks : [],
      final_verdict: isRecord(context.final_verdict) ? context.final_verdict : null,
      rules: typeof context.rules === "string" ? context.rules : null,
      knowledge: typeof context.knowledge === "string" ? context.knowledge : null,
      skills: typeof context.skills === "string" ? context.skills : null,
      design_documents: Array.isArray(context.design_documents) ? context.design_documents : [],
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
    review_round: number;
    failure_count: number;
    worker_generation: number;
    depends_on: readonly string[];
    context?: string;
    review?: boolean;
    notes?: string;
    replaces: readonly string[];
  } = {
    id: value.id as string,
    work_id: "",
    title: value.title as string,
    status: "ready",
    type: value.type as string,
    state_version: 0,
    updated_at: new Date().toISOString(),
    parent_task_id: null,
    acceptance: value.acceptance as string,
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
  return task;
}

const MODE_INSTRUCTIONS: Readonly<Record<"plan" | "replan", readonly string[]>> = {
  plan: [
    "Plan the Work in the input below as Tasks. The Worker runs every Task except type design Tasks, which the Designer runs. Give each Task a unique id, and use depends_on to order Tasks that need earlier results. Every Task's replaces is [] in a plan.",
    "Maximize safe parallelism across the Work: put substantial independent outcomes in sibling Tasks with no depends_on, and add a dependency only when a Task needs another Task's output, files, or decision. Each Worker can also split its assigned Task into independent subagent parts and launch those subagents concurrently; treat those subagents as leaf workers. Within one logical component Task, Hybrid Mode can split independent implementation parts into concurrent Executor subtasks. Do not serialize independent work just to impose an order.",
    "If work.owner_guidance is present, the Owner's answers take priority.",
    "reason is null unless your previous plan was rejected; then it starts with \"Your previous plan was rejected\" and lists the problems to fix. context.rules holds the rules every plan must follow (null if none).",
  ],
  replan: [
    "This is a REPLAN. \"tasks\" lists the root failed Tasks (may be empty). context.current_plan lists every Task in the Work with id, manager_task_id, status, depends_on and failed_by_dependency (true = it failed only because a dependency failed; do not retry or replace it, it resumes on its own).",
    [
      "Replan protocol:",
      "- To retry a failed Task, include it with its existing id and replaces: [] (you may revise title, acceptance, context, type and review). Its depends_on replaces the Task's current dependencies: copy them from current_plan to keep them, or change them (existing Task ids or ids of new Tasks in this replan; not itself and not a cancelled Task).",
      "- To replace a failed Task, add a NEW Task whose id does not appear in current_plan and list the replaced ids in replaces. Tasks that depended on a replaced Task will depend on the Tasks that replace it.",
      "- Every root failed Task must be either retried or replaced. Do not include completed or cancelled Tasks, do not reuse their ids, and do not depend on cancelled Tasks.",
      "- Preserve or improve safe parallelism: make independent retried/replacement/new Tasks siblings without depends_on; keep a dependency only when the work requires another Task's result, files, or decision.",
      "- Return {\"tasks\": []} only when no root failed Task remains and nothing needs to be added (reopen, or a final check that judged the Work incomplete but the Owner says it is done).",
      "- If work.owner_guidance is present, the Owner's answers take priority.",
    ].join("\n"),
    "context.failed_tasks gives, per root failed Task, why it failed (failure.kind, failure.detail), its last report (last_report, null if none) and the reviewer_findings or verification_failure of its latest attempt. Change what caused the failure; do not repeat the same plan.",
    "reason says why the replan was requested; when it starts with \"Your previous replan was rejected\", fix the listed problems. context.question holds the Owner's answer or the reopen request to act on (null if none). context.final_verdict holds the final check's summary and missing items when this replan follows an incomplete final check (null otherwise). context.rules holds the rules every plan must follow (null if none).",
  ],
};

const ACCEPTANCE_GUIDANCE =
  "Write acceptance criteria a Reviewer can check in one pass. When a criterion covers every occurrence of something (\"all\", \"every\", \"each\"), name its concrete scope: the directories or files, the identifiers, event types or UI surfaces it includes, and what it excludes, such as historical data or tests.";

const DESIGN_TASK_GUIDANCE: readonly string[] = [
  "Use type design for a Task whose deliverable is a design: architecture, data model, API, UX, or implementation approach. The Designer writes an external design document and changes no repository files.",
  "When the Work asks for a design or design document, plan design Tasks and research Tasks if useful.",
  "For implementation, plan one design Task first and make implementation Tasks depend on it only for heavy work: a new subsystem or feature spanning several components; API, data model, or cross-cutting changes; or work split into three or more implementation Tasks. For small or straightforward changes, plan implementation Tasks directly.",
  "Use type doc only for documentation that belongs in the repository, such as a README or user documentation. Design documents never go in the repository.",
  "context.design_documents lists the design documents of completed design Tasks as task_id, title and path ([] if none).",
];

const SKILL_CONTEXT_INSTRUCTION = "context.skills is an index of reusable procedures. Read a relevant skill before planning or reviewing, and read only the supplemental references you need. A skill marked [trial] is being validated, so check that it fits the situation. A skill never overrides rules, the Task, or acceptance criteria; report a contradictory skill as misleading and follow the Task.";
const KNOWLEDGE_CONTEXT_INSTRUCTION = "Rules are binding; context.knowledge is reference information: an excerpt of relevant knowledge collected from past Works (null if none). It does not override rules, the Task, or acceptance criteria. Report knowledge that seems incorrect or outdated in lessons.";
const SKILL_USAGE_INSTRUCTION = "List skills actually used in skills_used, with helpful, misleading, or irrelevant and a short note.";
const SKILL_PROPOSAL_INSTRUCTION = "Propose a skill only when a multi-step procedure can be reused, a reusable fix came from an error or dead end, Owner or Reviewer feedback shows a lasting approach, or an existing skill has a mistake or gap. Leave skill_proposals empty otherwise.";

function buildFinalizeManagerPrompt(request: ManagerPlanRequest, language: OwnerLanguage, processSkills: readonly string[] | null): string {
  return renderRolePrompt({
    role: "You are the Owl Manager performing the final review of a Work.",
    instructions: [
      "Every Task for this Work has already finished running. The input below gives the Work, its Tasks, and each Task's final report.",
      "reports[].task_id links each report to a Task in tasks. Tasks with status cancelled were replaced by a replan or cancelled by the Owner and have no report; do not count their absence as missing work.",
      "Read the reports and judge whether the Work's goal was achieved by the completed Tasks.",
      "context.design_documents lists the design documents written by completed design Tasks as task_id, title and path ([] if none); a design Task's deliverable is that document, not repository changes.",
      SKILL_CONTEXT_INSTRUCTION,
      KNOWLEDGE_CONTEXT_INSTRUCTION,
      SKILL_USAGE_INSTRUCTION,
      SKILL_PROPOSAL_INSTRUCTION,
      "Include in lessons only insights reusable in future Works. Exclude one-off circumstances, facts unique to this Work, and points that can be readily derived again.",
      "Use kind=procedure with procedure text for reusable steps. Use fact/decision/pitfall with topic for durable facts, reasoned decisions, and failure patterns. Use rule_candidate with rule_text/rule_scope only for short binding instructions; a rule_candidate becomes a rule only after Owner approval.",
    ],
    processSkills,
    output: MANAGER_FINALIZE_OUTPUT_SCHEMA,
    outputRules: ["missing is [] exactly when verdict is complete."],
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
    instructions: [...MODE_INSTRUCTIONS[mode], ACCEPTANCE_GUIDANCE, ...DESIGN_TASK_GUIDANCE, SKILL_CONTEXT_INSTRUCTION, KNOWLEDGE_CONTEXT_INSTRUCTION, SKILL_USAGE_INSTRUCTION],
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

export function parseManagerPlanWithFeedback(
  payload: Record<string, unknown>,
  request: ManagerPlanRequest,
): { readonly result: ManagerPlanResult; readonly skill_feedback: import("@owl/shared").SkillFeedback | null } {
  const schema = managerOutputSchema(request);
  const prepared = prepareLegacySkillOutput(schema, payload);
  payload = prepared.payload;
  const problem = validateRoleOutput(schema, payload);
  if (problem) {
    throw managerPlanInvalid(`manager_output_schema:${problem}`);
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
    result: { tasks, event: request.mode === "replan" ? "task.replanned" : "work.planned", verdict: null },
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
  const excluded = new Set(["mode", "work", "work_id", "tasks", "reports", "notes", "reason"]);
  const entries = Object.entries(value).filter(([key]) => !excluded.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
