import { extractReportPayload, isRecord, validateReportEnvelope } from "./protocol";
import { AgentRuntimeError, providerFailed, reportInvalid } from "./errors";
import type { ExecutorResult } from "@owl/shared";
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
  type RoleSchema,
} from "./role-contract";
import { DEFAULT_OWNER_LANGUAGE, MINIMAL_CODE_RULES, WORKER_SUBAGENT_RULES, type OwnerLanguage } from "@owl/shared";
import {
  type ExecutorSubtaskPlan,
  type HybridWorkerReport,
  type ProviderResponse,
  type ReportEnvelope,
  type WorkerRequest,
} from "./types";

/** The Worker report fields shared by the normal and Hybrid verdict outputs. */
const WORKER_REPORT_PROPERTIES: Readonly<Record<string, RoleSchema>> = {
  kind: { type: "string", enum: ["report"] },
  schema_version: { type: "string", enum: ["1.0.0"] },
  invocation_id: { type: "string", minLength: 1, description: "will be filled" },
  result: { type: "string", enum: ["success", "partial", "failed"], description: "see the result rules below" },
  work_done: {
    type: "string",
    description: "at most 3 short bullet lines describing the key action and outcome; do not narrate every step",
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
    passed: { type: "boolean", example: true, description: "see the verification rule below" },
    method: {
      type: "string",
      description: "one short sentence naming the checks and result, or why it could not be checked; no command output",
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
};

/** Normal Worker output. */
export const WORKER_REPORT_SCHEMA: RoleSchema = objectSchema(WORKER_REPORT_PROPERTIES);

/** Hybrid Mode phase 2 output: the Worker report plus the Team Leader verdict. */
export const HYBRID_REPORT_SCHEMA: RoleSchema = objectSchema({
  ...WORKER_REPORT_PROPERTIES,
  verdict: {
    type: "string",
    enum: ["ok", "retry", "needs_replanning"],
    description: "ok, retry, or needs_replanning per the review instructions",
  },
  retry_subtasks: {
    type: "array",
    items: objectSchema({
      subtask_id: { type: "string", minLength: 1, description: "id of the subtask to retry" },
      instruction: { type: "string", minLength: 1, description: "self-contained instruction for the retry" },
    }),
    example: [],
    description: "subtasks to retry; [] unless verdict is retry, at least one entry when verdict is retry",
  },
});

/** Hybrid Mode phase 1 output: the subtask plan. */
export const HYBRID_PLAN_SCHEMA: RoleSchema = objectSchema({
  subtasks: {
    type: "array",
    minItems: 1,
    items: objectSchema({
      subtask_id: { type: "string", minLength: 1, example: "s1", description: "short, stable subtask id such as s1" },
      title: {
        type: "string",
        minLength: 1,
        description: "what this subtask does in a few words, shown to the user (no rules or boilerplate)",
      },
      instruction: { type: "string", minLength: 1, description: "self-contained instruction for this subtask" },
      write_paths: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1, description: "workspace-relative file or directory" },
        example: ["src/component.ts"],
        description: "workspace-relative files or directories this subtask may edit; use [\"*\"] if scope is broad or uncertain",
      },
    }),
    description: "independent subtasks that Core runs concurrently when their write_paths do not overlap; at least one",
  },
});

/** Provider-enforced JSON Schema for Hybrid planning output. */
export const HYBRID_PLAN_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = providerSchema(HYBRID_PLAN_SCHEMA);

/**
 * The fixed Worker input for every mode: the same keys every time, with null
 * or [] when Core did not supply a value. The worktree is the process cwd,
 * not prompt content.
 */
export function workerPromptInput(request: WorkerRequest): Record<string, unknown> {
  const context = request.context ?? {};
  return {
    task: request.task,
    context: {
      rules: context.rules ?? null,
      knowledge: context.knowledge ?? null,
      skills: context.skills ?? null,
      dependency_reports: context.dependency_reports ?? [],
      artifact_paths: context.artifact_paths ?? [],
      verification_failure: context.verification_failure ?? null,
      previous_report: context.previous_report ?? null,
      reviewer_findings: context.reviewer_findings ?? [],
      owner_guidance: context.owner_guidance ?? [],
      retry_subtasks: context.retry_subtasks ?? [],
    },
  };
}

const WORKER_CONTEXT_INSTRUCTIONS: readonly string[] = [
  "context.rules holds the rules you must follow (null if none). context.dependency_reports lists, per completed Task this one depends on, what it did (work_done), the files it changed (changes) and what it left open (remaining_issues); context.artifact_paths lists their recorded artifact paths. Build on them; do not redo their work. When an entry has a design_document_path, read that design document and follow it.",
  "Rules are binding; context.knowledge is reference information: an excerpt of relevant knowledge collected from past Works (null if none). It does not override rules, the Task, or acceptance criteria. Report knowledge that seems incorrect or outdated in remaining_issues.",
  "context.skills is an index of reusable procedures. Read a relevant skill before working, and read only the supplemental references you need. A skill marked [trial] is being validated, so check that it fits the situation. A skill never overrides rules, the Task, or acceptance criteria; report a contradictory skill as misleading and follow the Task.",
  "If context.verification_failure is non-null, the previous attempt failed Core verification: read source, commands and error and fix the cause. If context.reviewer_findings is non-empty, it contains only major findings and every one must be fixed; address all of them. Minor findings are not passed to the Worker. Only one of the two describes the latest attempt; context.previous_report is that attempt's report (null if none).",
  "If context.owner_guidance is non-empty, the Owner answered earlier Decisions for this Work (newest first). Follow that guidance.",
];

const SKILL_FEEDBACK_INSTRUCTION =
"List each skill you actually used in skills_used, with helpful, misleading, or irrelevant and a short note. Propose a skill only when you solved a multi-step procedure that can be reused, found a reusable fix after an error or dead end, learned a lasting approach from Owner or Reviewer feedback, or found a mistake or gap in an existing skill. Leave skill_proposals empty otherwise.";

const RESULT_RULES: readonly string[] = [
  "Fill in result using these exact rules (do not guess or hedge):",
  "- \"success\": the task's work was completed as assigned (files/changes created or modified as requested). Use \"success\" even if you also did extra verification, even if the task was simple, and even if you are not 100% certain every edge case is covered. Completing the assigned work is success.",
  "- \"partial\": use ONLY when the task was genuinely interrupted or cut short (for example: you ran out of time/turns, a required resource was unavailable partway through, or you could only finish some of several explicitly requested changes and consciously left the rest undone). Do not use \"partial\" just to hedge or express uncertainty about quality.",
  "- \"failed\": use ONLY when the task could not be done at all (for example: the requested change is impossible, a hard blocker prevented any progress, or you made no meaningful progress).",
  "If the files/changes described in the task were actually created or applied, result MUST be \"success\", not \"partial\".",
  "verification.passed: set to true if you completed the primary work (files were created/modified as requested, or the change was applied). Set to false ONLY if the work itself failed or produced incorrect output. Do NOT set to false just because you could not run an execution test, could not get approval to run a command, or lack full confidence — those are normal. If the files exist with the expected content, passed is true.",
];

export function buildWorkerPrompt(
  request: WorkerRequest,
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
): string {
  return renderRolePrompt({
    role: "You are the Owl Worker. Perform the assigned task.",
    instructions: [
      "Keep the final report concise and scannable: write work_done as at most 3 short bullet lines describing the key action and outcome. Put each changed path and its concise change in changes. Keep verification.method to one short sentence naming the checks and their result. Do not narrate every acceptance criterion or paste raw command logs, full diffs, or full tool output.",
      ...WORKER_SUBAGENT_RULES,
      ...MINIMAL_CODE_RULES,
      ...WORKER_CONTEXT_INSTRUCTIONS,
      "If context.retry_subtasks is non-empty, an earlier attempt completed everything except the listed parts. Do only those parts and do not redo work that already succeeded.",
      SKILL_FEEDBACK_INSTRUCTION,
    ],
    processSkills,
    output: WORKER_REPORT_SCHEMA,
    outputRules: RESULT_RULES,
    language,
    inputs: [{ name: "Task", value: workerPromptInput(request) }],
  });
}

/** Designer input mirrors the Worker context and adds its external document destination. */
export function designerPromptInput(request: WorkerRequest): Record<string, unknown> {
  const workerInput = workerPromptInput(request);
  const context = workerInput.context as Record<string, unknown>;
  return {
    ...workerInput,
    context: {
      ...context,
      design_document_path: request.context?.design_document_path ?? null,
      design_tier: request.context?.design_tier ?? "standard",
    },
  };
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
      "Write the design as Markdown to context.design_document_path, the absolute path provided in the input, and overwrite the document on a retry.",
      "Do not modify any file in the repository working tree, do not commit, and do not create branches.",
      "The document must let an implementer proceed without asking: state the goal and constraints; the chosen approach and why; components and their interfaces; data and API changes; error handling; the test strategy; and an ordered implementation breakdown.",
      "In changes, list the design document using its absolute path and action created or modified. In verification.method, state that the document was written and self-reviewed against the Task's acceptance criteria.",
      "Use needs_replanning and question_for_manager exactly as the Worker does: set needs_replanning only when the Task itself needs a new plan, and set question_for_manager to null unless the Manager must resolve a blocker.",
      ...WORKER_CONTEXT_INSTRUCTIONS,
      "context.retry_subtasks is shared with the Worker input and is always empty for the Designer, whose runs are never split into subtasks; ignore it.",
      SKILL_FEEDBACK_INSTRUCTION,
    ],
    processSkills,
    output: WORKER_REPORT_SCHEMA,
    outputRules: RESULT_RULES,
    language,
    inputs: [{ name: "Task", value: designerPromptInput(request) }],
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

export function normalizeWorkerResponse(
  response: ProviderResponse,
  invocationId: string,
): ReportEnvelope {
  return normalizeWorkerResponseWithFeedback(response, invocationId).report;
}

export function normalizeWorkerResponseWithFeedback(
  response: ProviderResponse,
  invocationId: string,
): { readonly report: ReportEnvelope; readonly skill_feedback: import("@owl/shared").SkillFeedback | null } {
  try {
    const rawPayload = extractWorkerPayload(response, invocationId);
    // The prompt shows a placeholder ("<will be filled>") for invocation_id
    // because the model cannot know it; the runtime's own invocation id is
    // authoritative and is substituted before the schema is checked, so the
    // placeholder in that one field is never itself a validation failure.
    const suppliedPayload = invocationId ? { ...rawPayload, invocation_id: invocationId } : rawPayload;
    const prepared = prepareLegacySkillOutput(WORKER_REPORT_SCHEMA, suppliedPayload);
    const payload = prepared.payload;
    const problem = validateRoleOutput(WORKER_REPORT_SCHEMA, payload);
    if (problem) throw reportInvalid(`worker_output_schema:${problem}`);
    const { skills_used: _skillsUsed, skill_proposals: _skillProposals, ...reportPayload } = payload;
    return {
      report: validateReportEnvelope(reportPayload),
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

/**
 * Hybrid Mode (Worker=Team Leader) phase 1 prompt.
 * The Worker does NOT implement the Task itself here; it only decomposes it
 * into independent subtasks that will each be dispatched to a real,
 * separate Executor CLI subprocess (claude/codex) by the caller. The Worker
 * must return only the subtask plan - no report, no verdict.
 */
export function buildHybridPlanPrompt(
  request: WorkerRequest,
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
): string {
  return renderRolePrompt({
    role: "You are the Owl Worker, acting as a TEAM LEADER for this Task (Hybrid Mode, phase 1: planning).",
    instructions: [
      "Decompose the assigned Task into a small number of bounded, independent subtasks so Core can run them concurrently in the same Task workspace. This is the point of Hybrid Mode: split one component into parallel parts when their edits can be scoped separately. Do not serialize independent work or put it in separate Manager Tasks just to avoid using Hybrid Mode.",
      "Each subtask is dispatched to a SEPARATE Executor subprocess (a real claude/codex CLI instance). For each subtask, declare write_paths as the exact workspace-relative files/directories it may edit. Prefer disjoint scopes so Executors run at the same time; Core will sequence only subtasks whose declared paths overlap. Use [\"*\"] only when the scope is genuinely broad or uncertain. Do not give independent Executors overlapping write_paths.",
      "Subtasks must not depend on another subtask's output, decision, or in-progress edits. If steps depend on each other, combine them into one subtask. Give each a short, stable subtask_id (e.g. \"s1\", \"s2\") and a self-contained instruction with enough context for an independent Executor to complete it without seeing the rest of this conversation. You will NOT do any implementation work yourself in this phase.",
      "If context.retry_subtasks is non-empty, the previous attempt already completed every other part of this Task. Plan subtasks only for the listed retry instructions and do not plan or redo work that already succeeded.",
      "Plan the fewest subtasks that satisfy the acceptance criteria; do not add setup, refactoring, or extra tests the Task did not ask for. Tell each Executor to write the least code that is correct.",
      ...WORKER_CONTEXT_INSTRUCTIONS,
    ],
    processSkills,
    output: HYBRID_PLAN_SCHEMA,
    outputRules: ["Do not do the task's work yet; only produce the subtask plan."],
    language,
    inputs: [{ name: "Task", value: workerPromptInput(request) }],
  });
}

/** A single bounded regeneration attempt after a schema/contract mismatch. */
export function buildHybridPlanRepairPrompt(
  request: WorkerRequest,
  validationReason: string,
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
): string {
  return [
    "Your previous Hybrid Mode planning response did not satisfy Owl's machine-validated output contract.",
    `Validator finding: ${validationReason}`,
    "Regenerate the plan from the original Task below. Return only the object required by the JSON schema. Do not explain the validation finding or add prose, markdown, or any other fields.",
    buildHybridPlanPrompt(request, language, processSkills),
  ].join("\n\n");
}

/**
 * Hybrid Mode phase 2 prompt. The Worker reviews the results that real
 * Executor subprocesses produced for each subtask it planned in phase 1
 * (including any retry attempts already performed by the caller), then
 * merges/reconciles them and reports an extended verdict on top of the base
 * report shape so Core knows whether to proceed, ask for one more Worker
 * attempt, or escalate to the Manager.
 */
export function buildHybridVerdictPrompt(
  request: WorkerRequest,
  executorResults: readonly ExecutorResult[],
  language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE,
  processSkills: readonly string[] | null = null,
): string {
  return renderRolePrompt({
    role: "You are the Owl Worker, acting as a TEAM LEADER for this Task (Hybrid Mode, phase 2: review).",
    instructions: [
      [
        "Hybrid Mode review instructions:",
        "1. The Executor results input holds the results from the real Executor subprocesses you dispatched for each subtask, including a retry attempt for any subtask that initially failed.",
        "2. Review every Executor's output for correctness and completeness relative to its subtask instruction.",
        "3. Merge/reconcile the results and do a quality check across the whole Task.",
        "4. Decide a verdict:",
        "   - \"ok\": all or nearly all subtasks succeeded; the Task's work is complete.",
        "   - \"retry\": one or more subtasks failed but are retryable; list exactly what remains in retry_subtasks as {subtask_id, instruction} objects.",
        "   - \"needs_replanning\": half or more of the subtasks failed and cannot be completed as decomposed; explain why in question_for_manager.",
        "5. Keep the final report concise and scannable: write work_done as at most 3 short bullet lines describing the key actions and outcome. Put each changed path and its concise change in changes. Keep verification.method to one short sentence naming the checks and their result. Do not narrate every acceptance criterion or paste raw command logs, full diffs, or full tool output.",
      ].join("\n"),
      "If context.retry_subtasks is non-empty, this attempt only re-ran those previously failed parts; the rest of the Task was completed by the earlier attempt. Judge completeness against the retried parts and never list already-completed work in retry_subtasks.",
      ...WORKER_CONTEXT_INSTRUCTIONS,
      SKILL_FEEDBACK_INSTRUCTION,
    ],
    processSkills,
    output: HYBRID_REPORT_SCHEMA,
    outputRules: [
      ...RESULT_RULES.map((line) => line.replace("(files/changes created or modified as requested)", "(files/changes created or modified as requested by the Executors)")),
      "work_done summarizes what the Executors did.",
    ],
    language,
    inputs: [
      { name: "Executor results (subtask_id, success, output, exit_code, duration_ms)", value: executorResults },
      { name: "Task", value: workerPromptInput(request) },
    ],
  });
}

/**
 * Parse a Hybrid Mode phase 1 plan response (see buildHybridPlanPrompt).
 * The expected payload is a bare `{subtasks: [...]}` object, not a full
 * ReportEnvelope, so this uses its own extraction/validation rather than
 * extractReportPayload/validateReportEnvelope. Fails fast (via
 * reportInvalid) on any malformed or ambiguous output instead of silently
 * falling back to an empty/default plan.
 */
export function parseHybridPlanResponse(response: ProviderResponse): ExecutorSubtaskPlan {
  const format = response.format ?? "provider-json";
  let payload: Record<string, unknown>;
  if (format !== "canonical-jsonl") {
    payload = extractRoleOutputObject(response, "hybrid_plan_not_single_json_object");
  } else {
    let candidate: Record<string, unknown> | null = null;
    for (const rawLine of response.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (cause) {
        throw reportInvalid("hybrid_plan_canonical_jsonl_line_invalid", cause);
      }
      if (!isRecord(parsed)) {
        throw reportInvalid("hybrid_plan_canonical_jsonl_line_not_object");
      }
      if (parsed.type === "error" || parsed.type === "turn.failed" || parsed.kind === "error") {
        const reported = typeof parsed.message === "string"
          ? parsed.message
          : isRecord(parsed.error) && typeof parsed.error.message === "string" ? parsed.error.message : undefined;
        throw providerFailed("provider_reported_error", {
          exit_code: 0,
          signal: null,
          ...(reported !== undefined ? { error: reported } : {}),
          stdout: response.stdout,
        });
      }
      if (parsed.kind === "log" || parsed.kind === "activity") {
        continue;
      }
      if (!Array.isArray(parsed.subtasks)) {
        continue;
      }
      if (candidate !== null) {
        throw reportInvalid("hybrid_plan_canonical_jsonl_multiple_candidates");
      }
      candidate = parsed;
    }
    if (candidate === null) {
      throw reportInvalid("hybrid_plan_canonical_jsonl_missing");
    }
    payload = candidate;
  }

  const problem = validateRoleOutput(HYBRID_PLAN_SCHEMA, payload);
  if (problem) {
    throw reportInvalid(`hybrid_plan_schema:${problem}`);
  }
  const subtasks = payload.subtasks as readonly { subtask_id: string; title: string; instruction: string; write_paths: string[] }[];
  const seenSubtaskIds = new Set<string>();
  for (const item of subtasks) {
    if (seenSubtaskIds.has(item.subtask_id)) {
      throw reportInvalid("hybrid_plan_subtask_id_duplicate");
    }
    if (item.write_paths.some((path) => path.trim().length === 0)) {
      throw reportInvalid("hybrid_plan_write_paths_invalid");
    }
    seenSubtaskIds.add(item.subtask_id);
  }
  return {
    subtasks: subtasks.map((item) => ({
      subtask_id: item.subtask_id,
      title: item.title,
      instruction: item.instruction,
      write_paths: [...new Set(item.write_paths.map((path) => path.trim()))],
    })),
  };
}

/**
 * Parse a Hybrid Mode Worker response against HYBRID_REPORT_SCHEMA. The base
 * ReportEnvelope fields are then re-validated via validateReportEnvelope (the
 * wire contract Core stores is unchanged) and the verdict is layered on top.
 */
export function normalizeHybridWorkerResponse(
  response: ProviderResponse,
  invocationId: string,
): HybridWorkerReport {
  return normalizeHybridWorkerResponseWithFeedback(response, invocationId).report;
}

export function normalizeHybridWorkerResponseWithFeedback(
  response: ProviderResponse,
  invocationId: string,
): { readonly report: HybridWorkerReport; readonly skill_feedback: import("@owl/shared").SkillFeedback | null } {
  try {
    const rawPayload = extractWorkerPayload(response, invocationId);
    // See normalizeWorkerResponse: invocation_id is substituted before the
    // schema is checked so its fill-in placeholder is never itself rejected.
    const suppliedPayload = invocationId ? { ...rawPayload, invocation_id: invocationId } : rawPayload;
    const prepared = prepareLegacySkillOutput(HYBRID_REPORT_SCHEMA, suppliedPayload);
    const payload = prepared.payload;
    const problem = validateRoleOutput(HYBRID_REPORT_SCHEMA, payload);
    if (problem) throw reportInvalid(`hybrid_report_schema:${problem}`);
    const { verdict, retry_subtasks: retrySubtasks, skills_used: _skillsUsed, skill_proposals: _skillProposals, ...baseFields } = payload;
    const baseReport = validateReportEnvelope(baseFields);
    const normalizedRetrySubtasks = (retrySubtasks as readonly { subtask_id: string; instruction: string }[])
      .map((item) => ({ subtask_id: item.subtask_id, instruction: item.instruction }));
    // The one rule the schema cannot express: retry_subtasks is non-empty
    // exactly when the verdict is "retry".
    if (verdict === "retry" && normalizedRetrySubtasks.length === 0) {
      throw reportInvalid("hybrid_retry_subtasks_empty");
    }
    if (verdict !== "retry" && normalizedRetrySubtasks.length > 0) {
      throw reportInvalid("hybrid_retry_subtasks_unexpected");
    }
    return {
      report: {
        ...baseReport,
        verdict: verdict as HybridWorkerReport["verdict"],
        retry_subtasks: normalizedRetrySubtasks,
      },
      skill_feedback: skillFeedbackFromOutput(payload, prepared.hasSkillFields),
    };
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error;
    throw reportInvalid("hybrid_worker_output_invalid", error);
  }
}
