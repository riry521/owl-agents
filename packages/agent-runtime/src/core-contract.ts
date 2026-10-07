import type {
  AgentRunResult,
  AgentRunner as CoreAgentRunner,
  AdvisorRunRequest as CoreAdvisorRunRequest,
  AdvisorRunResult,
  ManagerPlanRequest as CoreManagerPlanRequest,
  ReviewerRunRequest as CoreReviewerRunRequest,
  WorkerRunRequest as CoreWorkerRunRequest,
  SkillFeedback,
} from "@owl/shared";
import type { ProjectInvestigationRequest, ProjectInvestigationRunResult } from "./project-investigation";
import type {
  AdvisorRequest,
  AdvisorResponse,
  ManagerPlanInput,
  ManagerPlanResult,
  ProviderClient,
  ReportEnvelope,
  ReviewResult,
  ReviewerRequest,
  TokenUsage,
  WorkerInput,
} from "./types";
import type { PlanUsageSnapshot } from "../../shared/dist/plan-usage.js";

/** Core's generated declaration is the authoritative AgentRunner contract. */
export type AgentRunner = CoreAgentRunner;
export type {
  AdvisorRunResult,
  AgentRunResult,
  CoreAdvisorRunRequest,
  CoreManagerPlanRequest,
  CoreReviewerRunRequest,
  CoreWorkerRunRequest,
};

/** Extra runtime fields keep the role-level stub observable without changing Core's contract. */
export interface RuntimeAgentRunResult extends AgentRunResult {
  readonly tasks?: ManagerPlanResult["tasks"];
  readonly report_envelope?: ReportEnvelope;
  readonly review?: ReviewResult;
  /** Redacted raw provider output kept for a run whose answer broke the role contract. */
  readonly output_log_path?: string;
}

/** The role-shaped Manager answer (Core's finalize path) plus the run's token usage. */
export type ManagerPlanRunResult = ManagerPlanResult & { readonly usage?: TokenUsage | null; readonly skill_feedback: SkillFeedback | null };

/** Overloads expose the local one-cycle demo while satisfying Core structurally. */
export interface RuntimeAgentRunner extends CoreAgentRunner {
  setPlanUsageObserver?(observer: (observation: PlanUsageSnapshot) => void): void;
  /** Output-only resubmissions allowed per run, read from settings when a request carries no limit. */
  setOutputResubmitLimit?(read: () => number): void;
  /** The underlying ProviderClient, exposed so Core can build persistent (session-based) runtimes on top of it (Phase 4). */
  readonly provider?: ProviderClient;
  runManagerPlan(request: CoreManagerPlanRequest): Promise<RuntimeAgentRunResult>;
  runManagerPlan(request: ManagerPlanInput): Promise<ManagerPlanRunResult>;
  runDesigner(request: CoreWorkerRunRequest): Promise<RuntimeAgentRunResult>;
  runDesigner(request: WorkerInput): Promise<ReportEnvelope>;
  runWorker(request: CoreWorkerRunRequest): Promise<RuntimeAgentRunResult>;
  runWorker(request: WorkerInput): Promise<ReportEnvelope>;
  runReviewer(request: CoreReviewerRunRequest): Promise<RuntimeAgentRunResult>;
  runReviewer(request: ReviewerRequest): Promise<ReviewResult>;
  runAdvisor(request: CoreAdvisorRunRequest): Promise<AdvisorRunResult>;
  runAdvisor(request: AdvisorRequest): Promise<AdvisorResponse>;
  runProjectInvestigation?(request: ProjectInvestigationRequest): Promise<ProjectInvestigationRunResult>;
}
