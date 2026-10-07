import type { AcceptanceDefect, GuardTokenIssuer, ManagerTrigger, RateLimitInfo, StoredAcceptanceCriterion, TaskNecessity, WebResearchCapture } from "@owl/shared";

export const REPORT_SCHEMA_VERSION = "1.1.0" as const;
/** Reports saved before schema 1.1.0 (`verification.passed` boolean). Read-only: new agent output must not use it. */
export const LEGACY_REPORT_SCHEMA_VERSION = "1.0.0" as const;

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

/** blocked means the check could not be run; it is never the same as passed or failed. */
export type VerificationStatus = "passed" | "failed" | "blocked";

/** The outcome for one numbered acceptance criterion, with the evidence behind it. */
export interface AcceptanceVerification {
  readonly criterion_id: string;
  readonly criterion: string;
  /** unverifiable: nothing this Task can run could prove the criterion. */
  readonly status: VerificationStatus | "unverifiable";
  readonly evidence: string;
  readonly unverifiable_reason?: string | null;
}

/** One check the Worker ran (test, typecheck, build, search). */
export interface VerificationCheck {
  readonly name: string;
  readonly status: VerificationStatus;
  readonly evidence: string;
}

/** The check of the integrated result after delegated children returned. */
export interface IntegrationVerification {
  readonly status: VerificationStatus;
  readonly evidence: string;
  /** true when the integrated result of delegated children had to be checked. */
  readonly required?: boolean;
}

/** Schema 1.1.0 verification: per-criterion status and evidence, not one boolean. */
export interface ReportVerificationV2 {
  readonly status: VerificationStatus;
  readonly method: string;
  readonly acceptance: readonly AcceptanceVerification[];
  readonly checks: readonly VerificationCheck[];
  readonly integration_check: IntegrationVerification | null;
}

/** Schema 1.0.0 verification, kept only to read stored reports. */
export interface LegacyReportVerification {
  readonly passed: boolean;
  readonly method: string;
}

/** One unresolved issue: what it is, what it affects, and what to do next. */
export interface RemainingIssue {
  readonly issue: string;
  readonly impact: string;
  readonly next_step: string;
}

/** A Worker record of how work was split, delegated, and retained. */
export interface WorkerDelegation {
  readonly decomposition: string;
  /** The Worker used its own provider subagents/forks (not Owl dispatch). Optional so stored reports stay valid. */
  readonly own_subagents_used?: boolean;
  readonly delegated: readonly {
    readonly child_id: string;
    readonly instruction: string;
    readonly provider: string;
    readonly model: string;
  }[];
  readonly retained: readonly {
    readonly part: string;
    readonly reason: string;
  }[];
}

export interface ReportEnvelope {
  readonly kind: "report";
  readonly schema_version: typeof REPORT_SCHEMA_VERSION;
  readonly invocation_id: string;
  readonly result: ReportResult;
  readonly work_done: string;
  readonly delegation: WorkerDelegation;
  readonly changes: readonly Record<string, unknown>[];
  readonly verification: ReportVerificationV2;
  readonly remaining_issues: readonly RemainingIssue[];
  readonly next_action: string;
  readonly needs_replanning: boolean;
  readonly question_for_manager: string | null;
  /** Worker only: a long process still running; Core holds the Task in waiting for it. */
  readonly pending_process?: Readonly<Record<string, unknown>>;
  /** Worker only: a problem outside this Task blocks a criterion; Core sends the Task to the Manager. */
  readonly external_blocker?: Readonly<Record<string, unknown>>;
  /** Designer only: the design cannot be produced; Core stops the Work and asks the Owner. */
  readonly design_blocked?: Record<string, unknown>;
}

/** A stored schema 1.0.0 report: the same envelope with the legacy verification. */
export type LegacyReportEnvelope = Omit<ReportEnvelope, "schema_version" | "verification"> & {
  readonly schema_version: typeof LEGACY_REPORT_SCHEMA_VERSION;
  readonly verification: LegacyReportVerification;
};

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
  /** Display text; role inputs carry acceptance_criteria instead, so a role never reads it. */
  readonly acceptance?: string;
  /** One entry per criterion; a Task planned with a free-text acceptance reads as one legacy criterion (AC1). */
  readonly acceptance_criteria?: readonly StoredAcceptanceCriterion[];
  /** The Manager's notes and necessity for the Task, as separate fields next to `context`. */
  readonly manager_notes?: string | null;
  /** Set when the Task has no stored plan context: `context` then holds the whole text, which may include notes and necessity. */
  readonly plan_context_legacy?: true;
  readonly review_round: number;
  readonly failure_count: number;
  readonly worker_generation: number;
  readonly depends_on: readonly string[];
  readonly context?: string;
  readonly project?: string;
  readonly review?: boolean;
  readonly notes?: string;
  /** Manager output: headings a doc Task must contain / test files a test Task must run (Core checks them). */
  readonly required_sections?: readonly string[];
  readonly required_tests?: readonly string[];
  /** Manager plan output only: ids of failed Tasks this new Task replaces. */
  readonly replaces?: readonly string[];
  /** Why the Task is needed (Manager plan output and role input; each criterion carries its own too). */
  readonly necessity?: TaskNecessity | null;
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
  /** Why the Manager is called; a structured ManagerTrigger, never a sentence. */
  readonly trigger?: ManagerTrigger;
  readonly mode?: "plan" | "replan" | "finalize";
  /** "pages" adds theme/cross_project to the finalize lessons; absent keeps the legacy output byte-identical. */
  readonly memory_mode?: "pages";
  /** Additional Manager context after work/tasks/reports/trigger are mapped to their typed fields. */
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
  readonly theme?: string;
  readonly cross_project?: boolean;
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
  /** Absent in verdicts recorded before backlog items were tied to Works. */
  readonly unaddressed_backlog_items?: readonly { readonly item_id: string; readonly reason: string }[];
  readonly lessons: readonly (ManagerLesson | LegacyManagerLesson)[];
}

export interface ManagerPlanResult {
  readonly tasks: readonly TaskDetail[];
  readonly event: ManagerEvent;
  readonly verdict: ManagerVerdict | null;
  readonly updated_title?: string | null;
  readonly updated_summary?: string | null;
  /** Replan only: open Tasks the Manager cancels or treats as done. */
  readonly task_actions?: readonly { readonly task_id: string; readonly action: "cancel" | "complete"; readonly reason: string }[];
}

/** What a completed Task this one depends on did, as Core hands it to the Worker. */
export interface DependencyReport {
  readonly task_id: string;
  readonly manager_task_id: string | null;
  readonly title: string;
  readonly work_done: string;
  readonly changed_files: readonly string[];
  readonly open_issues: readonly string[];
  readonly design_document_path: string | null;
  /** The full report (JSON file); work_done above is only a summary. Null if the Task has no report. */
  readonly report_path: string | null;
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
  /** Project test_policy.check_commands (argv lists) the Worker runs before reporting. */
  readonly check_commands?: readonly (readonly string[])[];
  readonly worktree?: string;
  readonly previous_report?: ReportEnvelope | null;
  /** Set when Core relaunches the Worker after the process it left running ended. */
  readonly process_wait?: Readonly<Record<string, unknown>> | null;
  readonly reviewer_findings?: readonly ReviewFinding[];
  /** Designer only: Core stopped remaking this design (rejections, limit, review_history). */
  readonly design_stop?: Readonly<Record<string, unknown>> | null;
  /** Owner answers to this Work's Decisions, newest first. */
  readonly owner_guidance?: readonly Readonly<Record<string, unknown>>[];
}

export interface WorkerRequest {
  readonly task: TaskDetail;
  readonly context?: WorkerContext;
  readonly invocation_id?: string;
}

export type WorkerInput = WorkerRequest | TaskDetail;

export interface ReviewFinding {
  readonly severity: "minor" | "major";
  /** "report" = about the report's wording only; never registered in the backlog. */
  readonly target: "deliverable" | "report";
  /** "beyond_acceptance" = asks for work no criterion or rule requires (Core stores it as minor); "overbuilt" = the delivered work adds what the criteria do not need. */
  readonly scope?: "in_scope" | "beyond_acceptance" | "overbuilt";
  /** "test_result" = about a test or check result (never registered in the backlog); "other" = anything else. */
  readonly subject: "test_result" | "other";
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
  readonly verdict: "pass" | "fix_required" | "replan_required" | "acceptance_defect";
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  /** Criteria that cannot be proven inside the Task; set only with verdict acceptance_defect. */
  readonly acceptance_defects?: readonly AcceptanceDefect[];
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
  /** Files the Task added, when Core could determine them; null when unknown. */
  readonly added_files?: readonly string[] | null;
  /** A design Task's external document, which the Reviewer reads instead of changed files. */
  readonly design_document?: { readonly path: string; readonly markdown: string } | null;
  /** The previous review round's minor findings; null on the first round. */
  readonly previous_minor_findings?: readonly ReviewFinding[] | null;
  /** Core's test run for this Task (failed test names and error points); null when there is none. */
  readonly core_tests?: Readonly<Record<string, unknown>> | null;
  /** Summary of the deterministic checks Core ran for this Task (check_commands and policy_checks, no output); null when there is none. */
  readonly core_checks?: Readonly<Record<string, unknown>> | null;
  /** The Owner's answers to earlier Decisions for this Work (newest first); they take priority over the Task. */
  readonly owner_guidance?: readonly Readonly<Record<string, unknown>>[];
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
  readonly role: "manager" | "designer" | "worker" | "reviewer" | "advisor" | "curator" | "librarian";
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
  /** Raw stdout JSONL records for telemetry parsing; callers must not retain or log them. */
  readonly on_stdout_line?: (line: string) => void;
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
 * Request to create a persistent advisor session. Unlike
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
  /** Raw stdout JSONL records for telemetry parsing; callers must not retain or log them. */
  readonly on_stdout_line?: (line: string) => void;
  /**
   * Called with the reply of a turn the provider started on its own (for
   * example when a background task finishes) while no Owl turn was in flight.
   */
  readonly on_unsolicited_reply?: (reply: { readonly reply: string; readonly usage: TokenUsage | null }) => void;
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
  | { type: "tool.web_research_failed"; turn_id: string; error: string }
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
  /** Why the session became unusable (process exit or protocol failure), when known. */
  readonly exit_detail?: string | null;
  send(turn: { turn_id: string; text: string; attachment_paths?: readonly string[] }): Promise<void>;
  events(): AsyncIterable<SessionEvent>;
  stop(reason: string, graceMs?: number): Promise<void>;
  /** Immediately terminate this Owl-owned session process group during Core shutdown. */
  terminateImmediately?(): void;
}

export interface ProviderClient {
  execute(request: ProviderExecutionRequest): Promise<ProviderResponse>;
  /** Tool names called in one raw stdout line, in this provider's stream format; absent means side effects cannot be observed. */
  toolNamesInLine?(adapter: AdapterId, line: string): string[];
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
  /** Grace between SIGTERM and SIGKILL when reaping an agent's process group. Defaults to 5 seconds. */
  readonly reapGraceMs?: number;
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
  /**
   * Tool names (trailing `*` = prefix) whose call counts as an external side
   * effect; a failure after one is never retried automatically.
   * Defaults to DEFAULT_SIDE_EFFECT_TOOLS.
   */
  readonly sideEffectTools?: readonly string[];
}

/** Local temporary contract; Core's generated declaration is authoritative. */
export interface LocalAgentRunner {
  runManagerPlan(request: ManagerPlanInput): Promise<ManagerPlanResult>;
  runDesigner(request: WorkerInput): Promise<ReportEnvelope>;
  runWorker(request: WorkerInput): Promise<ReportEnvelope>;
  runReviewer(request: ReviewerRequest): Promise<ReviewResult>;
}
export type ProviderId = string;
