import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AdvisorSuggestedAction } from "./advisor-response.js";
import type { OwnerLanguage } from "./owner-language.js";
import type { WebResearchCapture } from "./web-research.js";
import type { AgentFailureClass, RateLimitInfo } from "./rate-limit.js";

export type { AgentFailureClass, RateLimitInfo, RateLimitSource } from "./rate-limit.js";

export { loadOwlEnv, parseDotEnv, type DotEnvLoadOptions, type DotEnvLoadResult } from "./env.js";
export {
  ADVISOR_CURATION_ACTIONS,
  ADVISOR_CURATION_ACTION_TYPES,
  advisorCurationKind,
  parseAdvisorResponse,
  parseSlackAdvisorResponse,
  type AdvisorCurationKind,
  type AdvisorSuggestedAction,
  type ParsedAdvisorResponse,
} from "./advisor-response.js";
export {
  ADVISOR_CURATION_INSTRUCTION,
  addAdvisorReplyTargetInstruction,
  applyAdvisorInterfaceInstructions,
  buildSlackFormatInstruction,
} from "./advisor-prompt.js";
export {
  DEFAULT_OWNER_LANGUAGE,
  OWNER_LANGUAGES,
  OWNER_LANGUAGE_SETTINGS_KEY,
  isOwnerLanguage,
  outputLanguageInstruction,
  ownerLanguageFromLocale,
  type OwnerLanguage,
} from "./owner-language.js";
export { WORK_SUMMARY_SECTIONS, workSummaryInstruction, workSummaryLabel, workSummarySkeleton, type WorkSummarySection } from "./work-summary.js";
export { GUARD_COMMAND_KEYS, GUARD_CONTENT_KEYS, GUARD_NAMED_TOOLS, GUARD_PATH_KEYS, guardChecksToolCall } from "./guard-inputs.js";
export { GUARD_TOKEN_FILE_ENV, type GuardTokenAgent, type GuardTokenIssuer, type GuardTokenLease } from "./guard-token.js";
export { buildCodexCustomProviderArgs, CODEX_PROVIDER_API_KEY_ENV, CODEX_PROVIDER_BASE_URL_ENV } from "./codex-provider.js";
export { agentUserInstructionEnv, buildAgentPermissionArgs, buildPreToolUseHookArgs, RESEARCH_CAPTURE_ROLES, type AgentPermissionAdapter, type AgentPermissionRole, type AgentGuardConfiguration } from "./permission-args.js";
export {
  extractWebResearchCapture,
  hasAuthPasswordForm,
  WEB_RESEARCH_MAX_CONTENT_CHARS,
  WEB_RESEARCH_MAX_LINKS,
  WEB_RESEARCH_TOOLS,
  type WebResearchCapture,
  type WebResearchLink,
  type WebResearchTool,
} from "./web-research.js";
export { addTokenUsage, cliTokenUsage, tokenUsageOf, usageJson } from "./token-usage.js";
export { MINIMAL_CODE_RULES, WORKER_SUBAGENT_RULES, WORKING_STYLE_RULES } from "./agent-rules.js";
export { PROCESS_SKILLS_INSTALL_COMMANDS, PROCESS_SKILLS_PROMPT_FILES, PROCESS_SKILLS_SETTINGS_KEY, renderProcessSkills, type ProcessSkillsHarness, type ProcessSkillsInstallCommand, type ProcessSkillsPackForPrompt, type ProcessSkillsRole, type ProcessSkillsSettings } from "./process-skills.js";
export { designDocumentPath } from "./design-documents.js";
export {
  DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS,
  DEFAULT_LIBRARIAN_TIMES,
  KNOWLEDGE_AUTOMATION_SETTINGS_KEY,
  LIBRARIAN_TIME_PATTERN,
  MAX_LIBRARIAN_TIMES,
  KnowledgeAutomationValidationError,
  readKnowledgeAutomationSettings,
  validateKnowledgeAutomationSettings,
  type KnowledgeAutomationSettings,
  type KnowledgeAutomationSnapshot,
} from "./knowledge-automation.js";
export { renderWorkspaceToolsNote } from "./workspace-tools-note.js";
export { DEFAULT_ROLE_MODELS } from "./default-role-models.js";
export {
  builtinProviderHarness,
  CODEX_BUILTIN_MODELS,
  DEFAULT_HARNESS_MODELS,
  parseCodexModelsCache,
  type CodexCatalogModel,
  type ModelHarness,
} from "./harness-models.js";
export {
  AGENT_IDLE_TIMEOUT_ENV,
  AGENT_STALE_THRESHOLD_MS,
  AGENT_WALL_TIMEOUT_ENV,
  AgentTimeoutSettingError,
  agentIdleTimeoutMs,
  agentWallTimeoutMs,
  CodexProgressTracker,
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  DEFAULT_AGENT_WALL_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  type AgentTimeoutKind,
} from "./agent-timeouts.js";

/** The owner-facing responsibilities an agent can act under. */
export type ActorRole =
  | "advisor"
  | "manager"
  | "designer"
  | "worker"
  | "reviewer"
  | "librarian"
  | "curator";
/** Every role a Rule Store file (`level: role`) or a guard check may name. */
export const RULE_ROLES: readonly ActorRole[] = ["advisor", "manager", "designer", "worker", "reviewer", "librarian", "curator"];
export function isRuleRole(value: unknown): value is ActorRole {
  return typeof value === "string" && (RULE_ROLES as readonly string[]).includes(value);
}

export type JsonObject = Record<string, unknown>;
export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentRunRequest {
  readonly invocation_id: string;
  readonly work_id: string;
  readonly task_id: string | null;
  readonly attempt: number;
  readonly context: JsonObject;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  /** The Owner language for the human-readable values of the output. */
  readonly language?: OwnerLanguage;
}
export interface ManagerPlanRequest extends AgentRunRequest { readonly task_id: null; }
export interface WorkerRunRequest extends AgentRunRequest { readonly task_id: string; }
export interface ReviewerRunRequest extends AgentRunRequest { readonly task_id: string; readonly review_round: number; }
export interface CuratorProposal {
  readonly id: string;
  readonly payload: SkillFeedback["skill_proposals"][number];
  readonly project_id: string | null;
  readonly candidate_skill_names: readonly string[];
}
export interface CuratorCandidate {
  readonly name: string;
  readonly description: string;
  readonly files: Readonly<Record<string, string>>;
}
export interface CuratorUsage {
  readonly skill_name: string;
  readonly revision: number;
  readonly role: string | null;
  readonly verdict: "helpful" | "misleading" | "irrelevant" | null;
  readonly note: string | null;
}
export interface CuratorRequest {
  readonly proposals: readonly CuratorProposal[];
  readonly skill_index: readonly { readonly name: string; readonly description: string }[];
  readonly candidates: readonly CuratorCandidate[];
  readonly usages: readonly CuratorUsage[];
  readonly with_judgement: boolean;
  readonly invocation_id?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly language?: OwnerLanguage;
}
export interface CuratorJudgement {
  readonly reusable: number;
  readonly work_specific: number;
  readonly relation: "same" | "extends" | "different";
  readonly confidence: number;
}
export interface CuratorFile {
  readonly path: string;
  readonly content: string;
}
export interface CuratorSkill {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly files: readonly CuratorFile[];
}
export interface CuratorResultItem {
  readonly proposal_id: string;
  readonly decision: "create" | "update" | "merge" | "reject";
  readonly judgement: CuratorJudgement;
  readonly skill: CuratorSkill | null;
  readonly archive: readonly string[];
  readonly reason: string;
}
export type CuratorRunResult = { readonly ok: true; readonly results: readonly CuratorResultItem[] } | { readonly ok: false; readonly error: string };
export interface AdvisorRunRequest {
  readonly conversation_id: string;
  readonly messages: readonly { source: string; body: string }[];
  readonly invocation_id: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly system_prompt?: string;
}
export interface AdvisorRunResult { readonly reply: string; readonly suggested_actions?: readonly AdvisorSuggestedAction[]; }
export type AgentOutcome = "success" | "failed" | "partial";
export type FailureClass = "transient" | "deterministic";
export interface SkillFeedback {
  readonly skills_used: readonly { readonly name: string; readonly verdict: "helpful" | "misleading" | "irrelevant"; readonly note: string }[];
  readonly skill_proposals: readonly { readonly kind: "new" | "update"; readonly target: string | null; readonly summary: string; readonly steps_or_diff: string; readonly evidence: string }[];
}
export interface AgentRunResult {
  readonly outcome: AgentOutcome;
  readonly failure_class?: AgentFailureClass;
  readonly rate_limit?: RateLimitInfo | null;
  readonly error_key?: string;
  readonly retry_allowed?: boolean;
  readonly exit_code?: number | null;
  readonly signal?: string | null;
  readonly report_valid?: boolean;
  readonly adapter_version?: string;
  readonly report?: JsonObject | null;
  readonly message?: string;
  readonly skill_feedback: SkillFeedback | null;
  /** Tokens the provider reported for this run; absent or null when it reported none. */
  readonly usage?: TokenUsage | null;
}
export interface AgentRunner {
  runManagerPlan(request: ManagerPlanRequest): Promise<AgentRunResult>;
  runWorker(request: WorkerRunRequest): Promise<AgentRunResult>;
  runReviewer(request: ReviewerRunRequest): Promise<AgentRunResult>;
  runAdvisor(request: AdvisorRunRequest): Promise<AdvisorRunResult>;
  runCurator?(request: CuratorRequest): Promise<CuratorRunResult>;
  cancelAgent?(invocationId: string, force?: boolean): Promise<void>;
  setProcessObserver?(observer: (invocationId: string, event: AgentProcessEvent) => void | Promise<void>): void;
  setOutputObserver?(observer: (invocationId: string) => void): void;
}
/** Identifies the lifetime of the one-shot CLI process backing a logical AgentRun. */
export type AgentProcessEvent =
  | { readonly type: "spawned"; readonly pid: number }
  | { readonly type: "exited"; readonly pid: number };
/** What one Hybrid Executor needs from its Task; every key is always present. */
export interface ExecutorTaskContext {
  readonly title: string;
  readonly acceptance: string;
  readonly context: string;
  /** The Worker's Rule Store and Work rules, one per line; null when there are none. */
  readonly rules: string | null;
  readonly owner_guidance: readonly JsonObject[];
}
export interface ExecutorTask { readonly subtask_id: string; readonly instruction: string; readonly workspace_dir: string; readonly task: ExecutorTaskContext; /** Relative paths this Executor may edit; omitted means whole-workspace scope. */ readonly write_paths?: readonly string[]; readonly process_skills_dir?: string; /** Where process_skills_dir was detected; decides whether the Executor's own harness can invoke a skill natively. */ readonly process_skills_source?: "setting" | "claude" | "codex"; /** The Task's git worktree, when workspace_dir is one; null/omitted when it is not (e.g. the Owl workspace fallback). */ readonly worktree?: string | null; }
export interface ExecutorResult { readonly subtask_id: string; readonly success: boolean; readonly output: string; readonly exit_code: number; readonly duration_ms: number; }
export interface ExecutorConfig { readonly provider: "claude" | "codex" | string; readonly model: string; readonly effort?: string; readonly timeout_ms: number; }
export interface ProviderExecutionRequest {
  readonly adapter: string;
  readonly role: "manager" | "worker" | "reviewer" | "advisor" | "curator";
  readonly model: string;
  readonly effort?: string;
  readonly prompt: string;
  readonly invocation_id: string;
  readonly workspace_id?: string;
  readonly provider_session_id?: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Optional provider-enforced final-response schema for structured tasks. */
  readonly structured_output_schema?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly on_spawn?: (pid: number) => void;
}
export interface ProviderResponse { readonly adapter: string; readonly stdout: string; readonly stderr: string; readonly exit_code: number | null; readonly signal: string | null; readonly pid?: number; readonly provider_session_id?: string; readonly format?: "provider-json" | "canonical-jsonl" | "plain-text"; }
export interface ProviderSessionRequest { readonly adapter: string; readonly role: "advisor"; readonly model: string; readonly effort?: string; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly system_prompt: string; readonly provider_session_id?: string; }
export interface TokenUsage { readonly input_tokens?: number; readonly output_tokens?: number; readonly cache_read_tokens?: number; readonly cache_write_tokens?: number; }
export type SessionEvent =
  | { type: "session.ready"; provider_session_id: string; pid: number }
  | { type: "turn.delta"; turn_id: string; text: string }
  | { type: "tool.web_research"; turn_id: string; capture: WebResearchCapture }
  | { type: "turn.completed"; turn_id: string; reply: string; usage: TokenUsage | null }
  | { type: "turn.failed"; turn_id: string; error: string; rate_limit?: RateLimitInfo }
  | { type: "session.compacted"; cause: "auto" | "manual"; pre_tokens: number | null; summary: string | null; transcript_path: string | null }
  | { type: "session.exited"; exit_code: number | null; signal: string | null; stderr_tail: string };
export interface ProviderSession { readonly provider_session_id: string; readonly pid: number; /** True once the session can no longer accept turns (process exited or protocol failure). */ readonly exited?: boolean; send(turn: { turn_id: string; text: string; attachment_paths?: readonly string[] }): Promise<void>; events(): AsyncIterable<SessionEvent>; stop(reason: string, graceMs?: number): Promise<void>; terminateImmediately?(): void; }
export interface ProviderClient { execute(request: ProviderExecutionRequest): Promise<ProviderResponse>; createSession?(request: ProviderSessionRequest): Promise<ProviderSession>; }
/**
 * A provider could not resume a session with the requested settings (for
 * example a new system prompt). Resuming without them would keep a stale
 * prompt running, so the caller starts a fresh session instead.
 */
export class ProviderResumeUnsupportedError extends Error {
  public readonly code = "provider_resume_unsupported";
  public constructor(provider: string, reason: string) {
    super(`${provider} cannot resume the session with the requested settings: ${reason}`);
    this.name = "ProviderResumeUnsupportedError";
  }
}
export function isProviderResumeUnsupportedError(error: unknown): error is ProviderResumeUnsupportedError {
  return error instanceof ProviderResumeUnsupportedError
    || (error instanceof Error && error.name === "ProviderResumeUnsupportedError" && (error as { code?: unknown }).code === "provider_resume_unsupported");
}

/** The execution kind an agent run represents. */
export type AgentKind = "decision" | "task" | "executor";

/** Provider launch implementations, not credentials. */
export type ProviderAdapter = "claude-cli" | "codex-cli" | "api-key";

/** The model catalog reference an agent run is stored against. */
export interface ModelRef {
  provider: ProviderAdapter;
  catalog_id: string;
  model_name: string;
  effort: string;
  catalog_version: string;
}

/** A persisted run's relationship to an actor or child executor. */
export type RunType =
  | "role_run"
  | "child_executor_run"
  | "verification_run";

/** The canonical Work state values. */
export enum WorkState {
  Memo = "memo",
  Ready = "ready",
  Running = "running",
  JudgementWaiting = "judgement_waiting",
  Paused = "paused",
  Completed = "completed",
  Cancelled = "cancelled"
}

/** Work states that keep a Project's worktrees and branches in use; they block Project deletion and folder changes. */
export const PROJECT_LOCKING_WORK_STATES: readonly WorkState[] = [
  WorkState.Running,
  WorkState.Paused,
  WorkState.JudgementWaiting,
];

/** The canonical Task state values. */
export enum TaskState {
  Waiting = "waiting",
  Ready = "ready",
  Running = "running",
  Verifying = "verifying",
  ReviewFixWaiting = "review_fix_waiting",
  Failed = "failed",
  JudgementWaiting = "judgement_waiting",
  Completed = "completed",
  Paused = "paused",
  Cancelled = "cancelled"
}

/** Human-readable, actionable errors suitable for a UI or notification. */
export type HumanReadableErrorCode =
  | "invalid_ulid"
  | "invalid_owl_root"
  | "absolute_path_not_allowed"
  | "path_outside_owl_root";

export interface HumanReadableErrorOptions {
  code: HumanReadableErrorCode;
  message: string;
  remediation: string;
}

export class HumanReadableError extends Error {
  readonly code: HumanReadableErrorCode;
  readonly remediation: string;

  constructor(options: HumanReadableErrorOptions) {
    super(options.message);
    this.name = "HumanReadableError";
    this.code = options.code;
    this.remediation = options.remediation;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toUserMessage(): string {
    return `${this.message} ${this.remediation}`;
  }
}

/** A branded ULID string used for identifiers shared across packages. */
export type ULID = string & { readonly __ulidBrand: "ULID" };

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_ULID_TIMESTAMP = 0xffffffffffff;

function encodeBase32(value: bigint, length: number): string {
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = ULID_ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

/** Generate a Crockford-base32 ULID using the current millisecond timestamp. */
export function generateUlid(timestamp = Date.now()): ULID {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_ULID_TIMESTAMP) {
    throw new HumanReadableError({
      code: "invalid_ulid",
      message: "The ULID timestamp is outside the supported range.",
      remediation: "Use a non-negative millisecond timestamp within the ULID 48-bit range."
    });
  }

  let randomPart = 0n;
  for (const byte of randomBytes(10)) {
    randomPart = (randomPart << 8n) | BigInt(byte);
  }

  const value = `${encodeBase32(BigInt(timestamp), 10)}${encodeBase32(randomPart, 16)}`;
  if (!ULID_PATTERN.test(value)) {
    throw new HumanReadableError({
      code: "invalid_ulid",
      message: "The generated identifier did not match the ULID format.",
      remediation: "Retry the operation and inspect the runtime error log if it continues."
    });
  }
  return value as ULID;
}

/** Validate a canonical uppercase Crockford-base32 ULID. */
export function isValidUlid(value: unknown): value is ULID {
  return typeof value === "string" && ULID_PATTERN.test(value);
}

/** Convert an external string into a branded ULID or fail with an actionable error. */
export function assertValidUlid(value: string): asserts value is ULID {
  if (!isValidUlid(value)) {
    throw new HumanReadableError({
      code: "invalid_ulid",
      message: "The identifier is not a valid uppercase ULID.",
      remediation: "Provide a 26-character Crockford-base32 ULID."
    });
  }
}

/**
 * Resolve a path relative to the configured owl_root.
 * Absolute path segments and lexical traversal outside the root are rejected.
 */
export function resolveOwlPath(owlRoot: string, ...relativeSegments: string[]): string {
  if (!owlRoot || !isAbsolute(owlRoot)) {
    throw new HumanReadableError({
      code: "invalid_owl_root",
      message: "The configured owl_root must be an absolute path.",
      remediation: "Set owl_root in the installation configuration before resolving paths."
    });
  }

  if (relativeSegments.some((segment) => isAbsolute(segment))) {
    throw new HumanReadableError({
      code: "absolute_path_not_allowed",
      message: "An owl_root-relative path cannot contain an absolute segment.",
      remediation: "Pass only relative path segments below the configured owl_root."
    });
  }

  const root = resolve(owlRoot);
  const candidate = resolve(root, ...relativeSegments);
  const relativeCandidate = relative(root, candidate);
  const escapesRoot =
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${sep}`) ||
    isAbsolute(relativeCandidate);

  if (escapesRoot) {
    throw new HumanReadableError({
      code: "path_outside_owl_root",
      message: "The requested path is outside the configured owl_root.",
      remediation: "Choose a relative path that remains inside owl_root."
    });
  }

  return candidate;
}

/** Canonical event registry, including the legacy migration entry. */
export const CANONICAL_EVENT_REGISTRY = [
  "work.ready",
  "work.started",
  "work.paused",
  "work.resumed",
  "work.reopened",
  "work.reopen_rejected",
  "work.completed",
  "work.cancelled",
  "work.updated",
  "work.branches_deleted",
  "work.pushed",
  // No work.failed: Core surfaces Work failures as work-scoped system.alert or a Decision.
  "task.ready",
  "task.started",
  "task.completed",
  "task.failed",
  "task.failure.classified",
  "task.rate_limited",
  "task.replanned",
  "task.conflict",
  "verification.started",
  "verification.completed",
  "review.passed",
  "review.failed",
  "reviewer.rate_limited",
  "reviewer.deferred",
  "decision.opened",
  "decision.resolved",
  "decision.cancelled",
  "agent.started",
  "agent.exited",
  "agent.crashed",
  "agent.idle",
  "agent.tool_used",
  "advisor.action_rejected",
  "manager.rate_limited",
  "provider.paused",
  "provider.resumed",
  "git.merge.started",
  "git.merge.result",
  "git.merge.aborted",
  "git.worktree.removed",
  "guard.blocked",
  "message.received",
  "conversation.summary_failed",
  "artifact.created",
  "system.alert",
  "system.auth_revoked",
  "service.down",
  "legacy.imported"
] as const;

/** Compatibility name for callers that refer to the registry as a type list. */
export const CANONICAL_EVENT_TYPES = CANONICAL_EVENT_REGISTRY;

export type CanonicalEventType = (typeof CANONICAL_EVENT_REGISTRY)[number];
export type CanonicalEvent = CanonicalEventType;

/** External display alias only; it is intentionally not a canonical event type. */
export const CANONICAL_EVENT_ALIASES = {
  "decision.required": "decision.opened"
} as const satisfies Readonly<Record<string, CanonicalEventType>>;

export type CanonicalEventAlias = keyof typeof CANONICAL_EVENT_ALIASES;

export function isCanonicalEventType(value: string): value is CanonicalEventType {
  return (CANONICAL_EVENT_REGISTRY as readonly string[]).includes(value);
}

export { ClaudeStreamReader } from "./agent-stream.js";
export { PROCESS_GROUP_REAP_GRACE_MS, isProcessGroupAlive, reapProcessGroup, type ReapProcessGroupOptions } from "./process-group.js";
export { OWL_INSTANCE_ID_ENV, OWL_MARKER_PATTERN, resolveInstanceId } from "./instance-id.js";
