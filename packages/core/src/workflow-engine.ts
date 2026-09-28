import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { addTokenUsage, AGENT_STALE_THRESHOLD_MS, DEFAULT_HARNESS_MODELS, DEFAULT_ROLE_MODELS, designDocumentPath, tokenUsageOf, usageJson, type TokenUsage } from "@owl/shared";
import { DEFAULT_EXECUTOR_CONFIG, defaultExecutorRuntime, runExecutorsParallel, terminateActiveExecutorsImmediately } from "./executor.js";
import type { ExecutorConfig, ExecutorResult, ExecutorRunObserver, ExecutorRuntime, ExecutorTask } from "./executor.js";
import { HumanReadableError, validationError } from "./errors";
import { parseWorkRules, type RuleRole, type RuleStore } from "./rule-store";
import {
  applyReplanInTransaction,
  assertTaskDependencyGraph,
  cascadeDependencyFailureInTransaction,
  createTaskPlanInTransaction,
  isTerminalTaskState,
  reduceTaskInTransaction,
  reduceWorkInTransaction,
  type ReplanApplyGuard,
  type ReplanApplyResult,
} from "./state-reducer";
import { EXECUTOR_CONFIG_SETTINGS_KEY, HYBRID_MODE_SETTINGS_KEY } from "./types";
import { GitWorktreeGateway } from "./git-gateway.js";
import { processIdentityMatches, readProcessIdentity } from "./process-identity.js";
import { formatRuntimeFailure } from "./error-display.js";
import type { ProviderPauseController } from "./provider-pause-controller";
import { enqueueLearningJobInTransaction } from "./learning-pipeline.js";
import { DEFAULT_KNOWLEDGE_LIMITS, KnowledgeRetriever, type KnowledgeLimits } from "./knowledge-retrieval.js";
import { ownerGuidance } from "./owner-guidance.js";
import { dependencyContext, isTaskReviewRequired, loadFixContext, loadRetrySubtasks, reviewerTaskView, roleTaskView, taskDependencyIds } from "./task-context.js";
import { registerReviewBacklogInTransaction } from "./review-backlog.js";
import { clearPausedReviewerWait, recordPausedReviewerWait } from "./provider-pause-reviewer-wait.js";
import { agentCliNames, listProcesses, planSubagentReconciliation } from "./subagent-watcher.js";
import type {
  AgentRunResult,
  AgentRunner,
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
import type { ReplanPlan } from "./replan-plan";
import type { SkillBox } from "./skill-box";

const ACTIVE_AGENT_STATUSES = ["launch_pending", "spawned", "running", "cancel_requested"] as const;

/** Hybrid Worker phases recorded on its AgentRun (agent_runs.phase). */
type HybridPhase = "plan" | "executing" | "verdict";

const EXECUTOR_LABEL_MAX_CHARS = 160;
const EXECUTOR_OUTPUT_TOUCH_INTERVAL_MS = 5_000;
const SUBAGENT_SCAN_INTERVAL_MS = 5_000;

/** Whether `candidate` resolves to `base` itself or a path underneath it. */
function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `<subtask_id>: <first line of the instruction>`, capped for list display. */
function executorLabel(subtaskId: string, title: string): string {
  const label = `${subtaskId}: ${title.replace(/\s+/gu, " ").trim()}`;
  return label.length > EXECUTOR_LABEL_MAX_CHARS ? `${label.slice(0, EXECUTOR_LABEL_MAX_CHARS - 1)}…` : label;
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

/** Backoff schedule (ms) for transient-failure retries: 30s, 2m, 5m. */
const TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
const MAX_CAPTURED_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_CAPTURED_ARTIFACT_FILE_BYTES = 10 * 1024 * 1024;

export function normalizeReviewerVerdict(
  verdict: "pass" | "fix_required" | "replan_required",
  findings: readonly unknown[],
): "pass" | "fix_required" | "replan_required" {
  if (verdict !== "fix_required") return verdict;
  return findings.every((finding) =>
    finding !== null && typeof finding === "object" && !Array.isArray(finding) && (finding as JsonObject).severity === "minor"
  ) ? "pass" : "fix_required";
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

export interface ManagerReplanNeededInput {
  readonly work_id: string;
  readonly failed_task_ids: readonly string[];
  readonly reason: string;
  readonly question?: string | null;
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
  readonly providerPauseController?: ProviderPauseController;
  /** Root directory Hybrid Mode Executor workspaces are created under. Defaults to process.cwd(). */
  readonly owlRoot?: string;
  /** Durable runtime data directory. Defaults to `<owlRoot>/data`. */
  readonly dataDir?: string;
  /** Hybrid Mode Executor spawn config (provider/model/timeout). Defaults to DEFAULT_EXECUTOR_CONFIG. */
  readonly hybridExecutor?: ExecutorConfig;
  /**
   * Environment and CLI paths for Executor processes, resolved on every
   * dispatch. Defaults to PATH and HOME with executables looked up on PATH.
   */
  readonly executorRuntime?: () => ExecutorRuntime | Promise<ExecutorRuntime>;
  readonly ruleStore?: RuleStore;
  readonly skillBox?: SkillBox;
  readonly knowledgeRetriever?: KnowledgeRetriever;
  readonly getKnowledgeLimits?: () => KnowledgeLimits;
  readonly getProcessSkillsPack?: () => { readonly skills_dir: string; readonly source: "setting" | "claude" | "codex" } | null;
  /** How often checkStaleAgents scans for dead/idle agents. Defaults to 60 seconds. */
  readonly staleCheckIntervalMs?: number;
}

/**
 * Dependency resolution, capacity gating, launching, and Work completion are
 * deliberately command producers. They never write a Work/Task state column;
 * every state mutation goes through StateReducer in the same WriteLane
 * transaction as its canonical event and websocket outbox entry.
 */

const WF_MODEL_SETTINGS_KEY = "model_settings";
function resolveHybridExecutor(db: Pick<CoreDatabase, "get">): ExecutorConfig {
  const row = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", EXECUTOR_CONFIG_SETTINGS_KEY);
  if (!row) return DEFAULT_EXECUTOR_CONFIG;
  let value: unknown;
  try {
    value = JSON.parse(row.value_json) as unknown;
  } catch (error) {
    throw validationError("Stored Executor configuration is not valid JSON.", {
      key: EXECUTOR_CONFIG_SETTINGS_KEY,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Stored Executor configuration must be an object.", { key: EXECUTOR_CONFIG_SETTINGS_KEY });
  }
  const record = value as Record<string, unknown>;
  const rawProvider = typeof record.provider === "string" ? record.provider.trim().toLowerCase() : "";
  const provider = rawProvider === "openai" ? "codex" : rawProvider === "anthropic" ? "claude" : rawProvider;
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const effort = record.effort;
  const timeoutMs = record.timeout_ms;
  if (
    (provider !== "claude" && provider !== "codex") ||
    model.length === 0 ||
    (effort !== undefined && effort !== null && typeof effort !== "string") ||
    (typeof effort === "string" && effort.length > 0 && !["low", "medium", "high", "xhigh", "max"].includes(effort)) ||
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw validationError("Stored Executor configuration is invalid.", { key: EXECUTOR_CONFIG_SETTINGS_KEY });
  }
  return {
    provider,
    model,
    ...(typeof effort === "string" && effort.length > 0 ? { effort } : {}),
    timeout_ms: timeoutMs,
  };
}

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

export class WorkflowEngine {
  private readonly db: CoreDatabase;
  private readonly writeLane;
  private readonly agentRunner: AgentRunner;
  private readonly git: GitGateway;
  /** Per-Work cap on active non-Executor agent runs; null means unlimited. */
  private readonly maxParallel: number | null;
  /** Cap on active non-Executor agent runs across all Works; null means unlimited. */
  private readonly globalMaxParallel: number | null;
  private readonly onManagerReplanNeeded?: (input: ManagerReplanNeededInput) => Promise<void>;
  private readonly onTaskSettled?: (workId: string) => void;
  private readonly providerPauseController?: ProviderPauseController;
  /** In-process Task pipelines, keyed by the Worker's agent_run_id. */
  private readonly pipelines = new Map<string, Promise<void>>();
  private readonly owlRoot: string;
  private readonly dataDir: string;
  private readonly hybridExecutorOverride?: ExecutorConfig;
  private readonly executorRuntime: () => ExecutorRuntime | Promise<ExecutorRuntime>;
  private readonly ruleStore?: RuleStore;
  private readonly skillBox?: SkillBox;
  private readonly knowledgeRetriever?: KnowledgeRetriever;
  private readonly getKnowledgeLimits: () => KnowledgeLimits;
  private readonly getProcessSkillsPack?: () => { readonly skills_dir: string; readonly source: "setting" | "claude" | "codex" } | null;
  private readonly verificationChildren = new Set<ChildProcess>();
  private running = false;
  private stopping = false;
  private staleCheckInterval: ReturnType<typeof setInterval> | null = null;
  private subagentScanInterval: ReturnType<typeof setInterval> | null = null;
  private subagentScanInFlight = false;
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
    this.providerPauseController = options.providerPauseController;
    this.owlRoot = options.owlRoot ?? process.cwd();
    this.dataDir = options.dataDir ?? join(this.owlRoot, "data");
    this.git = options.git ?? new GitWorktreeGateway(options.db, this.owlRoot);
    this.hybridExecutorOverride = options.hybridExecutor;
    this.executorRuntime = options.executorRuntime ?? defaultExecutorRuntime;
    this.ruleStore = options.ruleStore;
    this.skillBox = options.skillBox;
    this.knowledgeRetriever = options.knowledgeRetriever;
    this.getKnowledgeLimits = options.getKnowledgeLimits ?? (() => DEFAULT_KNOWLEDGE_LIMITS);
    this.getProcessSkillsPack = options.getProcessSkillsPack;
    this.maxParallel = resolveMaxParallel(options.maxParallel);
    if (options.globalMaxParallel !== undefined && (!Number.isSafeInteger(options.globalMaxParallel) || options.globalMaxParallel < 1)) {
      throw validationError("dispatcher.global_max_parallel must be a positive integer.", { global_max_parallel: options.globalMaxParallel });
    }
    this.globalMaxParallel = options.globalMaxParallel ?? null;
    this.staleCheckIntervalMs = options.staleCheckIntervalMs ?? 60_000;
  }

  /** The role's Rule Store lines plus the Work's rules, one per line; null when there are none. */
  private composeRulesForRole(role: RuleRole, workId: string): string | null {
    if (!this.ruleStore) return null;
    const workRulesJson = this.db.get<{ rules_json: string | null }>("SELECT rules_json FROM works WHERE id = ?", workId)?.rules_json;
    const lines = this.ruleStore.getInstructionsForRole(role, parseWorkRules(workRulesJson, workId));
    return lines.length === 0 ? null : lines.join("\n");
  }

  public composeSkillsForWork(workId: string): string | null {
    if (!this.skillBox) return null;
    try {
      const projectId = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id ?? null;
      return this.skillBox.renderIndex(projectId);
    } catch (error) {
      console.warn(`[owl-core] Could not render skill index for Work ${workId}`, error);
      return null;
    }
  }

  public async composeKnowledgeForTask(workId: string, taskId: string | null): Promise<string | null> {
    if (!this.knowledgeRetriever) return null;
    try {
      const work = this.db.get<{ title: string; project_id: string | null }>(
        "SELECT title, project_id FROM works WHERE id = ?",
        workId,
      );
      if (!work) return null;
      const task = taskId
        ? this.db.get<{ title: string; acceptance: string | null; context: string | null }>(
            "SELECT title, acceptance, context FROM tasks WHERE id = ? AND work_id = ?",
            taskId,
            workId,
          )
        : undefined;
      const result = await this.knowledgeRetriever.render({
        work_title: work.title,
        task_title: task?.title,
        task_text: [task?.acceptance, task?.context].filter((value): value is string => Boolean(value)).join("\n"),
        project_id: work.project_id,
      }, this.getKnowledgeLimits());
      return result?.text ?? null;
    } catch (error) {
      console.warn(`[owl-core] Could not compose knowledge for Work ${workId}`, error);
      return null;
    }
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
      const runs = this.db.all<{ id: string; work_id: string; task_id: string | null; pid: number | null; origin: string | null }>(
        "SELECT id, work_id, task_id, pid, origin FROM agent_runs WHERE status IN ('launch_pending','spawned','running','cancel_requested')",
      );
      if (runs.length === 0) return;
      const plan = planSubagentReconciliation(processes, runs, agentCliNames());
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
      // An Executor's exit is recorded by its own close handler in the Hybrid
      // flow; reconciling it here would race that handler.
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
          reason: processFailure === "process_identity_mismatch"
            ? `Agent PID ${run.pid} no longer identifies the process recorded for this run.`
            : `Agent process ${run.pid} disappeared without a report.`,
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
  ): Promise<ReplanApplyResult> {
    const result = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const state = applyReplanInTransaction(transaction, workId, plan, guard, reason);
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
      "SELECT id FROM tasks WHERE work_id = ? AND status = 'waiting' ORDER BY priority DESC, created_at ASC",
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
        try {
          this.onTaskSettled?.(workId);
        } catch (error) {
          console.error(`[owl-core] Task settle notification failed for Work ${workId}`, error);
        }
      });
    this.pipelines.set(agentRunId, pipeline);
  }

  private isWorkRunning(workId: string): boolean {
    return this.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId)?.state === "running";
  }

  /** Match providerSelection's configured/default Provider when a role has no model override. */
  private providerForRoleModel(
    roleModel: { provider: string } | undefined,
    db: Pick<CoreDatabase, "get"> = this.db,
  ): string {
    if (roleModel) return roleModel.provider;
    const configuredProvider = process.env.OWL_PROVIDER_ID?.trim() || resolveHybridExecutor(db).provider;
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
      if (this.providerPauseController?.isPaused(roleProvider)) continue;
      if (type !== "design" && this.isHybridModeEnabled()) {
        const executorConfig = this.hybridExecutorOverride ?? resolveHybridExecutor(this.db);
        if (this.providerPauseController?.isPaused(executorConfig.provider)) continue;
      }
      const current = await this.snapshot(workId);
      if (current.capacity <= 0) break;
      const prepared = await this.git.prepareWorktree({ work_id: workId, task_id: taskId });
      if (!prepared.ok) {
        preparationFailure = new Error(ownerLanguage(this.db) === "en"
          ? `Could not prepare the worktree for Task ${taskId}. Cause: ${prepared.message}`
          : `Task ${taskId}のWorktree準備に失敗しました。原因: ${prepared.message}`);
        break;
      }
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
            const roleProvider = this.providerForRoleModel(roleModel, transaction);
            if (this.providerPauseController?.isPaused(roleProvider)) {
              throw new HumanReadableError({ code: "provider_paused", message: "The Task provider is paused.", remediation: "The Task will start when the provider resumes." });
            }
            if (type !== "design" && this.isHybridModeEnabled()) {
              const executorConfig = this.hybridExecutorOverride ?? resolveHybridExecutor(transaction);
              if (this.providerPauseController?.isPaused(executorConfig.provider)) {
                throw new HumanReadableError({ code: "provider_paused", message: "The Executor provider is paused.", remediation: "The Task will start when the provider resumes." });
              }
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
        // Other Tasks took the free capacity meanwhile; launch again when a
        // run finishes.
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "launch_capacity_exhausted") break;
        throw error;
      }
      const task = writeResult.state.next;
      launched.push(taskId);
      this.startPipeline(workId, taskId, agentRunId, task.worker_generation);
    }
    if (preparationFailure !== null) {
      throw preparationFailure;
    }
    return launched;
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
  private async triggerManagerReplanIfNeeded(
    workId: string,
    taskId: string,
    reason: string,
    question?: string | null,
  ): Promise<void> {
    if (!this.onManagerReplanNeeded) {
      return;
    }
    try {
      await this.onManagerReplanNeeded({
        work_id: workId,
        failed_task_ids: [taskId],
        reason,
        question: question ?? null,
      });
    } catch (error) {
      console.error(`[owl-core] Manager replan trigger failed for Work ${workId} Task ${taskId}`, error);
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
      const task = this.db.get<Pick<TaskRow, "status" | "type" | "review_override">>("SELECT status, type, review_override FROM tasks WHERE id = ?", taskId);
      if (!task) return;
      if (task.status === "running") {
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          failure_class: "deterministic",
          error_key: `${isDesigner ? "designer" : "worker"}_exception:${message}`,
          retry_allowed: false,
          report_present: false,
          reason: `${role} execution failed unexpectedly: ${message}`,
        }, "agent.crashed");
        return;
      }
      if (task.status === "verifying") {
        const verification = await this.writeLane.write({
          mutateState: (transaction) => reduceTaskInTransaction(transaction, taskId, {
            event: "verification.completed",
            payload: {
              outcome: "fail",
              review_required: isTaskReviewRequired(task),
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
          await this.triggerManagerReplanIfNeeded(workId, taskId, `Task ${taskId} verification failed unexpectedly: ${message}`);
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
    // The Task's real dependencies and what they produced.
    const dependencies = dependencyContext(this.db, taskId, this.dataDir);
    const task = taskRow ? roleTaskView(taskRow, dependencies.depends_on) : undefined;
    const retrySubtasks = loadRetrySubtasks(this.db, taskId);
    // The fix context of the latest attempt only (a failed verification
    // or a fix/replan review, never both), plus the Owner's answers.
    const guidance = ownerGuidance(this.db, workId, taskId);
    const reviewContext: JsonObject = {
      dependency_reports: dependencies.dependency_reports,
      artifact_paths: dependencies.artifact_paths,
      ...((loadFixContext(this.db, taskId) ?? {}) as JsonObject),
      owner_guidance: guidance,
      ...(retrySubtasks.length > 0 ? { retry_subtasks: retrySubtasks } : {}),
    };
    // One Task run (and every Hybrid phase and Executor in it) sees one rule set.
    const isDesigner = taskRow?.type === "design";
    const designTier = isDesigner && taskRow?.lead_designer_start_round != null ? "lead" : "standard";
    const role = isDesigner ? "designer" : "worker";
    const workerRules = this.composeRulesForRole(role, workId);
    const workerSkills = this.composeSkillsForWork(workId);
    const workerKnowledge = await this.composeKnowledgeForTask(workId, taskId);
    const hybridMode = !isDesigner && this.isHybridModeEnabled();
    const processSkillsPack = this.getProcessSkillsPack?.() ?? null;
    const runModel = this.db.get<{ provider: string; model: string }>("SELECT provider, model FROM agent_runs WHERE id = ?", agentRunId);
    const workerRoleModel = resolveRoleModel(this.db, isDesigner && designTier === "lead" ? "lead_designer" : role);
    const workerProvider = this.providerForRoleModel(workerRoleModel);
    if (!hybridMode) {
      const designPath = isDesigner ? designDocumentPath(this.dataDir, workId, taskId) : null;
      if (designPath) await mkdir(dirname(designPath), { recursive: true, mode: 0o700 });
      const designBaseline = designPath ? await designDocumentFingerprint(designPath) : null;
      const runRequest = {
        invocation_id: agentRunId,
        language: ownerLanguage(this.db),
        work_id: workId,
        task_id: taskId,
        attempt: generation,
        context: { task_id: taskId, work_id: workId, task, worktree: taskRow?.worktree_path ?? null, hybrid_mode: false, rules: workerRules, skills: workerSkills, knowledge: workerKnowledge, ...(designPath ? { design_document_path: designPath, design_tier: designTier } : {}), ...(processSkillsPack ? { process_skills_dir: processSkillsPack.skills_dir, process_skills_source: processSkillsPack.source } : {}), ...reviewContext },
        ...(workerRoleModel ? {
          model: runModel?.model ?? workerRoleModel.model,
          provider: runModel?.provider ?? workerProvider,
          effort: workerRoleModel.effort,
        } : { provider: runModel?.provider ?? workerProvider }),
      };
      const result = isDesigner
        ? await this.agentRunner.runDesigner(runRequest)
        : await this.agentRunner.runWorker(runRequest);
      if (this.stopping) return;
      await this.recordWorkerResult(workId, taskId, agentRunId, result, generation, designBaseline);
      return;
    }

    // Hybrid Mode (Worker=Team Leader) phase 1: the
    // Worker decomposes the Task into subtasks without doing any of the work
    // itself. A non-success plan result (e.g. a malformed/unparseable plan)
    // is routed through the normal failure recording path unchanged.
    await this.recordHybridPhase(workId, taskId, agentRunId, "plan");
    const planResult = await this.agentRunner.runWorker({
      invocation_id: agentRunId,
      language: ownerLanguage(this.db),
      work_id: workId,
      task_id: taskId,
      attempt: generation,
      context: { task_id: taskId, work_id: workId, task, worktree: taskRow?.worktree_path ?? null, hybrid_mode: true, hybrid_phase: "plan", rules: workerRules, skills: workerSkills, knowledge: workerKnowledge, ...(processSkillsPack ? { process_skills_dir: processSkillsPack.skills_dir, process_skills_source: processSkillsPack.source } : {}), ...reviewContext },
      ...(workerRoleModel ? {
        model: workerRoleModel.model,
        provider: workerProvider,
        effort: workerRoleModel.effort,
      } : { provider: workerProvider }),
    });
    if (this.stopping) return;
    if (planResult.outcome !== "success") {
      await this.recordWorkerResult(workId, taskId, agentRunId, planResult, generation);
      return;
    }
    await this.noteProviderSucceeded(agentRunId);
    const subtasks = this.extractHybridSubtasks(planResult, taskId);

    // Phase 2: spawn one real Executor CLI subprocess per subtask, retrying
    // any failed subtask exactly once.
    const subtaskTitles = new Map(subtasks.map((subtask) => [subtask.subtask_id, subtask.title]));
    const executorTasks: ExecutorTask[] = subtasks.map((subtask) => ({
      subtask_id: subtask.subtask_id,
      instruction: subtask.instruction,
      write_paths: subtask.write_paths,
      // Executors must see the same tracked files as their Worker. Use the
      // Task worktree when one exists, otherwise the normal Owl workspace.
      workspace_dir: taskRow?.worktree_path ?? this.owlRoot,
      task: {
        title: taskRow?.title ?? "",
        acceptance: taskRow?.acceptance ?? "",
        context: taskRow?.context ?? "",
        rules: workerRules,
        owner_guidance: guidance,
      },
      ...(processSkillsPack ? { process_skills_dir: processSkillsPack.skills_dir, process_skills_source: processSkillsPack.source } : {}),
    }));
    // Resolve the Executor settings at the point of dispatch. The HTTP settings
    // endpoint and Core both persist this row, so a long-lived Core process does
    // not keep using the configuration captured at construction time.
    const hybridExecutorConfig = this.hybridExecutorOverride ?? resolveHybridExecutor(this.db);
    if (this.providerPauseController?.isPaused(hybridExecutorConfig.provider)) {
      await this.recordRateLimitedTask(workId, taskId, agentRunId, {
        outcome: "failed",
        failure_class: "rate_limited",
        error_key: "provider_paused",
        rate_limit: { resets_at: null, source: null },
        message: "The Executor provider is paused.",
        skill_feedback: null,
      }, usagePayload(planResult.usage), { provider: hybridExecutorConfig.provider, role: "executor" });
      return;
    }
    const executorRuntime = await this.executorRuntime();
    await this.recordHybridPhase(workId, taskId, agentRunId, "executing", executorTasks.length);
    const executorResults = await runExecutorsParallel(
      executorTasks,
      hybridExecutorConfig,
      1,
      (executorTask, attempt) => this.trackExecutorRun(
        workId,
        taskId,
        agentRunId,
        hybridExecutorConfig,
        executorTask,
        executorLabel(executorTask.subtask_id, subtaskTitles.get(executorTask.subtask_id) ?? ""),
        attempt,
      ),
      executorRuntime,
    );
    if (this.stopping) return;
    await this.recordHybridPhase(workId, taskId, agentRunId, "verdict");

    // Phase 3: the Worker reviews the real Executor results and reports the
    // final report + verdict; recorded exactly like a normal Worker report.
    const verdictResult = await this.agentRunner.runWorker({
      invocation_id: agentRunId,
      language: ownerLanguage(this.db),
      work_id: workId,
      task_id: taskId,
      attempt: generation,
      context: {
        task_id: taskId,
        work_id: workId,
        task,
        worktree: taskRow?.worktree_path ?? null,
        hybrid_mode: true,
        hybrid_phase: "verdict",
        rules: workerRules,
        skills: workerSkills,
        knowledge: workerKnowledge,
        ...(processSkillsPack ? { process_skills_dir: processSkillsPack.skills_dir, process_skills_source: processSkillsPack.source } : {}),
        executor_results: executorResults,
        ...reviewContext,
      },
      ...(workerRoleModel ? {
        model: workerRoleModel.model,
        provider: workerProvider,
        effort: workerRoleModel.effort,
      } : { provider: workerProvider }),
    });
    if (this.stopping) return;
    // The Worker row holds the plan and verdict calls together.
    await this.recordWorkerResult(workId, taskId, agentRunId, {
      ...verdictResult,
      usage: addTokenUsage(planResult.usage, verdictResult.usage),
    }, generation);
  }

  /**
   * Record the Hybrid phase on the Worker's AgentRun so the UI can show what
   * the Worker is doing while no Worker process is alive (executing phase).
   * Display-only: a failed write is logged and never stops the Task.
   */
  private async recordHybridPhase(
    workId: string,
    taskId: string,
    workerRunId: string,
    phase: HybridPhase,
    subtaskCount?: number,
  ): Promise<void> {
    try {
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = utcNow();
          transaction.run(
            "UPDATE agent_runs SET phase = ?, subtask_count = COALESCE(?, subtask_count), updated_at = ? WHERE id = ?",
            phase,
            subtaskCount ?? null,
            now,
            workerRunId,
          );
          if (phase === "executing") {
            // The plan process has exited; restart the idle clock for the
            // Executor phase, whose output refreshes it from here on.
            transaction.run("UPDATE agent_runs SET last_output_at = ? WHERE id = ?", now, workerRunId);
          }
          return { agent_run_id: workerRunId, phase };
        },
        event: {
          idempotencyKey: `worker-phase:${workerRunId}:${phase}`,
          type: "worker.phase_changed",
          workId,
          taskId,
          agentRunId: workerRunId,
          payload: {
            agent_run_id: workerRunId,
            phase,
            ...(subtaskCount === undefined ? {} : { subtask_count: subtaskCount }),
          },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      console.error(`[owl-core] Failed to record Hybrid phase ${phase} for ${workerRunId}`, error);
    }
  }

  /**
   * Record one Executor attempt as an AgentRun (role 'executor', child of the
   * Worker run) and keep its pid, output activity and outcome up to date.
   * Tracking is display and cancellation support only: a failed write is
   * logged and the Executor still runs.
   */
  private async trackExecutorRun(
    workId: string,
    taskId: string,
    workerRunId: string,
    config: ExecutorConfig,
    task: ExecutorTask,
    label: string,
    attempt: number,
  ): Promise<ExecutorRunObserver> {
    const runId = createUlid();
    const previousRunId = this.db.get<{ id: string }>(
      `SELECT id FROM agent_runs WHERE parent_agent_id = ? AND role = 'executor' AND label = ?
        ORDER BY created_at DESC LIMIT 1`,
      workerRunId,
      label,
    )?.id ?? null;
    try {
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = utcNow();
          transaction.run(
            `INSERT INTO agent_runs
               (id, work_id, task_id, parent_agent_id, role, origin, provider, model, status, label,
                retry_of_run_id, started_at, last_output_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'executor', 'spawned', ?, ?, 'launch_pending', ?, ?, ?, ?, ?, ?)`,
            runId,
            workId,
            taskId,
            workerRunId,
            config.provider,
            config.model,
            label,
            attempt > 1 ? previousRunId : null,
            now,
            now,
            now,
            now,
          );
          transaction.run("UPDATE agent_runs SET last_output_at = ?, updated_at = ? WHERE id = ?", now, now, workerRunId);
          return { agent_run_id: runId };
        },
        event: {
          idempotencyKey: `executor-started:${runId}`,
          type: "executor.started",
          workId,
          taskId,
          agentRunId: runId,
          payload: {
            agent_run_id: runId,
            parent_agent_run_id: workerRunId,
            subtask_id: task.subtask_id,
            label,
            attempt,
          },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      console.error(`[owl-core] Failed to record Executor ${task.subtask_id} for ${workerRunId}`, error);
      return {};
    }
    let lastOutputTouch = 0;
    return {
      agent_run_id: runId,
      onSpawn: (pid) => {
        const identity = readProcessIdentity(pid);
        void this.writeLane.transact((transaction) => {
          const now = utcNow();
          transaction.run(
            `UPDATE agent_runs
                SET pid = ?, process_start_time = ?, process_cmdline_sha256 = ?,
                    status = CASE WHEN status IN ('launch_pending','spawned') THEN 'running' ELSE status END,
                    updated_at = ?
              WHERE id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')`,
            pid,
            identity.process_start_time,
            identity.process_cmdline_sha256,
            now,
            runId,
          );
          return { agent_run_id: runId, pid };
        }).catch((error) => console.error(`[owl-core] Failed to persist Executor pid for ${runId}`, error));
      },
      onOutput: () => {
        const nowMs = Date.now();
        if (nowMs - lastOutputTouch < EXECUTOR_OUTPUT_TOUCH_INTERVAL_MS) return;
        lastOutputTouch = nowMs;
        void this.writeLane.transact((transaction) => {
          const now = utcNow();
          transaction.run(
            `UPDATE agent_runs SET last_output_at = ?, updated_at = ?
              WHERE id IN (?, ?) AND status IN ('launch_pending','spawned','running','cancel_requested')`,
            now,
            now,
            runId,
            workerRunId,
          );
          return { agent_run_id: runId };
        }).catch((error) => console.error(`[owl-core] Failed to persist Executor output activity ${runId}`, error));
      },
      finish: async (result: ExecutorResult, usage: TokenUsage | null) =>
        this.finishExecutorRun(workId, taskId, workerRunId, runId, task, result, usage),
    };
  }

  /** Close an Executor AgentRun; resolves true when it had been cancelled. */
  private async finishExecutorRun(
    workId: string,
    taskId: string,
    workerRunId: string,
    runId: string,
    task: ExecutorTask,
    result: ExecutorResult,
    usage: TokenUsage | null,
  ): Promise<boolean> {
    try {
      const written = await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = utcNow();
          const row = transaction.get<{ status: string }>("SELECT status FROM agent_runs WHERE id = ?", runId);
          const cancelled = row?.status === "cancel_requested" || row?.status === "cancelled";
          const status = cancelled ? "cancelled" : result.success ? "completed" : "failed";
          transaction.run(
            `UPDATE agent_runs SET status = ?, pid = NULL, ended_at = COALESCE(ended_at, ?), updated_at = ?,
                usage_json = COALESCE(?, usage_json)
              WHERE id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')`,
            status,
            now,
            now,
            usageJson(usage),
            runId,
          );
          return { agent_run_id: runId, status, cancelled };
        },
        event: {
          idempotencyKey: `executor-finished:${runId}`,
          type: result.success ? "executor.completed" : "executor.failed",
          workId,
          taskId,
          agentRunId: runId,
          payload: {
            agent_run_id: runId,
            parent_agent_run_id: workerRunId,
            subtask_id: task.subtask_id,
            success: result.success,
            exit_code: result.exit_code,
            duration_ms: result.duration_ms,
            ...usagePayload(usage),
          },
        },
        outbox: [{ provider: "websocket" }],
      });
      if (!written.state.cancelled && result.success && this.providerPauseController) {
        const run = this.db.get<{ provider: string; started_at: string | null; created_at: string }>(
          "SELECT provider, started_at, created_at FROM agent_runs WHERE id = ?", runId,
        );
        if (run) await this.providerPauseController.noteProviderSucceeded(run.provider, run.started_at ?? run.created_at);
      }
      return written.state.cancelled;
    } catch (error) {
      console.error(`[owl-core] Failed to record Executor result for ${runId}`, error);
      return false;
    }
  }

  /**
   * Validate and extract the Hybrid Mode phase 1 plan's subtasks. Fails fast
   * (no silent fallback/default plan) on any malformed shape, since a bad
   * plan must never silently proceed to spawning Executors.
   */
  private extractHybridSubtasks(
    planResult: AgentRunResult,
    taskId: string,
  ): readonly { subtask_id: string; title: string; instruction: string; write_paths: readonly string[] }[] {
    const report = planResult.report;
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      throw validationError("Hybrid Mode plan result must include a JSON report object with subtasks.", {
        task_id: taskId,
      });
    }
    const rawSubtasks = (report as JsonObject).subtasks;
    if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
      throw validationError("Hybrid Mode plan report must include a non-empty subtasks array.", {
        task_id: taskId,
      });
    }
    return rawSubtasks.map((item) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? (item as JsonObject) : null;
      if (
        record === null ||
        typeof record.subtask_id !== "string" || record.subtask_id.length === 0 ||
        typeof record.title !== "string" || record.title.trim().length === 0 ||
        typeof record.instruction !== "string" || record.instruction.length === 0 ||
        (record.write_paths !== undefined && (
          !Array.isArray(record.write_paths) ||
          record.write_paths.length === 0 ||
          record.write_paths.some((path) => typeof path !== "string" || path.trim().length === 0)
        ))
      ) {
        throw validationError("Each Hybrid Mode subtask must have a non-empty subtask_id, title, instruction and valid write_paths.", {
          task_id: taskId,
        });
      }
      return {
        subtask_id: record.subtask_id,
        title: record.title,
        instruction: record.instruction,
        // Pre-schema mock/legacy reports stay safe: an undeclared scope conflicts with everything.
        write_paths: record.write_paths === undefined ? ["*"] : [...new Set((record.write_paths as string[]).map((path) => path.trim()))],
      };
    });
  }

  /**
   * Hybrid Mode (Worker=Team Leader) toggle, read
   * directly from the `settings` table (same `hybrid_mode` key as
   * Core.getHybridMode()). WorkflowEngine cannot import Core itself (Core
   * owns WorkflowEngine, so that would be circular), hence the direct query
   * against the shared CoreDatabase using the shared key constant.
   */
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

  private async recordWorkerResult(
    workId: string,
    taskId: string,
    agentRunId: string,
    result: AgentRunResult,
    generation: number,
    designBaseline?: DesignDocumentFingerprint | null,
  ): Promise<void> {
    if (this.stopping) return;
    if (await this.closeAbandonedWorkerRun(workId, taskId, agentRunId)) return;
    this.recordSkillFeedback(agentRunId, result.skill_feedback);
    // Every outcome below stores the tokens the Worker spent.
    const usage = usagePayload(result.usage);
    if (result.failure_class === "rate_limited") {
      await this.recordRateLimitedTask(workId, taskId, agentRunId, result, usage);
      return;
    }
    if (result.outcome === "success") await this.noteProviderSucceeded(agentRunId);
    // Consume needs_replanning/question_for_manager from the Worker report
    // regardless of outcome: a Worker can flag that its own Task needs a new
    // plan even while otherwise reporting success or a classified failure
    // that also carries a report (see the hasReport branch below).
    const reportObject =
      result.report && typeof result.report === "object" && !Array.isArray(result.report)
        ? (result.report as JsonObject)
        : undefined;
    // Hybrid Mode: the Worker report may carry an extended `verdict`
    // on top of the base ReportEnvelope fields ("ok" | "retry" |
    // "needs_replanning"). "needs_replanning" folds into the same
    // needs_replanning/question_for_manager check every Worker report
    // already goes through; "ok" needs no special handling (the normal
    // outcome-driven branches below apply); "retry" is handled after this
    // block, before the normal success/failure branches run.
    const verdict =
      reportObject && (reportObject.verdict === "ok" || reportObject.verdict === "retry" || reportObject.verdict === "needs_replanning")
        ? reportObject.verdict
        : null;
    if (reportObject) {
      const needsReplanning = reportObject.needs_replanning === true || verdict === "needs_replanning";
      const question =
        typeof reportObject.question_for_manager === "string" && reportObject.question_for_manager.trim().length > 0
          ? reportObject.question_for_manager
          : null;
      if (needsReplanning || question !== null) {
        const reason = question
          ? `Worker requested Manager replanning for Task ${taskId}: ${question}`
          : verdict === "needs_replanning"
            ? `Hybrid Worker reported needs_replanning for Task ${taskId}: half or more Executor subtasks failed.`
            : `Worker flagged needs_replanning for Task ${taskId}.`;
        // Record the result and fail the Task before the Manager runs: a
        // replan only revises a failed Task (task.replanned: failed ->
        // ready), so replanning a still-running Task would lose the revision.
        const reportResult = reportObject.result;
        const storableReport = reportResult === "success" || reportResult === "failed" || reportResult === "partial";
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          reason,
          question,
          needs_replanning: needsReplanning,
          ...(storableReport ? { report: reportObject } : {}),
          ...usage,
        }, "task.replan_requested", question);
        return;
      }
    }

    if (verdict === "retry") {
      // Hybrid Mode: the Worker (team leader) wants Core to give it one more
      // attempt with the still-failing subtasks, even though its own
      // report.result may already be "success" for the subtasks it did
      // finish. Route through the existing deterministic-failure retry path
      // (retry_allowed: true) so it reuses the same failure_count/
      // same_error_count budget and Manager-trigger threshold instead of a
      // bespoke hybrid retry counter — this bounds it to the architecture's
      // "1 retry per task" without new state-machine surface.
      const retrySubtasks = Array.isArray(reportObject?.retry_subtasks) ? reportObject?.retry_subtasks : [];
      await this.writeFailureEvent(workId, taskId, agentRunId, {
        failure_class: "deterministic",
        error_key: "hybrid_worker_retry_requested",
        retry_allowed: true,
        reason: `Hybrid Worker requested a retry for Task ${taskId}: ${JSON.stringify(retrySubtasks)}`,
        // The next Worker attempt reads these back as context.retry_subtasks.
        retry_subtasks: retrySubtaskInstructions(retrySubtasks),
        ...usage,
      });
      return;
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
        await this.captureArtifacts(workId, taskId, artifactTask?.worktree_path ?? null);
      }
      if (this.stopping) return;
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
      await this.runVerification(workId, taskId, agentRunId, result.report);
      return;
    }

    if (result.failure_class === "transient") {
      const retryNo = Math.max(0, generation - 1);
      if (!result.error_key) {
        throw validationError("A transient AgentRunner failure must include error_key.", { task_id: taskId });
      }
      const storedTask = this.db.get<{ retry_no: number }>("SELECT retry_no FROM tasks WHERE id = ?", taskId);
      const durableRetryNo = Number(storedTask?.retry_no ?? retryNo) + 1;
      if (durableRetryNo <= 3) {
        const delay = TRANSIENT_RETRY_DELAYS_MS[Math.min(durableRetryNo - 1, TRANSIENT_RETRY_DELAYS_MS.length - 1)];
        const nextAttemptAt = new Date(Date.now() + delay).toISOString();
        await this.writeFailureEvent(workId, taskId, agentRunId, {
          failure_class: "transient",
          retry_no: durableRetryNo,
          next_attempt_at: nextAttemptAt,
          error_key: result.error_key,
          retry_allowed: true,
          reason: result.message ?? (ownerLanguage(this.db) === "en" ? "The Provider returned a temporary error." : "Providerが一時的なエラーを返しました。"),
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
        error_key: result.error_key,
        retry_allowed: true,
        reason: "Transient retry budget exhausted after 3 attempts.",
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
    const payload: JsonObject = result.signal
      ? {
        report_present: false,
        error_key: errorKey,
        signal: result.signal,
        reason: result.message ?? (ownerLanguage(this.db) === "en" ? `The Worker exited on signal ${result.signal}.` : `Workerがシグナル ${result.signal} で終了しました。`),
        ...usage,
      }
      : {
        failure_class: "deterministic",
        error_key: errorKey,
        retry_allowed: result.retry_allowed !== false,
        reason: result.message ?? "The Worker reported a deterministic failure.",
        ...(hasReport ? { report: result.report } : {}),
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

  /** Retry pending Reviews whose provider has just entered its probe window. */
  public resumeProvider(provider: string): void {
    const reviewerProvider = this.providerForRoleModel(resolveRoleModel(this.db, "reviewer"));
    if (normalizeProviderId(reviewerProvider) !== normalizeProviderId(provider)) return;
    const pending = this.db.all<{ id: string; work_id: string; review_round: number; worker_agent_run_id: string; payload_json: string }>(
      `SELECT tasks.id, tasks.work_id, tasks.review_round,
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
      let report: unknown;
      try { report = JSON.parse(task.payload_json) as unknown; } catch { continue; }
      if (!report || typeof report !== "object" || Array.isArray(report)) continue;
      void this.runReviewer(task.work_id, task.id, task.worker_agent_run_id, report as JsonObject, task.review_round)
        .catch((error: unknown) => console.error(`[owl-core] Could not retry Reviewer for Task ${task.id}`, error));
    }
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

  private async writeFailureEvent(
    workId: string,
    taskId: string,
    agentRunId: string,
    payload: JsonObject,
    event = "task.failure.classified",
    question?: string | null,
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
      const reason =
        typeof payload.reason === "string"
          ? payload.reason
          : `Task ${taskId} reached its failure threshold (error_key=${String(payload.error_key ?? "unknown")}).`;
      await this.triggerManagerReplanIfNeeded(workId, taskId, reason, question);
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
          reason: `Designer Task worktree changes could not be discarded: ${discarded.message}`,
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
        reason: current !== null && current.size > 0n
          ? `Designer Task did not write the design document at ${documentPath} in this attempt.`
          : `Designer Task did not produce a non-empty design document at ${documentPath}.`,
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
  ): Promise<void> {
    if (this.stopping) return;
    const task = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!task) {
      throw validationError("The Task disappeared before Core verification started.", { task_id: taskId });
    }
    const reviewRequired = isTaskReviewRequired(task);
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
        : await this.executeVerificationPlan(workId, task, report);
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
    // A Task without review is finished here, so it is merged now; a
    // reviewed Task is merged once its review passes (runReviewer).
    const integration = passed && !reviewRequired ? await this.integrateTask(workId, taskId, task.worktree_path) : null;
    const verificationEvent = await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) =>
        reduceTaskInTransaction(transaction, taskId, {
          event: "verification.completed",
          payload: {
            outcome: passed ? "pass" : "fail",
            review_required: reviewRequired,
            agent_run_id: agentRunId,
            verification: verification as JsonObject,
            ...(integration ?? {}),
          },
        }),
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
          verification: verification as JsonObject,
          ...(integration ?? {}),
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (verificationEvent.state.manager_trigger) {
      await this.triggerManagerReplanIfNeeded(
        workId,
        taskId,
        integration && integration.merge_exit_code !== 0
          ? integrationFailureReason(taskId, "passed verification", integration)
          : `Task ${taskId} failed verification after exhausting its review rounds.`,
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
      const contents = await readFile(artifact.storage_path).catch(() => null);
      if (!contents) continue;
      const existing = await lstat(destination).catch(() => null);
      if (existing?.isFile()) {
        const existingContents = await readFile(destination);
        if (createHash("sha256").update(existingContents).digest("hex") === artifact.sha256) continue;
        console.warn(`[owl-core] Task ${taskId}: the dependency artifact ${artifact.path} from Task ${artifact.task_id} overwrote a different copy already in the worktree.`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
  }

  private async captureArtifacts(workId: string, taskId: string, worktreePath: string | null): Promise<void> {
    if (!worktreePath) return;
    const root = resolve(worktreePath);
    const files: Array<{ path: string; sha256: string; bytes: number; mime: string; contents: Buffer; storage_path: string }> = [];
    let capturedBytes = 0;
    const capture = async (absolute: string): Promise<void> => {
      const info = await lstat(absolute).catch(() => null);
      if (!info?.isFile() || info.size > MAX_CAPTURED_ARTIFACT_FILE_BYTES || capturedBytes + info.size > MAX_CAPTURED_ARTIFACT_BYTES) return;
      const contents = await readFile(absolute);
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
          idempotencyKey: `artifacts-captured:${taskId}:${files.map((file) => file.sha256).join(",")}`,
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

  /** Execute the persisted Project verification plan independently of Worker claims. */
  private async executeVerificationPlan(workId: string, task: TaskRow, report: JsonObject): Promise<JsonObject> {
    const workerPassed = reportedVerificationPassed(report);
    const project = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    if (!project?.project_id) {
      return { passed: workerPassed, source: "worker_report_only", commands: [] };
    }
    const projectRow = this.db.get<{ canonical_path: string; allowed_roots_json: string; verification_plan_json: string }>(
      "SELECT canonical_path, allowed_roots_json, verification_plan_json FROM projects WHERE id = ?",
      project.project_id,
    );
    if (!projectRow) return { passed: false, source: "project_missing", commands: [] };
    let allowedRoots: string[];
    let plan: Array<{ command_id: string; argv: string[]; cwd: string; env_allowlist: string[]; timeout_seconds: number; stdout_limit: number; stderr_limit: number; expected_exit_codes: number[] }>;
    try {
      allowedRoots = JSON.parse(projectRow.allowed_roots_json) as string[];
      plan = JSON.parse(projectRow.verification_plan_json) as typeof plan;
    } catch {
      return { passed: false, source: "invalid_project_plan", commands: [] };
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
    const results: JsonObject[] = [];
    for (const command of plan) {
      const cwd = resolve(root, command.cwd);
      if (!withinAllowed(cwd)) {
        results.push({ command_id: command.command_id, passed: false, error: "cwd_outside_allowed_roots" });
        continue;
      }
      const result = await this.runVerificationCommand(command.argv, cwd, command.env_allowlist, command.timeout_seconds * 1000, command.stdout_limit, command.stderr_limit, command.expected_exit_codes);
      results.push({ command_id: command.command_id, ...result });
    }
    return { passed: plan.length === 0 ? workerPassed : results.every((result) => result.passed === true), source: "project_verification_plan", commands: results };
  }

  private async runVerificationCommand(
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
      child.once("close", (code, signal) => { clearTimeout(timer); this.verificationChildren.delete(child); resolveResult({ passed: !timedOut && signal === null && expectedExitCodes.includes(code ?? -1), exit_code: code ?? -1, signal, stdout, stderr, timed_out: timedOut }); });
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
          const reduction = reduceTaskInTransaction(transaction, taskId, {
            event: "agent.crashed",
            payload: { role: "reviewer", report_present: false, error_key: `reviewer_failed:${message.slice(0, 200)}` },
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
      await this.triggerManagerReplanIfNeeded(workId, taskId, `Reviewer failed unexpectedly for Task ${taskId}: ${message}`);
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
      await this.triggerManagerReplanIfNeeded(workId, taskId, `Task ${taskId} has no design document to review after exhausting its review rounds.`);
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
    // Hybrid Worker reports add control fields that Core consumes to route
    // retries and replanning. The Reviewer accepts only the base
    // ReportEnvelope, so keep those Hybrid-only fields out of its input.
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
             (id, work_id, task_id, role, provider, model, status, started_at, created_at, updated_at)
             VALUES (?, ?, ?, 'reviewer', ?, ?, 'running', ?, ?, ?)`,
          reviewerAgentRunId,
          workId,
          taskId,
          reviewerProvider,
          reviewerRoleModel?.model ?? DEFAULT_HARNESS_MODELS.claude,
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
          payload: { task_id: taskId, agent_run_id: reviewerAgentRunId, provider: reviewerProvider },
        },
        outbox: [{ provider: "websocket" }],
      });
      return;
    }
    const processSkillsPack = this.getProcessSkillsPack?.() ?? null;
    const result = await this.agentRunner.runReviewer({
      invocation_id: reviewerAgentRunId,
      language: ownerLanguage(this.db),
      work_id: workId,
      task_id: taskId,
      attempt: task.worker_generation,
      review_round: reviewRound,
      context: {
        task: reviewerTaskView(task, taskDependencyIds(this.db, taskId)),
        report: reviewerReport,
        worktree: task.worktree_path ?? undefined,
        rules: this.composeRulesForRole("reviewer", workId),
        skills: this.composeSkillsForWork(workId),
        knowledge: await this.composeKnowledgeForTask(workId, taskId),
        ...(processSkillsPack ? { process_skills_dir: processSkillsPack.skills_dir, process_skills_source: processSkillsPack.source } : {}),
        changed_files: await this.git.changedPaths?.({ work_id: workId, task_id: taskId, worktree_path: task.worktree_path ?? undefined }) ?? null,
        ...(designDocument ? { design_document: designDocument } : {}),
      },
      ...(reviewerRoleModel ? {
        model: reviewerRoleModel.model,
        provider: reviewerProvider,
        effort: reviewerRoleModel.effort,
      } : { provider: reviewerProvider }),
    });
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
    if (rawVerdict !== "pass" && rawVerdict !== "fix_required" && rawVerdict !== "replan_required") {
      throw validationError("The Reviewer verdict is not recognized.", { task_id: taskId, agent_run_id: reviewerAgentRunId });
    }
    // A Reviewer replan_required verdict is escalated to the Manager
    // instead of being downgraded to fix_required: see the manager_trigger
    // check on reviewWriteResult below, and TASK_TRANSITION_TABLE row 28.
    const findings = reviewObject.findings;
    const tests = reviewObject.tests;
    if (!Array.isArray(findings) || !tests || typeof tests !== "object" || Array.isArray(tests)) {
      throw validationError("The Reviewer result is missing findings or tests.", { task_id: taskId });
    }
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
      review: reviewObject,
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
          JSON.stringify({ report, review: reviewObject }),
          utcNow(),
        );
        const agentUpdate = transaction.run(
          `UPDATE agent_runs
              SET status = ?, ended_at = ?, updated_at = ?, usage_json = COALESCE(?, usage_json)
            WHERE id = ? AND status = 'running'`,
          verdict === "pass" ? "completed" : "failed",
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
      const reason =
        rawVerdict === "replan_required"
          ? `Reviewer requested replanning for Task ${taskId}: ${
              typeof reviewObject.summary === "string" ? reviewObject.summary : "no summary provided"
            }`
          : integration
            ? integrationFailureReason(taskId, "passed review", integration)
            : `Task ${taskId} failed review after exhausting its review rounds.`;
      await this.triggerManagerReplanIfNeeded(workId, taskId, reason);
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

/** Whether an agent report's own `verification.passed` is true. */
function reportedVerificationPassed(report: JsonObject): boolean {
  const verification = report.verification;
  return verification !== null && typeof verification === "object" && !Array.isArray(verification)
    && (verification as JsonObject).passed === true;
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

function integrationFailureReason(taskId: string, how: string, integration: TaskIntegration): string {
  if (integration.failure_kind === "commit_failure") {
    const message = integration.failure_message ?? "git commit failed";
    return `Task ${taskId} ${how} but ${message}; the Task worktree is kept. Plan a fix, e.g. avoid files the repository's hooks reject.`;
  }
  return mergeConflictReason(taskId, how, integration);
}

function mergeConflictReason(taskId: string, how: string, integration: TaskIntegration): string {
  const files = integration.merge_conflict_files ?? [];
  return `Task ${taskId} ${how} but could not be merged into the Work branch ${integration.work_branch} (Git merge conflict${
    files.length > 0 ? ` in ${files.join(", ")}` : ""
  }). Plan a replacement that builds on the Work branch as it is now.`;
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

/** Normalize Hybrid retry_subtasks ({subtask_id, instruction} or strings) to instruction strings. */
function retrySubtaskInstructions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const instructions: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      instructions.push(item);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as JsonObject;
      if (typeof record.instruction === "string" && record.instruction.trim().length > 0) {
        instructions.push(
          typeof record.subtask_id === "string" && record.subtask_id.length > 0
            ? `${record.subtask_id}: ${record.instruction}`
            : record.instruction,
        );
      }
    }
  }
  return instructions;
}
