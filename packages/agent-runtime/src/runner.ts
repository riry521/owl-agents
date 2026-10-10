import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AgentRuntimeError, providerConfigInvalid, providerFailed, reportInvalid } from "./errors";
import {
  classifyProviderFailure,
  withProviderDetail,
  formatProviderError,
  formatRuntimeError,
  providerFailureCause,
  type ProviderFailureCause,
} from "./provider-error";
import { asManagerRequest, buildManagerPrompt, managerOutputSchema, parseManagerPlanWithFeedback } from "./manager";
import { statSync } from "node:fs";
import { EXTERNAL_DATA_POLICY, AgentTimeoutSettingError, readStoredAcceptanceCriteria, DEFAULT_REPORT_RESUBMIT_LIMIT, OUTPUT_FORMAT_INVALID_ERROR_KEY, REPORT_FORMAT_INVALID_ERROR_KEY, REPORT_RESUBMIT_LIMIT_CONTEXT_KEY, REPORT_RESUBMIT_SESSION_CONTEXT_KEY, CODEX_PROVIDER_API_KEY_ENV, CODEX_PROVIDER_BASE_URL_ENV, PROCESS_SKILLS_PROMPT_FILES, renderProcessSkills, parseResearchSubagentSettings, researchSubagentPromptRef, type CuratorRequest, type ResearcherPromptRef, type ResearchSubagentSettings, type CuratorRunResult, type ProcessSkillsRole, type PromptObserver, roleSessionContextLimit } from "@owl/shared";
import { type ReportCorrection, extractProviderUsage, harnessFailureDetail, isClaudeReportFormatFailure, isRecord, parseSingleJsonObject, unwrapClaudeCliResult, unwrapCodexCliResult } from "./protocol";
import { extractRoleOutputObject, providerSchema } from "./role-contract";
import { RoleSessionManager } from "./role-session-manager";
import { resolveOutputLogDir, writeInvalidOutputLog } from "./output-log";
import { createCliProvider } from "./provider";
import { OutputFormatError, outputResubmitPrompt, runWithOutputResubmit, type OutputResubmitOutcome } from "./output-resubmit";
import { DEFAULT_SIDE_EFFECT_TOOLS, isSideEffectTool } from "./side-effects";
import { buildKeywordPrompt, keywordProviderSchema, parseKeywordResponse, type KeywordExtractionRequest, type KeywordExtractionRunResult } from "./keyword-extraction";
import {
  buildClippingTagsPrompt, buildLibrarianOperationsPrompt, buildRuleJudgmentsPrompt, parseClippingTagsResponse, parseRuleJudgmentsResponse, parseLibrarianOperationsResponse,
  type ClippingTagsRequest, type RuleJudgmentsRequest, type LibrarianModelSetting, type LibrarianOperationsRequest, type LibrarianRunResult,
} from "./page-integration";
import { buildProjectInvestigationPrompt, parseProjectInvestigationResponse, projectInvestigationProviderSchema, type ProjectInvestigationRequest, type ProjectInvestigationRunResult } from "./project-investigation";
import { buildCuratorPrompt, curatorProviderSchema, parseCuratorResponse } from "./curator";
import {
  normalizeWorkerResponse,
  normalizeWorkerResponseWithFeedback,
  buildDesignerRolePrompt,
  buildWorkerPrompt,
  WORKER_REPORT_SCHEMA,
  DESIGNER_REPORT_SCHEMA,
} from "./worker";
import { claudeRateLimitEventObservation } from "../../shared/dist/plan-usage-claude.js";
import { codexRateLimitsFromJsonl } from "../../shared/dist/plan-usage-codex.js";
import type { PlanUsageSnapshot } from "../../shared/dist/plan-usage.js";
import {
  buildReviewerPrompt,
  parseReviewResult,
  parseReviewResultWithFeedback,
  REVIEW_OUTPUT_SCHEMA,
  validateReviewInput,
} from "./reviewer";
import type {
  CoreAdvisorRunRequest,
  CoreManagerPlanRequest,
  CoreReviewerRunRequest,
  CoreWorkerRunRequest,
  ManagerPlanRunResult,
  RuntimeAgentRunResult,
  RuntimeAgentRunner,
} from "./core-contract";
import {
  REPORT_SCHEMA_VERSION,
  type AdvisorRequest,
  type AdvisorResponse,
  type AgentRunnerOptions,
  type ManagerPlanInput,
  type ManagerPlanRequest,
  type ManagerPlanResult,
  type ProviderClient,
  type ProviderExecutionRequest,
  type ProviderResponse,
  type ReportEnvelope,
  type ReviewResult,
  type ReviewerRequest,
  type ReviewFinding,
  type TaskDetail,
  type TokenUsage,
  type WorkContext,
  type WorkerInput,
  type WorkerRequest,
} from "./types";
import {
  DEFAULT_OWNER_LANGUAGE,
  DISPATCH_MCP_ENABLE_ENV,
  formatAdvisorMalformed,
  generateUlid,
  isOwnerLanguage,
  parseAdvisorResponse as parseSharedAdvisorResponse,
  type OwnerLanguage,
} from "@owl/shared";

let invocationSequence = 0;

function defaultInvocationId(): string {
  invocationSequence += 1;
  return generateUlid();
}

function asWorkerRequest(input: WorkerInput): WorkerRequest {
  if ("task" in input) {
    return input as WorkerRequest;
  }
  return { task: input as TaskDetail };
}

function requireWorkerRequest(input: WorkerInput): WorkerRequest {
  const request = asWorkerRequest(input);
  if (request.task === undefined) {
    throw new AgentRuntimeError(
      "manager_plan_invalid",
      "The Worker request is missing its TaskDetail.",
      "worker_task_missing",
    );
  }
  return request;
}

function stubTask(
  workId: string,
  id: string,
  title: string,
  dependsOn: readonly string[],
  status: "ready" | "waiting",
): TaskDetail {
  return {
    id,
    work_id: workId,
    title,
    status,
    type: "code",
    state_version: 0,
    updated_at: "2026-01-01T00:00:00.000Z",
    parent_task_id: null,
    acceptance: `(1) ${title} is implemented and verified.\n  check: run the stub check`,
    acceptance_criteria: [{ id: "AC1", text: `${title} is implemented and verified.`, check: "run the stub check", serves: title, if_omitted: "the stub Task is not verified", check_weight: "light", weight_reason: "" }],
    review_round: 0,
    failure_count: 0,
    worker_generation: 0,
    depends_on: dependsOn,
    replaces: [],
    necessity: { serves: title, if_omitted: "the stub Work has nothing to run" },
  };
}

/** The Owner's language Core put on the request (the setting), or the default. */
function requestLanguage(input: unknown): OwnerLanguage {
  return isRecord(input) && isOwnerLanguage(input.language) ? input.language : DEFAULT_OWNER_LANGUAGE;
}

function stubWorkId(work: WorkContext): string {
  return work.id ?? work.work_id ?? "stub-work";
}

function stubPlan(request: ManagerPlanRequest): ManagerPlanResult {
  const workId = stubWorkId(request.work);
  const first = stubTask(workId, `${workId}-task-1`, "Implement the first task", [], "ready");
  const second = stubTask(
    workId,
    `${workId}-task-2`,
    "Implement the second task",
    [first.id],
    "waiting",
  );
  const tasks = request.mode === "finalize" && request.tasks !== undefined
    ? request.tasks
    : [first, second];
  if (request.mode === "finalize") {
    const complete = tasks.every((task) => task.status === "completed");
    return {
      tasks,
      event: null,
      verdict: {
        verdict: complete ? "complete" : "incomplete",
        summary: complete ? "All stub tasks are complete." : "Stub tasks are not all complete.",
        missing: complete
          ? []
          : tasks.filter((task) => task.status !== "completed").map((task) => ({
            item: `Task ${task.id}`,
            reason: `The Task is ${task.status}.`,
            fix: "Run the Task again.",
          })),
        lessons: [{
          lesson: "The stub provider exercises the role-runtime wiring only.",
          basis: "Stub provider output.",
          applies_to: "Tests of the role runtime.",
          proposes_rule: false,
        }],
      },
    };
  }
  if (request.mode === "replan") {
    // Replan protocol: retry every failed Task in place ([] when none failed).
    return {
      tasks: (request.tasks ?? []).map((task) => stubTask(workId, task.id, task.title, [], "ready")),
      event: "task.replanned",
      verdict: null,
    };
  }
  return { tasks, event: "work.planned", verdict: null };
}

function stubReport(request: WorkerRequest, invocationId: string): ReportEnvelope {
  return {
    kind: "report",
    schema_version: REPORT_SCHEMA_VERSION,
    invocation_id: request.invocation_id ?? invocationId,
    result: "success",
    work_done: `Stub completed ${request.task.title}.`,
    delegation: {
      decomposition: "The stub completed the Task as one unit.",
      delegated: [],
      retained: [{ part: request.task.title, reason: "The stub runner does not start child runs." }],
    },
    changes: [{ path: "stub://provider", summary: "fixed stage implementation response" }],
    verification: {
      status: "passed",
      method: "Stub provider; nothing was checked.",
      acceptance: [{ criterion_id: "AC1", criterion: request.task.acceptance_criteria?.[0]?.text ?? "AC1", status: "passed", evidence: "Stub provider; nothing was checked." }],
      checks: [],
      integration_check: null,
    },
    remaining_issues: [],
    next_action: "Send the report to Reviewer.",
    needs_replanning: false,
    question_for_manager: null,
  };
}

function stubReview(report: ReportEnvelope): ReviewResult {
  validateReviewInput(report);
  if (report.result !== "success") {
    return {
      verdict: "fix_required",
      summary: "The Worker report is not successful.",
      findings: [
        {
          severity: "major",
          target: "deliverable",
          subject: "other",
          file: "report",
          line: 0,
          problem: "The Worker result is not success.",
          reason: "Only a successful Worker result can be integrated.",
          fix: "Rerun the Worker until it reports success.",
        },
      ],
      tests: { ran: false, command: "stub-provider", passed: 0, failed: 0 },
    };
  }
  return {
    verdict: "pass",
    summary: "Stub review passed.",
    findings: [],
    tests: { ran: false, command: "stub-provider", passed: 0, failed: 0 },
  };
}

const PROVIDER_TO_ADAPTER: Record<string, string> = {
  anthropic: "claude-cli/v1",
  openai: "codex",
  "openai/codex": "codex",
  codex: "codex",
  claude: "claude-cli/v1",
};

function isCodexAdapterId(adapter: string | undefined): boolean {
  return adapter === "codex" || adapter === "codex-cli/v1" || adapter?.startsWith("codex/") === true;
}

function isClaudeAdapterId(adapter: string | undefined): boolean {
  return adapter === undefined || adapter === "claude" || adapter === "claude-cli/v1" || adapter.startsWith("claude/");
}

function processSkillsSourceOf(context: Record<string, unknown>): "setting" | "claude" | "codex" {
  return context.process_skills_source === "claude" || context.process_skills_source === "codex"
    ? context.process_skills_source
    : "setting";
}

function processSkillsFor(role: ProcessSkillsRole, context: unknown, adapter: string | undefined): string[] | null {
  if (!isRecord(context) || typeof context.process_skills_dir !== "string") return null;
  const skillsDir = context.process_skills_dir;
  const availableFiles = PROCESS_SKILLS_PROMPT_FILES.filter((path) => {
    try {
      return statSync(join(skillsDir, path)).isFile();
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") console.error(`[agent-runner] Could not stat process skill file ${path}`, error);
      return false;
    }
  });
  const source = processSkillsSourceOf(context);
  return renderProcessSkills(role, { skills_dir: skillsDir, source, available_files: availableFiles }, isCodexAdapterId(adapter) ? "codex" : "claude");
}

/** The custom provider API key values the runner holds, so a provider error echoing one never reaches the owner. */
function providerSecretValues(options: AgentRunnerOptions): string[] {
  return Object.values(options.providerApiKeys ?? {}).filter((value) => value.length > 0);
}

function resolveOverrides(
  input: Record<string, unknown>,
  options: AgentRunnerOptions,
): { model?: string; adapter?: string; effort?: string; env: Readonly<Record<string, string>> } {
  const model = typeof input.model === "string" ? input.model : undefined;
  const provider = typeof input.provider === "string" ? input.provider : undefined;
  const normalizedProvider = provider?.trim().toLowerCase();
  const adapter = normalizedProvider ? PROVIDER_TO_ADAPTER[normalizedProvider] : undefined;
  const custom = normalizedProvider ? options.providers?.[normalizedProvider] : undefined;
  if (provider && !adapter && !custom && normalizedProvider !== "") {
    throw new AgentRuntimeError("provider_unknown", `Unknown provider '${provider}'.`, "provider_registry_miss");
  }
  const effort = typeof input.effort === "string" ? input.effort : undefined;
  const resolvedAdapter = custom?.adapter ?? adapter;
  // A provider known only from the custom settings must name its endpoint;
  // without one its key would go to the harness's default service.
  if (custom && !adapter && !custom.backend_url) {
    throw providerConfigInvalid(`backend_url_missing:${normalizedProvider}`);
  }
  const env: Record<string, string> = {};
  const codexHarness = isCodexAdapterId(resolvedAdapter);
  if (custom?.backend_url) {
    env[codexHarness ? CODEX_PROVIDER_BASE_URL_ENV : "ANTHROPIC_BASE_URL"] = custom.backend_url;
  }
  const apiKey = custom?.api_key_env ? options.providerApiKeys?.[custom.api_key_env] : undefined;
  if (apiKey) {
    env[codexHarness ? CODEX_PROVIDER_API_KEY_ENV : "ANTHROPIC_API_KEY"] = apiKey;
  }
  // Ids of the Work/Task/Project the agent runs for, read by its owl-memory MCP server. A role without
  // one (the Curator has no Work, a Work without a Project) leaves the variable unset.
  for (const [name, field] of [["OWL_WORK_ID", "work_id"], ["OWL_TASK_ID", "task_id"], ["OWL_PROJECT_ID", "project_id"]] as const) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  return { model, adapter: resolvedAdapter, effort, env };
}

function requestForProvider(
  role: ProviderExecutionRequest["role"],
  invocationId: string,
  prompt: string,
  options: AgentRunnerOptions,
  workspaceId?: string,
  modelOverride?: string,
  adapterOverride?: string,
  effort?: string,
  cwdOverride?: string,
  envOverrides?: Readonly<Record<string, string>>,
  structuredOutputSchema?: Readonly<Record<string, unknown>>,
  researchSubagent?: ResearchSubagentSettings,
): ProviderExecutionRequest {
  return {
    adapter: adapterOverride ?? options.adapter ?? "claude-cli/v1",
    role,
    model: modelOverride ?? options.model ?? "",
    effort: effort ?? "",
    prompt,
    invocation_id: invocationId,
    workspace_id: workspaceId,
    cwd: cwdOverride ?? options.cwd ?? ".",
    ...(structuredOutputSchema ? { structured_output_schema: structuredOutputSchema } : {}),
    ...(researchSubagent ? { research_subagent: researchSubagent } : {}),
    env: {
      ...(options.env ?? {}),
      ...(envOverrides ?? {}),
      OWL_AGENT_ROLE: role,
      OWL_AGENT_RUN_ID: invocationId,
      OWL_AGENT_CWD: cwdOverride ?? options.cwd ?? ".",
    },
  };
}

/** The Claude session Core asks to resume for a report-only run (the Owner chose "resubmit the report only"). */
function reportResubmitSession(context: Record<string, unknown>): string | null {
  const value = context[REPORT_RESUBMIT_SESSION_CONTEXT_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatFailureAsCoreResult(errorKey: string, response: ProviderResponse, resubmits: number, language: OwnerLanguage, usage: TokenUsage | null): RuntimeAgentRunResult {
  return {
    outcome: "failed",
    report_valid: false,
    exit_code: response.exit_code,
    signal: response.signal,
    failure_class: "deterministic",
    rate_limit: null,
    error_key: errorKey,
    retry_allowed: false,
    ...(response.provider_session_id ? { provider_session_id: response.provider_session_id } : {}),
    message: language === "en"
      ? `The agent finished, but its final output did not match the required format and could not be accepted (including ${resubmits} output-only resubmission(s)). The work is kept.`
      : `エージェントの作業は終わりましたが、最終出力が指定の形式に合わず受け取れませんでした（出力だけの出し直し ${resubmits} 回を含む）。作業の内容は残っています。`,
    skill_feedback: null,
    ...withUsage(usage),
  };
}

// The reason codes providerFailed() is called with in this package; anything else may carry provider output or secrets.
const SAFE_PROVIDER_REASON = /^(?:provider_exit:(?:\d{1,3}|signal)|provider_reported_error|guard_token_unavailable|spawn_call_failed|child_process_error|stdin_close_failed|provider_output_too_large|provider_cancelled|provider_execute_failed)$/u;

function assertProviderCompleted(response: ProviderResponse): void {
  if (response.signal !== null || response.exit_code !== 0) {
    throw providerFailed(
      `provider_exit:${response.exit_code ?? "signal"}`,
      {
        exit_code: response.exit_code,
        signal: response.signal,
        ...(harnessFailureDetail(response.adapter, response.stdout) ?? {}),
        stdout: response.stdout,
        stderr: response.stderr,
      },
    );
  }
}

/** Converts a classified provider failure into the Core AgentRunner contract instead of throwing. */
function providerFailureAsCoreResult(cause: ProviderFailureCause, harness: string, language: OwnerLanguage, secrets: readonly string[]): RuntimeAgentRunResult {
  const classification = classifyProviderFailure(harness, cause, language, undefined, secrets);
  return {
    outcome: "failed",
    report_valid: false,
    exit_code: cause.exit_code,
    signal: cause.signal,
    failure_class: classification.failure_class,
    error_key: classification.error_key,
    retry_allowed: classification.retry_allowed,
    message: withProviderDetail(classification, language),
    ...(classification.rate_limit !== undefined ? { rate_limit: classification.rate_limit } : {}),
    skill_feedback: null,
  };
}

const CONTRACT_ERROR_CODES = new Set(["report_invalid", "review_invalid", "manager_plan_invalid"]);

function isContractError(error: unknown): error is AgentRuntimeError {
  return error instanceof AgentRuntimeError && CONTRACT_ERROR_CODES.has(error.code);
}

/**
 * Convert every provider-bound Core failure into a visible result. `usage` is
 * kept when the provider finished but its answer broke the role contract (the
 * tokens were spent); a failed provider process reports none.
 */
function runtimeFailureAsCoreResult(error: unknown, harness: string, outputLogPath: string | null, language: OwnerLanguage, usage: TokenUsage | null = null, secrets: readonly string[] = []): RuntimeAgentRunResult {
  if (error instanceof AgentRuntimeError && error.code !== "provider_failed") {
    const message = formatRuntimeError(error, formatProviderError(harness, error, {}, language), language);
    return {
      outcome: "failed",
      report_valid: false,
      failure_class: "deterministic",
      error_key: `runtime:${error.code}:${error.reason}`,
      // A malformed agent answer (extra prose, a stray key) is usually fixed
      // by running the agent again, so it uses Core's bounded deterministic
      // retry. Configuration errors still go straight to the Owner.
      retry_allowed: isContractError(error),
      message: outputLogPath ? `${message} ${language === "en" ? "Output log" : "出力ログ"}: ${outputLogPath}` : message,
      ...(outputLogPath ? { output_log_path: outputLogPath } : {}),
      skill_feedback: null,
      ...withUsage(usage),
    };
  }
  const cause = providerFailureCause(error) ?? {
    exit_code: null,
    signal: null,
    error,
  };
  return providerFailureAsCoreResult(cause, harness, language, secrets);
}

function isCoreManagerRequest(
  input: CoreManagerPlanRequest | ManagerPlanInput,
): input is CoreManagerPlanRequest {
  return (
    isRecord(input) &&
    typeof input.invocation_id === "string" &&
    typeof input.work_id === "string" &&
    input.task_id === null &&
    typeof input.attempt === "number" &&
    isRecord(input.context) &&
    !Object.prototype.hasOwnProperty.call(input, "work")
  );
}

function isCoreWorkerRequest(
  input: CoreWorkerRunRequest | WorkerInput,
): input is CoreWorkerRunRequest {
  return (
    isRecord(input) &&
    typeof input.invocation_id === "string" &&
    typeof input.work_id === "string" &&
    typeof input.task_id === "string" &&
    typeof input.attempt === "number" &&
    isRecord(input.context) &&
    !Object.prototype.hasOwnProperty.call(input, "task")
  );
}

function isCoreReviewerRequest(
  input: CoreReviewerRunRequest | ReviewerRequest,
): input is CoreReviewerRunRequest {
  return (
    isRecord(input) &&
    typeof input.invocation_id === "string" &&
    typeof input.work_id === "string" &&
    typeof input.task_id === "string" &&
    typeof input.attempt === "number" &&
    typeof input.review_round === "number" &&
    isRecord(input.context) &&
    !Object.prototype.hasOwnProperty.call(input, "report")
  );
}

function coreManagerRequestAsLocal(input: CoreManagerPlanRequest): ManagerPlanRequest {
  const context = input.context;
  const work = isRecord(context.work)
    ? context.work as unknown as ManagerPlanRequest["work"]
    : { id: input.work_id, title: `Work ${input.work_id}` };
  // "tasks" are the Tasks the request is about (the root failed Tasks of a
  // replan); context.failed_tasks is the per-Task failure brief and stays in
  // the fixed context keys.
  const tasks = Array.isArray(context.tasks)
    ? context.tasks.filter(isRecord) as unknown as NonNullable<ManagerPlanRequest["tasks"]>
    : undefined;
  return {
    work,
    ...(tasks ? { tasks } : {}),
    ...(isRecord(context.trigger) ? { trigger: context.trigger as unknown as NonNullable<ManagerPlanRequest["trigger"]> } : {}),
    mode: context.mode === "finalize" || context.mode === "replan" || context.mode === "plan"
      ? context.mode
      : "plan",
    context: managerAdditionalContext(context),
  };
}

function coreWorkerRequestAsLocal(input: CoreWorkerRunRequest): WorkerRequest {
  const context = input.context;
  const candidate = context.task;
  const workerContext: NonNullable<WorkerRequest["context"]> = {
    ...(typeof context.design_document_path === "string" ? { design_document_path: context.design_document_path } : {}),
    ...(context.design_tier === "lead" ? { design_tier: "lead" as const } : {}),
    ...(typeof context.rules === "string" ? { rules: context.rules } : {}),
    ...(typeof context.knowledge === "string" ? { knowledge: context.knowledge } : {}),
    ...(typeof context.skills === "string" ? { skills: context.skills } : {}),
    ...(Array.isArray(context.check_commands) ? { check_commands: context.check_commands as string[][] } : {}),
    ...(Array.isArray(context.report_check_commands) ? { report_check_commands: context.report_check_commands.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof context.worktree === "string" ? { worktree: context.worktree } : {}),
    ...(Array.isArray(context.dependency_reports) ? { dependency_reports: context.dependency_reports as NonNullable<WorkerRequest["context"]>["dependency_reports"] } : {}),
    ...(Array.isArray(context.artifact_paths) ? { artifact_paths: context.artifact_paths as string[] } : {}),
    ...(isRecord(context.verification_failure) ? { verification_failure: context.verification_failure as unknown as NonNullable<WorkerRequest["context"]>["verification_failure"] } : {}),
    ...(isRecord(context.previous_report) ? { previous_report: context.previous_report as unknown as NonNullable<WorkerRequest["context"]>["previous_report"] } : {}),
    ...(isRecord(context.process_wait) ? { process_wait: context.process_wait } : {}),
    ...(Array.isArray(context.reviewer_findings) ? { reviewer_findings: context.reviewer_findings as NonNullable<WorkerRequest["context"]>["reviewer_findings"] } : {}),
    ...(isRecord(context.design_stop) ? { design_stop: context.design_stop } : {}),
    ...(Array.isArray(context.owner_guidance) && context.owner_guidance.length > 0
      ? { owner_guidance: context.owner_guidance.filter(isRecord) }
      : {}),
  };
  if (isRecord(candidate)) {
    return {
      task: candidate as unknown as TaskDetail,
      invocation_id: input.invocation_id,
      context: workerContext,
    };
  }
  return {
    task: {
      id: input.task_id,
      work_id: input.work_id,
      title: `Worker task ${input.task_id}`,
      status: "running",
      type: "code",
      state_version: 0,
      updated_at: "1970-01-01T00:00:00.000Z",
      parent_task_id: null,
      acceptance_criteria: readStoredAcceptanceCriteria(null, "Complete the Task described by the Core context."),
      review_round: 0,
      failure_count: 0,
      worker_generation: input.attempt,
      depends_on: [],
    },
    invocation_id: input.invocation_id,
    context: workerContext,
  };
}

function coreReviewerRequestAsLocal(input: CoreReviewerRunRequest): ReviewerRequest {
  const context = input.context;
  const report = context.report;
  if (!isRecord(report)) {
    throw new AgentRuntimeError(
      "report_invalid",
      "The Reviewer context does not contain the Worker report required for review.",
      "review_report_missing",
    );
  }
  const task = isRecord(context.task)
    ? context.task as unknown as TaskDetail
    : {
        id: input.task_id,
        work_id: input.work_id,
        title: `Review task ${input.task_id}`,
        status: "verifying",
        type: "code",
        state_version: 0,
        updated_at: "1970-01-01T00:00:00.000Z",
        parent_task_id: null,
        acceptance_criteria: readStoredAcceptanceCriteria(null, "Review the Worker report supplied by Core."),
        review_round: input.review_round,
        failure_count: 0,
        worker_generation: input.attempt,
        depends_on: [],
      };
  return {
    task,
    report: report as unknown as ReportEnvelope,
    ...(typeof context.rules === "string" ? { context: context.rules } : {}),
    ...(typeof context.knowledge === "string" ? { knowledge: context.knowledge } : {}),
    ...(typeof context.skills === "string" ? { skills: context.skills } : {}),
    review_round: input.review_round,
    ...(typeof context.worktree === "string" ? { worktree: context.worktree } : {}),
    ...(isRecord(context.design_document) && typeof context.design_document.path === "string" && typeof context.design_document.markdown === "string"
      ? { design_document: { path: context.design_document.path, markdown: context.design_document.markdown } }
      : {}),
    ...(isRecord(context.core_tests) ? { core_tests: context.core_tests } : context.core_tests === null ? { core_tests: null } : {}),
    ...(isRecord(context.core_checks) ? { core_checks: context.core_checks } : context.core_checks === null ? { core_checks: null } : {}),
    ...(Array.isArray(context.owner_guidance) && context.owner_guidance.length > 0
      ? { owner_guidance: context.owner_guidance.filter(isRecord) }
      : {}),
    ...(Array.isArray(context.previous_minor_findings)
      ? { previous_minor_findings: context.previous_minor_findings as unknown as ReviewFinding[] }
      : context.previous_minor_findings === null
        ? { previous_minor_findings: null }
        : {}),
    ...(Array.isArray(context.added_files)
      ? { added_files: context.added_files.filter((item): item is string => typeof item === "string") }
      : context.added_files === null
        ? { added_files: null }
        : {}),
    ...(Array.isArray(context.changed_files)
      ? { changed_files: context.changed_files.filter((item): item is string => typeof item === "string") }
      : context.changed_files === null
        ? { changed_files: null }
        : {}),
  };
}

function managerAdditionalContext(value: Record<string, unknown>): Readonly<Record<string, unknown>> | undefined {
  const excluded = new Set(["mode", "work", "work_id", "tasks", "reports", "notes", "trigger", "process_skills_dir"]);
  const entries = Object.entries(value).filter(([key]) => !excluded.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The `usage` key of a result: left out when the provider reported none. */
function withUsage(usage: TokenUsage | null): { readonly usage?: TokenUsage } {
  return usage ? { usage } : {};
}

function reportAsCoreResult(
  report: ReportEnvelope,
  response: { readonly exit_code: number | null; readonly signal: string | null },
  usage: TokenUsage | null = null,
  skillFeedback: RuntimeAgentRunResult["skill_feedback"] = null,
  corrections: readonly ReportCorrection[] = [],
): RuntimeAgentRunResult {
  const result: RuntimeAgentRunResult = {
    outcome: report.result,
    ...(corrections.length > 0 ? { report_corrections: corrections } : {}),
    report_valid: true,
    report: report as unknown as Record<string, unknown>,
    report_envelope: report,
    exit_code: response.exit_code,
    signal: response.signal,
    skill_feedback: skillFeedback,
    ...withUsage(usage),
  };
  if (report.result !== "success") {
    return {
      ...result,
      failure_class: "deterministic",
      error_key: `report_result:${report.result}`,
      retry_allowed: true,
    };
  }
  return result;
}

function managerAsCoreResult(
  result: ManagerPlanResult,
  usage: TokenUsage | null = null,
  skillFeedback: RuntimeAgentRunResult["skill_feedback"] = null,
): RuntimeAgentRunResult {
  return {
    outcome: "success",
    report_valid: true,
    report: {
      tasks: result.tasks as unknown as Record<string, unknown>[],
      event: result.event,
      verdict: result.verdict,
      updated_title: result.updated_title ?? null,
      updated_summary: result.updated_summary ?? null,
      task_actions: result.task_actions ?? [],
    },
    tasks: result.tasks,
    skill_feedback: skillFeedback,
    ...withUsage(usage),
  };
}

function reviewAsCoreResult(
  result: ReviewResult,
  usage: TokenUsage | null = null,
  skillFeedback: RuntimeAgentRunResult["skill_feedback"] = null,
): RuntimeAgentRunResult {
  const passed = result.verdict === "pass";
  return {
    outcome: passed ? "success" : "failed",
    report_valid: true,
    report: result as unknown as Record<string, unknown>,
    review: result,
    skill_feedback: skillFeedback,
    ...withUsage(usage),
    ...(passed
      ? {}
      : {
          failure_class: "deterministic" as const,
          error_key: `review:${result.verdict}`,
          retry_allowed: false,
        }),
  };
}


function extractInnerStdout(response: { readonly adapter: string; readonly stdout: string; readonly format?: string }): string {
  if (response.format === "plain-text") return response.stdout;
  if ((response.format ?? "provider-json") === "provider-json") {
    return response.adapter === "codex" || response.adapter.startsWith("codex")
      ? unwrapCodexCliResult(response.stdout)
      : unwrapClaudeCliResult(response.stdout);
  }
  return response.stdout;
}

export function createAgentRunner(options: AgentRunnerOptions): RuntimeAgentRunner {
  const provider: ProviderClient = options.provider ?? createCliProvider(options);
  const invocationIdFactory = options.invocationIdFactory ?? defaultInvocationId;
  const activeControllers = new Map<string, { controller: AbortController; pid?: number }>();
  const lastOutputNotifiedAt = new Map<string, number>();
  let processObserver: ((invocationId: string, event: { type: "spawned" | "exited"; pid: number }) => void | Promise<void>) | undefined;
  let outputObserver: ((invocationId: string) => void) | undefined;
  let promptObserver: PromptObserver | undefined;
  let planUsageObserver: ((observation: PlanUsageSnapshot) => void) | undefined;
  const observePlanUsageLine = (adapter: string, line: string): void => {
    if (!planUsageObserver || line.trim().length === 0) return;
    let observedAt: Date;
    try { observedAt = new Date(options.now?.() ?? Date.now()); } catch { return; }
    let observation: PlanUsageSnapshot | null = null;
    if (adapter.startsWith("claude")) {
      try {
        const event: unknown = JSON.parse(line);
        if (isRecord(event) && event.type === "rate_limit_event") {
          observation = claudeRateLimitEventObservation(event, observedAt);
        }
      } catch { return; }
    } else if (isCodexAdapterId(adapter)) {
      observation = codexRateLimitsFromJsonl(line, observedAt);
    }
    if (observation) {
      try { planUsageObserver(observation); } catch { /* plan usage is best-effort telemetry */ }
    }
  };
  const observedProvider: ProviderClient = provider.createSession
    ? {
        ...provider,
        createSession: (request) => provider.createSession!({
          ...request,
          on_stdout_line: (line) => {
            try { request.on_stdout_line?.(line); } catch { /* telemetry must not affect the session */ }
            observePlanUsageLine(request.adapter, line);
          },
        }),
      }
    : provider;
  const notifyProcessObserver = async (
    invocationId: string,
    event: { type: "spawned" | "exited"; pid: number },
  ): Promise<void> => {
    try {
      await processObserver?.(invocationId, event);
    } catch (error) {
      console.error(`[agent-runtime] Process observer failed for ${invocationId} (${event.type})`, error);
    }
  };
  const sideEffectPatterns = options.sideEffectTools ?? DEFAULT_SIDE_EFFECT_TOOLS;
  const sideEffectInvocations = new Set<string>();
  const observeSideEffects = (request: ProviderExecutionRequest, line: string): void => {
    if ((provider.toolNamesInLine?.(request.adapter, line) ?? []).some((name) => isSideEffectTool(name, sideEffectPatterns))) {
      sideEffectInvocations.add(request.invocation_id);
    }
  };
  /** Makes a failed result non-retryable once the invocation has had an external side effect (a rate limit stays as is so Core pauses the provider). */
  const afterSideEffect = (invocationId: string, result: RuntimeAgentRunResult): RuntimeAgentRunResult =>
    !sideEffectInvocations.delete(invocationId) || result.outcome === "success" || result.failure_class === "rate_limited"
      ? result
      : { ...result, failure_class: "deterministic", retry_allowed: false, error_key: `side_effect_failure:${result.error_key ?? "unknown"}` };
  /** Role-shaped callers get a thrown error: release the record and mark it as a failure after a side effect. */
  const guardLegacySideEffects = async <T>(invocationId: string, run: () => Promise<T>): Promise<T> => {
    try {
      const value = await run();
      sideEffectInvocations.delete(invocationId);
      return value;
    } catch (error) {
      const cause = providerFailureCause(error);
      const classification = cause === null ? null : classifyProviderFailure(options.adapter ?? "provider", cause);
      const rateLimited = classification?.failure_class === "rate_limited";
      if (error instanceof Error && classification !== null && rateLimited) {
        // Core pauses on this mark alone, with or without a side effect.
        sideEffectInvocations.delete(invocationId);
        Object.assign(error, { failure_class: "rate_limited", ...(classification.rate_limit !== undefined ? { rate_limit: classification.rate_limit } : {}) });
      } else if (sideEffectInvocations.delete(invocationId) && error instanceof Error) {
        Object.assign(error, { outcome: "failed_after_side_effect", failure_class: "deterministic", retry_allowed: false });
      }
      throw error;
    }
  };
  const executeProviderWithPlanUsage = async (request: ProviderExecutionRequest): Promise<ProviderResponse> => {
    let receivedRawLines = false;
    const response = await provider.execute({
      ...request,
      on_stdout_line: (line) => {
        receivedRawLines = true;
        observeSideEffects(request, line);
        try { request.on_stdout_line?.(line); } catch { /* telemetry must not affect provider I/O */ }
        observePlanUsageLine(request.adapter, line);
      },
    });
    if (!receivedRawLines) {
      for (const line of response.stdout.split(/\r?\n/u)) {
        observePlanUsageLine(request.adapter, line);
        observeSideEffects(request, line);
      }
    }
    return response;
  };
  const contextLimit = (role: ProviderExecutionRequest["role"]): number => {
    try {
      return roleSessionContextLimit(options.env ?? {}, role);
    } catch (error) {
      if (error instanceof AgentTimeoutSettingError) throw providerConfigInvalid(`${error.setting.toLowerCase()}_invalid`);
      throw error;
    }
  };
  const executeProvider = async (request: ProviderExecutionRequest): Promise<ProviderResponse> => {
    // Checked on the first run too: the session manager only reads the limit when a prior session exists.
    contextLimit(request.role);
    const controller = new AbortController();
    const active: { controller: AbortController; pid?: number } = { controller };
    activeControllers.set(request.invocation_id, active);
    try {
      const response = await executeProviderWithPlanUsage({
        ...request,
        signal: controller.signal,
        on_spawn: (pid) => {
          active.pid = pid;
          if (pid > 0) void notifyProcessObserver(request.invocation_id, { type: "spawned", pid });
        },
        on_output: () => {
          const now = Date.now();
          const previous = lastOutputNotifiedAt.get(request.invocation_id) ?? 0;
          if (now - previous >= 1_000) {
            lastOutputNotifiedAt.set(request.invocation_id, now);
            outputObserver?.(request.invocation_id);
          }
        },
      });
      return response;
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw providerFailed("provider_execute_failed", error);
    } finally {
      if (active.pid !== undefined && active.pid > 0) {
        // Keep the persisted PID aligned with the actual child lifetime.
        await notifyProcessObserver(request.invocation_id, { type: "exited", pid: active.pid });
      }
      activeControllers.delete(request.invocation_id);
      lastOutputNotifiedAt.delete(request.invocation_id);
    }
  };

  const sessions = new RoleSessionManager({
    execute: executeProvider,
    contextLimit,
    hasSideEffect: (invocationId) => sideEffectInvocations.has(invocationId),
    onPrompt: (invocationId, record) => promptObserver?.(invocationId, record),
  });

  const executeCompletedProvider = async (request: ProviderExecutionRequest): Promise<ProviderResponse> => {
    const response = await sessions.run(request);
    assertProviderCompleted(response);
    return response;
  };

  let outputResubmitLimitReader: (() => number) | undefined;
  /** Output-only resubmissions allowed: Core's per-run limit in the request context, else the settings reader, else the default. */
  const resubmitLimitFor = (context?: Record<string, unknown>): number => {
    const value = context?.[REPORT_RESUBMIT_LIMIT_CONTEXT_KEY];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    try {
      return outputResubmitLimitReader?.() ?? DEFAULT_REPORT_RESUBMIT_LIMIT;
    } catch {
      return DEFAULT_REPORT_RESUBMIT_LIMIT;
    }
  };

  /**
   * Parses one role answer. A format violation (a contract error, or Claude running out of
   * structured-output retries) resumes the same session and asks for the answer only, up to
   * `limit` times, for every role and both harnesses. A side effect does not stop it: the
   * resubmit prompt only rewrites the answer (no commands, no edits), so it repeats nothing.
   */
  const runAndParse = <T>(
    request: ProviderExecutionRequest,
    first: ProviderResponse,
    parse: (response: ProviderResponse) => T,
    limit: number,
    execute: (request: ProviderExecutionRequest) => Promise<ProviderResponse> = executeProvider,
  ): Promise<OutputResubmitOutcome<T>> =>
    runWithOutputResubmit({
      first,
      limit,
      resubmit: (sessionId, prompt) => sessions.resubmit(request, sessionId, prompt, execute),
      parse: (response) => {
        if (request.structured_output_schema !== undefined && response.exit_code !== 0 && response.signal === null && isClaudeReportFormatFailure(request.adapter, response.stdout)) {
          let original: unknown;
          try { assertProviderCompleted(response); } catch (error) { original = error; }
          throw new OutputFormatError("the final output broke the enforced schema", original);
        }
        assertProviderCompleted(response);
        try {
          return parse(response);
        } catch (error) {
          if (isContractError(error)) throw new OutputFormatError(`${error.code}: ${error.reason}`, error);
          throw error;
        }
      },
    });

  /** The accepted value; a failed outcome rethrows the error the caller handled before output resubmission existed. */
  const acceptedValue = <T>(outcome: OutputResubmitOutcome<T>): T => {
    if (outcome.ok) return outcome.value;
    throw outcome.error instanceof OutputFormatError ? outcome.error.original ?? outcome.error : outcome.error;
  };

  /** A format violation that used up its resubmissions (an Owner decision, not a provider failure). */
  const exhaustedFormat = <T>(outcome: OutputResubmitOutcome<T>): boolean =>
    !outcome.ok && outcome.error instanceof OutputFormatError && Boolean(outcome.response.provider_session_id);

  const outputLogDir = resolveOutputLogDir(options);
  /** Keep the redacted raw output of an answer that broke the role contract. */
  const recordInvalidOutput = (
    error: unknown,
    response: ProviderResponse | undefined,
    invocationId: string,
    role: string,
  ): string | null => {
    if (!response || !isContractError(error)) return null;
    const rejected = `${error.code}:${error.reason}`;
    sessions.markRejected(invocationId, rejected);
    return writeInvalidOutputLog(outputLogDir, { invocationId, role, reason: rejected, response });
  };

  const runManagerPlan = async (
    input: CoreManagerPlanRequest | ManagerPlanInput,
  ): Promise<RuntimeAgentRunResult | ManagerPlanRunResult> => {
    if (isCoreManagerRequest(input)) {
      const request = coreManagerRequestAsLocal(input);
      const invocationId = input.invocation_id;
      let adapter: string | undefined;
      let response: ProviderResponse | undefined;
      try {
        const overrides = resolveOverrides(input as unknown as Record<string, unknown>, options);
        adapter = overrides.adapter;
        const managerRequest = requestForProvider("manager", invocationId, buildManagerPrompt(request, requestLanguage(input), processSkillsFor("manager_plan", input.context, overrides.adapter ?? options.adapter)), options, input.work_id, overrides.model, overrides.adapter, overrides.effort, undefined, overrides.env, providerSchema(managerOutputSchema(request)));
        const outcome = await runAndParse(
          managerRequest,
          await sessions.run(managerRequest),
          (answer) => parseManagerPlanWithFeedback(extractRoleOutputObject(answer, "manager_stdout_not_single_json_object"), request),
          resubmitLimitFor(input.context),
        );
        response = outcome.response;
        if (exhaustedFormat(outcome)) return afterSideEffect(invocationId, formatFailureAsCoreResult(OUTPUT_FORMAT_INVALID_ERROR_KEY, outcome.response, outcome.resubmits, requestLanguage(input), outcome.usage));
        const parsed = acceptedValue(outcome);
        return afterSideEffect(invocationId, managerAsCoreResult(parsed.result, outcome.usage, parsed.skill_feedback));
      } catch (error) {
        return afterSideEffect(invocationId, runtimeFailureAsCoreResult(error, adapter ?? options.adapter ?? "provider", recordInvalidOutput(error, response, invocationId, "manager"), requestLanguage(input), response ? extractProviderUsage(response) : null, providerSecretValues(options)));
      }
    }
    const inputRecord = input as unknown as Record<string, unknown>;
    const request = asManagerRequest(input as ManagerPlanInput);
    // Core's finalization path still sends the role-level Manager request
    // shape, which includes `work` and therefore does not match the Core
    // request discriminator above. Keep honoring the same role overrides as
    // the Core-shaped path instead of silently falling back to the global
    // Executor provider/model.
    const overrides = resolveOverrides(inputRecord, options);
    const invocationId = typeof inputRecord.invocation_id === "string" && inputRecord.invocation_id.length > 0
      ? inputRecord.invocation_id
      : invocationIdFactory();
    let response: ProviderResponse | undefined;
    return guardLegacySideEffects(invocationId, async () => {
    try {
      const managerRequest = requestForProvider(
        "manager",
        invocationId,
        buildManagerPrompt(
          request,
          requestLanguage(input),
          processSkillsFor(
            request.mode === "finalize" ? "manager_finalize" : "manager_plan",
            inputRecord.context,
            overrides.adapter ?? options.adapter,
          ),
        ),
        options,
        typeof inputRecord.work_id === "string" ? inputRecord.work_id : undefined,
        overrides.model,
        overrides.adapter,
        overrides.effort,
        undefined,
        overrides.env,
        providerSchema(managerOutputSchema(request)),
      );
      const outcome = await runAndParse(
        managerRequest,
        await sessions.run(managerRequest),
        (answer) => parseManagerPlanWithFeedback(extractRoleOutputObject(answer, "manager_stdout_not_single_json_object"), request),
        resubmitLimitFor(isRecord(inputRecord.context) ? inputRecord.context : undefined),
      );
      response = outcome.response;
      if (exhaustedFormat(outcome)) {
        throw new AgentRuntimeError(OUTPUT_FORMAT_INVALID_ERROR_KEY, "The Manager answer kept breaking the output format after output-only resubmissions.", "resubmit_limit_exceeded", (outcome as { error: unknown }).error);
      }
      const parsed = acceptedValue(outcome);
      return { ...parsed.result, skill_feedback: parsed.skill_feedback, ...withUsage(outcome.usage) };
    } catch (error) {
      // Keep the broken answer for the operator like the Core-shaped path,
      // then rethrow: role-shaped callers expect a ManagerPlanResult or an
      // error, and Core converts the error into a failed attempt.
      recordInvalidOutput(error, response, invocationId, "manager");
      throw error;
    }
    });
  };

  /** One provider run that returns a Worker or Designer report. */
  const runReportRole = async (
    role: "worker" | "designer",
    input: CoreWorkerRunRequest | WorkerInput,
    hybridMode = false,
  ): Promise<RuntimeAgentRunResult | ReportEnvelope> => {
    const reportSchema = role === "designer" ? DESIGNER_REPORT_SCHEMA : WORKER_REPORT_SCHEMA;
    const buildPrompt = (request: WorkerRequest, language: OwnerLanguage, processSkills?: readonly string[] | null, researcher: ResearcherPromptRef | null = null) =>
      role === "designer"
        ? buildDesignerRolePrompt(request, language, processSkills)
        : buildWorkerPrompt(request, language, processSkills, hybridMode, researcher);
    if (isCoreWorkerRequest(input)) {
      const request = coreWorkerRequestAsLocal(input);
      const invocationId = input.invocation_id;
      let adapter: string | undefined;
      let response: ProviderResponse | undefined;
      try {
        const overrides = resolveOverrides(input as unknown as Record<string, unknown>, options);
        adapter = overrides.adapter;
        const processSkills = processSkillsFor(role, input.context, overrides.adapter ?? options.adapter);
        const researchSettings = role === "worker" ? parseResearchSubagentSettings(input.context.research_subagent) : null;
        // The prompt and the argv both follow researcher: the Worker is never told to use a role it was not given.
        const researcher = researchSettings ? researchSubagentPromptRef(isCodexAdapterId(overrides.adapter ?? options.adapter) ? "codex" : "claude") : null;
        const workerRequest = requestForProvider(
          role,
          invocationId,
          buildPrompt(request, requestLanguage(input), processSkills, researcher),
          options,
          input.work_id,
          overrides.model,
          overrides.adapter,
          overrides.effort,
          typeof input.context.worktree === "string" ? input.context.worktree : undefined,
          {
            ...overrides.env,
            ...(hybridMode ? { [DISPATCH_MCP_ENABLE_ENV]: "1" } : {}),
          },
          providerSchema(reportSchema, isClaudeAdapterId(overrides.adapter ?? options.adapter)),
          researcher && researchSettings ? researchSettings : undefined,
        );
        const resumeSessionId = reportResubmitSession(input.context);
        const first = resumeSessionId
          ? await sessions.resubmit(workerRequest, resumeSessionId, outputResubmitPrompt("the previous report did not match the enforced schema"))
          : await sessions.run(workerRequest);
        const outcome = await runAndParse(
          workerRequest,
          first,
          (answer) => normalizeWorkerResponseWithFeedback(answer, invocationId, Boolean(hybridMode), request.task, reportSchema),
          resubmitLimitFor(input.context),
        );
        response = outcome.response;
        if (exhaustedFormat(outcome)) { recordInvalidOutput((outcome as { error: OutputFormatError }).error.original, outcome.response, invocationId, role); return afterSideEffect(invocationId, formatFailureAsCoreResult(REPORT_FORMAT_INVALID_ERROR_KEY, outcome.response, outcome.resubmits, requestLanguage(input), outcome.usage)); }
        const normalized = acceptedValue(outcome);
        return afterSideEffect(invocationId, reportAsCoreResult(normalized.report, outcome.response, outcome.usage, normalized.skill_feedback, normalized.corrections));
      } catch (error) {
        return afterSideEffect(invocationId, runtimeFailureAsCoreResult(error, adapter ?? options.adapter ?? "provider", recordInvalidOutput(error, response, invocationId, role), requestLanguage(input), response ? extractProviderUsage(response) : null, providerSecretValues(options)));
      }
    }
    const request = requireWorkerRequest(input as WorkerInput);
    const invocationId = request.invocation_id ?? invocationIdFactory();
    return guardLegacySideEffects(invocationId, async () => {
    const legacyRequest = requestForProvider(
      role,
      invocationId,
      buildPrompt(request, requestLanguage(input)),
      options,
      undefined,
      undefined,
      undefined,
      undefined,
      request.context?.worktree,
      undefined,
      providerSchema(reportSchema, isClaudeAdapterId(options.adapter)),
    );
    const outcome = await runAndParse(
      legacyRequest,
      await sessions.run(legacyRequest),
      (answer) => normalizeWorkerResponseWithFeedback(answer, invocationId, false, request.task, reportSchema).report,
      resubmitLimitFor(request.context as Record<string, unknown> | undefined),
    );
    return acceptedValue(outcome);
    });
  };

  const runWorker = async (
    input: CoreWorkerRunRequest | WorkerInput,
  ): Promise<RuntimeAgentRunResult | ReportEnvelope> => {
    if (!isCoreWorkerRequest(input) || !isRecord(input.context) || input.context.hybrid_mode !== true) {
      return runReportRole("worker", input);
    }
    return runReportRole("worker", input, true);
  };

  const runDesigner = (input: CoreWorkerRunRequest | WorkerInput): Promise<RuntimeAgentRunResult | ReportEnvelope> =>
    runReportRole("designer", input);

  const runReviewer = async (
    input: CoreReviewerRunRequest | ReviewerRequest,
  ): Promise<RuntimeAgentRunResult | ReviewResult> => {
    if (isCoreReviewerRequest(input)) {
      const request = coreReviewerRequestAsLocal(input);
      let adapter: string | undefined;
      let response: ProviderResponse | undefined;
      try {
        validateReviewInput(request.report);
        const overrides = resolveOverrides(input as unknown as Record<string, unknown>, options);
        adapter = overrides.adapter;
        const reviewerRequest = requestForProvider(
          "reviewer",
          input.invocation_id,
          buildReviewerPrompt(request, requestLanguage(input), processSkillsFor("reviewer", input.context, overrides.adapter ?? options.adapter)),
          options,
          input.work_id,
          overrides.model,
          overrides.adapter,
          overrides.effort,
          typeof input.context.worktree === "string" ? input.context.worktree : undefined,
          overrides.env,
          providerSchema(REVIEW_OUTPUT_SCHEMA),
        );
        const outcome = await runAndParse(reviewerRequest, await sessions.run(reviewerRequest), (answer) => parseReviewResultWithFeedback(answer, request.task), resubmitLimitFor(input.context));
        response = outcome.response;
        if (exhaustedFormat(outcome)) return afterSideEffect(input.invocation_id, formatFailureAsCoreResult(OUTPUT_FORMAT_INVALID_ERROR_KEY, outcome.response, outcome.resubmits, requestLanguage(input), outcome.usage));
        const parsed = acceptedValue(outcome);
        return afterSideEffect(input.invocation_id, reviewAsCoreResult(parsed.review, outcome.usage, parsed.skill_feedback));
      } catch (error) {
        return afterSideEffect(input.invocation_id, runtimeFailureAsCoreResult(error, adapter ?? options.adapter ?? "provider", recordInvalidOutput(error, response, input.invocation_id, "reviewer"), requestLanguage(input), response ? extractProviderUsage(response) : null, providerSecretValues(options)));
      }
    }
    const request = input as ReviewerRequest;
    validateReviewInput(request.report);
    const invocationId = invocationIdFactory();
    return guardLegacySideEffects(invocationId, async () => {
    const legacyRequest = requestForProvider(
      "reviewer",
      invocationId,
      buildReviewerPrompt(request, requestLanguage(input)),
      options,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerSchema(REVIEW_OUTPUT_SCHEMA),
    );
    const outcome = await runAndParse(legacyRequest, await sessions.run(legacyRequest), (answer) => parseReviewResult(answer, request.task), resubmitLimitFor());
    return acceptedValue(outcome);
    });
  };

  const runAdvisor = async (
    input: CoreAdvisorRunRequest | AdvisorRequest,
  ): Promise<AdvisorResponse> => {
    const request: AdvisorRequest = "conversation_id" in input && "messages" in input && !("work_id" in input)
      ? input as AdvisorRequest
      : {
          conversation_id: (input as CoreAdvisorRunRequest).conversation_id,
          messages: [...(input as CoreAdvisorRunRequest).messages],
          system_prompt: (input as CoreAdvisorRunRequest).system_prompt,
        };
    const invocationId = "invocation_id" in input ? (input as CoreAdvisorRunRequest).invocation_id : invocationIdFactory();
    const { model, adapter, effort, env } = resolveOverrides(input as unknown as Record<string, unknown>, options);
    const response = await executeProvider(
      requestForProvider("advisor", invocationId, buildAdvisorPrompt(request), options, undefined, model, adapter, effort, undefined, env),
    );
    assertProviderCompleted(response);
    return parseAdvisorResponse(extractInnerStdout(response));
  };

  const runCurator = async (input: CuratorRequest): Promise<CuratorRunResult> => {
    const invocationId = input.invocation_id ?? invocationIdFactory();
    let directory: string | undefined;
    try {
      const overrides = resolveOverrides(input as unknown as Record<string, unknown>, options);
      directory = await mkdtemp(join(tmpdir(), "owl-curator-"));
      const request = requestForProvider(
        "curator",
        invocationId,
        buildCuratorPrompt(input),
        options,
        undefined,
        overrides.model,
        overrides.adapter,
        overrides.effort,
        directory,
        overrides.env,
        curatorProviderSchema(),
      );
      const outcome = await runAndParse(
        request,
        await executeProviderWithPlanUsage(request),
        (answer) => {
          const result = parseCuratorResponse(answer);
          if ("error" in result) throw new OutputFormatError(result.error);
          return result;
        },
        resubmitLimitFor(),
        executeProviderWithPlanUsage,
      );
      if (!outcome.ok) {
        if (outcome.error instanceof OutputFormatError) return { ok: false, error: outcome.error.problem };
        throw outcome.error;
      }
      return { ok: true, results: outcome.value.results };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "curator_execution_failed" };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const runKeywordExtraction = async (input: KeywordExtractionRequest): Promise<KeywordExtractionRunResult> => {
    const invocationId = input.invocation_id ?? invocationIdFactory();
    let directory: string | undefined;
    try {
      const overrides = resolveOverrides(input as unknown as Record<string, unknown>, options);
      directory = await mkdtemp(join(tmpdir(), "owl-keywords-"));
      const keywordRequest = requestForProvider(
        "curator",
        invocationId,
        buildKeywordPrompt(input),
        options,
        undefined,
        overrides.model,
        overrides.adapter,
        overrides.effort,
        directory,
        overrides.env,
        keywordProviderSchema(),
      );
      const outcome = await runAndParse(
        keywordRequest,
        await executeProviderWithPlanUsage(keywordRequest),
        (answer) => {
          const result = parseKeywordResponse(answer);
          if ("error" in result) throw new OutputFormatError(result.error);
          return result;
        },
        resubmitLimitFor(),
        executeProviderWithPlanUsage,
      );
      if (!outcome.ok) {
        if (outcome.error instanceof OutputFormatError) return { ok: false, error: outcome.error.problem };
        throw outcome.error;
      }
      return { ok: true, items: outcome.value.items };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "keyword_extraction_failed" };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  /** One read-only librarian call on the Librarian role model; Core writes whatever the returned JSON allows. */
  const runLibrarianJson = async (
    input: { readonly model: LibrarianModelSetting; readonly run_id?: string },
    prefix: string,
    prompt: string,
    schema: Readonly<Record<string, unknown>> | undefined,
    parse: typeof parseLibrarianOperationsResponse,
    failure: string,
    resubmitLimit: number = resubmitLimitFor(),
  ): Promise<LibrarianRunResult> => {
    const invocationId = input.run_id ?? invocationIdFactory();
    let directory: string | undefined;
    try {
      const overrides = resolveOverrides({ ...input.model }, options);
      directory = await mkdtemp(join(tmpdir(), prefix));
      const librarianRequest = requestForProvider(
        "librarian",
        invocationId,
        prompt,
        options,
        undefined,
        overrides.model,
        overrides.adapter,
        overrides.effort,
        directory,
        overrides.env,
        schema,
      );
      const response = await executeProviderWithPlanUsage(librarianRequest);
      const outcome = await runAndParse(
        librarianRequest,
        response,
        (answer) => {
          const result = parse(answer);
          if ("error" in result) throw new OutputFormatError(result.error);
          return result;
        },
        resubmitLimit,
        executeProviderWithPlanUsage,
      );
      if (!outcome.ok) {
        if (outcome.error instanceof OutputFormatError) return { ok: false, error: outcome.error.problem };
        throw outcome.error;
      }
      const parsed = outcome.value;
      const usage = extractProviderUsage(outcome.response);
      return {
        ok: true,
        output: parsed.output,
        ...(usage?.input_tokens !== undefined && usage.output_tokens !== undefined ? { usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } } : {}),
      };
    } catch (error) {
      // Only fixed codes reach the stored error: an unknown Error (or a free-text reason that may carry provider output or secrets) collapses to `failure`.
      if (!(error instanceof AgentRuntimeError)) return { ok: false, error: failure };
      if (/provider_timeout/u.test(error.reason)) return { ok: false, error: "timeout" };
      return { ok: false, error: SAFE_PROVIDER_REASON.test(error.reason) ? `${error.code}:${error.reason}` : error.code };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  // No provider schema for the two librarian calls below: haiku often answers with prose (about an unavailable
  // StructuredOutput tool, or a summary of what it did) under --json-schema; the prompt carries the output shape
  // and the parser takes the JSON text (fenced or not).
  const runLibrarianOperations = (input: LibrarianOperationsRequest): Promise<LibrarianRunResult> =>
    runLibrarianJson(input, "owl-librarian-operations-", buildLibrarianOperationsPrompt(input), undefined, parseLibrarianOperationsResponse, "librarian_operations_failed");

  const runClippingTags = (input: ClippingTagsRequest): Promise<LibrarianRunResult> =>
    runLibrarianJson(input, "owl-clipping-tags-", buildClippingTagsPrompt(input), undefined, parseClippingTagsResponse, "clipping_tags_failed");

  // Resubmission is off: one judgement is one model call, and Core treats an unreadable answer as "no judgement".
  const runRuleJudgments = (input: RuleJudgmentsRequest): Promise<LibrarianRunResult> =>
    runLibrarianJson(input, "owl-rule-judgments-", buildRuleJudgmentsPrompt(input), undefined, parseRuleJudgmentsResponse, "rule_judgments_failed", 0);

  const runProjectInvestigation = async (input: ProjectInvestigationRequest): Promise<ProjectInvestigationRunResult> => {
    const invocationId = input.invocation_id ?? invocationIdFactory();
    const controller = new AbortController();
    try {
      if (!isAbsolute(input.repo_path) || !statSync(input.repo_path, { throwIfNoEntry: false })?.isDirectory()) {
        return { ok: false, error: "repo_path_invalid", invocation_id: invocationId };
      }
      const overrides = resolveOverrides(input as unknown as Record<string, unknown>, options);
      const request = requestForProvider(
        "librarian",
        invocationId,
        buildProjectInvestigationPrompt(input),
        options,
        undefined,
        overrides.model,
        overrides.adapter,
        overrides.effort,
        input.repo_path,
        { ...overrides.env, OWL_PROVIDER_TIMEOUT_MS: String(input.timeout_ms ?? 600_000) },
        projectInvestigationProviderSchema(),
      );
      activeControllers.set(invocationId, { controller });
      const signalled = { ...request, signal: controller.signal };
      const response = await executeProviderWithPlanUsage(signalled);
      const outcome = await runAndParse(
        signalled,
        response,
        (answer) => {
          const parsed = parseProjectInvestigationResponse(answer, input.output_settings);
          if ("error" in parsed) throw new OutputFormatError(parsed.error);
          return parsed.investigation;
        },
        resubmitLimitFor(),
        executeProviderWithPlanUsage,
      );
      if (!outcome.ok) {
        if (outcome.error instanceof OutputFormatError) return { ok: false, error: `invalid_output:${outcome.error.problem}`, invocation_id: invocationId };
        throw outcome.error;
      }
      return { ok: true, investigation: outcome.value, invocation_id: invocationId };
    } catch (error) {
      const reason = error instanceof AgentRuntimeError ? error.reason : error instanceof Error ? error.message : String(error);
      const message = reason.slice(0, 200);
      const failure = controller.signal.aborted ? "cancelled"
        : /provider_timeout/u.test(reason) ? "timeout"
          : `provider_failed:${message}`;
      return { ok: false, error: failure, invocation_id: invocationId };
    } finally {
      activeControllers.delete(invocationId);
    }
  };

  return {
    runManagerPlan,
    runDesigner,
    runWorker,
    runReviewer,
    runAdvisor,
    runCurator,
    runKeywordExtraction,
    runLibrarianOperations,
    runClippingTags,
    runRuleJudgments,
    runProjectInvestigation,
    provider: observedProvider,
    cancelAgent: async (invocationId: string, force?: boolean) => {
      const active = activeControllers.get(invocationId);
      if (!active) return;
      active.controller.abort();
      if (force && active.pid) {
        try { process.kill(-active.pid, "SIGKILL"); } catch { try { process.kill(active.pid, "SIGKILL"); } catch { /* exited */ } }
      }
    },
    setProcessObserver: (observer: (invocationId: string, event: { type: "spawned" | "exited"; pid: number }) => void | Promise<void>) => {
      processObserver = observer;
    },
    setOutputObserver: (observer: (invocationId: string) => void) => {
      outputObserver = observer;
    },
    setPromptObserver: (observer: PromptObserver | undefined) => {
      promptObserver = observer;
    },
    setPlanUsageObserver: (observer: (observation: PlanUsageSnapshot) => void) => {
      planUsageObserver = observer;
    },
    setOutputResubmitLimit: (read: () => number) => {
      outputResubmitLimitReader = read;
    },
  } as RuntimeAgentRunner;
}

export function createStubAgentRunner(): RuntimeAgentRunner {
  const invocationIdFactory = defaultInvocationId;
  const runManagerPlan = async (
    input: CoreManagerPlanRequest | ManagerPlanInput,
  ): Promise<RuntimeAgentRunResult | ManagerPlanResult> => {
    if (isCoreManagerRequest(input)) {
      return managerAsCoreResult(stubPlan(coreManagerRequestAsLocal(input)));
    }
    return stubPlan(asManagerRequest(input as ManagerPlanInput));
  };
  const runWorker = async (
    input: CoreWorkerRunRequest | WorkerInput,
  ): Promise<RuntimeAgentRunResult | ReportEnvelope> => {
    if (isCoreWorkerRequest(input)) {
      const report = stubReport(coreWorkerRequestAsLocal(input), invocationIdFactory());
      return reportAsCoreResult(report, { exit_code: 0, signal: null });
    }
    return stubReport(requireWorkerRequest(input as WorkerInput), invocationIdFactory());
  };
  const runDesigner = async (
    input: CoreWorkerRunRequest | WorkerInput,
  ): Promise<RuntimeAgentRunResult | ReportEnvelope> => {
    const isCore = isCoreWorkerRequest(input);
    const request = isCore ? coreWorkerRequestAsLocal(input) : requireWorkerRequest(input as WorkerInput);
    const path = request.context?.design_document_path;
    const invocationId = request.invocation_id ?? invocationIdFactory();
    if (path) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "# Design\n\nThe design document is ready for review.\n", "utf8");
    }
    const report = {
      ...stubReport(request, invocationId),
      work_done: "Prepared the design document.",
      changes: path ? [{ file: path, action: "created" }] : [],
      verification: {
        status: "passed" as const,
        method: "Wrote the document and self-reviewed it against the Task acceptance criteria.",
        acceptance: [{ criterion_id: "AC1", criterion: request.task.acceptance_criteria?.[0]?.text ?? "AC1", status: "passed" as const, evidence: "Wrote the document and self-reviewed it." }],
        checks: [],
        integration_check: null,
      },
    };
    return isCore ? reportAsCoreResult(report, { exit_code: 0, signal: null }) : report;
  };
  const runReviewer = async (
    input: CoreReviewerRunRequest | ReviewerRequest,
  ): Promise<RuntimeAgentRunResult | ReviewResult> => {
    if (isCoreReviewerRequest(input)) {
      return reviewAsCoreResult(stubReview(coreReviewerRequestAsLocal(input).report));
    }
    return stubReview((input as ReviewerRequest).report);
  };
  const runAdvisor = async (
    _input: CoreAdvisorRunRequest | AdvisorRequest,
  ): Promise<AdvisorResponse> => {
    return { reply: "This is a stub advisor response.", suggested_actions: [] };
  };
  // No runCurator: without a provider there is no Curator, and Core keeps
  // skill proposals queued instead of spending their attempts.
  return { runManagerPlan, runDesigner, runWorker, runReviewer, runAdvisor, provider: undefined } as RuntimeAgentRunner;
}


export function buildAdvisorPrompt(request: AdvisorRequest): string {
  const systemPrompt = request.system_prompt?.trim() || "You are the Owl Advisor. Answer the operator's question or continue the conversation below. You may inspect and implement code changes when useful.";
  const shape = JSON.stringify({
    reply: "<your reply to the conversation>",
    suggested_actions: [],
  }, null, 2);
  return [
    systemPrompt,
    ...(systemPrompt.includes(EXTERNAL_DATA_POLICY) ? [] : [EXTERNAL_DATA_POLICY]),
    "Return exactly one JSON object (no markdown fences, no extra text before or after) in this exact shape:",
    shape,
    "reply: a helpful, direct answer or response to the latest message.",
    "suggested_actions: optional array of {type, description} objects for concrete next steps you recommend. Use an empty array if none.",
    "Here is the conversation and any relevant work context:",
    JSON.stringify(
      {
        conversation_id: request.conversation_id,
        messages: request.messages,
        work_context: request.work_context ?? null,
      },
      null,
      2,
    ),
  ].join("\n\n");
}

/**
 * Parses the Advisor's raw stdout into a reply plus optional suggested
 * actions. The persistent-session contract lets the Advisor reply in natural
 * language instead of the
 * original strict single-JSON-object contract, since turns now stream out of
 * a long-lived provider session rather than being wrapped by a one-shot
 * prompt that demanded JSON. Three shapes are accepted, in order:
 *   1. Backward compat: the entire response is one JSON object with a
 *      string `.reply` (the pre-persistent-session contract).
 *   2. Natural text containing a ```owl-actions``` fenced JSON array: the
 *      fence supplies suggested_actions, the surrounding text is the reply.
 *   3. Plain natural text: the whole response is the reply, no actions.
 */
export function parseAdvisorResponse(rawStdout: string): AdvisorResponse {
  try {
    return parseSharedAdvisorResponse(rawStdout, (reason, detail) => {
      console.warn(`[agent-runtime] Ignoring malformed Advisor owl-actions block (${formatAdvisorMalformed(reason, detail)}); keeping reply text.`);
    });
  } catch (error) {
    throw reportInvalid("advisor_response_invalid", error);
  }
}
