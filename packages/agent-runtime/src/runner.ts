import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { addTokenUsage, CODEX_PROVIDER_API_KEY_ENV, CODEX_PROVIDER_BASE_URL_ENV, PROCESS_SKILLS_PROMPT_FILES, renderProcessSkills, type CuratorRequest, type CuratorRunResult, type ProcessSkillsRole } from "@owl/shared";
import { extractProviderUsage, harnessFailureDetail, isRecord, parseSingleJsonObject, unwrapClaudeCliResult, unwrapCodexCliResult } from "./protocol";
import { extractRoleOutputObject, providerSchema, splitRolePrompt } from "./role-contract";
import { resolveOutputLogDir, writeInvalidOutputLog } from "./output-log";
import { createCliProvider } from "./provider";
import { buildKeywordPrompt, keywordProviderSchema, parseKeywordResponse, type KeywordExtractionRequest, type KeywordExtractionRunResult } from "./keyword-extraction";
import { buildCuratorPrompt, curatorProviderSchema, parseCuratorResponse } from "./curator";
import {
  normalizeWorkerResponse,
  normalizeWorkerResponseWithFeedback,
  buildDesignerRolePrompt,
  buildWorkerPrompt,
  normalizeHybridWorkerResponse,
  normalizeHybridWorkerResponseWithFeedback,
  buildHybridPlanRepairPrompt,
  buildHybridPlanPrompt,
  buildHybridVerdictPrompt,
  HYBRID_PLAN_OUTPUT_SCHEMA,
  HYBRID_REPORT_SCHEMA,
  parseHybridPlanResponse,
  WORKER_REPORT_SCHEMA,
} from "./worker";
import type { ExecutorResult } from "@owl/shared";
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
    acceptance: `${title} is implemented and verified.`,
    review_round: 0,
    failure_count: 0,
    worker_generation: 0,
    depends_on: dependsOn,
    replaces: [],
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
    changes: [{ path: "stub://provider", summary: "fixed stage implementation response" }],
    verification: { passed: true, method: "Stub provider; nothing was checked." },
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
          pre_existing: false,
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
    } catch {
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
    env: {
      ...(options.env ?? {}),
      ...(envOverrides ?? {}),
      OWL_AGENT_ROLE: role,
      OWL_AGENT_RUN_ID: invocationId,
      OWL_AGENT_CWD: cwdOverride ?? options.cwd ?? ".",
    },
  };
}

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
    ...(typeof context.reason === "string" ? { reason: context.reason } : {}),
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
    ...(typeof context.worktree === "string" ? { worktree: context.worktree } : {}),
    ...(Array.isArray(context.dependency_reports) ? { dependency_reports: context.dependency_reports as NonNullable<WorkerRequest["context"]>["dependency_reports"] } : {}),
    ...(Array.isArray(context.artifact_paths) ? { artifact_paths: context.artifact_paths as string[] } : {}),
    ...(isRecord(context.verification_failure) ? { verification_failure: context.verification_failure as unknown as NonNullable<WorkerRequest["context"]>["verification_failure"] } : {}),
    ...(isRecord(context.previous_report) ? { previous_report: context.previous_report as unknown as NonNullable<WorkerRequest["context"]>["previous_report"] } : {}),
    ...(Array.isArray(context.reviewer_findings) ? { reviewer_findings: context.reviewer_findings as NonNullable<WorkerRequest["context"]>["reviewer_findings"] } : {}),
    ...(Array.isArray(context.owner_guidance) && context.owner_guidance.length > 0
      ? { owner_guidance: context.owner_guidance.filter(isRecord) }
      : {}),
    ...(Array.isArray(context.retry_subtasks)
      ? { retry_subtasks: context.retry_subtasks.filter((item): item is string => typeof item === "string" && item.length > 0) }
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
      acceptance: "Complete the Task described by the Core context.",
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
        acceptance: "Review the Worker report supplied by Core.",
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
  const excluded = new Set(["mode", "work", "work_id", "tasks", "reports", "notes", "reason", "process_skills_dir"]);
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
): RuntimeAgentRunResult {
  const result: RuntimeAgentRunResult = {
    outcome: report.result,
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

const ROLE_SESSION_CONTEXT_LIMIT = 80_000;
const MAX_ROLE_SESSIONS = 256;

interface RolePromptSnapshot {
  readonly header: string;
  readonly inputs: Record<string, unknown>;
  readonly shape: string;
}

interface RoleSessionEntry {
  readonly id: string;
  readonly settings: string;
  readonly snapshot: RolePromptSnapshot | null;
  readonly handoff: string;
  readonly contextTokens: number | null;
  readonly invocationId: string;
  readonly rejected: string | null;
}

function setRoleField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function changedRoleFields(current: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      setRoleField(changed, key, null);
    } else if (!Object.prototype.hasOwnProperty.call(previous, key)) {
      setRoleField(changed, key, current[key]);
    } else if (isRecord(current[key]) && isRecord(previous[key])) {
      const nested = changedRoleFields(current[key] as Record<string, unknown>, previous[key] as Record<string, unknown>);
      if (Object.keys(nested).length > 0) setRoleField(changed, key, nested);
    } else if (JSON.stringify(current[key]) !== JSON.stringify(previous[key])) {
      setRoleField(changed, key, current[key]);
    }
  }
  return changed;
}

function roleFollowupPrompt(
  role: ProviderExecutionRequest["role"],
  current: RolePromptSnapshot,
  previous: RoleSessionEntry,
): string {
  const changedInput = changedRoleFields(current.inputs, previous.snapshot?.inputs ?? {});
  return [
    `Continue as the Owl ${role} for this Task. Earlier instructions and unchanged input still apply.`,
    "Apply only the changed fields; missing fields are unchanged and null means removed.",
    "Inspect affected files and return exactly one JSON object matching the enforced schema.",
    ...(previous.rejected ? [`The previous answer was rejected for ${previous.rejected}; return a corrected answer.`] : []),
    `Changed input:\n${JSON.stringify(changedInput)}`,
  ].join("\n\n");
}

function rolePromptWithHandoff(prompt: string, role: ProviderExecutionRequest["role"], previous: RoleSessionEntry): string {
  const rejection = previous.rejected
    ? `\n\nThe previous ${role} answer was rejected for ${previous.rejected}; do not treat it as valid.`
    : "";
  return `${prompt}\n\nPrevious ${role} answer handoff:\n${previous.handoff}${rejection}`;
}

function compactRoleHandoff(response: ProviderResponse): string {
  try {
    return JSON.stringify(extractRoleOutputObject(response, "handoff_invalid")).slice(0, 4_000);
  } catch {
    return "Previous provider answer was unavailable; inspect the current Task and affected files.";
  }
}

const CODEX_TOOL_ITEM_TYPES = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

function providerModelCalls(response: ProviderResponse, codex: boolean): number | null {
  try {
    if (!codex) {
      const wrapper: unknown = JSON.parse(response.stdout);
      return isRecord(wrapper) && typeof wrapper.num_turns === "number" ? wrapper.num_turns : null;
    }
    let calls = 1;
    for (const line of response.stdout.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(event) && event.type === "item.completed" && isRecord(event.item) &&
        typeof event.item.type === "string" && CODEX_TOOL_ITEM_TYPES.has(event.item.type)) calls += 1;
    }
    return calls;
  } catch {
    return null;
  }
}

/**
 * Provider usage is cumulative over every model call in a run, so the final
 * context size is estimated from the per-call average under linear growth.
 */
function contextTokenCount(response: ProviderResponse): number | null {
  const usage = extractProviderUsage(response);
  if (!usage) return null;
  const codex = response.adapter === "codex" || response.adapter.startsWith("codex");
  const calls = providerModelCalls(response, codex);
  if (calls === null || calls < 1) return null;
  const total = codex
    ? (usage.input_tokens ?? 0)
    : (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  return Math.round((2 * total) / calls);
}

export function createAgentRunner(options: AgentRunnerOptions): RuntimeAgentRunner {
  const provider: ProviderClient = options.provider ?? createCliProvider(options);
  const roleSessions = new Map<string, RoleSessionEntry>();
  const inFlightCounts = new Map<string, number>();
  const enterRoleCall = (key: string): boolean => {
    const alreadyInFlight = inFlightCounts.has(key);
    inFlightCounts.set(key, (inFlightCounts.get(key) ?? 0) + 1);
    return alreadyInFlight;
  };
  const leaveRoleCall = (key: string): void => {
    const count = (inFlightCounts.get(key) ?? 1) - 1;
    if (count === 0) {
      inFlightCounts.delete(key);
    } else {
      inFlightCounts.set(key, count);
    }
  };
  const invocationIdFactory = options.invocationIdFactory ?? defaultInvocationId;
  const activeControllers = new Map<string, { controller: AbortController; pid?: number }>();
  const lastOutputNotifiedAt = new Map<string, number>();
  let processObserver: ((invocationId: string, event: { type: "spawned" | "exited"; pid: number }) => void | Promise<void>) | undefined;
  let outputObserver: ((invocationId: string) => void) | undefined;
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
  const executeProvider = async (request: ProviderExecutionRequest): Promise<ProviderResponse> => {
    const controller = new AbortController();
    const active: { controller: AbortController; pid?: number } = { controller };
    activeControllers.set(request.invocation_id, active);
    try {
      return await provider.execute({
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
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw providerFailed("provider_execute_failed", error);
    } finally {
      if (active.pid !== undefined && active.pid > 0) {
        // A logical run can span several one-shot CLI processes (Hybrid plan,
        // Executor phase, and verdict). Keep the persisted PID aligned with
        // the actual child lifetime so stale detection does not mistake the
        // completed planning process for a still-running logical run.
        await notifyProcessObserver(request.invocation_id, { type: "exited", pid: active.pid });
      }
      activeControllers.delete(request.invocation_id);
      lastOutputNotifiedAt.delete(request.invocation_id);
    }
  };

  const saveRoleSession = (
    key: string,
    request: ProviderExecutionRequest,
    settings: string,
    snapshot: RolePromptSnapshot | null,
    response: ProviderResponse,
    resumedSessionId?: string,
  ): void => {
    const id = response.provider_session_id ?? resumedSessionId;
    if (response.exit_code === 0 && response.signal === null && id) {
      roleSessions.delete(key);
      roleSessions.set(key, {
        id,
        settings,
        snapshot,
        handoff: compactRoleHandoff(response),
        contextTokens: contextTokenCount(response),
        invocationId: request.invocation_id,
        rejected: null,
      });
      if (roleSessions.size > MAX_ROLE_SESSIONS) {
        const oldestKey = roleSessions.keys().next().value;
        if (oldestKey !== undefined) roleSessions.delete(oldestKey);
      }
    } else {
      roleSessions.delete(key);
    }
  };

  const executeRoleProvider = async (request: ProviderExecutionRequest): Promise<ProviderResponse> => {
    if (!request.workspace_id || request.role === "advisor" || request.role === "curator") {
      return executeProvider(request);
    }

    const key = `${request.workspace_id}\u0000${request.role}\u0000${request.cwd}`;
    if (enterRoleCall(key)) {
      try {
        return await executeProvider(request);
      } finally {
        leaveRoleCall(key);
      }
    }

    try {
      const settings = JSON.stringify([
        request.adapter,
        request.model,
        request.effort,
        request.cwd,
        request.env.ANTHROPIC_BASE_URL,
        request.env[CODEX_PROVIDER_BASE_URL_ENV],
      ]);
      const prior = roleSessions.get(key);
      const snapshot = splitRolePrompt(request.prompt);

      if (request.role === "reviewer") {
        const response = await executeProvider(prior
          ? { ...request, prompt: rolePromptWithHandoff(request.prompt, request.role, prior) }
          : request);
        saveRoleSession(key, request, settings, snapshot, response);
        return response;
      }

      const compatible = prior && prior.settings === settings && prior.snapshot !== null && snapshot !== null &&
        prior.snapshot.header === snapshot.header && prior.snapshot.shape === snapshot.shape &&
        (prior.contextTokens === null || prior.contextTokens <= ROLE_SESSION_CONTEXT_LIMIT)
        ? prior
        : undefined;
      const prompt = compatible && snapshot
        ? roleFollowupPrompt(request.role, snapshot, compatible)
        : prior
          ? rolePromptWithHandoff(request.prompt, request.role, prior)
          : request.prompt;
      const runRequest = (sessionId?: string): ProviderExecutionRequest => ({
        ...request,
        prompt,
        ...(sessionId ? { provider_session_id: sessionId } : {}),
      });

      let response = await executeProvider(runRequest(compatible?.id));
      let resumedSessionId = compatible?.id;
      if (compatible && response.exit_code !== 0 && response.signal === null && !response.provider_session_id) {
        roleSessions.delete(key);
        resumedSessionId = undefined;
        response = await executeProvider({
          ...request,
          prompt: rolePromptWithHandoff(request.prompt, request.role, compatible),
        });
      }

      saveRoleSession(key, request, settings, snapshot, response, resumedSessionId);
      return response;
    } catch (error) {
      roleSessions.delete(key);
      throw error;
    } finally {
      leaveRoleCall(key);
    }
  };

  const executeCompletedProvider = async (request: ProviderExecutionRequest): Promise<ProviderResponse> => {
    const response = await executeRoleProvider(request);
    assertProviderCompleted(response);
    return response;
  };

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
    for (const [key, entry] of [...roleSessions]) {
      if (entry.invocationId !== invocationId) continue;
      roleSessions.delete(key);
      roleSessions.set(key, { ...entry, rejected });
    }
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
        response = await executeCompletedProvider(
          requestForProvider("manager", invocationId, buildManagerPrompt(request, requestLanguage(input), processSkillsFor("manager_plan", input.context, overrides.adapter ?? options.adapter)), options, input.work_id, overrides.model, overrides.adapter, overrides.effort, undefined, overrides.env, providerSchema(managerOutputSchema(request))),
        );
        const parsed = parseManagerPlanWithFeedback(extractRoleOutputObject(response, "manager_stdout_not_single_json_object"), request);
        return managerAsCoreResult(parsed.result, extractProviderUsage(response), parsed.skill_feedback);
      } catch (error) {
        return runtimeFailureAsCoreResult(error, adapter ?? options.adapter ?? "provider", recordInvalidOutput(error, response, invocationId, "manager"), requestLanguage(input), response ? extractProviderUsage(response) : null, providerSecretValues(options));
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
    try {
      response = await executeCompletedProvider(
        requestForProvider(
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
        ),
      );
      const parsed = parseManagerPlanWithFeedback(extractRoleOutputObject(response, "manager_stdout_not_single_json_object"), request);
      return { ...parsed.result, skill_feedback: parsed.skill_feedback, ...withUsage(extractProviderUsage(response)) };
    } catch (error) {
      // Keep the broken answer for the operator like the Core-shaped path,
      // then rethrow: role-shaped callers expect a ManagerPlanResult or an
      // error, and Core converts the error into a failed attempt.
      recordInvalidOutput(error, response, invocationId, "manager");
      throw error;
    }
  };

  /**
   * One single-shot run that returns the Worker report: the Worker outside
   * Hybrid Mode, and the Designer. Only the prompt and the role differ.
   */
  const runReportRole = async (
    role: "worker" | "designer",
    input: CoreWorkerRunRequest | WorkerInput,
  ): Promise<RuntimeAgentRunResult | ReportEnvelope> => {
    const buildPrompt = role === "designer" ? buildDesignerRolePrompt : buildWorkerPrompt;
    if (isCoreWorkerRequest(input)) {
      const request = coreWorkerRequestAsLocal(input);
      const invocationId = input.invocation_id;
      let adapter: string | undefined;
      let response: ProviderResponse | undefined;
      try {
        const overrides = resolveOverrides(input as unknown as Record<string, unknown>, options);
        adapter = overrides.adapter;
        const processSkills = processSkillsFor(role, input.context, overrides.adapter ?? options.adapter);
        response = await executeCompletedProvider(
          requestForProvider(
            role,
            invocationId,
            buildPrompt(request, requestLanguage(input), processSkills),
            options,
            input.work_id,
            overrides.model,
            overrides.adapter,
            overrides.effort,
            typeof input.context.worktree === "string" ? input.context.worktree : undefined,
            overrides.env,
            providerSchema(WORKER_REPORT_SCHEMA),
          ),
        );
        const normalized = normalizeWorkerResponseWithFeedback(response, invocationId);
        return reportAsCoreResult(normalized.report, response, extractProviderUsage(response), normalized.skill_feedback);
      } catch (error) {
        return runtimeFailureAsCoreResult(error, adapter ?? options.adapter ?? "provider", recordInvalidOutput(error, response, invocationId, role), requestLanguage(input), response ? extractProviderUsage(response) : null, providerSecretValues(options));
      }
    }
    const request = requireWorkerRequest(input as WorkerInput);
    const invocationId = request.invocation_id ?? invocationIdFactory();
    const response = await executeCompletedProvider(
      requestForProvider(
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
        providerSchema(WORKER_REPORT_SCHEMA),
      ),
    );
    return normalizeWorkerResponse(response, invocationId);
  };

  const runWorker = async (
    input: CoreWorkerRunRequest | WorkerInput,
  ): Promise<RuntimeAgentRunResult | ReportEnvelope> => {
    if (!isCoreWorkerRequest(input) || !isRecord(input.context) || input.context.hybrid_mode !== true) {
      return runReportRole("worker", input);
    }
    const request = coreWorkerRequestAsLocal(input);
    const invocationId = input.invocation_id;
    let adapter: string | undefined;
    let response: ProviderResponse | undefined;
    // A repaired Hybrid plan spent the tokens of both processes.
    let earlierUsage: TokenUsage | null = null;
    // Hybrid Mode: Core flags the request via
    // context.hybrid_mode when the `hybrid_mode` setting is on, and picks
    // the phase via context.hybrid_phase ("plan" | "verdict"; default
    // "plan"). Phase "plan" asks the Worker (team leader) to decompose the
    // Task into subtasks that Core dispatches to real Executor CLI
    // subprocesses (executor.ts). Phase "verdict" asks the Worker to
    // review the real Executor results supplied via
    // context.executor_results and produce the final report+verdict
    // (parsed with the extended shape via normalizeHybridWorkerResponse).
    const language = requestLanguage(input);
    try {
      const overrides = resolveOverrides(input as unknown as Record<string, unknown>, options);
      adapter = overrides.adapter;
      const processSkills = processSkillsFor("worker", input.context, overrides.adapter ?? options.adapter);
      const hybridPhase: "plan" | "verdict" = input.context.hybrid_phase === "verdict" ? "verdict" : "plan";
      let prompt: string;
      if (hybridPhase === "verdict") {
        const rawExecutorResults = input.context.executor_results;
        if (!Array.isArray(rawExecutorResults)) {
          throw reportInvalid("hybrid_executor_results_missing");
        }
        const executorResults = rawExecutorResults as unknown as readonly ExecutorResult[];
        prompt = buildHybridVerdictPrompt(request, executorResults, language, processSkills);
      } else {
        prompt = buildHybridPlanPrompt(request, language, null);
      }
      const structuredOutputSchema = hybridPhase === "plan" ? HYBRID_PLAN_OUTPUT_SCHEMA : providerSchema(HYBRID_REPORT_SCHEMA);
      const executeWorkerPrompt = (workerPrompt: string): Promise<ProviderResponse> => executeCompletedProvider(
        requestForProvider(
          "worker",
          invocationId,
          workerPrompt,
          options,
          input.work_id,
          overrides.model,
          overrides.adapter,
          overrides.effort,
          typeof input.context.worktree === "string" ? input.context.worktree : undefined,
          overrides.env,
          structuredOutputSchema,
        ),
      );
      response = await executeWorkerPrompt(prompt);
      if (hybridPhase === "plan") {
        let plan: ReturnType<typeof parseHybridPlanResponse>;
        try {
          plan = parseHybridPlanResponse(response);
        } catch (error) {
          if (
            !(error instanceof AgentRuntimeError) ||
            error.code !== "report_invalid" ||
            !error.reason.startsWith("hybrid_plan_")
          ) {
            throw error;
          }
          earlierUsage = extractProviderUsage(response);
          response = undefined;
          response = await executeWorkerPrompt(buildHybridPlanRepairPrompt(request, error.reason, language, null));
          plan = parseHybridPlanResponse(response);
        }
        return {
          outcome: "success",
          report_valid: false,
          report: plan as unknown as Record<string, unknown>,
          skill_feedback: null,
          exit_code: response.exit_code,
          signal: response.signal,
          ...withUsage(addTokenUsage(earlierUsage, extractProviderUsage(response))),
        };
      }
      const normalized = normalizeHybridWorkerResponseWithFeedback(response, invocationId);
      return reportAsCoreResult(normalized.report, response, extractProviderUsage(response), normalized.skill_feedback);
    } catch (error) {
      const usage = addTokenUsage(earlierUsage, response ? extractProviderUsage(response) : null);
      return runtimeFailureAsCoreResult(error, adapter ?? options.adapter ?? "provider", recordInvalidOutput(error, response, invocationId, "worker"), requestLanguage(input), usage, providerSecretValues(options));
    }
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
        response = await executeCompletedProvider(
          requestForProvider(
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
          ),
        );
        const parsed = parseReviewResultWithFeedback(response);
        return reviewAsCoreResult(parsed.review, extractProviderUsage(response), parsed.skill_feedback);
      } catch (error) {
        return runtimeFailureAsCoreResult(error, adapter ?? options.adapter ?? "provider", recordInvalidOutput(error, response, input.invocation_id, "reviewer"), requestLanguage(input), response ? extractProviderUsage(response) : null, providerSecretValues(options));
      }
    }
    const request = input as ReviewerRequest;
    validateReviewInput(request.report);
    const invocationId = invocationIdFactory();
    const response = await executeCompletedProvider(
      requestForProvider(
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
      ),
    );
    return parseReviewResult(response);
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
      const response = await provider.execute(request);
      assertProviderCompleted(response);
      const parsed = parseCuratorResponse(response);
      return "error" in parsed ? { ok: false, error: parsed.error } : { ok: true, results: parsed.results };
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
      const response = await provider.execute(requestForProvider(
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
      ));
      assertProviderCompleted(response);
      const parsed = parseKeywordResponse(response);
      return "error" in parsed ? { ok: false, error: parsed.error } : { ok: true, items: parsed.items };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "keyword_extraction_failed" };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
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
    provider,
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
      verification: { passed: true, method: "Wrote the document and self-reviewed it against the Task acceptance criteria." },
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
    return parseSharedAdvisorResponse(rawStdout, (reason) => {
      console.warn(`[agent-runtime] Ignoring malformed Advisor owl-actions block (${reason}); keeping reply text.`);
    });
  } catch (error) {
    throw reportInvalid("advisor_response_invalid", error);
  }
}
