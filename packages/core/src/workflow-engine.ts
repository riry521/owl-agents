import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { OUTPUT_FORMAT_INVALID_ERROR_KEY, readDesignBlocked, isReportFormatInvalidErrorKey, REPORT_RESUBMIT_LIMIT_CONTEXT_KEY, REPORT_RESUBMIT_SESSION_CONTEXT_KEY, readStoredAcceptanceCriteria, readStoredTaskPlanContext, requestsSpecTest, AGENT_STALE_THRESHOLD_MS, builtinProviderHarness, DEFAULT_HARNESS_MODELS, DEFAULT_ROLE_MODELS, designDocumentPath, OWL_INSTANCE_ID_ENV, reapProcessGroup, resolveInstanceId, tokenUsageOf, usageJson, type DelegationMismatchKind, type ResearchSubagentSettings, type TaskReplanTrigger, type TokenUsage } from "@owl/shared";
import { matchesAnyGlob } from "../../shared/dist/glob.js";
import { taskVerificationMarker } from "./workspace-process-sweeper.js";
import { TRANSIENT_RETRY_DELAYS_MS, TRANSIENT_RETRY_LIMIT } from "./attempt-policy";
import { terminateActiveExecutorsImmediately } from "./executor.js";
import type { ChildRunScheduler } from "./child-run-scheduler.js";
import { HumanReadableError, validationError } from "./errors";
import { pendingReportResubmit, reportResubmitLimit } from "./report-resubmit";
import { PROCESS_WAIT_EVENT, validatePendingProcess, validatePrerequisiteSpec, type PrerequisiteSpec } from "../../shared/dist/prerequisite.js";
import {
  ACCEPTANCE_DEFECT_EVENT,
  ACCEPTANCE_DEFECT_VERDICT,
  normalizeAcceptanceDefects,
  workerAcceptanceDefects,
  type AcceptanceDefect,
  type AcceptanceDefectSource,
} from "../../shared/dist/acceptance-defect.js";
import type { RuleStore } from "./rule-store";
import {
  appendEventInTransaction,
  applyReplanInTransaction,
  assertTaskDependencyGraph,
  cascadeDependencyFailureInTransaction,
  createTaskPlanInTransaction,
  isTerminalTaskState,
  openRemakeLimitDecisionInTransaction,
  reduceTaskInTransaction,
  reduceWorkInTransaction,
  stopTaskForNoProgressInTransaction,
  type ReplanApplyGuard,
  type ReplanApplyResult,
} from "./state-reducer";
import { lineageReviewHistory, recordTaskChangeMeasurementInTransaction } from "./task-lineage";
import { progressGuard } from "./progress-guard";
import { HYBRID_MODE_SETTINGS_KEY } from "./types";
import { GitWorktreeGateway } from "./git-gateway.js";
import { processIdentityMatches, readProcessIdentity } from "./process-identity.js";
import { formatRuntimeFailure } from "./error-display.js";
import { rethrowUnlessRateLimited, type ProviderPauseController } from "./provider-pause-controller";
import { enqueueLearningJobInTransaction } from "./learning-pipeline.js";
import type { IndexInjector } from "./memory/index-injector.js";
import { ContextBuilder } from "./context-builder.js";
import { pendingExternalBlocker, taskDependencyIds } from "./task-context.js";
import { EXTERNAL_BLOCKER_EVENT, reportedExternalBlocker, type ExternalBlocker } from "../../shared/dist/external-blocker.js";
import { registerReviewBacklogInTransaction, settleWorkBacklogOnCompletionInTransaction } from "./review-backlog.js";
import { clearPausedReviewerWait, readPausedReviewerWait, recordPausedReviewerWait } from "./provider-pause-reviewer-wait.js";
import { agentCliNames, installedAgentCliMatches, listProcesses, planSubagentReconciliation } from "./subagent-watcher.js";
import { evaluateWorkerCompletion, type WorkerChild } from "./task-completion-gate.js";
import { NO_CORE_ACTIVITY, type CoreActivityReporter } from "./core-activity.js";
import { coreTestErrorOutcome, coreTestRunBrief, notApplicableTestRun, runCoreTests, workTestRunner, type CoreTestRunDeps, type CoreTestRunOutcome } from "./core-test-run.js";
import { DEFAULT_TEST_RUN_SETTINGS, type TestRunSettings } from "../../shared/dist/test-run-settings.js";
import { DEFAULT_TEST_DETECTION_RULES, type TestDetectionRules } from "./test-detection-rules.js";
import { reportCheckCommands, resolveTestRun, type TestRunResolution } from "./test-detection.js";
import { latestTestRun, testRunSettingsFromJson, type TestCommandRunner } from "./test-runs.js";
import { QUARANTINE_FIX_TASK_PREFIX } from "./test-quarantine.js";
import { evaluateTaskTypePolicy, verificationPolicySettings, type TaskVerificationSpec } from "./task-verification-policy.js";
import { reviewRouting } from "./assurance-settings.js";
import { insertRequestUsageRows } from "./token-usage-report.js";
import type { HookRequestUsage } from "../../shared/dist/token-relay.js";
import { decideReviewRouting, effectiveReviewRequired, taskArtifactPaths, type ReviewRoutingDecision } from "./review-routing.js";
import type {
  AgentRunResult,
  AgentRunner,
  ChangedFile,
  CoreDatabase,
  CoreWriteLaneTransaction,
  GitGateway,
  JsonObject,
  TaskPlanItem,
  TaskRow,
  WorkLearningInput,
  WorkflowSnapshot,
} from "./types";
import { ownerLanguage } from "./owner-language";
import { prerequisiteExpiredBrief } from "./decision-brief";
import type { ReplanPlan } from "./replan-plan";
import type { SkillBox } from "./skill-box";
import { defaultOwlRoot } from "./workspace-layout.js";

const ACTIVE_AGENT_STATUSES = ["launch_pending", "spawned", "running", "cancel_requested"] as const;

const SUBAGENT_SCAN_INTERVAL_MS = 5_000;

/** Whether `candidate` resolves to `base` itself or a path underneath it. */
function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `{ usage }` for a reducer or event payload, or nothing when no usage was reported. */
function usagePayload(usage: unknown): JsonObject {
  const normalized = tokenUsageOf(usage);
  return normalized ? { usage: { ...normalized } } : {};
}

function normalizeProviderId(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (value === "anthropic" || value === "claude") return "anthropic";
  if (value === "openai" || value === "openai/codex" || value === "codex") return "openai";
  return value;
}

function isActiveAgentStatus(status: string | undefined): boolean {
  return status !== undefined && (ACTIVE_AGENT_STATUSES as readonly string[]).includes(status);
}

const MAX_CAPTURED_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_CAPTURED_ARTIFACT_FILE_BYTES = 10 * 1024 * 1024;
/** Limits of the Project-less change measurement; exceeding the entry count makes the measurement incomplete, not empty. */
const WORKTREE_SNAPSHOT_MAX_ENTRIES = 100_000;
const WORKTREE_SNAPSHOT_MAX_KEPT_BYTES = 64 * 1024 * 1024;

type TaskChangeMeasurement = {
  files: ChangedFile[] | null;
  approximate: boolean;
  unmeasured_reason?: string;
  /** The files are relative to this generation's own start, not to the Task's first state. */
  since_generation_start?: boolean;
};

/** sha256 of a worktree file; "deleted" when it is gone, "special:<code>" when it cannot be read. */
async function hashWorktreeFile(root: string, path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "deleted" : `special:${code ?? "unknown"}`;
  }
}

interface WorktreeEntry {
  hash: string;
  lines: number;
  binary: boolean;
  text?: string;
}

export function normalizeReviewerVerdict(
  verdict: "pass" | "fix_required" | "replan_required",
  findings: readonly unknown[],
): "pass" | "fix_required" | "replan_required" {
  // replan_required backed only by requests beyond the acceptance criteria is not a reason to replan.
  if (verdict === "replan_required") {
    return findings.length > 0 && findings.every((finding) =>
      finding !== null && typeof finding === "object" && !Array.isArray(finding) && (finding as JsonObject).scope === "beyond_acceptance"
    ) ? "pass" : verdict;
  }
  if (verdict !== "fix_required") return verdict;
  return findings.every((finding) =>
    finding !== null && typeof finding === "object" && !Array.isArray(finding) && (finding as JsonObject).severity === "minor"
  ) ? "pass" : "fix_required";
}

/** A finding that only asks for work beyond the acceptance criteria never sends the Task back: it is stored as minor. */
export function normalizeReviewFindings(findings: readonly unknown[]): unknown[] {
  return findings.map((finding) =>
    finding !== null && typeof finding === "object" && !Array.isArray(finding)
      && (finding as JsonObject).scope === "beyond_acceptance" && (finding as JsonObject).severity === "major"
      ? { ...(finding as JsonObject), severity: "minor" }
      : finding);
}

function mimeForPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  const types: Record<string, string> = {
    ts: "text/typescript", tsx: "text/tsx", js: "text/javascript", jsx: "text/jsx",
    json: "application/json", md: "text/markdown", txt: "text/plain", css: "text/css",
    html: "text/html", yaml: "text/yaml", yml: "text/yaml", png: "image/png", jpg: "image/jpeg",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

/** A SubagentStart / SubagentStop notification, or the stopped subagent's request usage. */
export type HookSubagentInput =
  | { readonly event: "start" | "stop"; readonly agentId: string; readonly agentType: string | null }
  | { readonly event: "usage"; readonly agentId: string; readonly agentType: string | null; readonly requests: readonly HookRequestUsage[] };

export interface ManagerReplanNeededInput {
  readonly work_id: string;
  readonly failed_task_ids: readonly string[];
  readonly trigger: TaskReplanTrigger;
}

export interface WorkflowEngineOptions {
  readonly db: CoreDatabase;
  readonly agentRunner: AgentRunner;
  readonly git?: GitGateway;
  /** Maximum active non-Executor agent runs per Work. Unlimited unless set. */
  readonly maxParallel?: number;
  /** Maximum active non-Executor agent runs across all Works. Unlimited unless set. */
  readonly globalMaxParallel?: number;
  readonly onManagerReplanNeeded?: (input: ManagerReplanNeededInput) => Promise<void>;
  /**
   * Called after a Task's pipeline (Worker, verification, review and merge)
   * settles, so the caller can schedule the Work again without waiting for
   * its next periodic tick.
   */
  readonly onTaskSettled?: (workId: string) => void;
  /** Called after a Task's pipeline settled, with the Work and Task that ran it. */
  readonly onTaskPipelineSettled?: (workId: string, taskId: string) => void;
  /** Called when prepareWorktree created a new Task worktree, before its first agent run. */
  readonly onWorktreeCreated?: (worktreePath: string) => void;
  readonly providerPauseController?: ProviderPauseController;
  readonly childRuns?: ChildRunScheduler;
  /** Root directory used when a Task has no dedicated worktree. Defaults to process.cwd(). */
  readonly owlRoot?: string;
  /** Durable runtime data directory. Defaults to `<owlRoot>/data`. */
  readonly dataDir?: string;
  readonly ruleStore?: RuleStore;
  readonly skillBox?: SkillBox;
  readonly memoryInjector?: Pick<IndexInjector, "compose">;
  readonly getProcessSkillsPack?: () => { readonly skills_dir: string; readonly source: "setting" | "claude" | "codex" } | null;
  /** Settings for the Worker's read-only researcher subagent, read at every Worker launch. */
  readonly getResearchSubagentSettings?: () => ResearchSubagentSettings;
  /** How often checkStaleAgents scans for dead/idle agents. Defaults to 60 seconds. */
  readonly staleCheckIntervalMs?: number;
  /** Where baseline checkouts for Core test runs go. Defaults to `<owlRoot>/.owl-workspaces`. */
  readonly workspaceRoot?: string;
  /** Replaces the process-starting runner of Core test runs (tests). */
  readonly testCommandRunner?: TestCommandRunner;
  /** Where Core test runs report their start, end and output. */
  readonly coreActivity?: CoreActivityReporter;
  readonly testDetectionRules?: TestDetectionRules;
}

/**
 * Dependency resolution, capacity gating, launching, and Work completion are
 * deliberately command producers. They never write a Work/Task state column;
 * every state mutation goes through StateReducer in the same WriteLane
 * transaction as its canonical event and websocket outbox entry.
 */

const WF_MODEL_SETTINGS_KEY = "model_settings";

export function resolveRoleModel(db: Pick<CoreDatabase, "get">, role: string): { model: string; provider: string; effort?: string } | undefined {
  const row = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", WF_MODEL_SETTINGS_KEY);
  if (!row) return DEFAULT_ROLE_MODELS[role as keyof typeof DEFAULT_ROLE_MODELS];
  let parsed: { roles?: unknown };
  try {
    parsed = JSON.parse(row.value_json) as { roles?: unknown };
  } catch (error) {
    throw validationError("Stored model settings are not valid JSON.", {
      key: WF_MODEL_SETTINGS_KEY,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.roles)) {
    throw validationError("Stored model settings must contain a roles array.", { key: WF_MODEL_SETTINGS_KEY });
  }
  const found = parsed.roles.find((candidate): candidate is { role?: unknown; model?: unknown; provider?: unknown; effort?: unknown } => (
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
  ) && (candidate as { role?: unknown }).role === role);
  // Settings stored before the Designer existed have no designer entry.
  if (!found && role === "designer") return DEFAULT_ROLE_MODELS.designer;
  if (!found && role === "lead_designer") return DEFAULT_ROLE_MODELS.lead_designer;
  if (!found || typeof found.model !== "string" || found.model.trim().length === 0 || typeof found.provider !== "string" || found.provider.trim().length === 0) {
    throw validationError(`Stored model settings are missing a valid ${role} provider/model.`, { key: WF_MODEL_SETTINGS_KEY, role });
  }
  if (found.effort !== undefined && (typeof found.effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(found.effort))) {
    throw validationError(`Stored model settings contain an invalid ${role} effort.`, { key: WF_MODEL_SETTINGS_KEY, role });
  }
  return { model: found.model, provider: found.provider.trim().toLowerCase(), effort: found.effort as string | undefined };
}

/** Order-aware added/deleted line counts; a reordered line counts as deleted and added. Counts everything when too large. */
function diffLineCounts(before: string[], after: string[]): { added: number; deleted: number } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  if (a.length * b.length > 4_000_000) return { added: b.length, deleted: a.length };
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) row[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!);
    previous = row;
  }
  const common = previous[b.length]!;
  return { added: b.length - common, deleted: a.length - common };
}

const execFileAsync = promisify(execFile);

export class WorkflowEngine {
  private readonly db: CoreDatabase;
  private readonly contextBuilder: ContextBuilder;
  /** Project-less Task id -> worktree state before its first Worker started; the baseline for measuring what the Task changed. */
  private readonly worktreeBaselines = new Map<string, Map<string, WorktreeEntry>>();
  /** The lineage generation each recorded baseline belongs to; a later generation of the same Task id starts a new baseline. */
  private readonly baselineGeneration = new Map<string, number>();
  private readonly writeLane;
  private readonly agentRunner: AgentRunner;
  private readonly git: GitGateway;
  /** Per-Work cap on active non-Executor agent runs; null means unlimited. */
  private readonly maxParallel: number | null;
  /** Cap on active non-Executor agent runs across all Works; null means unlimited. */
  private readonly globalMaxParallel: number | null;
  private readonly onManagerReplanNeeded?: (input: ManagerReplanNeededInput) => Promise<void>;
  private readonly onTaskSettled?: (workId: string) => void;
  private readonly onTaskPipelineSettled?: (workId: string, taskId: string) => void;
  private readonly onWorktreeCreated?: (worktreePath: string) => void;
  private readonly providerPauseController?: ProviderPauseController;
  private readonly childRuns?: ChildRunScheduler;
  private readonly reviewerRetriesInFlight = new Set<string>();
  /** In-process Task pipelines, keyed by the Worker's agent_run_id. */
  private readonly pipelines = new Map<string, Promise<void>>();
  private readonly pipelineTasks = new Map<string, { readonly workId: string; readonly taskId: string }>();
  private readonly owlRoot: string;
  private readonly dataDir: string;
  private readonly ruleStore?: RuleStore;
  private readonly skillBox?: SkillBox;
  private readonly memoryInjector?: Pick<IndexInjector, "compose">;
  private readonly getProcessSkillsPack?: () => { readonly skills_dir: string; readonly source: "setting" | "claude" | "codex" } | null;
  private readonly getResearchSubagentSettings?: () => ResearchSubagentSettings;
  private readonly verificationChildren = new Set<ChildProcess>();
  private readonly workspaceRoot: string;
  private readonly testCommandRunner?: TestCommandRunner;
  private readonly coreActivity: CoreActivityReporter;
  private readonly testDetectionRules: TestDetectionRules;
  /** Serialises baseline checkouts per Project (one path each). */
  private readonly baselineLocks = new Map<string, Promise<unknown>>();
  private running = false;
  private stopping = false;
  private staleCheckInterval: ReturnType<typeof setInterval> | null = null;
  private subagentScanInterval: ReturnType<typeof setInterval> | null = null;
  private subagentScanInFlight = false;
  private readonly gatingAgentRuns = new Set<string>();
  private readonly idleAlertedAgentRuns = new Map<string, string>();
  /**
   * Worker/Reviewer runs whose process looked dead on the last scan, keyed by
   * agent_run_id. A process that just exited normally is still reflected in
   * `pid`/identity columns for a brief window before its own exit handler
   * clears them, so the first dead-pid observation is recorded rather than
   * acted on; only a run whose pid is still the same one two scans later is
   * a real orphan.
   */
  private readonly deadPidSeen = new Map<string, { pid: number; at: number }>();
  private readonly staleCheckIntervalMs: number;
  /**
   * A running agent with no output for this long raises `agent.idle`. The
   * alert never stops the process; the provider's no-output limit, which is
   * never shorter than this threshold, does.
   */
  private static readonly STALE_THRESHOLD_MS = AGENT_STALE_THRESHOLD_MS;

  public constructor(options: WorkflowEngineOptions) {
    this.db = options.db;
    this.writeLane = options.db.createWriteLane();
    this.agentRunner = options.agentRunner;
    this.onManagerReplanNeeded = options.onManagerReplanNeeded;
    this.onTaskSettled = options.onTaskSettled;
    this.onTaskPipelineSettled = options.onTaskPipelineSettled;
    this.onWorktreeCreated = options.onWorktreeCreated;
    this.providerPauseController = options.providerPauseController;
    this.childRuns = options.childRuns;
    this.owlRoot = options.owlRoot ?? defaultOwlRoot();
    this.dataDir = options.dataDir ?? join(this.owlRoot, "data");
    this.workspaceRoot = options.workspaceRoot ?? join(this.owlRoot, ".owl-workspaces");
    this.testCommandRunner = options.testCommandRunner;
    this.coreActivity = options.coreActivity ?? NO_CORE_ACTIVITY;
    this.testDetectionRules = options.testDetectionRules ?? DEFAULT_TEST_DETECTION_RULES;
    this.git = options.git ?? new GitWorktreeGateway(options.db, this.owlRoot);
    this.ruleStore = options.ruleStore;
    this.skillBox = options.skillBox;
    this.memoryInjector = options.memoryInjector;
    this.contextBuilder = new ContextBuilder(this.db, this.dataDir, { ruleStore: this.ruleStore, skillBox: this.skillBox, memoryInjector: this.memoryInjector });
    this.getProcessSkillsPack = options.getProcessSkillsPack;
    this.getResearchSubagentSettings = options.getResearchSubagentSettings;
    this.maxParallel = resolveMaxParallel(options.maxParallel);
    if (options.globalMaxParallel !== undefined && (!Number.isSafeInteger(options.globalMaxParallel) || options.globalMaxParallel < 1)) {
      throw validationError("dispatcher.global_max_parallel must be a positive integer.", { global_max_parallel: options.globalMaxParallel });
    }
    this.globalMaxParallel = options.globalMaxParallel ?? null;
    this.staleCheckIntervalMs = options.staleCheckIntervalMs ?? 60_000;
  }

  private projectIdOf(workId: string): { project_id?: string } {
    const projectId = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id;
    return projectId ? { project_id: projectId } : {};
  }

  public composeSkillsForWork(workId: string): string | null {
    return this.contextBuilder.skills(workId);
  }

  public composeKnowledgeForTask(workId: string, taskId: string | null, role: "designer" | "worker" | "reviewer" = "worker", changedFiles: readonly string[] | null = null): Promise<string | null> {
    return this.contextBuilder.knowledge(workId, taskId, role, changedFiles);
  }

  public start(): void {
    this.running = true;
  }

  public async stop(): Promise<void> {
    this.stopImmediately();
    await this.writeLane.drain();
  }

  /** Stop scheduling and terminate every child process owned by this engine. */
  public stopImmediately(): void {
    this.running = false;
    this.stopping = true;
    this.stopStaleDetection();
    for (const child of this.verificationChildren) signalChildProcessGroup(child, "SIGKILL");
    terminateActiveExecutorsImmediately();
  }

  public startStaleDetection(): void {
    if (this.staleCheckInterval) return;
    this.staleCheckInterval = setInterval(() => this.checkStaleAgents(), this.staleCheckIntervalMs);
    this.subagentScanInterval = setInterval(() => void this.scanSubagents(), SUBAGENT_SCAN_INTERVAL_MS);
    this.subagentScanInterval.unref?.();
  }

  public stopStaleDetection(): void {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }
    if (this.subagentScanInterval) {
      clearInterval(this.subagentScanInterval);
      this.subagentScanInterval = null;
    }
  }

  /**
   * Record agent CLIs that running agents started by themselves (see
   * subagent-watcher.ts) as observed executor AgentRuns, and close them when
   * their process is gone. Works the same for every provider and harness.
   */
  public async scanSubagents(processes = listProcesses()): Promise<void> {
    if (this.subagentScanInFlight || processes === null) return;
    this.subagentScanInFlight = true;
    try {
      await this.closeOrphanedHookSubagents();
      // Hook-reported children have no process; the stop hook closes them.
      const runs = this.db.all<{ id: string; work_id: string; task_id: string | null; pid: number | null; origin: string | null }>(
        "SELECT id, work_id, task_id, pid, origin FROM agent_runs WHERE hook_agent_id IS NULL AND status IN ('launch_pending','spawned','running','cancel_requested')",
      );
      if (runs.length === 0) return;
      const plan = planSubagentReconciliation(processes, runs, agentCliNames(), installedAgentCliMatches);
      const runById = new Map(runs.map((run) => [run.id, run]));
      for (const runId of plan.exited) {
        const run = runById.get(runId);
        if (!run) continue;
        await this.writeLane.write({
          mutateState: (transaction: CoreWriteLaneTransaction) => {
            const now = utcNow();
            transaction.run(
              `UPDATE agent_runs
                  SET status = CASE WHEN status = 'cancel_requested' THEN 'cancelled' ELSE 'exited' END,
                      pid = NULL, ended_at = COALESCE(ended_at, ?), updated_at = ?
                WHERE id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')`,
              now,
              now,
              runId,
            );
            return { agent_run_id: runId };
          },
          event: {
            idempotencyKey: `subagent-exited:${runId}`,
            type: "subagent.exited",
            workId: run.work_id,
            taskId: run.task_id,
            agentRunId: runId,
            payload: { agent_run_id: runId },
          },
          outbox: [{ provider: "websocket" }],
        });
      }
      for (const found of plan.detected) {
        const parent = runById.get(found.parent_run_id);
        if (!parent) continue;
        const runId = createUlid();
        const identity = readProcessIdentity(found.pid);
        await this.writeLane.write({
          mutateState: (transaction: CoreWriteLaneTransaction) => {
            const now = utcNow();
            transaction.run(
              `INSERT INTO agent_runs
                 (id, work_id, task_id, parent_agent_id, role, origin, provider, model, status, label, pid,
                  process_start_time, process_cmdline_sha256, started_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'executor', 'observed', ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
              runId,
              parent.work_id,
              parent.task_id,
              parent.id,
              found.provider,
              found.model ?? "unknown",
              found.label,
              found.pid,
              identity.process_start_time,
              identity.process_cmdline_sha256,
              identity.process_start_time ?? now,
              now,
              now,
            );
            return { agent_run_id: runId };
          },
          event: {
            idempotencyKey: `subagent-detected:${runId}`,
            type: "subagent.detected",
            workId: parent.work_id,
            taskId: parent.task_id,
            agentRunId: runId,
            payload: {
              agent_run_id: runId,
              parent_agent_run_id: parent.id,
              provider: found.provider,
              label: found.label,
            },
          },
          outbox: [{ provider: "websocket" }],
        });
      }
    } catch (error) {
      console.error("[owl-core] Subagent scan failed", error);
    } finally {
      this.subagentScanInFlight = false;
    }
  }

  /**
   * A Worker's own subagent as its harness reported it (SubagentStart / Stop
   * hook). Only the id and type are kept, never the hook's prompt or other
   * input. A repeated start or stop changes nothing. A usage upload stores
   * the subagent's request token counts; a repeated one adds no rows.
   */
  public recordHookSubagent(
    parentRunId: string,
    input: HookSubagentInput,
  ): Promise<{ readonly agent_run_id: string | null; readonly changed: boolean }> {
    // One notification at a time, so the lookup and the write cannot interleave.
    const run = this.hookSubagentChain.then(() => this.recordHookSubagentNow(parentRunId, input));
    this.hookSubagentChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private hookSubagentChain: Promise<void> = Promise.resolve();

  private async recordHookSubagentNow(
    parentRunId: string,
    input: HookSubagentInput,
  ): Promise<{ readonly agent_run_id: string | null; readonly changed: boolean }> {
    const parent = this.db.get<{ id: string; work_id: string; task_id: string | null; provider: string; model: string }>(
      "SELECT id, work_id, task_id, provider, model FROM agent_runs WHERE id = ? AND role = 'worker'",
      parentRunId,
    );
    if (!parent) return { agent_run_id: null, changed: false };
    const existing = this.db.get<{ id: string; status: string }>(
      "SELECT id, status FROM agent_runs WHERE parent_agent_id = ? AND hook_agent_id = ?",
      parent.id,
      input.agentId,
    );
    if (input.event === "usage") {
      // Without a recorded start, the rows belong to the Worker's own run.
      const runId = existing?.id ?? parent.id;
      const inserted = await this.writeLane.transact((tx) => insertRequestUsageRows(tx, input.requests.map((request) => ({
        ...request, agent_run_id: runId, work_id: parent.work_id, child_run_id: null, provider: parent.provider, subagent: true,
      }))));
      return { agent_run_id: runId, changed: inserted > 0 };
    }
    if (input.event === "start") {
      if (existing) return { agent_run_id: existing.id, changed: false };
      const runId = createUlid();
      const label = input.agentType ?? "subagent";
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = utcNow();
          transaction.run(
            `INSERT INTO agent_runs
               (id, work_id, task_id, parent_agent_id, role, origin, provider, model, status, label, hook_agent_id,
                started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'executor', 'observed', ?, ?, 'running', ?, ?, ?, ?, ?)`,
            runId, parent.work_id, parent.task_id, parent.id, parent.provider, parent.model, label, input.agentId, now, now, now,
          );
          return { agent_run_id: runId };
        },
        event: {
          idempotencyKey: `subagent-detected:${runId}`,
          type: "subagent.detected",
          workId: parent.work_id,
          taskId: parent.task_id,
          agentRunId: runId,
          payload: { agent_run_id: runId, parent_agent_run_id: parent.id, provider: parent.provider, label },
        },
        outbox: [{ provider: "websocket" }],
      });
      return { agent_run_id: runId, changed: true };
    }
    if (!existing || existing.status !== "running") return { agent_run_id: existing?.id ?? null, changed: false };
    await this.closeHookSubagent(existing.id, parent.work_id, parent.task_id);
    return { agent_run_id: existing.id, changed: true };
  }

  private async closeHookSubagent(runId: string, workId: string, taskId: string | null): Promise<void> {
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const now = utcNow();
        transaction.run(
          "UPDATE agent_runs SET status = 'exited', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ? AND status = 'running'",
          now, now, runId,
        );
        return { agent_run_id: runId };
      },
      event: {
        idempotencyKey: `subagent-exited:${runId}`,
        type: "subagent.exited",
        workId,
        taskId,
        agentRunId: runId,
        payload: { agent_run_id: runId },
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  /**
   * Hook-reported children with no live ancestor never get a stop hook. An
   * ancestor that is active, or whose completion gate is still running, keeps
   * them open: a finished intermediate parent (e.g. an executor) is not enough.
   */
  private async closeOrphanedHookSubagents(): Promise<void> {
    const running = this.db.all<{ id: string; work_id: string; task_id: string | null; parent_agent_id: string | null }>(
      "SELECT id, work_id, task_id, parent_agent_id FROM agent_runs WHERE hook_agent_id IS NOT NULL AND status = 'running'",
    );
    const active = new Set(["launch_pending", "spawned", "running", "cancel_requested"]);
    for (const child of running) {
      let alive = false;
      const seen = new Set<string>();
      for (let id = child.parent_agent_id; id && !seen.has(id) && !alive; ) {
        seen.add(id);
        const row = this.db.get<{ parent_agent_id: string | null; status: string }>("SELECT parent_agent_id, status FROM agent_runs WHERE id = ?", id);
        if (!row) break;
        alive = active.has(row.status) || this.gatingAgentRuns.has(id);
        id = row.parent_agent_id;
      }
      if (!alive) await this.closeHookSubagent(child.id, child.work_id, child.task_id);
    }
  }

  private checkStaleAgents(): void {
    // Observed subagents are reconciled by scanSubagents(), and Owl cannot
    // see their output, so neither crash nor idle detection applies to them.
    const agents = this.db.all<{ id: string; work_id: string; task_id: string | null; role: string; status: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null; last_output_at: string | null; updated_at: string }>(
      "SELECT id, work_id, task_id, role, status, pid, process_start_time, process_cmdline_sha256, last_output_at, updated_at FROM agent_runs WHERE status IN ('launch_pending','spawned','running','cancel_requested') AND (origin IS NULL OR origin <> 'observed')",
    );
    const activeIds = new Set(agents.map((agent) => agent.id));
    for (const id of this.idleAlertedAgentRuns.keys()) {
      if (!activeIds.has(id)) this.idleAlertedAgentRuns.delete(id);
    }
    for (const id of this.deadPidSeen.keys()) {
      if (!activeIds.has(id)) this.deadPidSeen.delete(id);
    }
    for (const run of agents) {
      let processFailure: string | null = null;
      if (run.pid != null && run.pid > 0) {
        try {
          process.kill(run.pid, 0);
          const expected = {
            process_start_time: run.process_start_time,
            process_cmdline_sha256: run.process_cmdline_sha256,
          };
          const observed = readProcessIdentity(run.pid);
          const identityAvailable = expected.process_start_time !== null
            && expected.process_cmdline_sha256 !== null
            && observed.process_start_time !== null
            && observed.process_cmdline_sha256 !== null;
          if (identityAvailable && !processIdentityMatches(expected, observed)) {
            processFailure = "process_identity_mismatch";
          }
        } catch {
          processFailure = "process_died_without_report";
        }
      }
      // A child Executor's exit is recorded by its own close handler;
      // reconciling it here would race that handler.
      if (processFailure !== null && run.role === "executor") continue;
      // A Worker/Reviewer CLI that exits normally still has its old pid on
      // this row for a brief window before its own exit handler clears it,
      // which a scan landing in that window would otherwise misread as a
      // crash. Only a pid still dead on a second, later scan is a real orphan.
      if (processFailure !== null && (run.role === "worker" || run.role === "designer" || run.role === "reviewer")) {
        const seen = this.deadPidSeen.get(run.id);
        if (!seen || seen.pid !== run.pid) {
          this.deadPidSeen.set(run.id, { pid: run.pid ?? -1, at: Date.now() });
          continue;
        }
        this.deadPidSeen.delete(run.id);
      } else if (processFailure === null) {
        this.deadPidSeen.delete(run.id);
      }
      if (processFailure !== null) {
        if (run.status === "cancel_requested") {
          void this.writeLane.write({
            mutateState: (transaction) => {
              const now = utcNow();
              transaction.run(
                "UPDATE agent_runs SET status = 'cancelled', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ? AND status = 'cancel_requested'",
                now, now, run.id,
              );
              return { agent_run_id: run.id, cancelled: true };
            },
            event: {
              idempotencyKey: `stale-cancel:${run.id}`,
              type: "agent.exited",
              workId: run.work_id,
              taskId: run.task_id,
              agentRunId: run.id,
              payload: { agent_run_id: run.id, outcome: "cancelled", result_ignored: true },
            },
            outbox: [{ provider: "websocket" }],
          }).catch((error) => console.error(`[stale-detect] Failed to reconcile cancelled agent ${run.id}`, error));
          continue;
        }
        const payload: JsonObject = {
          role: run.role,
          report_present: false,
          error_key: processFailure,
          pid: run.pid,
        };
        if (run.task_id && (run.role === "worker" || run.role === "designer" || run.role === "reviewer")) {
            void this.writeFailureEvent(run.work_id, run.task_id, run.id, payload, "agent.crashed")
              .catch((error) => console.error(`[stale-detect] Failed to reconcile crashed agent ${run.id}`, error));
        } else {
          void this.writeLane.write({
            mutateState: (transaction) => {
              const now = utcNow();
              transaction.run(
                "UPDATE agent_runs SET status = 'failed', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('launch_pending','spawned','running')",
                now, now, run.id,
              );
              return { agent_run_id: run.id };
            },
            event: {
              idempotencyKey: `stale-crash:${run.id}`,
              type: "agent.crashed",
              workId: run.work_id,
              taskId: run.task_id,
              agentRunId: run.id,
              payload,
            },
            outbox: [{ provider: "websocket" }],
          }).catch((error) => console.error(`[stale-detect] Failed to record stale agent ${run.id}`, error));
        }
        console.log(`[stale-detect] Agent ${run.id} (pid ${run.pid ?? "unknown"} ${processFailure}) → reconciled`);
        continue;
      }
      const outputAt = Date.parse(run.last_output_at ?? run.updated_at);
      if (!Number.isFinite(outputAt) || Date.now() - outputAt <= WorkflowEngine.STALE_THRESHOLD_MS) continue;
      const outputMarker = run.last_output_at ?? run.updated_at;
      if (this.idleAlertedAgentRuns.get(run.id) === outputMarker) continue;
      this.idleAlertedAgentRuns.set(run.id, outputMarker);
      const thresholdSeconds = Math.floor(WorkflowEngine.STALE_THRESHOLD_MS / 1000);
      this.writeLane.write({
        mutateState: () => ({ agent_run_id: run.id, idle: true }),
        event: {
          idempotencyKey: `agent-idle:${run.id}:${outputMarker}`,
          type: "agent.idle",
          workId: run.work_id,
          taskId: run.task_id,
          agentRunId: run.id,
          payload: {
            agent_run_id: run.id,
            threshold_seconds: thresholdSeconds,
            last_output_at: outputMarker,
            action: "notify_only",
          },
        },
        outbox: [{ provider: "websocket" }],
      }).catch((error) => console.error(`[stale-detect] Failed to record idle alert for ${run.id}`, error));
      console.log(`[stale-detect] Agent ${run.id} has produced no output for more than ${thresholdSeconds}s → alert only`);
    }
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async registerPlan(
    workId: string,
    items: readonly TaskPlanItem[],
    managerEvent: "work.planned" | "task.replanned" | "system.alert" = "system.alert",
  ): Promise<readonly TaskRow[]> {
    const eventId = `plan-registered:${workId}:${createUlid()}`;
    const result = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const work = transaction.get<{ plan_revision: number }>("SELECT plan_revision FROM works WHERE id = ?", workId);
        if (!work) throw validationError("Cannot register a Task plan for a missing Work.", { work_id: workId });
        transaction.run("UPDATE works SET plan_revision = plan_revision + 1, updated_at = ? WHERE id = ?", utcNow(), workId);
        return createTaskPlanInTransaction(transaction, workId, items);
      },
      event: {
        idempotencyKey: eventId,
        type: managerEvent,
        workId,
        payload: {
          kind: "task_plan_registered",
          task_count: items.length,
          manager_event: managerEvent,
          created_at: utcNow(),
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    return result.state;
  }

  /**
   * Apply a validated Manager replan in ONE WriteLane transaction (see
   * applyReplanInTransaction): new Tasks, retried Tasks (Task rows 20/20b)
   * with their revised instructions and dependencies, replaced Tasks (row 30)
   * with their dependents re-pointed, cascade restores (row 31) and a single
   * plan_revision bump. The Work state, the plan revision and every root
   * Task's status are re-checked inside the transaction; an abort
   * (REPLAN_WORK_NOT_RUNNING / REPLAN_PLAN_STALE) or any other error writes
   * nothing.
   */
  public async applyReplan(
    workId: string,
    plan: ReplanPlan,
    guard: ReplanApplyGuard,
    reason: string,
    consumedOwnerReplanKey?: string,
    options: {
      readonly afterApply?: (transaction: CoreWriteLaneTransaction, applied: ReplanApplyResult) => void;
      readonly prerequisites?: ReadonlyMap<string, PrerequisiteSpec>;
    } = {},
  ): Promise<ReplanApplyResult> {
    const result = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const state = applyReplanInTransaction(transaction, workId, plan, guard, reason, options.prerequisites);
        // A wait on the Owner can only end by an answer: open the Decision now (deduplicated by its reason).
        for (const [taskId, spec] of options.prerequisites ?? []) {
          const owner = spec.conditions.filter((condition) => condition.kind === "owner");
          if (owner.length === 0) continue;
          const title = transaction.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId)?.title ?? taskId;
          const brief = prerequisiteExpiredBrief(
            { taskId, taskTitle: title, kind: "owner", detail: owner.map((condition) => condition.description).join(" / "), reason: spec.reason, conditions: spec.conditions.map((condition) => condition.description) },
            ownerLanguage(transaction),
          );
          const known = transaction.get<{ id: string }>("SELECT id FROM decisions WHERE work_id = ? AND status = 'open' AND reason = ?", workId, brief.reason);
          const decisionId = openRemakeLimitDecisionInTransaction(transaction, { workId, blockedTaskIds: [taskId], brief, now: utcNow() });
          // The same notification event decisions.open emits (the dispatcher delivers it).
          if (known === undefined) {
            appendEventInTransaction(transaction, {
              type: "decision.opened",
              idempotencyKey: `decision-opened:owner-wait:${decisionId}`,
              workId,
              taskId: null,
              payload: { work_id: workId, scope: "work", blocked_task_ids: [taskId], ...brief, allow_free_text: true, issuer_role: "core", decision_id: decisionId, language: ownerLanguage(transaction) } as unknown as JsonObject,
            });
          }
        }
        // The Owner's replan request that produced this plan is now applied;
        // clear it in the same transaction so a crash right after this write
        // never leaves it in limbo between attempted and queued.
        if (consumedOwnerReplanKey !== undefined) {
          transaction.run(
            `DELETE FROM idempotency_keys
              WHERE key = ? AND json_extract(response_json, '$.status') = 'attempted'`,
            consumedOwnerReplanKey,
          );
        }
        options.afterApply?.(transaction, state);
        return state;
      },
      event: {
        idempotencyKey: `task-replan-applied:${workId}:${guard.base_plan_revision}`,
        type: "task.replanned",
        workId,
        payload: {
          kind: "manager_replan_applied",
          work_id: workId,
          task_ids: [...plan.reopenIds],
          new_task_local_ids: plan.newItems.map((item, index) => item.manager_task_id ?? item.id ?? `item-${index + 1}`),
          superseded_task_ids: [...plan.supersessions.keys()],
          base_plan_version: guard.base_plan_revision,
          current_plan_version: guard.base_plan_revision,
          reason,
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    return result.state;
  }

  /** Detect cycles before changing any task state. */
  public validateDependencies(workId: string): void {
    assertTaskDependencyGraph(this.db, workId);
  }

  /** Promote waiting Tasks whose dependencies are all completed. */
  public async resolveDependencies(workId: string): Promise<readonly string[]> {
    this.validateDependencies(workId);
    const waiting = this.db.all<{ id: string }>(
      "SELECT id FROM tasks WHERE work_id = ? AND status = 'waiting' AND prerequisite_json IS NULL ORDER BY priority DESC, created_at ASC",
      workId,
    );
    const ready: string[] = [];
    for (const task of waiting) {
      const dependencies = this.db.all<{ status: string }>(
        `SELECT dependency.status AS status
           FROM task_dependencies AS edge
           JOIN tasks AS dependency ON dependency.id = edge.depends_on_task_id
          WHERE edge.task_id = ?`,
        task.id,
      );
      if (dependencies.some((dependency) => dependency.status === "cancelled")) {
        throw validationError("A cancelled dependency cannot be promoted to ready.", { task_id: task.id });
      }
      const completed = dependencies.every((dependency) => dependency.status === "completed");
      if (!completed) {
        continue;
      }
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) =>
          reduceTaskInTransaction(transaction, task.id, {
            event: "task.ready",
            payload: { dependencies_completed: true },
          }),
        event: {
          // The same Task can return to waiting when a Manager replan adds a
          // dependency, then become ready again after that dependency finishes.
          // Each transition is a separate event; the Task ID alone is not unique.
          idempotencyKey: `task-ready:${task.id}:${createUlid()}`,
          type: "task.ready",
          taskId: task.id,
          workId,
          payload: { task_id: task.id, dependencies_completed: true },
        },
        outbox: [{ provider: "websocket" }],
      });
      ready.push(task.id);
    }
    return ready;
  }

  public async snapshot(workId: string): Promise<WorkflowSnapshot> {
    const tasks = this.db.all<{ id: string; status: string }>("SELECT id, status FROM tasks WHERE work_id = ?", workId);
    return {
      work_id: workId,
      ready_task_ids: tasks.filter((task) => task.status === "ready").map((task) => task.id),
      running_task_ids: tasks.filter((task) => task.status === "running" || task.status === "verifying").map((task) => task.id),
      completed_task_ids: tasks.filter((task) => task.status === "completed").map((task) => task.id),
      capacity: this.launchCapacity(this.db, workId),
    };
  }

  /**
   * Agent runs this Work may still start: the per-Work limit minus the Work's
   * active non-Executor runs, capped by what the global limit leaves free.
   * Unset limits impose no cap (every ready Task may start at once).
   */
  private launchCapacity(reader: Pick<CoreDatabase, "get">, workId: string): number {
    if (this.maxParallel === null && this.globalMaxParallel === null) return Infinity;
    const counts = reader.get<{ work_active: number; all_active: number }>(
      `SELECT COALESCE(SUM(CASE WHEN work_id = ? THEN 1 ELSE 0 END), 0) AS work_active, COUNT(*) AS all_active
         FROM agent_runs
        WHERE role <> 'executor' AND status IN ('launch_pending', 'spawned', 'running', 'cancel_requested')`,
      workId,
    );
    const workFree = this.maxParallel === null ? Infinity : this.maxParallel - Number(counts?.work_active ?? 0);
    const globalFree = this.globalMaxParallel === null ? Infinity : this.globalMaxParallel - Number(counts?.all_active ?? 0);
    return Math.max(0, Math.min(workFree, globalFree));
  }

  /** Wait for every in-process Task pipeline to settle. */
  public async drainPipelines(): Promise<void> {
    while (this.pipelines.size > 0) {
      await Promise.allSettled([...this.pipelines.values()]);
    }
  }

  /**
   * Run a started Task's Worker, verification, review and merge without
   * holding up the launch of other Tasks.
   */
  private startPipeline(workId: string, taskId: string, agentRunId: string, generation: number): void {
    if (this.pipelines.has(agentRunId)) {
      console.error(`[owl-core] Task ${taskId} already has a pipeline for agent run ${agentRunId}; not starting another.`);
      return;
    }
    const pipeline = this.runWorker(workId, taskId, agentRunId, generation)
      .catch((error: unknown) => console.error(`[owl-core] Task ${taskId} pipeline failed outside the normal recovery path`, error))
      .finally(() => {
        this.pipelines.delete(agentRunId);
        this.pipelineTasks.delete(agentRunId);
        try {
          this.onTaskPipelineSettled?.(workId, taskId);
        } catch (error) {
          console.error(`[owl-core] Task pipeline settle notification failed for Task ${taskId}`, error);
        }
        try {
          this.onTaskSettled?.(workId);
        } catch (error) {
          console.error(`[owl-core] Task settle notification failed for Work ${workId}`, error);
        }
      });
    this.pipelines.set(agentRunId, pipeline);
    this.pipelineTasks.set(agentRunId, { workId, taskId });
  }

  /** Tasks whose Worker, verification, review or merge pipeline is in flight in this process. */
  public activePipelineTasks(): readonly { readonly workId: string; readonly taskId: string }[] {
    return [...this.pipelineTasks.values()];
  }

  private isWorkRunning(workId: string): boolean {
    return this.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId)?.state === "running";
  }

  /** Match providerSelection's configured/default Provider when a role has no model override. */
  private providerForRoleModel(
    roleModel: { provider: string } | undefined,
  ): string {
    if (roleModel) return roleModel.provider;
    const configuredProvider = process.env.OWL_PROVIDER_ID?.trim() || "anthropic";
    return normalizeProviderId(configuredProvider);
  }

  /**
   * Launch ready Tasks up to the CPU/memory protection limit. Each started
   * Task runs its own pipeline; this returns once the Tasks are started.
   */
  public async launchReady(workId: string): Promise<readonly string[]> {
    if (!this.running) {
      return [];
    }
    const launchable = this.db.all<{ id: string; type: string }>(
      `SELECT id, type FROM tasks
        WHERE work_id = ? AND status IN ('ready', 'review_fix_waiting')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY priority DESC, created_at ASC`,
      workId,
      utcNow(),
    );
    const launched: string[] = [];
    const conflicted: { taskId: string; trigger: TaskReplanTrigger }[] = [];
    let preparationFailure: Error | null = null;
    for (const { id: taskId, type } of launchable) {
      // Pause, cancel, a blocking Decision or engine shutdown can land while
      // an earlier iteration awaited the worktree or the WriteLane.
      if (!this.running || !this.isWorkRunning(workId)) break;
      const leadStart = this.db.get<{ lead_designer_start_round: number | null }>(
        "SELECT lead_designer_start_round FROM tasks WHERE id = ?", taskId,
      )?.lead_designer_start_round ?? null;
      const role = type === "design" ? "designer" : "worker";
      const roleModel = resolveRoleModel(this.db, type === "design" && leadStart !== null ? "lead_designer" : role);
      const roleProvider = this.providerForRoleModel(roleModel);
      if (this.providerPauseController?.isPaused(roleProvider)) {
        // A stop-report run must not wait for the provider: the Owner is asked without the Designer's report.
        if (type === "design") await this.stopDesignWithoutReport(workId, taskId, roleProvider);
        continue;
      }
      const current = await this.snapshot(workId);
      if (current.capacity <= 0) break;
      const prepared = await this.git.prepareWorktree({ work_id: workId, task_id: taskId });
      if (!prepared.ok && prepared.failure_kind === "work_sync_conflict") {
        // Retrying would hit the same conflict, and it concerns this Task
        // alone: fail it for replanning and keep launching the others.
        const trigger = await this.recordWorkSyncConflict(workId, taskId, prepared.message);
        if (trigger !== null) conflicted.push({ taskId, trigger });
        continue;
      }
      if (!prepared.ok) {
        preparationFailure = new Error(ownerLanguage(this.db) === "en"
          ? `Could not prepare the worktree for Task ${taskId}. Cause: ${prepared.message}`
          : `Task ${taskId}のWorktree準備に失敗しました。原因: ${prepared.message}`);
        break;
      }
      if (prepared.created && prepared.worktree_path) this.onWorktreeCreated?.(prepared.worktree_path);
      if (prepared.worktree_path) {
        await this.materializeDependencyArtifacts(workId, taskId, prepared.worktree_path);
      }
      const agentRunId = createUlid();
      let writeResult;
      try {
        writeResult = await this.writeLane.write({
          mutateState: (transaction: CoreWriteLaneTransaction) => {
            const leadStart = transaction.get<{ lead_designer_start_round: number | null }>(
              "SELECT lead_designer_start_round FROM tasks WHERE id = ?", taskId,
            )?.lead_designer_start_round ?? null;
            const roleModel = resolveRoleModel(transaction, type === "design" && leadStart !== null ? "lead_designer" : role);
            const roleProvider = this.providerForRoleModel(roleModel);
            if (this.providerPauseController?.isPaused(roleProvider)) {
              throw new HumanReadableError({ code: "provider_paused", message: "The Task provider is paused.", remediation: "The Task will start when the provider resumes." });
            }
            // A Task that reached the no-progress limit by any path must not
            // start; the catch below stops it for the Owner.
            const stalled = transaction.get<{ no_progress_count: number }>("SELECT no_progress_count FROM tasks WHERE id = ?", taskId);
            if ((stalled?.no_progress_count ?? 0) >= progressGuard(transaction).no_progress_limit && !pendingExternalBlocker(transaction, taskId)) {
              throw new HumanReadableError({
                code: "no_progress_limit_reached",
                message: "The Task reached the no-progress limit.",
                remediation: "The Owner decides how to proceed.",
                details: { work_id: workId, task_id: taskId },
              });
            }
            // Capacity is counted in the same transaction that inserts the
            // run, so concurrent launches never exceed the limits.
            if (this.launchCapacity(transaction, workId) <= 0) {
              throw new HumanReadableError({
                code: "launch_capacity_exhausted",
                message: "No agent capacity is free to start this Task.",
                remediation: "The Task starts when a running agent finishes.",
                details: { work_id: workId, task_id: taskId },
              });
            }
            return reduceTaskInTransaction(transaction, taskId, {
              event: "task.started",
              payload: {
                capacity_acquired: true,
                // The launch lease holds only while the Work is still
                // running in this very transaction (not paused, cancelled
                // or blocked on a Decision since the loop check).
                launch_lease_acquired: transaction.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId)?.state === "running",
                agent_run_id: agentRunId,
                role,
                provider: roleProvider,
                model: roleModel?.model ?? DEFAULT_HARNESS_MODELS.claude,
                effort: roleModel?.effort ?? null,
                invocation_id: agentRunId,
                worktree_path: prepared.worktree_path ?? null,
              },
            });
          },
          event: {
            idempotencyKey: `task-started:${taskId}:${agentRunId}`,
            type: "task.started",
            workId,
            taskId,
            agentRunId,
            payload: { task_id: taskId, agent_run_id: agentRunId, role, worktree_path: prepared.worktree_path ?? null },
          },
          outbox: [{ provider: "websocket" }],
        });
      } catch (error) {
        // The Work left `running`, or the Task left ready/review_fix_waiting
        // (paused, cancelled), while its worktree was being prepared: skip
        // it, and stop launching when the Work itself stopped.
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "invalid_state_transition") {
          console.warn(`[owl-core] Task ${taskId} was not started: it is no longer launchable.`);
          continue;
        }
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "provider_paused") continue;
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "no_progress_limit_reached") {
          await this.writeLane.transact((transaction) => {
            stopTaskForNoProgressInTransaction(transaction, { taskId, gate: "worker", now: utcNow() });
            return null;
          });
          continue;
        }
        // Other Tasks took the free capacity meanwhile; launch again when a
        // run finishes.
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "launch_capacity_exhausted") break;
        throw error;
      }
      const task = writeResult.state.next;
      launched.push(taskId);
      this.startPipeline(workId, taskId, agentRunId, task.worker_generation);
    }
    for (const { taskId, trigger } of conflicted) {
      await this.triggerManagerReplanIfNeeded(workId, trigger);
    }
    if (preparationFailure !== null) {
      throw preparationFailure;
    }
    return launched;
  }

  /**
   * Fail a Task whose worktree conflicts with the Work branch (Task row 35)
   * and return the trigger to hand the Manager, or null when the Task left
   * ready/review_fix_waiting meanwhile.
   */
  private async recordWorkSyncConflict(workId: string, taskId: string, message: string): Promise<TaskReplanTrigger | null> {
    const taskBranch = `owl/task/${workId}/${taskId}`;
    const workBranch = `owl/work/${workId}/work`;
    const files = mergeConflictPaths(message);
    const payload: JsonObject = { task_id: taskId, task_branch: taskBranch, work_branch: workBranch, merge_conflict_files: files, message };
    try {
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => reduceTaskInTransaction(transaction, taskId, { event: "task.conflict", payload }),
        event: {
          idempotencyKey: `task-conflict:${taskId}:${createUlid()}`,
          type: "task.conflict",
          workId,
          taskId,
          payload,
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "invalid_state_transition") return null;
      throw error;
    }
    return { kind: "launch_conflict", task_id: taskId, merge_conflict_files: files };
  }

  /** Resolve dependencies, then launch ready work in one engine tick. */
  public async tick(workId: string): Promise<WorkflowSnapshot> {
    await this.resolveDependencies(workId);
    await this.launchReady(workId);
    return this.snapshot(workId);
  }

  /**
   * Complete the Work once every Task is terminal. `merge` records how the
   * Work reached its Project base branch and is kept on the event payload.
   */
  public async completeWorkIfReady(
    workId: string,
    managerFinalVerdict: string,
    merge?: JsonObject,
    learnings?: WorkLearningInput,
    unaddressedBacklogItemIds: readonly string[] = [],
  ): Promise<boolean> {
    const tasks = this.db.all<{ status: string }>("SELECT status FROM tasks WHERE work_id = ?", workId);
    const work = this.db.get<{ created_at: string; plan_revision: number; state_version: number }>(
      "SELECT created_at, plan_revision, state_version FROM works WHERE id = ?",
      workId,
    );
    // "all_tasks_completed" below means every Task is terminal, including
    // superseded (cancelled) ones (see TASK_TERMINAL_STATES).
    const allTerminal = tasks.length > 0 && tasks.every((task) => isTerminalTaskState(task.status));
    if (!allTerminal || !work) {
      return false;
    }
    if (managerFinalVerdict !== "complete") {
      return false;
    }
    const completedAt = utcNow();
    const createdAtDate = new Date(work.created_at);
    const startedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(work.created_at) &&
      Number.isFinite(createdAtDate.getTime())
      ? work.created_at
      : createdAtDate.toISOString();
    const taskCount = tasks.filter((task) => task.status === "completed").length;
    const durationMs = Math.max(0, Math.round(Date.parse(completedAt) - Date.parse(startedAt)));
    const completionPayload: JsonObject = {
      work_id: workId,
      manager_final_verdict: managerFinalVerdict,
      task_count: taskCount,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
    };
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const result = reduceWorkInTransaction(transaction, workId, {
          event: "work.completed",
          expected_version: work?.state_version,
          payload: { all_tasks_completed: true, manager_final_verdict: managerFinalVerdict, now: completedAt },
        });
        settleWorkBacklogOnCompletionInTransaction(transaction, workId, unaddressedBacklogItemIds, completedAt);
        if (learnings) {
          enqueueLearningJobInTransaction(transaction, {
            work_id: workId,
            agent_run_id: learnings.agent_run_id,
            project_id: learnings.project_id,
            lessons: learnings.lessons,
          });
        }
        return result;
      },
      event: {
        idempotencyKey: `work-completed:${workId}:${work?.state_version ?? 0}:${work?.plan_revision ?? 0}`,
        type: "work.completed",
        workId,
        payload: merge === undefined
          ? completionPayload
          : { ...completionPayload, merge },
      },
      outbox: [{ provider: "websocket" }],
    });
    return true;
  }

  /**
   * Notify Core that a Task needs a Manager replan (either the reducer set
   * manager_trigger on a failure threshold, or a Worker report explicitly
   * asked for one via needs_replanning/question_for_manager). Errors from
   * the callback are logged, not rethrown: Core.triggerManagerReplan already
   * degrades to an Owner Decision on its own failure, and a Manager-replan
   * problem must never crash the launchReady/runWorker call chain.
   */
  private async triggerManagerReplanIfNeeded(workId: string, trigger: TaskReplanTrigger): Promise<void> {
    if (!this.onManagerReplanNeeded) {
      return;
    }
    // A quarantine fix Task that could not fix its test stays failed: no replan, no Decision, and the Work goes on.
    const failed = this.db.get<{ manager_task_id: string | null }>("SELECT manager_task_id FROM tasks WHERE id = ?", trigger.task_id);
    if (failed?.manager_task_id?.startsWith(QUARANTINE_FIX_TASK_PREFIX)) return;
    try {
      await this.onManagerReplanNeeded({
        work_id: workId,
        failed_task_ids: [trigger.task_id],
        trigger,
      });
    } catch (error) {
      console.error(`[owl-core] Manager replan trigger failed for Work ${workId} Task ${trigger.task_id}`, error);
    }
  }

  private async runWorker(workId: string, taskId: string, agentRunId: string, generation: number): Promise<void> {
    try {
      await this.runWorkerInternal(workId, taskId, agentRunId, generation);
    } catch (error) {
      if (this.stopping) return;
      await this.recordWorkerFailure(workId, taskId, agentRunId, error);
    }
  }

  /**
   * A Worker run whose Task was cancelled, or whose run was cancelled or
   * already closed, has no result to record. Closes a still-active run as
   * cancelled (result ignored) and resolves true; resolves false when the
   * run still owns its Task.
   */
  private async closeAbandonedWorkerRun(workId: string, taskId: string, agentRunId: string): Promise<boolean> {
    const ownership = this.db.get<{ task_status: string; agent_status: string }>(
      `SELECT tasks.status AS task_status, agent_runs.status AS agent_status
         FROM tasks JOIN agent_runs ON agent_runs.id = ?
        WHERE tasks.id = ?`,
      agentRunId,
      taskId,
    );
    if (
      ownership &&
      isActiveAgentStatus(ownership.agent_status) &&
      ownership.task_status !== "cancelled" &&
      ownership.agent_status !== "cancel_requested"
    ) {
      return false;
    }
    if (!ownership || !isActiveAgentStatus(ownership.agent_status)) return true;
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        transaction.run(
          "UPDATE agent_runs SET status = 'cancelled', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ? AND status IN ('cancel_requested','running','spawned','launch_pending')",
          now,
          now,
          agentRunId,
        );
        return { agent_run_id: agentRunId, result_ignored: true };
      },
      event: {
        idempotencyKey: `agent-result-ignored:${agentRunId}`,
        type: "agent.exited",
        workId,
        taskId,
        agentRunId,
        payload: { agent_run_id: agentRunId, outcome: "cancelled", result_ignored: true },
      },
      outbox: [{ provider: "websocket" }],
    });
    return true;
  }

  private async recordWorkerFailure(workId: string, taskId: string, agentRunId: string, error: unknown): Promise<void> {
    const isDesigner = this.db.get<{ type: string }>("SELECT type FROM tasks WHERE id = ?", taskId)?.type === "design";
    const role = isDesigner ? "Designer" : "Worker";
    const message = formatRuntimeFailure(error, role, ownerLanguage(this.db));
    try {
      if (await this.closeAbandonedWorkerRun(workId, taskId, agentRunId)) return;
      const task = this.db.get<Pick<TaskRow, "status" | "type" | "review_override" | "review_decision">>("SELECT status, type, review_override, review_decision FROM tasks WHERE id = ?", taskId);
      if (!task) return;
      if (task.status === "running") {
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          failure_class: "deterministic",
          error_key: `${isDesigner ? "designer" : "worker"}_exception:${message}`,
          retry_allowed: false,
          report_present: false,
          reason: message,
        }, "agent.crashed");
        return;
      }
      if (task.status === "verifying") {
        const verification = await this.writeLane.write({
          mutateState: (transaction) => reduceTaskInTransaction(transaction, taskId, {
            event: "verification.completed",
            payload: {
              outcome: "fail",
              review_required: effectiveReviewRequired(task, reviewRouting(this.db)),
              agent_run_id: agentRunId,
              verification: { passed: false, source: "worker_exception", commands: [], error: message },
            },
          }),
          event: {
            idempotencyKey: `verification-failed:${agentRunId}`,
            type: "verification.completed",
            workId,
            taskId,
            agentRunId,
            payload: { task_id: taskId, agent_run_id: agentRunId, outcome: "fail", verification: { passed: false, source: "worker_exception", error: message } },
          },
          outbox: [{ provider: "websocket" }],
        });
        if (verification.state.manager_trigger) {
          await this.triggerManagerReplanIfNeeded(workId, { kind: "verification_error", task_id: taskId, message });
        }
      }
    } catch (recoveryError) {
      console.error(`[owl-core] Failed to reconcile Worker exception for Task ${taskId}`, recoveryError);
    }
  }

  private async runWorkerInternal(workId: string, taskId: string, agentRunId: string, generation: number): Promise<void> {
    if (this.stopping) return;
    // The Work may have been cancelled between task.started and here: no
    // Worker process is started for a cancelled Task or a cancelled run.
    if (await this.closeAbandonedWorkerRun(workId, taskId, agentRunId)) return;
    const taskRow = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    // A Worker session owns the full Hybrid Task, including child dispatches.
    const isDesigner = taskRow?.type === "design";
    const designTier = isDesigner && taskRow?.lead_designer_start_round != null ? "lead" : "standard";
    const role = isDesigner ? "designer" : "worker";
    const workerContext = await this.contextBuilder.buildWorkerContext(role, workId, taskId, taskRow);
    const hybridMode = !isDesigner && this.isHybridModeEnabled();
    const processSkillsPack = this.getProcessSkillsPack?.() ?? null;
    const research = isDesigner ? null : this.researchSubagentSettings();
    const runModel = this.db.get<{ provider: string; model: string }>("SELECT provider, model FROM agent_runs WHERE id = ?", agentRunId);
    const workerRoleModel = resolveRoleModel(this.db, isDesigner && designTier === "lead" ? "lead_designer" : role);
    const workerProvider = this.providerForRoleModel(workerRoleModel);
    const workerHarness = builtinProviderHarness(runModel?.provider ?? workerProvider) ?? builtinProviderHarness(workerProvider) ?? "claude";
    const designPath = isDesigner ? designDocumentPath(this.dataDir, workId, taskId) : null;
    if (designPath) await mkdir(dirname(designPath), { recursive: true, mode: 0o700 });
    const designBaseline = designPath ? await designDocumentFingerprint(designPath) : null;
    const resubmitSession = pendingReportResubmit(this.db, taskId, agentRunId, taskRow?.worktree_path ?? null);
    // Core stopped remaking this design: the Designer only reports why (design_blocked).
    const designStop = isDesigner ? parseDesignStopRecord(taskRow?.design_stop_json) : null;
    const runRequest = {
      invocation_id: agentRunId,
      language: ownerLanguage(this.db),
      work_id: workId,
      task_id: taskId,
      ...this.projectIdOf(workId),
      attempt: generation,
      context: {
        task_id: taskId,
        work_id: workId,
        worktree: taskRow?.worktree_path ?? null,
        hybrid_mode: hybridMode,
        [REPORT_RESUBMIT_LIMIT_CONTEXT_KEY]: reportResubmitLimit(this.db),
        ...(resubmitSession ? { [REPORT_RESUBMIT_SESSION_CONTEXT_KEY]: resubmitSession } : {}),
        ...(designPath ? { design_document_path: designPath, design_tier: designTier } : {}),
        ...(designStop ? { design_stop: { ...designStop, review_history: lineageReviewHistory(this.db, taskId) as unknown as JsonObject[] } } : {}),
        ...(processSkillsPack ? { process_skills_dir: processSkillsPack.skills_dir, process_skills_source: processSkillsPack.source } : {}),
        ...(research ? { research_subagent: research as unknown as JsonObject } : {}),
        ...(isDesigner ? {} : { report_check_commands: this.workerReportCheckCommands(workId, taskRow?.worktree_path ?? null) }),
        ...workerContext,
      },
      ...(workerRoleModel ? {
        model: runModel?.model ?? workerRoleModel.model,
        provider: runModel?.provider ?? workerProvider,
        effort: workerRoleModel.effort,
      } : { provider: runModel?.provider ?? workerProvider }),
    };
    let result: AgentRunResult;
    if (isDesigner) {
      result = await this.agentRunner.runDesigner(runRequest).catch(rethrowUnlessRateLimited);
    } else {
      const { legacy: _legacy, ...parentPlanContext } = readStoredTaskPlanContext(taskRow?.plan_context_json, taskRow?.context ?? null);
      this.childRuns?.registerParent({
        agent_run_id: agentRunId,
        work_id: workId,
        task_id: taskId,
        ...this.projectIdOf(workId),
        harness: workerHarness,
        workspace_dir: taskRow?.worktree_path ?? this.owlRoot,
        worktree: taskRow?.worktree_path ?? null,
        task: {
          title: taskRow?.title ?? "",
          acceptance_criteria: readStoredAcceptanceCriteria(taskRow?.acceptance_criteria_json, taskRow?.acceptance ?? ""),
          ...parentPlanContext,
          rules: workerContext.rules,
          owner_guidance: workerContext.owner_guidance,
          knowledge: workerContext.knowledge,
        },
        ...(processSkillsPack ? { process_skills_dir: processSkillsPack.skills_dir, process_skills_source: processSkillsPack.source } : {}),
      });
      await this.recordWorktreeBaseline(workId, taskRow);
      let workerReturned = false;
      try {
        result = await this.agentRunner.runWorker({
          ...runRequest,
          context: { ...runRequest.context, dispatch_enabled: this.childRuns !== undefined },
        }).catch(rethrowUnlessRateLimited);
        workerReturned = true;
        if (result.outcome === "success") {
          try {
            await this.recordDelegationMismatch(workId, taskId, agentRunId, result.report);
          } catch (error) {
            console.error(`[owl-core] Failed to compare Worker delegation with dispatches for ${agentRunId}`, error);
          }
        }
      } finally {
        await this.childRuns?.releaseParent(agentRunId, workerReturned ? "parent_ended" : "parent_cancelled");
      }
    }
    if (this.stopping) return;
    await this.recordWorkerResult(workId, taskId, agentRunId, result, generation, designBaseline, hybridMode);
  }

  /** Compare the Worker's delegation report with durable child dispatches without blocking review. */
  private async recordDelegationMismatch(
    workId: string,
    taskId: string,
    workerRunId: string,
    report: AgentRunResult["report"],
  ): Promise<void> {
    const children = this.childRuns?.list({ parent_agent_run_id: workerRunId }) ?? [];
    const mismatches: { kind: DelegationMismatchKind; detail?: string; child_id?: string }[] = [];
    const reportedChildren = new Set<string>();
    const reportObject = report && typeof report === "object" && !Array.isArray(report)
      ? report as JsonObject
      : null;
    const delegation = reportObject?.delegation && typeof reportObject.delegation === "object" && !Array.isArray(reportObject.delegation)
      ? reportObject.delegation as JsonObject
      : null;

    if (!delegation) {
      mismatches.push({ kind: "delegation_missing" });
    } else {
      if (typeof delegation.decomposition !== "string" || delegation.decomposition.trim().length === 0) {
        mismatches.push({ kind: "delegation_missing", detail: "decomposition" });
      }
      const delegated = Array.isArray(delegation.delegated) ? delegation.delegated : null;
      if (delegated === null) mismatches.push({ kind: "delegation_missing", detail: "delegated" });
      const retained = Array.isArray(delegation.retained) ? delegation.retained : null;
      if (retained === null) {
        mismatches.push({ kind: "missing_reason", detail: "retained" });
      } else {
        retained.forEach((item, index) => {
          const kept = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : null;
          if (!kept || typeof kept.part !== "string" || kept.part.trim().length === 0 || typeof kept.reason !== "string" || kept.reason.trim().length === 0) {
            mismatches.push({ kind: "missing_reason", detail: `retained[${index}]` });
          }
        });
      }

      for (const [index, item] of (delegated ?? []).entries()) {
        const assignment = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : null;
        if (!assignment || typeof assignment.child_id !== "string" || assignment.child_id.trim().length === 0) {
          mismatches.push({ kind: "unknown_child", detail: `delegated[${index}]` });
          continue;
        }
        const childId = assignment.child_id;
        if (!children.some((child) => child.id === childId) || reportedChildren.has(childId)) {
          mismatches.push({ kind: "unknown_child", detail: `delegated[${index}]`, child_id: childId });
          continue;
        }
        reportedChildren.add(childId);
      }
    }

    for (const child of children) {
      if (!reportedChildren.has(child.id)) mismatches.push({ kind: "unreported_child", child_id: child.id });
    }
    for (const child of children) {
      if (child.status === "queued" || child.status === "running") {
        mismatches.push({ kind: "unfinished_child", child_id: child.id });
      }
    }
    if (mismatches.length === 0) return;

    try {
      await this.writeLane.write({
        mutateState: () => ({ agent_run_id: workerRunId, mismatches: mismatches.length }),
        event: {
          idempotencyKey: `worker-delegation-mismatch:${workerRunId}`,
          type: "worker.delegation_mismatch",
          workId,
          taskId,
          agentRunId: workerRunId,
          payload: {
            agent_run_id: workerRunId,
            mismatches,
            reported_delegation: delegation,
            dispatches: children.map((child) => ({
              child_id: child.id,
              instruction: child.instruction,
              provider: child.provider,
              model: child.model,
              status: child.status,
            })),
          },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      console.error(`[owl-core] Failed to record delegation mismatch for ${workerRunId}`, error);
    }
  }

  /** A stored setting that fails validation drops the researcher from both the prompt and the argv; the Worker still starts. */
  private researchSubagentSettings(): ResearchSubagentSettings | null {
    try {
      return this.getResearchSubagentSettings?.() ?? null;
    } catch (error) {
      console.error("[owl-core] Researcher settings could not be read; starting the Worker without the researcher", error);
      return null;
    }
  }

  private isHybridModeEnabled(): boolean {
    const row = this.db.get<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = ?",
      HYBRID_MODE_SETTINGS_KEY,
    );
    if (!row) {
      return false;
    }
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      if (typeof parsed !== "boolean") {
        throw new Error("hybrid_mode must be a boolean");
      }
      return parsed;
    } catch (error) {
      throw validationError("Stored Hybrid Mode setting is invalid.", {
        key: HYBRID_MODE_SETTINGS_KEY,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Completion gate: a success claim the report itself contradicts never reaches verification or the Reviewer. */
  private async evaluateCompletionGate(taskId: string, agentRunId: string, result: AgentRunResult, hybridAtLaunch: boolean, taskType?: string) {
    // While the gate runs, the Worker keeps its hook-detected descendants open even if it has already ended.
    this.gatingAgentRuns.add(agentRunId);
    try {
      return await this.judgeCompletion(taskId, agentRunId, result, hybridAtLaunch, taskType);
    } finally {
      this.gatingAgentRuns.delete(agentRunId);
    }
  }

  private async judgeCompletion(taskId: string, agentRunId: string, result: AgentRunResult, hybridAtLaunch: boolean, taskType?: string) {
    // Close observed children whose process is already gone, so only genuinely unfinished ones hold the parent back.
    await this.scanSubagents();
    const type = taskType ?? this.db.get<{ type: string }>("SELECT type FROM tasks WHERE id = ?", taskId)?.type;
    // Observed children can sit under the Worker or under any of its descendants (e.g. a dispatched executor).
    const observed = this.db.all<{ id: string; status: string }>(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM agent_runs WHERE parent_agent_id = ?
         UNION SELECT r.id FROM agent_runs r JOIN tree ON r.parent_agent_id = tree.id
       )
       SELECT r.id, r.status FROM agent_runs r JOIN tree ON tree.id = r.id WHERE r.origin = 'observed'`,
      agentRunId,
    );
    const children: WorkerChild[] = [
      ...(this.childRuns?.list({ parent_agent_run_id: agentRunId }) ?? []).map((child) => ({ id: child.id, kind: "dispatched" as const, status: child.status })),
      ...observed.map((row) => ({ id: row.id, kind: "observed" as const, status: row.status })),
    ];
    return evaluateWorkerCompletion(result.report, {
      hybrid: type !== "design" && hybridAtLaunch,
      delegated_work_detected: observed.length > 0,
      children,
    });
  }

  /**
   * Send acceptance criteria that cannot be proven inside the Task to the
   * Manager: fail the Task without touching its failure or review counters
   * and ask for a rewrite of those criteria on the same Task id.
   */
  public async reportAcceptanceDefect(input: {
    readonly workId: string;
    readonly taskId: string;
    readonly source: AcceptanceDefectSource;
    readonly agentRunId: string;
    readonly defects: readonly AcceptanceDefect[];
    readonly report: JsonObject | null;
    readonly usage?: JsonObject | null;
  }): Promise<void> {
    if (input.defects.length === 0) {
      console.warn(`[owl-core] reportAcceptanceDefect called without defects for Task ${input.taskId}`);
      return;
    }
    await this.writeFailureEvent(input.workId, input.taskId, input.agentRunId, {
      task_id: input.taskId,
      source: input.source,
      defects: input.defects.map((defect) => ({ ...defect })),
      ...(input.report ? { report: input.report } : {}),
      ...(input.usage ?? {}),
    }, ACCEPTANCE_DEFECT_EVENT);
  }

  /** The Worker stopped on a problem outside the Task: fail it for the Manager; AttemptPolicy decides Manager or Owner. */
  private async reportExternalBlocker(input: {
    readonly workId: string;
    readonly taskId: string;
    readonly agentRunId: string;
    readonly blocker: ExternalBlocker;
    readonly report: JsonObject;
    readonly usage: JsonObject;
  }): Promise<void> {
    await this.writeFailureEvent(input.workId, input.taskId, input.agentRunId, {
      task_id: input.taskId,
      external_blocker: { ...input.blocker },
      error_key: "external_blocker",
      reason: input.blocker.summary,
      run_outcome: "partial",
      report: input.report,
      ...input.usage,
    }, EXTERNAL_BLOCKER_EVENT, null, { kind: "external_blocker", task_id: input.taskId, cause: input.blocker.kind });
  }

  /**
   * A partial report with pending_process is a wait, not a failure: hold the Task in waiting (row 32c) until the
   * process ends; once process_wait_max_count is used up (since the last restart of the Task's line) the same write
   * opens an Owner Decision. False (invalid shape, or waiting turned off with 0) leaves the report to be handled as an ordinary partial.
   */
  private async holdForWorkerProcess(
    workId: string,
    taskId: string,
    agentRunId: string,
    report: JsonObject,
    pending: JsonObject,
    usage: ReturnType<typeof usagePayload>,
  ): Promise<boolean> {
    const settings = progressGuard(this.db);
    let spec: PrerequisiteSpec;
    try {
      const condition = validatePendingProcess(pending);
      spec = validatePrerequisiteSpec({
        reason: condition.description,
        source: "worker",
        conditions: [condition],
        base_head: null,
        deadline_at: new Date(Date.now() + settings.process_wait_max_hours * 3_600_000).toISOString(),
        replan_question: null,
      });
    } catch (error) {
      console.warn(`[owl-core] Task ${taskId}: pending_process ignored: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    const used = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND type = ?
          AND sequence > COALESCE((SELECT MAX(sequence) FROM events
                                    WHERE task_id = ? AND type IN ('task.replanned', 'decision.resolved', 'task.prerequisite_resumed')), 0)`,
      taskId,
      PROCESS_WAIT_EVENT,
      taskId,
    )?.n ?? 0;
    if (settings.process_wait_max_count === 0) return false; // 0 turns the wait off
    // Used up: the Task still waits (nothing failed), but an Owner Decision opens in the same write instead of a relaunch.
    const exhausted = used >= settings.process_wait_max_count;
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const reduced = reduceTaskInTransaction(transaction, taskId, {
          event: PROCESS_WAIT_EVENT,
          payload: { agent_run_id: agentRunId, prerequisite: spec as unknown as JsonObject, report, ...usage },
        });
        if (exhausted) {
          const title = transaction.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId)?.title ?? taskId;
          const brief = prerequisiteExpiredBrief(
            { taskTitle: title, kind: "wait_count", detail: `process_wait_max_count=${settings.process_wait_max_count}`, reason: spec.reason, conditions: spec.conditions.map((condition) => condition.description) },
            ownerLanguage(transaction),
          );
          openRemakeLimitDecisionInTransaction(transaction, { workId, blockedTaskIds: [taskId], brief, now: utcNow() });
        }
        return reduced;
      },
      event: {
        idempotencyKey: `process-wait:${taskId}:${agentRunId}`,
        type: PROCESS_WAIT_EVENT,
        workId,
        taskId,
        agentRunId,
        payload: { task_id: taskId, agent_run_id: agentRunId, pending_process: pending, deadline_at: spec.deadline_at },
      },
      outbox: [{ provider: "websocket" }],
    });
    return true;
  }

  private async recordWorkerResult(
    workId: string,
    taskId: string,
    agentRunId: string,
    result: AgentRunResult,
    generation: number,
    designBaseline?: DesignDocumentFingerprint | null,
    hybridMode = false,
  ): Promise<void> {
    if (this.stopping) return;
    if (await this.closeAbandonedWorkerRun(workId, taskId, agentRunId)) return;
    this.recordSkillFeedback(agentRunId, result.skill_feedback);
    await this.recordReportCorrections(workId, taskId, agentRunId, result.report_corrections);
    // Every outcome below stores the tokens the Worker spent.
    const usage = usagePayload(result.usage);
    if (result.failure_class === "rate_limited") {
      await this.recordRateLimitedTask(workId, taskId, agentRunId, result, usage);
      return;
    }
    if (result.outcome === "success") await this.noteProviderSucceeded(agentRunId);
    const reportObject =
      result.report && typeof result.report === "object" && !Array.isArray(result.report)
        ? (result.report as JsonObject)
        : undefined;
    // A design Task stops without a remake when the Designer reports design_blocked, and always
    // after the stop-report run (whatever it returned): the Owner decides, the design is not accepted.
    const designTask = this.db.get<{ type: string; design_stop_json: string | null }>("SELECT type, design_stop_json FROM tasks WHERE id = ?", taskId);
    if (designTask?.type === "design") {
      const blocked = readDesignBlocked(reportObject?.design_blocked);
      if (reportObject?.design_blocked != null && blocked === null) {
        console.warn(`[owl-core] Ignoring an invalid design_blocked in the report of Agent run ${agentRunId}`);
      }
      if (blocked !== null || designTask.design_stop_json !== null) {
        const reportResult = reportObject?.result;
        const storableReport = reportResult === "success" || reportResult === "failed" || reportResult === "partial";
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          source: blocked !== null ? "designer" : "core",
          design_blocked: blocked as JsonObject | null,
          run_outcome: "not_achieved",
          ...(reportObject && storableReport ? { report: reportObject } : {}),
          ...usage,
        }, "task.design_blocked");
        return;
      }
    }
    // Consume needs_replanning/question_for_manager from the Worker report
    // regardless of outcome: a Worker can flag that its Task needs a new plan
    // even while otherwise reporting success or a classified failure.
    // Outcome and error_key are not read: a partial after a side effect arrives as side_effect_failure:report_result:partial.
    const external = reportedExternalBlocker(reportObject, designTask?.type);
    if (external.ignored !== null) console.warn(`[owl-core] Ignoring external_blocker (${external.ignored}) in the report of Agent run ${agentRunId}`);
    if (external.blocker !== null && reportObject) {
      await this.reportExternalBlocker({ workId, taskId, agentRunId, blocker: external.blocker, report: reportObject, usage });
      return;
    }
    if (reportObject && result.outcome === "success") {
      // Criteria the Task cannot prove go back to the Manager on the same Task;
      // the Worker is not restarted and the Task is not replaced.
      const defects = workerAcceptanceDefects(reportObject);
      if (defects.length > 0) {
        await this.reportAcceptanceDefect({ workId, taskId, source: "worker", agentRunId, defects, report: reportObject, usage });
        return;
      }
    }
    if (reportObject) {
      const needsReplanning = reportObject.needs_replanning === true;
      const question =
        typeof reportObject.question_for_manager === "string" && reportObject.question_for_manager.trim().length > 0
          ? reportObject.question_for_manager
          : null;
      if (needsReplanning || question !== null) {
        // Record the result and fail the Task before the Manager runs: a
        // replan only revises a failed Task (task.replanned: failed ->
        // ready), so replanning a still-running Task would lose the revision.
        const gate = result.outcome === "success" ? await this.evaluateCompletionGate(taskId, agentRunId, result, hybridMode) : null;
        const gateFields = gate && !gate.passed
          ? { error_key: gate.error_key ?? "worker_completion_gate_failed", gate_reasons: [...gate.reasons] }
          : {};
        const reportResult = reportObject.result;
        const storableReport = reportResult === "success" || reportResult === "failed" || reportResult === "partial";
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          question,
          needs_replanning: needsReplanning,
          run_outcome: !needsReplanning && question !== null ? "question" : "replan",
          ...gateFields,
          ...(storableReport ? { report: reportObject } : {}),
          ...usage,
        }, "task.replan_requested", question);
        return;
      }
    }

    if (result.outcome === "success") {
      if (result.report_valid !== true) {
        throw validationError("A successful AgentRunner result must explicitly mark its report valid.", {
          task_id: taskId,
          agent_run_id: agentRunId,
        });
      }
      if (!result.report || typeof result.report !== "object" || Array.isArray(result.report)) {
        throw validationError("A successful AgentRunner result must include a JSON report object.", {
          task_id: taskId,
          agent_run_id: agentRunId,
        });
      }
      const artifactTask = this.db.get<{ type: string; worktree_path: string | null }>("SELECT type, worktree_path FROM tasks WHERE id = ?", taskId);
      if (artifactTask?.type === "design") {
        if (!await this.acceptDesignDocument(workId, taskId, agentRunId, artifactTask.worktree_path, designBaseline ?? null, usage)) return;
      } else {
        await this.captureArtifacts(workId, taskId, agentRunId, artifactTask?.worktree_path ?? null);
      }
      if (this.stopping) return;
      const pendingProcess = (result.report as JsonObject).pending_process;
      if ((result.report as JsonObject).result === "partial" && pendingProcess && typeof pendingProcess === "object") {
        if (await this.holdForWorkerProcess(workId, taskId, agentRunId, result.report as JsonObject, pendingProcess as JsonObject, usage)) return;
      }
      const gate = await this.evaluateCompletionGate(taskId, agentRunId, result, hybridMode, artifactTask?.type);
      if (!gate.passed) {
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          failure_class: "deterministic",
          error_key: gate.error_key ?? "worker_completion_gate_failed",
          retry_allowed: true,
          gate_reasons: [...gate.reasons],
          report: result.report as JsonObject,
          ...usage,
        });
        return;
      }
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) =>
          reduceTaskInTransaction(transaction, taskId, {
            event: "agent.exited",
            payload: { outcome: "success", report_valid: true, agent_run_id: agentRunId, report: result.report, ...usage },
          }),
        event: {
          idempotencyKey: `agent-exited:${agentRunId}`,
          type: "agent.exited",
          workId,
          taskId,
          agentRunId,
          payload: { outcome: "success", report_valid: true, report: result.report, ...usage },
        },
        outbox: [{ provider: "websocket" }],
      });
      if (this.stopping) return;
      await this.runVerification(workId, taskId, agentRunId, result.report, hybridMode && artifactTask?.type !== "design");
      return;
    }

    if (result.failure_class === "transient") {
      const retryNo = Math.max(0, generation - 1);
      if (!result.error_key) {
        throw validationError("A transient AgentRunner failure must include error_key.", { task_id: taskId });
      }
      const storedTask = this.db.get<{ retry_no: number }>("SELECT retry_no FROM tasks WHERE id = ?", taskId);
      const durableRetryNo = Number(storedTask?.retry_no ?? retryNo) + 1;
      if (durableRetryNo <= TRANSIENT_RETRY_LIMIT) {
        const delay = TRANSIENT_RETRY_DELAYS_MS[Math.min(durableRetryNo - 1, TRANSIENT_RETRY_DELAYS_MS.length - 1)];
        const nextAttemptAt = new Date(Date.now() + delay).toISOString();
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          failure_class: "transient",
          retry_no: durableRetryNo,
          next_attempt_at: nextAttemptAt,
          error_key: result.error_key,
          retry_allowed: true,
          reason: result.message ?? null,
          ...usage,
        });
        return;
      }
      // Transient retry budget exhausted (3 attempts): escalate as a
      // deterministic failure so it counts toward failure_count/
      // same_error_count and can reach the Manager-trigger threshold
      // instead of retrying forever.
      await this.writeFailureEvent(workId, taskId, agentRunId, {
        failure_class: "deterministic",
        escalated_from: "transient",
        error_key: result.error_key,
        retry_allowed: true,
        reason: result.message ?? null,
        ...usage,
      });
      return;
    }

    // Safety rule: an unclassified failure is deterministic, never silently retried as transient.
    const errorKey = result.error_key;
    if (!errorKey) {
      throw validationError("A deterministic AgentRunner failure must include error_key.", { task_id: taskId });
    }
    const event = result.signal ? "agent.crashed" : "task.failure.classified";
    const hasReport = !result.signal && result.report && typeof result.report === "object" && !Array.isArray(result.report);
    const reportResultValue = hasReport ? (result.report as JsonObject).result : null;
    const reportRunOutcome = errorKey.startsWith("report_result:")
      ? reportResultValue === "failed" ? "not_achieved" : reportResultValue === "partial" ? "partial" : null
      : null;
    const payload: JsonObject = result.signal
      ? {
        report_present: false,
        error_key: errorKey,
        signal: result.signal,
        reason: result.message ?? null,
        ...usage,
      }
      : {
        failure_class: "deterministic",
        error_key: errorKey,
        retry_allowed: result.retry_allowed !== false,
        reason: result.message ?? null,
        // A failed or partial report is a valid result the agent produced.
        ...(reportRunOutcome ? { run_outcome: reportRunOutcome } : {}),
        ...(hasReport ? { report: result.report } : {}),
        // Lets a "resubmit only the report" answer resume this very session.
        ...(isReportFormatInvalidErrorKey(errorKey) && result.provider_session_id
          ? { provider_session_id: result.provider_session_id, worktree_path: this.db.get<{ worktree_path: string | null }>("SELECT worktree_path FROM tasks WHERE id = ?", taskId)?.worktree_path ?? null }
          : {}),
        ...usage,
      };
    await this.writeFailureEvent(workId, taskId, agentRunId, payload, event);
  }

  private async recordRateLimitedTask(
    workId: string,
    taskId: string,
    agentRunId: string,
    result: AgentRunResult,
    usage: JsonObject,
    pauseContext?: { readonly provider: string; readonly role: string },
  ): Promise<void> {
    const run = this.db.get<{ provider: string; role: string }>("SELECT provider, role FROM agent_runs WHERE id = ?", agentRunId);
    if (!run || !this.providerPauseController) {
      throw validationError("A rate-limited Task requires its provider pause controller.", { task_id: taskId, agent_run_id: agentRunId });
    }
    const pause = await this.providerPauseController.recordRateLimit({
      provider: pauseContext?.provider ?? run.provider,
      resets_at: result.rate_limit?.resets_at ?? null,
      role: pauseContext?.role ?? run.role,
      work_id: workId,
      task_id: taskId,
      last_error_key: result.error_key ?? "rate_limited",
      last_error: result.message ?? null,
    });
    const payload: JsonObject = {
      task_id: taskId,
      agent_run_id: agentRunId,
      provider: pause.provider,
      resume_at: pause.resume_at,
      failure_class: "rate_limited",
      ...usage,
    };
    await this.writeLane.write({
      mutateState: (transaction) => reduceTaskInTransaction(transaction, taskId, { event: "task.rate_limited", payload }),
      event: {
        idempotencyKey: `task-rate-limited:${agentRunId}`,
        type: "task.rate_limited",
        workId,
        taskId,
        agentRunId,
        payload,
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  private async noteProviderSucceeded(agentRunId: string): Promise<void> {
    if (!this.providerPauseController) return;
    const run = this.db.get<{ provider: string; started_at: string | null; created_at: string }>(
      "SELECT provider, started_at, created_at FROM agent_runs WHERE id = ?", agentRunId,
    );
    if (run) await this.providerPauseController.noteProviderSucceeded(run.provider, run.started_at ?? run.created_at);
  }

  /**
   * Retry pending Reviews after a provider resumes. A Review that was waiting on
   * `provider` is retried even when the Reviewer role has since moved to another
   * provider, as long as the current Reviewer provider is not paused.
   */
  public resumeProvider(provider: string): void {
    const reviewerProvider = this.currentReviewerProvider();
    if (this.providerPauseController?.isPaused(reviewerProvider)) return;
    const matchesCurrent = normalizeProviderId(reviewerProvider) === normalizeProviderId(provider);
    this.retryPendingReviews((taskId) => {
      if (matchesCurrent) return true;
      const wait = readPausedReviewerWait(this.db, taskId);
      return wait !== undefined && normalizeProviderId(wait.provider) === normalizeProviderId(provider);
    });
  }

  /** Retry Reviews parked behind a paused provider once the current Reviewer provider can run. */
  public retryWaitingReviews(): void {
    if (this.providerPauseController?.isPaused(this.currentReviewerProvider())) return;
    this.retryPendingReviews((taskId) => readPausedReviewerWait(this.db, taskId) !== undefined);
  }

  /** Start a Reviewer now for every verifying Task that has none (after the Owner chose "run only the Reviewer again"). */
  public rerunPendingReviews(): void {
    this.retryPendingReviews(() => true);
  }

  private currentReviewerProvider(): string {
    return this.providerForRoleModel(resolveRoleModel(this.db, "reviewer"));
  }

  private retryPendingReviews(include: (taskId: string) => boolean): void {
    const pending = this.db.all<{ id: string; work_id: string; type: string; worktree_path: string | null; review_round: number; worker_agent_run_id: string; payload_json: string }>(
      `SELECT tasks.id, tasks.work_id, tasks.type, tasks.worktree_path, tasks.review_round,
              worker.id AS worker_agent_run_id, reports.payload_json
         FROM tasks
         JOIN agent_runs AS worker ON worker.id = (
           SELECT latest.id FROM agent_runs AS latest
            WHERE latest.task_id = tasks.id AND latest.role IN ('worker','designer') AND latest.report_id IS NOT NULL
            ORDER BY latest.created_at DESC LIMIT 1
         )
         JOIN reports ON reports.id = worker.report_id
        WHERE tasks.status = 'verifying'
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs AS reviewer WHERE reviewer.task_id = tasks.id AND reviewer.role = 'reviewer'
              AND reviewer.status IN ('launch_pending','spawned','running','cancel_requested')
          )`,
    );
    for (const task of pending) {
      if (this.reviewerRetriesInFlight.has(task.id) || !include(task.id)) continue;
      let report: unknown;
      try { report = JSON.parse(task.payload_json) as unknown; } catch (error) {
        console.warn(`[owl-core] Task ${task.id} is not retried for review: its Worker report payload is unreadable:`, error);
        continue;
      }
      if (!report || typeof report !== "object" || Array.isArray(report)) continue;
      this.reviewerRetriesInFlight.add(task.id);
      // A research Task is never reviewed: one left waiting by an older routing is finished without a Reviewer.
      void (task.type === "research"
        ? this.completeWaitingResearch(task.work_id, task.id, task.worktree_path, task.worker_agent_run_id)
        : this.runReviewer(task.work_id, task.id, task.worker_agent_run_id, report as JsonObject, task.review_round))
        .catch((error: unknown) => console.error(`[owl-core] Could not retry Reviewer for Task ${task.id}`, error))
        .finally(() => this.reviewerRetriesInFlight.delete(task.id));
    }
  }

  private async completeWaitingResearch(workId: string, taskId: string, worktreePath: string | null, agentRunId: string): Promise<void> {
    const integration = await this.integrateTask(workId, taskId, worktreePath);
    const verification: JsonObject = { passed: true, source: "research_without_review", commands: [] };
    const verificationEvent = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => reduceTaskInTransaction(transaction, taskId, {
        event: "verification.completed",
        payload: { outcome: "pass", review_required: false, agent_run_id: agentRunId, verification, ...integration },
      }),
      event: {
        idempotencyKey: `verification-completed:research-without-review:${taskId}:${agentRunId}`,
        type: "verification.completed",
        workId,
        taskId,
        agentRunId,
        payload: { task_id: taskId, agent_run_id: agentRunId, outcome: "pass", review_required: false, verification, ...integration },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (verificationEvent.state.manager_trigger) {
      await this.triggerManagerReplanIfNeeded(workId, integrationTrigger(taskId, "verification", integration));
    }
  }

  private async recordReportCorrections(
    workId: string,
    taskId: string,
    agentRunId: string,
    corrections: AgentRunResult["report_corrections"],
  ): Promise<void> {
    if (!corrections || corrections.length === 0) return;
    await this.writeLane.write({
      mutateState: () => ({}),
      event: {
        idempotencyKey: `worker-report-corrected:${agentRunId}`,
        type: "worker.report_corrected",
        workId,
        taskId,
        agentRunId,
        payload: { agent_run_id: agentRunId, corrections: corrections.map((c) => ({ ...c })) },
      },
      outbox: [],
    });
  }

  private recordSkillFeedback(agentRunId: string, feedback: AgentRunResult["skill_feedback"]): void {
    if (!feedback || !this.skillBox) return;
    try {
      void this.skillBox.recordFeedback(agentRunId, feedback).catch((error) => {
        console.warn(`[owl-core] Could not record skill feedback for Agent run ${agentRunId}`, error);
      });
    } catch (error) {
      console.warn(`[owl-core] Could not record skill feedback for Agent run ${agentRunId}`, error);
    }
  }

  private async stopDesignWithoutReport(workId: string, taskId: string, pausedProvider: string): Promise<void> {
    const task = this.db.get<{ design_stop_json: string | null; state_version: number }>("SELECT design_stop_json, state_version FROM tasks WHERE id = ?", taskId);
    if (!task || task.design_stop_json === null) return;
    const payload: JsonObject = { task_id: taskId, source: "core", design_blocked: null, provider_paused: pausedProvider };
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => reduceTaskInTransaction(transaction, taskId, { event: "task.design_blocked", payload }),
      event: {
        idempotencyKey: `task-design-blocked:paused:${taskId}:${task.state_version}`,
        type: "task.design_blocked",
        workId,
        taskId,
        payload,
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  private async writeFailureEvent(
    workId: string,
    taskId: string,
    agentRunId: string,
    payload: JsonObject,
    event = "task.failure.classified",
    question?: string | null,
    trigger: TaskReplanTrigger | null = null,
  ): Promise<void> {
    const eventPayload = { ...payload, agent_run_id: agentRunId };
    const writeResult = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) =>
        reduceTaskInTransaction(transaction, taskId, { event, payload: eventPayload }),
      event: {
        idempotencyKey: `${event}:${agentRunId}`,
        type: event,
        workId,
        taskId,
        agentRunId,
        payload: eventPayload,
      },
      outbox: [{ provider: "websocket" }],
    });
    // A newly failed Task already cascaded to its waiting dependents inside
    // reduceTaskInTransaction.
    if (writeResult.state.manager_trigger) {
      await this.triggerManagerReplanIfNeeded(workId, trigger ?? {
        kind: "failure_threshold",
        task_id: taskId,
        error_key: typeof payload.error_key === "string" ? payload.error_key : null,
        reason: typeof payload.reason === "string" ? payload.reason : null,
        question: question ?? null,
      });
    }
  }

  /**
   * Check a successful Designer attempt before it is verified. Changes left
   * in the repository worktree are discarded and recorded as an alert; the
   * design document must be non-empty and written by this attempt (it
   * differs from the file that existed before the attempt started).
   * Returns false when the attempt was recorded as failed.
   */
  private async acceptDesignDocument(
    workId: string,
    taskId: string,
    agentRunId: string,
    worktreePath: string | null,
    baseline: DesignDocumentFingerprint | null,
    usage: JsonObject,
  ): Promise<boolean> {
    const projectId = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id ?? null;
    // A Project-less Work has no Git worktree, so there is nothing to discard.
    if (projectId !== null) {
      const discarded = await this.git.discardTaskWorktreeChanges({ work_id: workId, task_id: taskId, worktree_path: worktreePath });
      if (!discarded.ok) {
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          failure_class: "deterministic",
          error_key: "design_worktree_cleanup_failed",
          retry_allowed: false,
          reason: discarded.message,
          ...usage,
        });
        return false;
      }
      if (discarded.changed_paths.length > 0) {
        await this.writeLane.write({
          mutateState: () => ({}),
          event: {
            idempotencyKey: `design-changes-discarded:${agentRunId}`,
            type: "system.alert",
            workId,
            taskId,
            agentRunId,
            payload: {
              kind: "design_changes_discarded",
              schema_version: "1.0.0",
              task_id: taskId,
              agent_run_id: agentRunId,
              message: `The Designer changed repository files; ${discarded.changed_paths.length} path(s) were discarded.`,
              discarded_paths: [...discarded.changed_paths],
            },
          },
          outbox: [{ provider: "websocket" }],
        });
      }
    }
    const documentPath = designDocumentPath(this.dataDir, workId, taskId);
    const current = await designDocumentFingerprint(documentPath);
    const written = current !== null && current.size > 0n && (baseline === null || !sameFingerprint(baseline, current));
    if (!written) {
      await this.writeFailureEvent(workId, taskId, agentRunId, {
        failure_class: "deterministic",
        error_key: "design_document_missing",
        retry_allowed: true,
        ...usage,
      });
      return false;
    }
    return true;
  }

  private async runVerification(
    workId: string,
    taskId: string,
    agentRunId: string,
    report: JsonObject,
    hybridAtLaunch = false,
  ): Promise<void> {
    if (this.stopping) return;
    const task = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!task) {
      throw validationError("The Task disappeared before Core verification started.", { task_id: taskId });
    }
    await this.writeLane.write({
      mutateState: () => ({ task_id: taskId, verification: "started" }),
      event: {
        idempotencyKey: `verification-started:${agentRunId}`,
        type: "verification.started",
        workId,
        taskId,
        agentRunId,
        payload: { task_id: taskId, agent_run_id: agentRunId },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (this.stopping) return;
    let verification: JsonObject;
    try {
      // A design Task changes no code: the design document check is its
      // verification, together with the Designer's own verdict.
      verification = task.type === "design"
        ? { passed: reportedVerificationPassed(report), source: "design_document", commands: [] }
        : await this.executeVerificationPlan(workId, task, report, agentRunId);
    } catch (error) {
      verification = {
        passed: false,
        source: "core_verification_error",
        commands: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.stopping) return;
    const passed = verification.passed === true;
    // Core decides the review after verification, from what the Task changed.
    // A routing failure must not skip the Reviewer, so it falls back to required.
    // The same measurement feeds the routing and the lineage's change record.
    const measurement = await this.measureTaskChanges(workId, task).catch((error: unknown): TaskChangeMeasurement => ({
      files: null,
      approximate: true,
      unmeasured_reason: `changes could not be measured: ${error instanceof Error ? error.message : String(error)}`,
    }));
    const routing = await this.routeReview(workId, task, hybridAtLaunch, measurement).catch((error: unknown): ReviewRoutingDecision | null => {
      console.warn(`[owl-core] Review routing failed for Task ${taskId}; requiring review.`, error);
      return null;
    });
    // A research Task is never reviewed, even when routing itself failed.
    const reviewRequired = task.type === "research" ? false : routing?.required ?? true;
    // A Task without review is finished here, so it is merged now; a
    // reviewed Task is merged once its review passes (runReviewer).
    const integration = passed && !reviewRequired ? await this.integrateTask(workId, taskId, task.worktree_path) : null;
    const verificationEvent = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const reduced = reduceTaskInTransaction(transaction, taskId, {
          event: "verification.completed",
          payload: {
            outcome: passed ? "pass" : "fail",
            review_required: reviewRequired,
            agent_run_id: agentRunId,
            verification: verification as JsonObject,
            ...(integration ?? {}),
          },
        });
        recordTaskChangeMeasurementInTransaction(transaction, { workId, taskId, agentRunId, changes: measurement.files, sinceGenerationStart: measurement.since_generation_start === true });
        // Only a verified result fixes the decision; a failed attempt is routed again.
        if (routing && passed) {
          transaction.run(
            "UPDATE tasks SET review_decision = ?, review_decision_json = ? WHERE id = ?",
            routing.required ? "required" : "not_required",
            JSON.stringify(routing),
            taskId,
          );
        }
        return reduced;
      },
      event: {
        idempotencyKey: `verification-completed:${agentRunId}`,
        type: "verification.completed",
        workId,
        taskId,
        agentRunId,
        payload: {
          task_id: taskId,
          agent_run_id: agentRunId,
          outcome: passed ? "pass" : "fail",
          review_required: reviewRequired,
          ...(routing ? { review_routing: routing as unknown as JsonObject } : {}),
          verification: verification as JsonObject,
          ...(integration ?? {}),
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (verificationEvent.state.manager_trigger) {
      await this.triggerManagerReplanIfNeeded(
        workId,
        integration && integration.merge_exit_code !== 0
          ? integrationTrigger(taskId, "verification", integration)
          : { kind: "verification_exhausted", task_id: taskId },
      );
    }
    if (passed && reviewRequired && verificationEvent.state.next.status === "verifying") {
      await this.runReviewer(workId, taskId, agentRunId, report, verificationEvent.state.next.review_round);
    }
  }

  /**
   * A Work without a Project has no shared git history to carry a
   * dependency's output into a dependent Task's isolated worktree, so a
   * dependent Task otherwise starts from an empty folder. Copy the latest
   * code/generated artifacts of this Task's completed direct dependencies
   * into its worktree, at the same relative path they were captured at.
   */
  private async materializeDependencyArtifacts(workId: string, taskId: string, worktreePath: string): Promise<void> {
    const work = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    if (work?.project_id) return;
    const dependsOn = taskDependencyIds(this.db, taskId);
    if (dependsOn.length === 0) return;
    const taskPlaceholders = dependsOn.map(() => "?").join(",");
    const completed = this.db.all<{ id: string }>(
      `SELECT id FROM tasks WHERE id IN (${taskPlaceholders}) AND status = 'completed'`,
      ...dependsOn,
    );
    if (completed.length === 0) return;
    const artifactPlaceholders = completed.map(() => "?").join(",");
    const artifacts = this.db.all<{ path: string; storage_path: string; sha256: string; task_id: string }>(
      `SELECT a.path, a.storage_path, a.sha256, a.task_id
         FROM artifacts a
        WHERE a.task_id IN (${artifactPlaceholders}) AND a.kind IN ('code', 'generated')
          AND a.version_no = (
            SELECT MAX(version_no) FROM artifacts WHERE work_id = a.work_id AND task_id = a.task_id AND path = a.path
          )
        ORDER BY a.created_at ASC, a.id ASC`,
      ...completed.map((dependency) => dependency.id),
    );
    if (artifacts.length === 0) return;
    const root = resolve(worktreePath);
    for (const artifact of artifacts) {
      const destination = resolve(root, artifact.path);
      if (destination === root || !inside(root, destination)) continue;
      const contents = await readFile(artifact.storage_path).catch((error: NodeJS.ErrnoException) => {
        console.warn(`[owl-core] Task ${taskId}: dependency artifact ${artifact.path} from Task ${artifact.task_id} could not be read, so it is not copied into the worktree:`, error);
        return null;
      });
      if (!contents) continue;
      const existing = await lstat(destination).catch(() => null); // Why not log: an unreadable destination fails at the write below.
      if (existing?.isFile()) {
        const existingContents = await readFile(destination);
        if (createHash("sha256").update(existingContents).digest("hex") === artifact.sha256) continue;
        console.warn(`[owl-core] Task ${taskId}: the dependency artifact ${artifact.path} from Task ${artifact.task_id} overwrote a different copy already in the worktree.`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
  }

  private async captureArtifacts(workId: string, taskId: string, agentRunId: string, worktreePath: string | null): Promise<void> {
    if (!worktreePath) return;
    const root = resolve(worktreePath);
    const files: Array<{ path: string; sha256: string; bytes: number; mime: string; contents: Buffer; storage_path: string }> = [];
    let capturedBytes = 0;
    const capture = async (absolute: string): Promise<void> => {
      const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") console.warn(`[owl-core] Task ${taskId}: artifact ${absolute} could not be inspected and is not recorded:`, error);
        return null;
      });
      if (!info?.isFile()) return;
      if (info.size > MAX_CAPTURED_ARTIFACT_FILE_BYTES || capturedBytes + info.size > MAX_CAPTURED_ARTIFACT_BYTES) {
        console.warn(`[owl-core] Task ${taskId}: artifact ${absolute} (${info.size} bytes) exceeds the capture size limit and is not recorded.`);
        return;
      }
      const contents = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") console.warn(`[owl-core] Task ${taskId}: artifact ${absolute} could not be read and is not recorded:`, error);
        return null;
      });
      if (!contents) return;
      const relPath = relative(root, absolute).split("\\").join("/");
      const sha256 = createHash("sha256").update(contents).digest("hex");
      const storagePath = join(this.dataDir, "artifacts", workId, taskId, sha256);
      files.push({
        path: relPath,
        sha256,
        bytes: contents.byteLength,
        mime: mimeForPath(relPath),
        contents,
        storage_path: storagePath,
      });
      capturedBytes += contents.byteLength;
    };
    const visit = async (directory: string): Promise<void> => {
      if (files.length >= 2000) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= 2000 || entry.name === ".git" || entry.name === "node_modules") continue;
        const absolute = resolve(directory, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await visit(absolute);
        else await capture(absolute);
      }
    };
    // In a Git Task worktree the artifacts are the files this Task changed,
    // not the whole checkout it started from. A non-Git isolated workspace
    // holds only what the Task produced, so it is captured as a whole.
    const changed = await this.git.changedPaths?.({ work_id: workId, task_id: taskId, worktree_path: root }) ?? null;
    if (changed === null) {
      await visit(root);
    } else {
      for (const path of changed) {
        if (files.length >= 2000) break;
        const absolute = resolve(root, path);
        if (absolute.startsWith(`${root}/`)) await capture(absolute);
      }
    }
    if (files.length === 0) return;

    // A Task worktree is removed after a successful review/merge. Archive
    // content-addressed bytes before recording the metadata so the artifact
    // row never points at a path that is about to disappear. The hash makes a
    // repeated capture safe; a mismatching pre-existing target is refused.
    const createdArchives: string[] = [];
    for (const file of files) {
      await mkdir(dirname(file.storage_path), { recursive: true, mode: 0o700 });
      const temporary = `${file.storage_path}.${createUlid()}.tmp`;
      try {
        await writeFile(temporary, file.contents, { flag: "wx", mode: 0o600 });
        await rename(temporary, file.storage_path);
        createdArchives.push(file.storage_path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        const existing = await lstat(file.storage_path).catch(() => null);
        if (!existing?.isFile()) throw error;
        const existingContents = await readFile(file.storage_path);
        if (createHash("sha256").update(existingContents).digest("hex") !== file.sha256) {
          throw validationError("A durable artifact path already contains different content.", { storage_path: file.storage_path });
        }
      }
    }
    const now = utcNow();
    try {
      await this.writeLane.write({
        mutateState: (transaction) => {
          let inserted = 0;
          for (const file of files) {
            // Scoped by work_id and path/sha256 only (not task_id): a file a
            // dependency's artifacts already cover, and that
            // materializeDependencyArtifacts copied into this Task's
            // worktree unchanged, is not this Task's own artifact.
            const exists = transaction.get<{ id: string }>(
              "SELECT id FROM artifacts WHERE work_id = ? AND path = ? AND sha256 = ? LIMIT 1",
              workId,
              file.path,
              file.sha256,
            );
            if (exists) continue;
            const version = transaction.get<{ version_no: number }>(
              "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM artifacts WHERE work_id = ? AND task_id = ? AND path = ?",
              workId,
              taskId,
              file.path,
            );
            transaction.run(
              `INSERT INTO artifacts
                 (id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, commit_ref, source_event_id, version_no, created_at, storage_path)
               VALUES (?, ?, ?, ?, 'generated', 1, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
              createUlid(),
              workId,
              taskId,
              file.path,
              file.sha256,
              file.bytes,
              file.mime,
              Number(version?.version_no ?? 0) + 1,
              now,
              file.storage_path,
            );
            inserted += 1;
          }
          return { work_id: workId, task_id: taskId, artifact_count: inserted };
        },
        event: {
          // One capture per Worker run: a fix round that leaves the files as
          // they were captures the same contents again.
          idempotencyKey: `artifacts-captured:${taskId}:${agentRunId}`,
          type: "artifact.created",
          workId,
          taskId,
          payload: { work_id: workId, task_id: taskId, artifact_count: files.length, paths: files.map((file) => file.path) },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      await Promise.all(createdArchives.map((path) => unlink(path).catch(() => undefined)));
      throw error;
    }
  }

  /**
   * Snapshot of every entry under a Project-less Task worktree (symlinks and node_modules included, only the top-level .git
   * skipped), independent of artifact capture limits. Contents are kept for small text files so edits can be counted by line.
   */
  private async snapshotWorktree(root: string): Promise<Map<string, WorktreeEntry>> {
    const entries = new Map<string, WorktreeEntry>();
    let keptBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (directory === root && entry.name === ".git") continue;
        const absolute = resolve(directory, entry.name);
        const info = await lstat(absolute);
        const path = relative(root, absolute).split("\\").join("/");
        if (info.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (entries.size >= WORKTREE_SNAPSHOT_MAX_ENTRIES) throw new Error(`more than ${WORKTREE_SNAPSHOT_MAX_ENTRIES} entries`);
        if (info.isSymbolicLink()) {
          entries.set(path, { hash: `link:${await readlink(absolute)}`, lines: 0, binary: true });
        } else if (info.isFile()) {
          const contents = await readFile(absolute);
          const binary = contents.includes(0);
          const text = binary ? "" : contents.toString("utf8");
          const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
          const keep = !binary && keptBytes + contents.byteLength <= WORKTREE_SNAPSHOT_MAX_KEPT_BYTES;
          if (keep) keptBytes += contents.byteLength;
          entries.set(path, { hash: createHash("sha256").update(contents).digest("hex"), lines, binary, ...(keep ? { text } : {}) });
        } else {
          entries.set(path, { hash: `special:${info.mode}`, lines: 0, binary: true });
        }
      }
    };
    await visit(root);
    return entries;
  }

  /**
   * Everything the Task changed, measured independently of artifact capture limits: Git's per-file counts for a Project,
   * a comparison with the worktree as it was when the Worker first started otherwise. `files` is null, with a reason,
   * when it cannot be measured completely.
   */
  private async measureTaskChanges(workId: string, task: TaskRow): Promise<TaskChangeMeasurement> {
    const hasProject = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id;
    if (hasProject) {
      if (!this.git.diffStats) return { files: null, approximate: false, unmeasured_reason: "git diff statistics are not available" };
      const stats = await this.git.diffStats({ work_id: workId, task_id: task.id, worktree_path: task.worktree_path ?? undefined });
      if (!stats) return { files: null, approximate: false, unmeasured_reason: "git diff unavailable" };
      const root = task.worktree_path ? resolve(task.worktree_path) : null;
      const files = await Promise.all([...stats].map(async (file) => (root ? { ...file, content_hash: await hashWorktreeFile(root, file.path) } : { ...file })));
      return { files, approximate: false };
    }
    if (!task.worktree_path) return { files: null, approximate: true, unmeasured_reason: "the Task has no worktree to measure" };
    const baseline = this.worktreeBaselines.get(task.id);
    if (!baseline) return { files: null, approximate: true, unmeasured_reason: "the worktree state before the Worker started was not recorded" };
    let current: Map<string, WorktreeEntry>;
    try {
      current = await this.snapshotWorktree(resolve(task.worktree_path));
    } catch (error) {
      return { files: null, approximate: true, unmeasured_reason: `changes could not be measured: ${error instanceof Error ? error.message : String(error)}` };
    }
    const files: ChangedFile[] = [];
    for (const path of new Set([...baseline.keys(), ...current.keys()])) {
      const before = baseline.get(path);
      const after = current.get(path);
      if (before && after && before.hash === after.hash) continue;
      let added = after?.lines ?? 0;
      let deleted = before?.lines ?? 0;
      if (before?.text !== undefined && after?.text !== undefined) {
        ({ added, deleted } = diffLineCounts(before.text.split("\n"), after.text.split("\n")));
      }
      files.push({ path, added_lines: added, deleted_lines: deleted, binary: Boolean(before?.binary || after?.binary), content_hash: after?.hash ?? "deleted" });
    }
    return { files: files.sort((left, right) => left.path.localeCompare(right.path)), approximate: true, since_generation_start: true };
  }

  /** Record the Project-less worktree before the Task's first Worker run; a later run (retry, restart) must not overwrite it. */
  private async recordWorktreeBaseline(workId: string, task: TaskRow | undefined): Promise<void> {
    if (!task?.worktree_path || this.projectIdOf(workId).project_id) return;
    const runs = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND role = 'worker'", task.id)?.n ?? 0;
    const generation = this.db.get<{ g: number }>("SELECT lineage_generation AS g FROM tasks WHERE id = ?", task.id)?.g ?? 1;
    const newGeneration = generation > (this.baselineGeneration.get(task.id) ?? generation);
    if (!newGeneration && (runs > 1 || this.worktreeBaselines.has(task.id))) return;
    try {
      this.worktreeBaselines.set(task.id, await this.snapshotWorktree(resolve(task.worktree_path)));
      this.baselineGeneration.set(task.id, generation);
    } catch (error) {
      console.warn(`[owl-core] Could not record the worktree baseline for Task ${task.id}; review will be required.`, error);
    }
  }

  /** Decide whether the Reviewer is required, from the Task's plan, what it changed and its history (see review-routing.ts). */
  private async routeReview(workId: string, task: TaskRow, hybridAtLaunch: boolean, measurement: TaskChangeMeasurement): Promise<ReviewRoutingDecision> {
    // A measurement that failed is recorded as unmeasured (review required), not dropped.
    const { files, approximate, unmeasured_reason } = measurement;
    const exists = (sql: string): boolean => this.db.get<{ n: number }>(sql, task.id) !== undefined;
    const delegated = exists("SELECT 1 AS n FROM child_runs WHERE task_id = ? LIMIT 1")
      || exists("SELECT 1 AS n FROM agent_runs WHERE parent_agent_id IN (SELECT id FROM agent_runs WHERE task_id = ? AND role = 'worker') LIMIT 1");
    // The same predicate as review-metrics' completion_gate_failures.
    const gateFailures = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type IN ('task.failure.classified','task.replan_requested')
         AND json_type(payload_json,'$.gate_reasons') = 'array'`,
      task.id,
    )?.n ?? 0;
    const reviewFailures = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'review.failed'", task.id)?.n ?? 0;
    return decideReviewRouting({
      task,
      files,
      line_counts_approximate: approximate,
      delegated,
      hybrid_at_launch: hybridAtLaunch,
      unmeasured_reason,
      gate_failures: gateFailures,
      rejections: Math.max(task.total_review_attempts, reviewFailures),
      artifact_paths: taskArtifactPaths(this.db, task.id),
      settings: reviewRouting(this.db),
    });
  }

  /** Execute the persisted Project verification plan independently of Worker claims. */
  private async executeVerificationPlan(workId: string, task: TaskRow, report: JsonObject, agentRunId: string | null = null): Promise<JsonObject> {
    const workerPassed = reportedVerificationPassed(report);
    const project = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    if (!project?.project_id) {
      return this.verifyByTaskType(workId, task, report, workerPassed, "sole", false, agentRunId);
    }
    const projectRow = this.db.get<{ canonical_path: string; allowed_roots_json: string; verification_plan_json: string }>(
      "SELECT canonical_path, allowed_roots_json, verification_plan_json FROM projects WHERE id = ?",
      project.project_id,
    );
    if (!projectRow) return { passed: false, source: "project_missing", commands: [], check_commands: [] };
    let allowedRoots: string[];
    let plan: Array<{ command_id: string; argv: string[]; cwd: string; env_allowlist: string[]; timeout_seconds: number; stdout_limit: number; stderr_limit: number; expected_exit_codes: number[] }>;
    try {
      allowedRoots = JSON.parse(projectRow.allowed_roots_json) as string[];
      plan = JSON.parse(projectRow.verification_plan_json) as typeof plan;
    } catch {
      return { passed: false, source: "invalid_project_plan", commands: [], check_commands: [] };
    }
    // Verification must run against the same checkout that the Worker used.
    // Running from the canonical project path would silently verify the base
    // checkout instead of the Task's changes.  The worktree itself is created
    // by GitWorktreeGateway under owl_root, so it is trusted as the selected
    // execution root; command cwd values are still constrained beneath it.
    const root = resolve(task.worktree_path ?? projectRow.canonical_path);
    const worktreeRoot = task.worktree_path ? root : null;
    const withinAllowed = (candidate: string): boolean => {
      const relToRoot = relative(root, candidate);
      const beneathRoot = relToRoot === "" || (!relToRoot.startsWith("..") && !relToRoot.startsWith("/"));
      if (!beneathRoot) return false;
      if (worktreeRoot) return true;
      return allowedRoots.some((allowed) => {
        const base = resolve(allowed);
        const rel = relative(base, candidate);
        return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
      });
    };
    const { error: removeError, removed } = task.worktree_path ? await this.removeUnrequestedTests(workId, task, root) : { error: null, removed: [] };
    if (removeError !== null) return { passed: false, worker_verification_passed: workerPassed, source: "task_type_policy", core_checks: "executed", commands: [], check_commands: [], error_key: "unrequested_tests_remove_failed", error: removeError };
    const results: JsonObject[] = [];
    for (const command of plan) {
      const cwd = resolve(root, command.cwd);
      if (!withinAllowed(cwd)) {
        results.push({ command_id: command.command_id, passed: false, error: "cwd_outside_allowed_roots" });
        continue;
      }
      const result = await this.runVerificationCommand(task.id, command.argv, cwd, command.env_allowlist, command.timeout_seconds * 1000, command.stdout_limit, command.stderr_limit, command.expected_exit_codes);
      results.push({ command_id: command.command_id, ...result });
    }
    const coreChecksPassed = results.every((result) => result.passed === true);
    // An empty plan checks nothing, so the Task type policy is the Core check; otherwise it only adds to the plan.
    const policy = await this.verifyByTaskType(workId, task, report, workerPassed, plan.length === 0 ? "sole" : "supplement", true, agentRunId, removed);
    if (plan.length === 0) return policy;
    const policyChecks = policy.commands as JsonObject[];
    return {
      passed: workerPassed && coreChecksPassed && policy.passed === true,
      worker_verification_passed: workerPassed,
      core_checks: "executed",
      source: "project_verification_plan",
      commands: [...results, ...policyChecks],
      check_commands: policy.check_commands,
      type_policy: policy.type_policy,
      error_key: !coreChecksPassed ? "project_check_failed" : policy.error_key,
      error: policy.error,
      ...(policy.test_run !== undefined ? { test_run: policy.test_run } : {}),
    };
  }

  /**
   * Core's own check of a Task's output by its type, so that the Worker's
   * report alone never passes a code, doc, config or test Task.
   */
  private async verifyByTaskType(workId: string, task: TaskRow, report: JsonObject, workerPassed: boolean, mode: "sole" | "supplement", hasProject: boolean, agentRunId: string | null = null, removedTests: readonly string[] = []): Promise<JsonObject> {
    const settings = verificationPolicySettings(this.db);
    const root = task.worktree_path === null ? null : resolve(task.worktree_path);
    const files = root === null ? [] : await this.taskChangedFiles(workId, task, root, hasProject);
    const deletedFiles = root === null || !hasProject ? [] : [...(await this.git.deletedPaths?.({ work_id: workId, task_id: task.id, worktree_path: root }) ?? [])];
    let spec: TaskVerificationSpec = {};
    try {
      const parsed: unknown = task.verification_spec_json ? JSON.parse(task.verification_spec_json) : {};
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) spec = parsed as TaskVerificationSpec;
    } catch (error) {
      // Why not treat as none: that would silently drop the Task's required checks (fail-closed).
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[owl-core] Task ${task.id} verification_spec_json is unreadable; verification fails:`, error);
      return { passed: false, worker_verification_passed: workerPassed, source: "task_type_policy", core_checks: "executed", commands: [], check_commands: [], error_key: "verification_spec_unreadable", error: `verification_spec_json is unreadable: ${message}` };
    }
    const claimedChanges = (Array.isArray(report.changes) ? report.changes : [])
      .filter((change): change is JsonObject => change !== null && typeof change === "object" && !Array.isArray(change))
      .flatMap((change) => typeof change.file === "string" && !removedTests.includes(change.file) ? [{ file: change.file, action: typeof change.action === "string" ? change.action : "" }] : []);
    const { limits } = settings;
    const checks = hasProject && root !== null ? await this.runCheckCommands(workId, task, root) : [];
    if (checks.some((check) => check.passed !== true)) {
      const failed = checks.find((check) => check.passed !== true);
      return { passed: false, worker_verification_passed: workerPassed, source: "check_commands", core_checks: "executed", commands: checks, check_commands: checks, error_key: "check_failed", error: `Check command failed: ${String(failed?.command_id)}` };
    }
    const coreTests = hasProject && root !== null && task.type !== "design" ? await this.runTaskCoreTests(workId, task, root, files, spec, agentRunId) : null;
    const policy = await evaluateTaskTypePolicy({
      type: task.type,
      root,
      files,
      deletedFiles,
      removedTests,
      claimedChanges,
      spec,
      settings,
      mode,
      coreTestRun: coreTests && coreTests.outcome.status !== "not_applicable" ? { run_id: coreTests.outcome.run_id, mode: coreTests.outcome.mode, passed_files: coreTests.outcome.passed_files, failed_files: coreTests.outcome.failed_files } : undefined,
      runCommand: async (argv, cwd) => {
        const outcome = await this.runVerificationCommand(task.id, argv, cwd, limits.env_allowlist, limits.timeout_seconds * 1000, limits.stdout_limit_bytes, limits.stderr_limit_bytes, [0]);
        return {
          passed: outcome.passed === true,
          exit_code: typeof outcome.exit_code === "number" ? outcome.exit_code : null,
          timed_out: outcome.timed_out === true,
          stdout: typeof outcome.stdout === "string" ? outcome.stdout : undefined,
          stderr: typeof outcome.stderr === "string" ? outcome.stderr : undefined,
          error: typeof outcome.error === "string" ? outcome.error : undefined,
        };
      },
    });
    // Pre-existing failures and an empty selection never fail the Task; only in_scope failures and a run that could not go through do.
    const coreFailed = coreTests !== null && (coreTests.outcome.status === "failed" || coreTests.outcome.status === "error");
    const coreErrorKey = coreTests?.outcome.status === "error" ? "test_not_executed" : "test_failed";
    const coreError = coreTests === null ? null : coreTests.outcome.status === "error"
      ? coreTests.outcome.error
      : `Core test run failed: ${coreTests.outcome.in_scope.length} test(s) in ${coreTests.outcome.failed_files.length} file(s)`;
    return {
      passed: workerPassed && policy.passed && !coreFailed,
      worker_verification_passed: workerPassed,
      source: "task_type_policy",
      core_checks: policy.core_checks,
      commands: policy.checks as unknown as JsonObject[],
      check_commands: checks,
      type_policy: policy as unknown as JsonObject,
      error_key: !workerPassed ? "worker_verification_failed" : policy.error_key ?? (coreFailed ? coreErrorKey : null),
      error: policy.error ?? (coreFailed ? coreError : null),
      ...(coreTests ? { test_run: coreTestRunBrief(coreTests.outcome, coreTests.settings) as unknown as JsonObject } : {}),
    };
  }

  /**
   * Deletes the test files this Task added when none of its criteria asks for a spec test.
   * Returns the removed files and an error message when a file could not be removed (nothing known to delete is not an error).
   */
  private async removeUnrequestedTests(workId: string, task: TaskRow, root: string): Promise<{ error: string | null; removed: string[] }> {
    const none = { error: null, removed: [] };
    if (requestsSpecTest(readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance ?? ""))) return none;
    const project = this.projectTestRunRow(workId);
    if (!project) return none;
    // test_patterns apply even when the Owner turned the Core test run off.
    const explicit = project.test_run_json === null ? null : testRunSettingsFromJson(project.test_run_json);
    const resolved = explicit === null ? await this.resolveProjectTestRun(project, root) : null;
    const patterns = explicit?.test_patterns ?? (resolved?.enabled ? resolved.settings.test_patterns : []);
    if (patterns.length === 0) return none;
    const added = await this.git.addedPaths?.({ work_id: workId, task_id: task.id, worktree_path: root }) ?? null;
    if (added === null) return none;
    const files = added.filter((file) => matchesAnyGlob(file, patterns));
    if (files.length === 0) return none;
    try {
      for (const file of files) await rm(join(root, file), { force: true });
    } catch (error) {
      return { error: `Could not remove unrequested test file: ${error instanceof Error ? error.message : String(error)}`, removed: [] };
    }
    console.log(`[owl-core] Task ${task.id}: removed test files added without a spec_test criterion (no_spec_test_criterion): ${files.join(", ")}`);
    await this.writeLane.transact((transaction) => {
      appendEventInTransaction(transaction, {
        type: "task.unrequested_tests_removed",
        idempotencyKey: `unrequested-tests-removed:${task.id}:${createUlid()}`,
        workId,
        taskId: task.id,
        payload: { schema_version: "1.0.0", task_id: task.id, files, reason: "no_spec_test_criterion" },
      });
    });
    return { error: null, removed: files };
  }

  /** Runs the Project's test_policy.check_commands in the Task worktree, stopping at the first failure; [] when there are none. */
  private async runCheckCommands(workId: string, task: TaskRow, root: string): Promise<JsonObject[]> {
    const commands = this.contextBuilder.checkCommands(workId);
    const { limits } = verificationPolicySettings(this.db);
    const results: JsonObject[] = [];
    for (const [index, argv] of commands.entries()) {
      const result = await this.runVerificationCommand(task.id, argv, root, limits.env_allowlist, limits.timeout_seconds * 1000, limits.stdout_limit_bytes, limits.stderr_limit_bytes, [0]);
      results.push({ command_id: `check:${index}`, ...result });
      if (result.passed !== true) break;
    }
    return results;
  }

  /**
   * Core's own run of the tests related to what the Task changed (and the ones that failed last time).
   * null when the Project has no test_run settings; a non-Git checkout runs without a commit record.
   */
  private async runTaskCoreTests(workId: string, task: TaskRow, root: string, files: readonly string[], spec: TaskVerificationSpec, agentRunId: string | null): Promise<{ outcome: CoreTestRunOutcome; settings: TestRunSettings } | null> {
    const project = this.projectTestRunRow(workId);
    if (!project) return null;
    const git =(args: string[]): Promise<string> => execFileAsync("git", args, { cwd: root }).then((result) => result.stdout.trim());
    let commit: string;
    let dirty: boolean;
    let isGit = true;
    try {
      commit = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
      dirty = (await git(["status", "--porcelain"])).length > 0;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (/not a git repository/iu.test(stderr)) {
        // Why not skip the run: the Project's test settings still decide the verification; only the commit record is empty.
        console.warn(`[owl-core] Task ${task.id} is not in a Git checkout; running the Core tests without a commit.`);
        commit = "";
        dirty = false;
        isGit = false;
      } else {
        // A git failure (timeout, lock, I/O) is not proof of "no checkout": fail the verification instead of skipping the tests.
        console.error(`[owl-core] Task ${task.id}: git failed before the Core test run; verification fails.`, error);
        const message = `Core tests could not be started because git failed: ${error instanceof Error ? error.message : String(error)}`;
        return { outcome: { ...notApplicableTestRun(message), status: "error", error: message, reason: undefined }, settings: DEFAULT_TEST_RUN_SETTINGS };
      }
    }
    const resolved = await this.resolveProjectTestRun(project, root);
    if (!resolved.enabled) return { outcome: notApplicableTestRun(resolved.reason), settings: DEFAULT_TEST_RUN_SETTINGS };
    const settings = resolved.settings;
    let baseCommit: string | null = null;
    try {
      // A non-Git checkout has no merge-base to compare against; git would throw here.
      if (isGit) baseCommit = await this.git.projectBaseCommit?.({ work_id: workId, task_id: task.id, worktree_path: root }) ?? null;
    } catch (error) {
      return { outcome: coreTestErrorOutcome(error), settings };
    }
    const run: TestCommandRunner = this.testCommandRunner ?? (async (argv, cwd, timeoutMs, limit) => {
      const started = Date.now();
      const result = await this.runVerificationCommand(task.id, argv, cwd, [...settings.env_allowlist, "HOME"], timeoutMs, limit, limit, [0]);
      const error = typeof result.error === "string" ? result.error : undefined;
      return {
        exit_code: error !== undefined || typeof result.exit_code !== "number" ? null : result.exit_code,
        timed_out: result.timed_out === true,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        duration_ms: Date.now() - started,
        ...(error !== undefined ? { error } : {}),
      };
    });
    // Selection follows what changed since the previous check (committed or not); the Work-level change set stays cumulative.
    const digest: Record<string, string> = {};
    for (const file of files) {
      digest[file] = await readFile(join(root, file)).then((data) => createHash("sha256").update(data).digest("hex"), () => "");
    }
    const previousRun = latestTestRun(this.db, { scope: "task", task_id: task.id });
    const previousRow = previousRun ? this.db.get<{ selection_json: string }>("SELECT selection_json FROM test_runs WHERE id = ?", previousRun.id) : undefined;
    const before = previousRow ? (JSON.parse(previousRow.selection_json) as { change_digest?: Record<string, string> }).change_digest : undefined;
    const sinceChecked = before === undefined ? files : [...new Set([...Object.keys(digest), ...Object.keys(before)])].filter((file) => digest[file] !== before[file]);
    const outcome = await runCoreTests(this.coreTestRunDeps(workId, settings), {
      scope: "task",
      project_id: project.id,
      work_id: workId,
      task_id: task.id,
      agent_run_id: agentRunId,
      root,
      commit,
      base_commit: baseCommit,
      repo: project.canonical_path,
      changed_files: sinceChecked,
      change_digest: digest,
      // The Task's worktree forks from the Work branch, so its own change set is what decides "not changed by the Work" here.
      work_changed_files: files,
      required_tests: spec.required_tests ?? [],
      force_full: null,
      dirty,
      settings,
      run,
    });
    return { outcome, settings };
  }

  /**
   * Core's test run on the integrated Work branch. The first run selects the tests related to what the Work changed
   * against its base (the whole suite when the diff is unavailable or a full_run_pattern matches); later ones are the tests
   * that failed last time plus those related to what changed since. Pre-existing failures are triaged and
   * backlogged inside runCoreTests. null when the Project has no test_run settings or the checkout is unavailable.
   */
  public async runWorkCoreTests(workId: string): Promise<{ outcome: CoreTestRunOutcome; settings: TestRunSettings } | null> {
    const project = this.projectTestRunRow(workId);
    const gateway = this.git;
    if (!project || !gateway.withWorkCheckout || !gateway.diffPaths) return null;
    const previous = latestTestRun(this.db, { scope: "work", work_id: workId });
    let settings: TestRunSettings = DEFAULT_TEST_RUN_SETTINGS;
    // A checkout that cannot be prepared or restored is an error outcome, never a skipped run that lets the Work proceed.
    const outcome = await gateway.withWorkCheckout({ work_id: workId }, async (checkout) => {
      const resolved = await this.resolveProjectTestRun(project, checkout.path);
      if (!resolved.enabled) return notApplicableTestRun(resolved.reason);
      settings = resolved.settings;
      const baseDeps = this.coreTestRunDeps(workId, settings);
      const baseRun: TestCommandRunner = this.testCommandRunner ?? workTestRunner({ workId, envAllowlist: settings.env_allowlist, instanceId: resolveInstanceId(this.dataDir) });
      const activity = this.coreActivity(workId, "core_tests");
      // The baseline run (failure triage) is also Core's test command; report it so the activity does not look stalled.
      const deps: CoreTestRunDeps = {
        ...baseDeps,
        baselineRunner: (argv, cwd, timeoutMs, limit) => {
          activity.command(argv);
          return baseDeps.baselineRunner(argv, cwd, timeoutMs, limit, () => activity.output());
        },
      };
      let workChanged: readonly string[] | null;
      let sincePrevious: readonly string[] | null;
      try {
        workChanged = await gateway.diffPaths!({ work_id: workId, from: checkout.base_commit, to: checkout.commit });
        sincePrevious = previous === null ? workChanged : await gateway.diffPaths!({ work_id: workId, from: previous.commit_sha, to: checkout.commit });
      } catch (error) {
        await activity.end("error");
        throw error;
      }
      const run: TestCommandRunner = (argv, cwd, timeoutMs, limit) => {
        activity.command(argv);
        return baseRun(argv, cwd, timeoutMs, limit, () => activity.output());
      };
      return runCoreTests(deps, {
        scope: "work",
        project_id: project.id,
        work_id: workId,
        task_id: null,
        agent_run_id: null,
        root: checkout.path,
        commit: checkout.commit,
        base_commit: checkout.base_commit,
        repo: checkout.repo,
        changed_files: sincePrevious ?? [],
        work_changed_files: workChanged ?? [],
        required_tests: [],
        force_full: previous === null ? "first_work_run" : sincePrevious === null ? "diff_unavailable" : null,
        settings,
        run,
      }).then(
        async (result) => { await activity.end(result.status === "passed" || result.status === "failed" || result.status === "error" ? result.status : "done"); return result; },
        async (error: unknown) => { await activity.end("error"); throw error; },
      );
    }).catch(coreTestErrorOutcome);
    return outcome === null ? null : { outcome, settings };
  }

  private projectTestRunRow(workId: string): { id: string; canonical_path: string; test_run_json: string | null; test_run_detected_json: string | null; report_check_commands_json: string | null } | undefined {
    return this.db.get(
      "SELECT p.id, p.canonical_path, p.test_run_json, p.test_run_detected_json, p.report_check_commands_json FROM projects p JOIN works w ON w.project_id = p.id WHERE w.id = ?",
      workId,
    );
  }

  /** Commands the Worker runs before reporting, resolved in the Task worktree; [] without a Project. */
  private workerReportCheckCommands(workId: string, worktree: string | null): string[] {
    const project = this.projectTestRunRow(workId);
    if (!project) return [];
    return reportCheckCommands({
      configured: project.report_check_commands_json === null ? [] : JSON.parse(project.report_check_commands_json) as string[],
      explicit_json: project.test_run_json,
      detected_json: project.test_run_detected_json,
      root: worktree ?? project.canonical_path,
      rules: this.testDetectionRules,
    });
  }

  /** Explicit test_run > saved detection > detection now (stored for the next check). */
  private async resolveProjectTestRun(project: { id: string; test_run_json: string | null; test_run_detected_json: string | null }, root: string): Promise<TestRunResolution> {
    const resolved = resolveTestRun({
      explicit_json: project.test_run_json,
      detected_json: project.test_run_detected_json,
      root,
      rules: this.testDetectionRules,
      now: new Date().toISOString(),
      warn: (message) => console.warn(`[owl-core] ${message}`),
    });
    if (resolved.save !== null) {
      await this.writeLane.transact((tx) => {
        tx.run("UPDATE projects SET test_run_detected_json = ? WHERE id = ? AND test_run_json IS NULL", JSON.stringify(resolved.save), project.id);
      });
    }
    return resolved;
  }

  private coreTestRunDeps(workId: string, settings: TestRunSettings): CoreTestRunDeps {
    return {
      db: this.db,
      writeLane: this.writeLane,
      workspaceRoot: this.workspaceRoot,
      baselineRunner: this.testCommandRunner ?? workTestRunner({ workId, envAllowlist: settings.env_allowlist, instanceId: resolveInstanceId(this.dataDir) }),
      baselineLocks: this.baselineLocks,
    };
  }

  /** Files this Task changed, relative to its worktree: Git's view with a Project, the captured artifacts without one. */
  private async taskChangedFiles(workId: string, task: TaskRow, root: string, hasProject: boolean): Promise<string[]> {
    if (hasProject) {
      const changed = await this.git.changedPaths?.({ work_id: workId, task_id: task.id, worktree_path: root }) ?? null;
      if (changed !== null) return [...changed];
    }
    const rows = this.db.all<{ path: string }>("SELECT DISTINCT path FROM artifacts WHERE task_id = ?", task.id);
    const existing: string[] = [];
    for (const { path } of rows) {
      const absolute = resolve(root, path);
      if (absolute.startsWith(`${root}/`) && (await lstat(absolute).catch(() => null))?.isFile()) existing.push(path);
    }
    return existing;
  }

  private async runVerificationCommand(
    taskId: string,
    argv: readonly string[],
    cwd: string,
    envAllowlist: readonly string[],
    timeoutMs: number,
    stdoutLimit: number,
    stderrLimit: number,
    expectedExitCodes: readonly number[],
  ): Promise<JsonObject> {
    if (argv.length === 0) return { passed: false, error: "argv_empty" };
    if (this.stopping) return { passed: false, error: "workflow_stopping" };
    const env: Record<string, string> = {};
    for (const key of new Set(["PATH", ...envAllowlist])) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env[OWL_INSTANCE_ID_ENV] = resolveInstanceId(this.dataDir);
    env.OWL_AGENT_RUN_ID = taskVerificationMarker(taskId);
    return new Promise<JsonObject>((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      this.verificationChildren.add(child);
      const append = (current: string, chunk: Buffer, cap: number): string => {
        const currentBytes = Buffer.from(current);
        if (currentBytes.byteLength >= cap) return current;
        return Buffer.concat([currentBytes, chunk.subarray(0, cap - currentBytes.byteLength)]).toString();
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, stdoutLimit); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, stderrLimit); });
      const killGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* process already exited */ } }
      };
      const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 5000).unref(); }, Math.max(1, timeoutMs));
      child.once("error", (error) => { clearTimeout(timer); this.verificationChildren.delete(child); resolveResult({ passed: false, exit_code: -1, stdout, stderr, error: error.message }); });
      child.once("close", (code, signal) => { clearTimeout(timer); this.verificationChildren.delete(child); void reapProcessGroup(child.pid); resolveResult({ passed: !timedOut && signal === null && expectedExitCodes.includes(code ?? -1), exit_code: code ?? -1, signal, stdout, stderr, timed_out: timedOut }); });
    });
  }

  private async runReviewer(
    workId: string,
    taskId: string,
    workerAgentRunId: string,
    report: JsonObject,
    reviewRound: number,
  ): Promise<void> {
    try {
      await this.runReviewerInternal(workId, taskId, workerAgentRunId, report, reviewRound);
    } catch (error) {
      if (this.stopping) return;
      await this.recordReviewerFailure(workId, taskId, error);
    }
  }

  private async ignoreReviewerResult(
    workId: string,
    taskId: string,
    reviewerAgentRunId: string,
    reason: string,
  ): Promise<void> {
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        transaction.run(
          "UPDATE agent_runs SET status = 'cancelled', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')",
          now,
          now,
          reviewerAgentRunId,
        );
        return { agent_run_id: reviewerAgentRunId, result_ignored: true };
      },
      event: {
        idempotencyKey: `reviewer-result-ignored:${reviewerAgentRunId}`,
        type: "agent.exited",
        workId,
        taskId,
        agentRunId: reviewerAgentRunId,
        payload: {
          agent_run_id: reviewerAgentRunId,
          outcome: "cancelled",
          result_ignored: true,
          reason,
        },
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  private async recordReviewerFailure(workId: string, taskId: string, error: unknown): Promise<void> {
    const message = formatRuntimeFailure(error, "Reviewer", ownerLanguage(this.db));
    const reviewer = this.db.get<{ id: string; status: string }>(
      "SELECT id, status FROM agent_runs WHERE task_id = ? AND role = 'reviewer' ORDER BY created_at DESC LIMIT 1",
      taskId,
    );
    const taskStatus = this.db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", taskId)?.status;
    if (taskStatus === "cancelled" || reviewer?.status === "cancel_requested" || reviewer?.status === "cancelled") {
      if (reviewer) {
        await this.ignoreReviewerResult(workId, taskId, reviewer.id, "review_result_arrived_after_cancellation");
      }
      return;
    }
    let managerTrigger = false;
    await this.writeLane.write({
      mutateState: (transaction) => {
        const task = transaction.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", taskId);
        if (task?.status === "verifying") {
          // The Reviewer itself failed (provider or contract error): no
          // finding was produced, so this must not consume a review round.
          // Use the Reviewer crash path (Task row 29), which is bounded by
          // tasks.reviewer_failure_count (REVIEWER_FAILURE_LIMIT) instead.
          const formatInvalid = (error as { details?: { error_key?: unknown } } | null)?.details?.error_key === OUTPUT_FORMAT_INVALID_ERROR_KEY;
          const reduction = reduceTaskInTransaction(transaction, taskId, {
            event: "agent.crashed",
            payload: { role: "reviewer", report_present: false, error_key: formatInvalid ? OUTPUT_FORMAT_INVALID_ERROR_KEY : `reviewer_failed:${message.slice(0, 200)}`, ...(formatInvalid ? { reason: message } : {}) },
          });
          managerTrigger = reduction.manager_trigger;
        }
        if (reviewer && ["launch_pending", "spawned", "running", "cancel_requested"].includes(reviewer.status)) {
          transaction.run(
            "UPDATE agent_runs SET status = 'failed', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')",
            utcNow(),
            utcNow(),
            reviewer.id,
          );
        }
        return { task_id: taskId, reviewer_agent_run_id: reviewer?.id ?? null, error: message };
      },
      event: {
        idempotencyKey: `reviewer-failed:${taskId}:${reviewer?.id ?? createUlid()}`,
        type: "review.failed",
        workId,
        taskId,
        agentRunId: reviewer?.id ?? null,
        payload: { task_id: taskId, reviewer_agent_run_id: reviewer?.id ?? null, verdict: "fix_required", error: message },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (managerTrigger) {
      await this.triggerManagerReplanIfNeeded(workId, { kind: "reviewer_error", task_id: taskId, message });
    }
  }

  /**
   * Fail the verification of a design Task whose document disappeared
   * before its review, sending it back to the Designer through the normal
   * fix round.
   */
  private async returnDesignForMissingDocument(
    workId: string,
    taskId: string,
    designerAgentRunId: string,
    reviewRound: number,
    documentPath: string,
  ): Promise<void> {
    const verification: JsonObject = {
      passed: false,
      source: "design_document",
      commands: [],
      error_key: "design_document_missing",
      error: `The design document at ${documentPath} is missing or empty.`,
    };
    const writeResult = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        if (transaction.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", taskId)?.status !== "verifying") {
          throw validationError("The Task was cancelled or advanced before its Reviewer started.", { task_id: taskId });
        }
        return reduceTaskInTransaction(transaction, taskId, {
          event: "verification.completed",
          payload: { outcome: "fail", review_required: true, agent_run_id: designerAgentRunId, verification },
        });
      },
      event: {
        idempotencyKey: `design-document-missing:${designerAgentRunId}:${reviewRound}`,
        type: "verification.completed",
        workId,
        taskId,
        agentRunId: designerAgentRunId,
        payload: {
          task_id: taskId,
          agent_run_id: designerAgentRunId,
          outcome: "fail",
          review_required: true,
          verification,
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (writeResult.state.manager_trigger) {
      await this.triggerManagerReplanIfNeeded(workId, { kind: "design_document_missing", task_id: taskId });
    }
  }

  private async runReviewerInternal(
    workId: string,
    taskId: string,
    workerAgentRunId: string,
    report: JsonObject,
    reviewRound: number,
  ): Promise<void> {
    if (this.stopping) return;
    const task = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!task) {
      throw validationError("The Task disappeared before Core started its Reviewer.", { task_id: taskId });
    }
    // Older Worker reports may contain Core routing fields; the Reviewer only
    // needs the report itself. The delegation record remains part of it.
    const reviewerReport = Object.fromEntries(
      Object.entries(report).filter(([key]) => key !== "verdict" && key !== "retry_subtasks"),
    ) as JsonObject;
    // A design Task has no changed files; the Reviewer reads its document.
    // Without one there is nothing to review, so the Designer runs again.
    let designDocument: { path: string; markdown: string } | null = null;
    if (task.type === "design") {
      const path = designDocumentPath(this.dataDir, workId, taskId);
      const markdown = await readFile(path, "utf8").catch(() => null);
      if (markdown === null || markdown.trim().length === 0) {
        await this.returnDesignForMissingDocument(workId, taskId, workerAgentRunId, reviewRound, path);
        return;
      }
      designDocument = { path, markdown };
    }
    const reviewerAgentRunId = createUlid();
    const reviewerRoleModel = resolveRoleModel(this.db, "reviewer");
    const reviewerProvider = this.providerForRoleModel(reviewerRoleModel);
    if (this.providerPauseController?.isPaused(reviewerProvider)) {
      await this.writeLane.transact((transaction) => {
        recordPausedReviewerWait(transaction, taskId, reviewerProvider, utcNow());
      });
      return;
    }
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const currentTask = transaction.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", taskId);
        if (currentTask?.status !== "verifying") {
          throw validationError("The Task was cancelled or advanced before its Reviewer started.", { task_id: taskId });
        }
        const now = utcNow();
        clearPausedReviewerWait(transaction, taskId);
        transaction.run(
          `INSERT INTO agent_runs
             (id, work_id, task_id, role, provider, model, effort, status, started_at, created_at, updated_at)
             VALUES (?, ?, ?, 'reviewer', ?, ?, ?, 'running', ?, ?, ?)`,
          reviewerAgentRunId,
          workId,
          taskId,
          reviewerProvider,
          reviewerRoleModel?.model ?? DEFAULT_HARNESS_MODELS.claude,
          reviewerRoleModel?.effort ?? null,
          now,
          now,
          now,
        );
        return { agent_run_id: reviewerAgentRunId };
      },
      event: {
        idempotencyKey: `reviewer-started:${reviewerAgentRunId}`,
        type: "reviewer.started",
        workId,
        taskId,
        agentRunId: reviewerAgentRunId,
        payload: { task_id: taskId, agent_run_id: reviewerAgentRunId, review_round: reviewRound },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (this.stopping) return;
    if (this.providerPauseController?.isPaused(reviewerProvider)) {
      await this.writeLane.write({
        mutateState: (transaction) => {
          const now = utcNow();
          transaction.run("UPDATE agent_runs SET status = 'exited', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", now, now, reviewerAgentRunId);
          recordPausedReviewerWait(transaction, taskId, reviewerProvider, now);
          return { agent_run_id: reviewerAgentRunId, provider_paused: true };
        },
        event: {
          idempotencyKey: `reviewer-deferred:${reviewerAgentRunId}`,
          type: "reviewer.deferred",
          workId,
          taskId,
          agentRunId: reviewerAgentRunId,
          payload: {
            task_id: taskId,
            agent_run_id: reviewerAgentRunId,
            provider: reviewerProvider,
            model: reviewerRoleModel?.model ?? DEFAULT_HARNESS_MODELS.claude,
            effort: reviewerRoleModel?.effort ?? null,
          },
        },
        outbox: [{ provider: "websocket" }],
      });
      return;
    }
    const processSkillsPack = this.getProcessSkillsPack?.() ?? null;
    const changedFiles = await this.git.changedPaths?.({ work_id: workId, task_id: taskId, worktree_path: task.worktree_path ?? undefined }) ?? null;
    const addedFiles = await this.git.addedPaths?.({ work_id: workId, task_id: taskId, worktree_path: task.worktree_path ?? undefined }) ?? null;
    const reviewerContext = await this.contextBuilder.buildReviewerContext(workId, task, changedFiles, addedFiles);
    const result = await this.agentRunner.runReviewer({
      invocation_id: reviewerAgentRunId,
      language: ownerLanguage(this.db),
      work_id: workId,
      task_id: taskId,
      ...this.projectIdOf(workId),
      attempt: task.worker_generation,
      review_round: reviewRound,
      context: {
        task: reviewerContext.task,
        report: reviewerReport,
        worktree: task.worktree_path ?? undefined,
        rules: reviewerContext.rules,
        skills: reviewerContext.skills,
        knowledge: reviewerContext.knowledge,
        ...(processSkillsPack ? { process_skills_dir: processSkillsPack.skills_dir, process_skills_source: processSkillsPack.source } : {}),
        changed_files: reviewerContext.changed_files,
        added_files: reviewerContext.added_files,
        previous_minor_findings: reviewerContext.previous_minor_findings,
        core_tests: reviewerContext.core_tests,
        core_checks: reviewerContext.core_checks,
        owner_guidance: reviewerContext.owner_guidance,
        ...(designDocument ? { design_document: designDocument } : {}),
      },
      ...(reviewerRoleModel ? {
        model: reviewerRoleModel.model,
        provider: reviewerProvider,
        effort: reviewerRoleModel.effort,
      } : { provider: reviewerProvider }),
    }).catch(rethrowUnlessRateLimited);
    if (this.stopping && result.failure_class !== "rate_limited") return;
    if (result.failure_class === "rate_limited") {
      if (!this.providerPauseController) {
        throw validationError("A rate-limited Reviewer requires its provider pause controller.", { task_id: taskId, agent_run_id: reviewerAgentRunId });
      }
      const provider = reviewerProvider;
      const pause = await this.providerPauseController.recordRateLimit({
        provider,
        resets_at: result.rate_limit?.resets_at ?? null,
        role: "reviewer",
        work_id: workId,
        task_id: taskId,
        last_error_key: result.error_key ?? "rate_limited",
        last_error: result.message ?? null,
      });
      const payload = { task_id: taskId, agent_run_id: reviewerAgentRunId, provider: pause.provider, resume_at: pause.resume_at };
      await this.writeLane.write({
        mutateState: (transaction) => {
          const now = utcNow();
          transaction.run("UPDATE agent_runs SET status = 'exited', ended_at = ?, updated_at = ?, usage_json = COALESCE(?, usage_json) WHERE id = ? AND status = 'running'", now, now, usageJson(result.usage), reviewerAgentRunId);
          recordPausedReviewerWait(transaction, taskId, provider, now);
          return payload;
        },
        event: {
          idempotencyKey: `reviewer-rate-limited:${reviewerAgentRunId}`,
          type: "reviewer.rate_limited",
          workId,
          taskId,
          agentRunId: reviewerAgentRunId,
          payload,
        },
        outbox: [{ provider: "websocket" }],
      });
      return;
    }
    if (result.outcome === "success") await this.noteProviderSucceeded(reviewerAgentRunId);
    const ownership = this.db.get<{ task_status: string; agent_status: string }>(
      `SELECT tasks.status AS task_status, agent_runs.status AS agent_status
         FROM tasks JOIN agent_runs ON agent_runs.id = ?
        WHERE tasks.id = ?`,
      reviewerAgentRunId,
      taskId,
    );
    if (
      !ownership ||
      !isActiveAgentStatus(ownership.agent_status) ||
      ownership.task_status !== "verifying" ||
      ownership?.agent_status === "cancel_requested" ||
      ownership?.agent_status === "cancelled"
    ) {
      if (!ownership || !isActiveAgentStatus(ownership.agent_status)) return;
      await this.ignoreReviewerResult(workId, taskId, reviewerAgentRunId, "review_result_arrived_after_cancellation");
      return;
    }
    this.recordSkillFeedback(reviewerAgentRunId, result.skill_feedback);
    if (result.report_valid !== true || !result.report || typeof result.report !== "object" || Array.isArray(result.report)) {
      if (result.outcome !== "success") {
        throw validationError(
          result.message ?? `Reviewer Provider failed (outcome=${result.outcome}).`,
          {
            task_id: taskId,
            agent_run_id: reviewerAgentRunId,
            error_key: result.error_key ?? null,
          },
        );
      }
      throw validationError("The Reviewer result must include a valid report object.", {
        task_id: taskId,
        agent_run_id: reviewerAgentRunId,
      });
    }
    const review = (result as AgentRunResult & { readonly review?: unknown }).review;
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      if (result.outcome !== "success") {
        throw validationError(
          result.message ?? `Reviewer Provider failed (outcome=${result.outcome}).`,
          {
            task_id: taskId,
            agent_run_id: reviewerAgentRunId,
            error_key: result.error_key ?? null,
          },
        );
      }
      throw validationError("The Reviewer result must include its review verdict.", {
        task_id: taskId,
        agent_run_id: reviewerAgentRunId,
      });
    }
    const reviewObject = review as JsonObject;
    const rawVerdict = reviewObject.verdict;
    if (rawVerdict !== "pass" && rawVerdict !== "fix_required" && rawVerdict !== "replan_required" && rawVerdict !== ACCEPTANCE_DEFECT_VERDICT) {
      throw validationError("The Reviewer verdict is not recognized.", { task_id: taskId, agent_run_id: reviewerAgentRunId });
    }
    // A Reviewer replan_required verdict is escalated to the Manager
    // instead of being downgraded to fix_required: see the manager_trigger
    // check on reviewWriteResult below, and TASK_TRANSITION_TABLE row 28.
    const rawFindings = reviewObject.findings;
    const tests = reviewObject.tests;
    if (!Array.isArray(rawFindings) || !tests || typeof tests !== "object" || Array.isArray(tests)) {
      throw validationError("The Reviewer result is missing findings or tests.", { task_id: taskId });
    }
    if (rawVerdict === ACCEPTANCE_DEFECT_VERDICT) {
      // Not a review: no reviews row and no review.failed, so neither the review
      // limits nor lineage_review_attempts count it. The shared route fails the
      // Task, closes this Reviewer run and asks the Manager to rewrite the criteria.
      const defects = normalizeAcceptanceDefects(reviewObject.acceptance_defects);
      if (defects.length === 0) {
        throw validationError("The Reviewer reported acceptance_defect without acceptance_defects.", { task_id: taskId, agent_run_id: reviewerAgentRunId });
      }
      await this.reportAcceptanceDefect({ workId, taskId, source: "reviewer", agentRunId: reviewerAgentRunId, defects, report: null, usage: usagePayload(result.usage) });
      return;
    }
    const findings = normalizeReviewFindings(rawFindings);
    const storedReview: JsonObject = { ...reviewObject, findings: findings as JsonObject[] };
    const verdict = normalizeReviewerVerdict(rawVerdict, findings);
    const expectedOutcome = rawVerdict === "pass" ? "success" : "failed";
    if (result.outcome !== expectedOutcome) {
      throw validationError("The Reviewer outcome does not match its verdict.", {
        task_id: taskId,
        agent_run_id: reviewerAgentRunId,
        verdict,
        outcome: result.outcome,
      });
    }

    const integration = verdict === "pass" ? await this.integrateTask(workId, taskId, task.worktree_path) : null;
    const event = verdict === "pass" ? "review.passed" : "review.failed";
    const reviewPayload: JsonObject = {
      task_id: taskId,
      agent_run_id: reviewerAgentRunId,
      worker_agent_run_id: workerAgentRunId,
      review_round: reviewRound,
      verdict,
      review: storedReview,
      ...(integration ?? {}),
    };
    const reviewWriteResult = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const reduction = reduceTaskInTransaction(transaction, taskId, { event, payload: reviewPayload });
        // reviews.round is a per-Task sequence, not tasks.review_round: a
        // Manager replan resets review_round to 0 (Task row 20), and reusing
        // it here would collide with UNIQUE (task_id, round) of the earlier
        // plan's review rows. Readers take the latest review by round DESC.
        transaction.run(
          `INSERT INTO reviews
             (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
           VALUES (?, ?, COALESCE((SELECT MAX(round) + 1 FROM reviews WHERE task_id = ?), 0), ?, ?, ?, ?)`,
          reviewerAgentRunId,
          taskId,
          taskId,
          verdict,
          JSON.stringify(findings),
          JSON.stringify({ report, review: storedReview }),
          utcNow(),
        );
        const agentUpdate = transaction.run(
          `UPDATE agent_runs
              SET status = 'completed', outcome = ?, ended_at = ?, updated_at = ?, usage_json = COALESCE(?, usage_json)
            WHERE id = ? AND status = 'running'`,
          verdict === "pass" ? "success" : verdict === "replan_required" ? "replan" : "redo",
          utcNow(),
          utcNow(),
          usageJson(result.usage),
          reviewerAgentRunId,
        );
        if (agentUpdate.changes !== 1) {
          throw new HumanReadableError({
            code: "reviewer_run_not_found",
            message: "The Reviewer run disappeared before its result was recorded.",
            remediation: "Inspect the Reviewer run record and retry the review step.",
            details: { agent_run_id: reviewerAgentRunId, task_id: taskId },
          });
        }
        if (reduction.next.status === "completed") registerReviewBacklogInTransaction(transaction, taskId, utcNow());
        return reduction;
      },
      event: {
        idempotencyKey: `${event}:${taskId}:${reviewRound}:${reviewerAgentRunId}`,
        type: event,
        workId,
        taskId,
        agentRunId: reviewerAgentRunId,
        payload: reviewPayload,
      },
      outbox: [{ provider: "websocket" }],
    });
    if (reviewWriteResult.state.manager_trigger) {
      const budget = reviewWriteResult.state.review_budget;
      const trigger: TaskReplanTrigger = budget
        ? { kind: "review_budget_exhausted", task_id: taskId, attempts: budget.attempts, limit: budget.limit }
        : rawVerdict === "replan_required"
          ? { kind: "reviewer_replan_requested", task_id: taskId, summary: typeof reviewObject.summary === "string" ? reviewObject.summary : null }
          : integration
            ? integrationTrigger(taskId, "review", integration)
            : { kind: "review_exhausted", task_id: taskId };
      await this.triggerManagerReplanIfNeeded(workId, trigger);
    }
  }

  /**
   * Merge a finished Task into the Work branch and drop its worktree. On a
   * conflict the merge is aborted and the worktree kept (conflict_retained).
   * A Project-less Work has no branch to merge; its isolated Task workspace is
   * kept until the Work reaches a terminal state, when it is merged into the
   * Work's outputs folder and removed.
   */
  private async integrateTask(workId: string, taskId: string, worktreePath: string | null): Promise<TaskIntegration> {
    const taskBranch = `owl/task/${workId}/${taskId}`;
    const workBranch = `owl/work/${workId}/work`;
    const projectId = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id;
    if (projectId === null || projectId === undefined) {
      return { merge_exit_code: 0, task_branch: taskBranch, work_branch: workBranch, worktree_state: "retained" };
    }
    const request = { work_id: workId, task_id: taskId, worktree_path: worktreePath, task_branch: taskBranch, work_branch: workBranch };
    const taskType = this.db.get<{ type: string }>("SELECT type FROM tasks WHERE id = ?", taskId)?.type;
    if (taskType === "design") {
      const removal = await this.git.removeTaskWorktreeAndBranch(request);
      if (!removal.ok) {
        throw new HumanReadableError({
          code: "worktree_removal_failed",
          message: "Core could not remove the completed Designer Task worktree.",
          remediation: "Inspect the Git worker result and retry the integration step.",
          details: { task_id: taskId, message: removal.message },
        });
      }
      return { merge_exit_code: 0, task_branch: taskBranch, work_branch: workBranch, worktree_state: "merged" };
    }
    // A retried integration (a crash after the merge but before this call
    // returned, or a duplicate call) must not merge the same Task branch
    // twice. When the branch is already fully part of the Work branch, only
    // the worktree still needs cleaning up.
    if ((await this.git.taskBranchMerged?.(request)) === true) {
      const removal = await this.git.removeWorktree(request);
      if (!removal.ok) {
        throw new HumanReadableError({
          code: "worktree_removal_failed",
          message: "Core could not remove the completed Task worktree.",
          remediation: "Inspect the Git worker result and retry the integration step.",
          details: { task_id: taskId, message: removal.message },
        });
      }
      return { merge_exit_code: 0, task_branch: taskBranch, work_branch: workBranch, worktree_state: "merged" };
    }
    const merge = await this.git.integrateTask(request);
    if (!Number.isSafeInteger(merge.exit_code) || merge.exit_code < 0) {
      throw validationError("The Git merge result has an invalid exit code.", { task_id: taskId });
    }
    if (merge.merged && merge.exit_code !== 0) {
      throw validationError("The Git merge result marked success with a non-zero exit code.", { task_id: taskId });
    }
    if (merge.merged) {
      if (!merge.worktree_removed) {
        throw new HumanReadableError({
          code: "worktree_removal_failed",
          message: "Core could not remove the completed Task worktree.",
          remediation: "Inspect the Git worker result and retry the integration step.",
          details: { task_id: taskId, message: merge.removal_message ?? merge.message },
        });
      }
      return { merge_exit_code: 0, task_branch: taskBranch, work_branch: workBranch, worktree_state: "merged" };
    }
    if (!merge.aborted) {
      throw new HumanReadableError({
        code: "git_merge_abort_failed",
        message: "Core could not abort the failed Task merge.",
        remediation: "Inspect the Git worker result before retrying integration.",
        details: { task_id: taskId, message: merge.abort_message ?? merge.message },
      });
    }
    if (merge.failure_kind === "commit_failure") {
      return {
        merge_exit_code: merge.exit_code === 0 ? 1 : merge.exit_code,
        failure_kind: "commit_failure",
        failure_message: merge.message,
        stderr_tail: merge.stderr_tail ?? "",
        task_branch: taskBranch,
        work_branch: workBranch,
        worktree_state: "active",
      };
    }
    return {
      merge_exit_code: merge.exit_code === 0 ? 1 : merge.exit_code,
      merge_conflict_files: mergeConflictPaths(merge.message),
      task_branch: taskBranch,
      work_branch: workBranch,
      worktree_state: "conflict_retained",
    };
  }

  /**
   * Cascade a permanent Task failure to every Task that transitively depends
   * on it. Every reducer path that fails a Task already does this inside its
   * own transaction (reduceTaskInTransaction); this entry point remains for
   * callers that must reconcile a Task failed outside the reducer.
   */
  public async cascadeFailure(workId: string, failedTaskId: string): Promise<void> {
    await this.writeLane.transact((transaction: CoreWriteLaneTransaction) =>
      cascadeDependencyFailureInTransaction(transaction, workId, failedTaskId),
    );
  }
}

/**
 * Whether an agent report's own verification passed: `verification.status` is
 * "passed" (schema 1.1.0), or the legacy 1.0.0 `verification.passed` is true.
 * failed and blocked both count as not passed.
 */
function reportedVerificationPassed(report: JsonObject): boolean {
  const verification = report.verification;
  if (verification === null || typeof verification !== "object" || Array.isArray(verification)) return false;
  const { status, passed } = verification as JsonObject;
  return status === undefined ? passed === true : status === "passed";
}

/** Identity of a design document on disk, to tell whether an attempt rewrote it. */
type DesignDocumentFingerprint = { readonly ino: bigint; readonly size: bigint; readonly mtime_ns: bigint };

async function designDocumentFingerprint(path: string): Promise<DesignDocumentFingerprint | null> {
  const stat = await lstat(path, { bigint: true }).catch(() => null);
  if (!stat?.isFile()) return null;
  return { ino: stat.ino, size: stat.size, mtime_ns: stat.mtimeNs };
}

function sameFingerprint(left: DesignDocumentFingerprint, right: DesignDocumentFingerprint): boolean {
  return left.ino === right.ino && left.size === right.size && left.mtime_ns === right.mtime_ns;
}

/** Result of merging a finished Task into the Work branch, recorded on its completion event. */
type TaskIntegration = {
  merge_exit_code: number;
  merge_conflict_files?: string[];
  failure_kind?: "commit_failure";
  failure_message?: string;
  stderr_tail?: string;
  task_branch: string;
  work_branch: string;
  worktree_state: "merged" | "retained" | "conflict_retained" | "active";
};

function integrationTrigger(taskId: string, after: "verification" | "review", integration: TaskIntegration): TaskReplanTrigger {
  const commitFailure = integration.failure_kind === "commit_failure";
  return {
    kind: "task_integration_failed",
    task_id: taskId,
    after,
    failure_kind: commitFailure ? "commit_failure" : "merge_conflict",
    work_branch: integration.work_branch,
    merge_conflict_files: integration.merge_conflict_files ?? [],
    message: commitFailure ? integration.failure_message ?? null : null,
  };
}

/** Paths git reports as conflicted ("CONFLICT (...): Merge conflict in <path>"), at most 20. */
export function mergeConflictPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("CONFLICT (")) continue;
    const match = /Merge conflict in (.+)$/u.exec(trimmed) ?? /^CONFLICT \([^)]*\): (\S+) deleted in /u.exec(trimmed);
    if (match?.[1]) paths.add(match[1]);
    if (paths.size >= 20) break;
  }
  return [...paths];
}

/**
 * Per-Work cap on active non-Executor agent runs. Explicit `options.maxParallel`
 * wins; otherwise OWL_CORE_MAX_PARALLEL applies when set; otherwise null (no cap).
 */
function resolveMaxParallel(explicit: number | undefined): number | null {
  if (typeof explicit === "number") {
    if (!Number.isSafeInteger(explicit) || explicit < 1) {
      throw validationError("max_parallel must be a positive integer.", { max_parallel: explicit });
    }
    return explicit;
  }
  const envValue = typeof process !== "undefined" ? process.env.OWL_CORE_MAX_PARALLEL : undefined;
  if (envValue === undefined) return null;
  const configured = Number(envValue);
  if (Number.isSafeInteger(configured) && configured > 0) {
    return configured;
  }
  throw validationError("OWL_CORE_MAX_PARALLEL must be a positive integer when set.", { value: envValue });
}

function signalChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.pid <= 0) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* child has already exited */ }
  }
}

/** The recorded stop of a design Task for the stop-report run's context; null when none or unreadable. */
function parseDesignStopRecord(json: string | null | undefined): JsonObject | null {
  if (json == null) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return {
      trigger: value.trigger === "lead_review_rejections" ? "lead_review_rejections" : "designer",
      rejections: typeof value.rejections === "number" ? value.rejections : null,
      limit: typeof value.limit === "number" ? value.limit : null,
    };
  } catch {
    return { trigger: "designer", rejections: null, limit: null };
  }
}
