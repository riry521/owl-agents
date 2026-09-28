import type { GuardTokenIssuer, RateLimitInfo, WebResearchCapture } from "@owl/shared";

export const REPORT_SCHEMA_VERSION = "1.0.0" as const;

export type ReportResult = "success" | "failed" | "partial";

export type ManagerEvent = "work.planned" | "task.replanned" | null;

export type TaskType =
  | "research"
  | "design"
  | "code"
  | "config"
  | "doc"
  | "test"
  | (string & {});

/** How the Worker checked its result. */
export interface ReportVerification {
  readonly passed: boolean;
  readonly method: string;
}

/** One unresolved issue: what it is, what it affects, and what to do next. */
export interface RemainingIssue {
  readonly issue: string;
  readonly impact: string;
  readonly next_step: string;
}

export interface ReportEnvelope {
  readonly kind: "report";
  readonly schema_version: typeof REPORT_SCHEMA_VERSION;
  readonly invocation_id: string;
  readonly result: ReportResult;
  readonly work_done: string;
  readonly changes: readonly Record<string, unknown>[];
  readonly verification: ReportVerification;
  readonly remaining_issues: readonly RemainingIssue[];
  readonly next_action: string;
  readonly needs_replanning: boolean;
  readonly question_for_manager: string | null;
}

/**
 * Hybrid Mode (Worker=Team Leader) extended Worker report. The Worker
 * decomposes its Task into logical subtasks, works through them, and adds
 * a verdict on top of the base ReportEnvelope so Core knows whether to
 * proceed, retry the Worker once with the listed subtasks, or escalate to
 * the Manager.
 */
export interface HybridWorkerReport extends ReportEnvelope {
  readonly verdict?: "ok" | "retry" | "needs_replanning";
  readonly retry_subtasks?: readonly { subtask_id: string; instruction: string }[];
}

/**
 * Hybrid Mode plan-phase (phase 1 of 2) output: the Worker, acting as team
 * leader, decomposes its Task into independent subtasks without doing any
 * of the work itself. Core spawns one real Executor subprocess per subtask
 * (see executor.ts) and later calls the Worker again (phase 2, verdict)
 * with the ExecutorResult list so it can merge them into a HybridWorkerReport.
 */
export interface ExecutorSubtaskPlan {
  readonly subtasks: readonly {
    readonly subtask_id: string;
    /** A few words for the user; Core shows it as the Executor's label. */
    readonly title: string;
    readonly instruction: string;
    /** Relative files/directories this Executor may edit; ["*"] means unknown or broad scope. */
    readonly write_paths: readonly string[];
  }[];
}

/** TaskDetail plus the Manager plan dependency field. */
export interface TaskDetail {
  readonly id: string;
  readonly work_id: string;
  readonly title: string;
  readonly status: string;
  readonly type: TaskType;
  readonly state_version: number;
  readonly updated_at: string;
  readonly parent_task_id: string | null;
  readonly acceptance: string;
  readonly review_round: number;
  readonly failure_count: number;
  readonly worker_generation: number;
  readonly depends_on: readonly string[];
  readonly context?: string;
  readonly project?: string;
  readonly review?: boolean;
  readonly notes?: string;
  /** Manager plan output only: ids of failed Tasks this new Task replaces. */
  readonly replaces?: readonly string[];
}

export interface WorkContext {
  readonly id?: string;
  readonly work_id?: string;
  readonly title: string;
  readonly summary?: string;
  readonly owner_id?: string;
  readonly project_id?: string | null;
  readonly size?: "small" | "normal" | "large";
  readonly [key: string]: unknown;
}

export interface ManagerPlanRequest {
  readonly work: WorkContext;
  readonly tasks?: readonly TaskDetail[];
  readonly reports?: readonly ReportEnvelope[];
  readonly notes?: readonly string[];
  readonly reason?: string;
  readonly mode?: "plan" | "replan" | "finalize";
  /** Additional Manager context after work/tasks/reports/reason are mapped to their typed fields. */
  readonly context?: Readonly<Record<string, unknown> & { readonly knowledge?: string | null }>;
}

export type ManagerPlanInput = ManagerPlanRequest | WorkContext;

/** A point the Final Manager found missing: what, why, and how to fix it. */
export interface ManagerMissingItem {
  readonly item: string;
  readonly reason: string;
  readonly fix: string;
}

/** A reusable lesson from the Work, classified for future use. */
export interface ManagerLesson {
  readonly lesson: string;
  readonly basis: string;
  readonly applies_to: string;
  readonly kind: "procedure" | "fact" | "decision" | "pitfall" | "rule_candidate";
  readonly topic: string;
  readonly procedure: string;
  readonly rule_text: string;
  readonly rule_scope: "all" | "manager" | "designer" | "worker" | "reviewer" | "advisor";
}

interface LegacyManagerLesson {
  readonly lesson: string;
  readonly basis: string;
  readonly applies_to: string;
  readonly proposes_rule: boolean;
}

export interface ManagerVerdict {
  readonly verdict: "complete" | "incomplete";
  readonly summary: string;
  readonly missing: readonly ManagerMissingItem[];
  readonly lessons: readonly (ManagerLesson | LegacyManagerLesson)[];
}

export interface ManagerPlanResult {
  readonly tasks: readonly TaskDetail[];
  readonly event: ManagerEvent;
  readonly verdict: ManagerVerdict | null;
}

/** What a completed Task this one depends on did, as Core hands it to the Worker. */
export interface DependencyReport {
  readonly task_id: string;
  readonly manager_task_id: string | null;
  readonly title: string;
  readonly work_done: string;
  readonly changes: readonly Record<string, unknown>[];
  readonly remaining_issues: readonly unknown[];
  readonly design_document_path: string | null;
}

/** The Core verification that failed the previous attempt. */
export interface VerificationFailure {
  readonly source: string;
  readonly commands: readonly unknown[];
  readonly error: string | null;
}

export interface WorkerContext {
  /** Absolute destination for a design Task's Markdown deliverable. */
  readonly design_document_path?: string;
  readonly design_tier?: "standard" | "lead";
  /** Per completed dependency: what it did, what it changed, what it left open. */
  readonly dependency_reports?: readonly DependencyReport[];
  /** Recorded code/generated artifact paths of the completed dependencies. */
  readonly artifact_paths?: readonly string[];
  /** Set when the previous attempt failed Core verification; never together with reviewer_findings. */
  readonly verification_failure?: VerificationFailure | null;
  readonly rules?: string;
  readonly knowledge?: string | null;
  readonly skills?: string | null;
  readonly worktree?: string;
  readonly previous_report?: ReportEnvelope | null;
  readonly reviewer_findings?: readonly ReviewFinding[];
  /** Owner answers to this Work's Decisions, newest first. */
  readonly owner_guidance?: readonly Readonly<Record<string, unknown>>[];
  /**
   * Hybrid Mode: instructions of the subtasks a previous attempt's verdict
   * asked to retry. Every other part of the Task already succeeded.
   */
  readonly retry_subtasks?: readonly string[];
}

export interface WorkerRequest {
  readonly task: TaskDetail;
  readonly context?: WorkerContext;
  readonly invocation_id?: string;
}

export type WorkerInput = WorkerRequest | TaskDetail;

export interface ReviewFinding {
  readonly severity: "minor" | "major";
  /** Path of the file the finding is about; "" for a general finding. */
  readonly file: string;
  /** 1-based line number; 0 when no specific line applies. */
  readonly line: number;
  /** What is wrong. */
  readonly problem: string;
  /** Why it matters. */
  readonly reason: string;
  /** How to fix it. */
  readonly fix: string;
}

export interface ReviewTests {
  readonly ran: boolean;
  readonly command: string;
  readonly passed: number;
  readonly failed: number;
}

export interface ReviewResult {
  readonly verdict: "pass" | "fix_required" | "replan_required";
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly tests: ReviewTests;
}

export interface ReviewerRequest {
  readonly task: TaskDetail;
  readonly report: ReportEnvelope;
  readonly context?: string;
  readonly knowledge?: string | null;
  readonly skills?: string | null;
  readonly review_round?: number;
  readonly worktree?: string;
  /** Files the Worker changed, when Core could determine them; null when unknown. */
  readonly changed_files?: readonly string[] | null;
  /** A design Task's external document, which the Reviewer reads instead of changed files. */
  readonly design_document?: { readonly path: string; readonly markdown: string } | null;
}

export interface AdvisorRequest {
  readonly conversation_id: string;
  readonly messages: readonly { source: string; body: string }[];
  readonly work_context?: WorkContext;
  readonly system_prompt?: string;
}

export interface AdvisorResponse {
  readonly reply: string;
  readonly suggested_actions?: readonly { type: string; description: string }[];
}

/** @deprecated Use ProviderId. Widened to string for provider-agnostic support. */
export type AdapterId = string;

export interface ProviderExecutionRequest {
  readonly adapter: AdapterId;
  readonly role: "manager" | "designer" | "worker" | "reviewer" | "advisor" | "curator";
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
  readonly on_output?: () => void;
}

export interface ProviderResponse {
  readonly adapter: AdapterId;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly pid?: number;
  readonly provider_session_id?: string;
  readonly format?: "provider-json" | "canonical-jsonl" | "plain-text";
}

/**
 * Request to create (or resume) a persistent advisor session. Unlike
 * ProviderExecutionRequest, this is not one-shot: the returned ProviderSession
 * stays alive across many turns until stop() is called.
 */
export interface ProviderSessionRequest {
  readonly adapter: string;
  readonly role: "advisor";
  readonly model: string;
  readonly effort?: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly system_prompt: string;
  readonly provider_session_id?: string; // if set, resume instead of starting fresh
}

export interface TokenUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_write_tokens?: number;
}

export type SessionEvent =
  | { type: "session.ready"; provider_session_id: string; pid: number }
  | { type: "turn.delta"; turn_id: string; text: string }
  | { type: "tool.web_research"; turn_id: string; capture: WebResearchCapture }
  | { type: "turn.completed"; turn_id: string; reply: string; usage: TokenUsage | null }
  | { type: "turn.failed"; turn_id: string; error: string; rate_limit?: RateLimitInfo }
  | {
      type: "session.compacted";
      cause: "auto" | "manual";
      pre_tokens: number | null;
      summary: string | null;
      transcript_path: string | null;
    }
  | { type: "session.exited"; exit_code: number | null; signal: string | null; stderr_tail: string };

export interface ProviderSession {
  readonly provider_session_id: string;
  readonly pid: number;
  /**
   * True once the session can no longer accept turns (its process exited or
   * the driver hit a protocol failure). Core uses it to replace a driver that
   * died while idle instead of reusing it.
   */
  readonly exited?: boolean;
  send(turn: { turn_id: string; text: string; attachment_paths?: readonly string[] }): Promise<void>;
  events(): AsyncIterable<SessionEvent>;
  stop(reason: string, graceMs?: number): Promise<void>;
  /** Immediately terminate this Owl-owned session process group during Core shutdown. */
  terminateImmediately?(): void;
}

export interface ProviderClient {
  execute(request: ProviderExecutionRequest): Promise<ProviderResponse>;
  /** Undefined when the harness backing this client has no session support yet. */
  createSession?(request: ProviderSessionRequest): Promise<ProviderSession>;
}

export interface AgentRunnerOptions {
  readonly provider?: ProviderClient;
  readonly adapter?: AdapterId;
  readonly executablePath?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Optional user-defined provider ids mapped to one of the two CLI harnesses. */
  readonly providers?: Readonly<Record<string, {
    readonly adapter: AdapterId;
    readonly backend_url?: string;
    readonly api_key_env?: string;
  }>>;
  /**
   * Values of the custom provider key variables named by `providers[].api_key_env`.
   * They are applied only to the processes of the provider that names them and
   * are never part of the shared agent environment.
   */
  readonly providerApiKeys?: Readonly<Record<string, string>>;
  /**
   * Issues the guard token of each agent process. Its file path reaches the
   * process as OWL_GUARD_TOKEN_FILE and the token is revoked when the process
   * ends; without it no token is passed.
   */
  readonly guardToken?: GuardTokenIssuer;
  readonly now?: () => string;
  readonly invocationIdFactory?: () => string;
  /**
   * Directory for redacted raw provider output of runs whose answer broke the
   * role contract. Defaults to `<data dir>/logs/agent-output` when env.OWL_ROOT
   * is set; null disables it.
   */
  readonly outputLogDir?: string | null;
}

/** Local temporary contract; Core's generated declaration is authoritative. */
export interface LocalAgentRunner {
  runManagerPlan(request: ManagerPlanInput): Promise<ManagerPlanResult>;
  runDesigner(request: WorkerInput): Promise<ReportEnvelope>;
  runWorker(request: WorkerInput): Promise<ReportEnvelope>;
  runReviewer(request: ReviewerRequest): Promise<ReviewResult>;
}
export type ProviderId = string;
