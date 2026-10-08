import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_IDLE_TIMEOUT_ENV,
  AgentTimeoutSettingError,
  agentUserInstructionEnv,
  agentIdleTimeoutMs,
  buildAgentPermissionArgs,
  cliTokenUsage,
  reapProcessGroup,
  CodexProgressTracker,
  ClaudeStreamReader,
  DEFAULT_AGENT_WALL_TIMEOUT_MS,
  DEFAULT_HARNESS_MODELS,
  GUARD_TOKEN_FILE_ENV,
  MINIMAL_CODE_RULES,
  parseHandoffMemo,
  PROCESS_SKILLS_PROMPT_FILES,
  RELAY_STATE_FILE_ENV,
  RequestUsageTracker,
  renderProcessSkills,
  renderWorkspaceToolsNote,
  WORKING_STYLE_RULES,
  type AgentTimeoutKind,
  type ChildRunFailureKind,
  type ExecutorConfig,
  type ExecutorRelayConfig,
  type ExecutorResult,
  type ExecutorTask,
  type GuardTokenIssuer,
  type GuardTokenLease,
  type HandoffMemo,
  type RequestTokenUsage,
  type TokenUsage,
} from "@owl/shared";
import { formatRuntimeFailure } from "./error-display.js";

export type { ExecutorConfig, ExecutorResult, ExecutorTask, ExecutorTaskContext } from "@owl/shared";

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  provider: "claude",
  model: DEFAULT_HARNESS_MODELS.claude,
  effort: "high",
  // Wall-clock limit per Executor process; an explicit 0 in the Executor
  // settings removes the limit.
  timeout_ms: DEFAULT_AGENT_WALL_TIMEOUT_MS,
};

const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
const EXECUTOR_RESULT_CAP_BYTES = 32 * 1024;
const EXECUTOR_RESULT_TRUNCATION_MARKER = "\n[Executor result truncated to 32 KiB]\n";
const KILL_GRACE_MS = 30_000;
const activeExecutorChildren = new Set<ChildProcess>();

/** Kill every dispatched child Executor process group owned by this Core instance. */
export function terminateActiveExecutorsImmediately(): void {
  for (const child of activeExecutorChildren) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
    signalProcessGroup(child, "SIGKILL");
  }
}

/**
 * Process settings for Executor CLIs. The server supplies the agent
 * environment (without Owl's own credentials) and the resolved CLI paths;
 * an executable left out is looked up on the environment's PATH.
 */
export interface ExecutorRuntime {
  /** Owl installation root whose permission hook guards the Executor. */
  readonly owlRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executables: { readonly claude?: string; readonly codex?: string };
  /** Issues the guard token of each Executor process; without it no token is passed. */
  readonly guardToken?: GuardTokenIssuer;
  /** Classifies a failed process's output as a provider rate limit; null when it is not one. */
  readonly detectRateLimit?: (provider: string, stdout: string, stderr: string) => { resets_at: string | null } | null;
}

/**
 * Runtime for callers that do not supply one: PATH, HOME and the no-output
 * limit setting only, the CLIs looked up on PATH, and the installation root
 * from OWL_ROOT or the cwd.
 */
export function defaultExecutorRuntime(): ExecutorRuntime {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", AGENT_IDLE_TIMEOUT_ENV] as const) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  return { owlRoot: process.env.OWL_ROOT ?? process.cwd(), env, executables: {} };
}

function environment(
  task: ExecutorTask,
  runtime: ExecutorRuntime,
  guardLease: GuardTokenLease | undefined,
  runId: string | undefined,
  provider: ExecutorConfig["provider"],
  relayStateFile?: string,
): Record<string, string> {
  const instructionEnv = provider === "claude" || provider === "codex"
    ? agentUserInstructionEnv(provider, runtime.env)
    : {};
  const env: Record<string, string> = {
    ...runtime.env,
    ...instructionEnv,
    OWL_AGENT_ROLE: "worker",
    OWL_AGENT_RUN_ID: runId ?? task.subtask_id,
    OWL_AGENT_SUBTASK_ID: task.subtask_id,
    OWL_AGENT_CWD: task.workspace_dir,
    // An Executor always runs inside a Task, so it carries the Work/Task ids; the Project only when the Work has one.
    ...(task.work_id ? { OWL_WORK_ID: task.work_id } : {}),
    ...(task.task_id ? { OWL_TASK_ID: task.task_id } : {}),
    ...(task.project_id ? { OWL_PROJECT_ID: task.project_id } : {}),
    ...(guardLease ? { [GUARD_TOKEN_FILE_ENV]: guardLease.file } : {}),
  };
  // Children never get the dispatch tools, so they cannot start grandchildren.
  delete env.OWL_DISPATCH_MCP;
  // Only this segment's own state file may reach the relay hook, never one inherited from the server.
  delete env[RELAY_STATE_FILE_ENV];
  if (relayStateFile) env[RELAY_STATE_FILE_ENV] = relayStateFile;
  return env;
}

/** `env` is the Executor's own process environment, so the owl-memory MCP config gets its run id, ids and guard token file. */
export function argv(config: ExecutorConfig, runtime: ExecutorRuntime, cwd?: string, env: Readonly<Record<string, string | undefined>> | undefined = runtime.env): string[] {
  const guard = { owlRoot: runtime.owlRoot, role: "worker" as const, env, cwd, tokenRelay: config.relay !== undefined };
  if (config.provider === "codex") {
    return [runtime.executables.codex ?? "codex", "exec", "--json", ...buildAgentPermissionArgs("worker", "codex", guard), "--skip-git-repo-check", "--model", config.model,
      ...(config.effort ? ["--config", `model_reasoning_effort=${config.effort}`] : []), "--", "-"];
  }
  if (config.provider !== "claude") {
    throw new Error(`Unsupported Executor provider: ${config.provider}`);
  }
  return [runtime.executables.claude ?? "claude", "-p", "--output-format", "stream-json", "--verbose", ...buildAgentPermissionArgs("worker", "claude", guard), "--model", config.model, ...(config.effort ? ["--effort", config.effort] : [])];
}

function codexFinalMessage(stdout: string): string | null {
  let finalMessage: string | null = null;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      // Ignore non-event noise and keep looking for the final report. Never
      // return raw stdout as a fallback because it may contain tool logs.
      continue;
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "item.completed" || typeof record.item !== "object" || record.item === null || Array.isArray(record.item)) continue;
    const item = record.item as Record<string, unknown>;
    if (item.type !== "agent_message") continue;
    if (typeof item.text === "string") {
      finalMessage = item.text;
      continue;
    }
    if (Array.isArray(item.content)) {
      const text = item.content
        .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null && !Array.isArray(part))
        .map((part) => typeof part.text === "string" ? part.text : "")
        .filter((part) => part.length > 0)
        .join("\n");
      if (text.length > 0) finalMessage = text;
    }
  }
  return finalMessage;
}

function claudeFinalMessage(stdout: string): { text: string; is_error: boolean } | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.type !== "result" || typeof record.result !== "string") return null;
    const is_error = record.is_error === true || (typeof record.subtype === "string" && record.subtype !== "success");
    return { text: record.result, is_error };
  } catch {
    return null;
  }
}

/**
 * The Executor's final assistant report, or null when the process produced
 * none. `is_error` is always false for Codex, which has no such signal; for
 * Claude it reflects the CLI's own `is_error`/`subtype` fields.
 */
function executorFinalReport(provider: string, stdout: string): { text: string; is_error: boolean } | null {
  if (provider === "codex") {
    const text = codexFinalMessage(stdout);
    return text?.trim() ? { text: text.trim(), is_error: false } : null;
  }
  if (provider === "claude") {
    const parsed = claudeFinalMessage(stdout);
    if (!parsed || parsed.text.trim().length === 0) return null;
    return { text: parsed.text.trim(), is_error: parsed.is_error };
  }
  return null;
}

/**
 * Token usage of a finished Executor process, or null. Uses the same parser
 * as agent-runtime's extractProviderUsage; never throws.
 */
export function extractExecutorUsage(provider: string, stdout: string): TokenUsage | null {
  return provider === "codex" || provider === "claude" ? cliTokenUsage(provider, stdout) : null;
}

function compactExecutorOutput(report: string): string {
  const combined = report.trim();
  const bytes = Buffer.from(combined, "utf8");
  if (bytes.byteLength <= EXECUTOR_RESULT_CAP_BYTES) return combined;

  const available = EXECUTOR_RESULT_CAP_BYTES - Buffer.byteLength(EXECUTOR_RESULT_TRUNCATION_MARKER, "utf8");
  const headBytes = Math.floor(available / 2);
  const tailBytes = available - headBytes;
  return `${bytes.subarray(0, headBytes).toString("utf8")}${EXECUTOR_RESULT_TRUNCATION_MARKER}${bytes.subarray(bytes.byteLength - tailBytes).toString("utf8")}`;
}

/** Where a relayed child left off; given to the next segment's prompt. */
export interface RelayResume { readonly reason: "handoff" | "kill"; readonly segment: number; readonly memo: HandoffMemo | null }

/** What the relay hook tells a child whose prompt crossed the handoff limit. */
export function relayHandoffMessage(promptTokens: number, relay: ExecutorRelayConfig): string {
  return `Owl: this session's context has reached ${promptTokens} tokens, over the handoff limit of ${relay.handoff_tokens}. Stop starting new work. Finish at most the step in progress, then end your reply with the owl-child-handoff block from your instructions. Owl stops this session at ${relay.kill_tokens} tokens.`;
}

const HANDOFF_FORMAT = '{"summary":"<= 1200 chars, the goal of this part and where it stands","done":["finished step"],"remaining":["step still to do"],"next_steps":["the very next action"],"changed_files":["relative/path"],"notes":"<= 1500 chars, decisions, pitfalls, and commands the next child needs"}';

/** The prompt every child gets: the Worker's instruction plus the Task, Owl rules, Owner guidance and working rules. */
export function buildChildRunPrompt(
  task: ExecutorTask,
  processSkills: readonly string[] | null = null,
  retry: { readonly failure_kind: string; readonly failure_reason: string } | null = null,
  relay: { readonly budget: ExecutorRelayConfig; readonly previous: RelayResume | null } | null = null,
): string {
  const { title, acceptance_criteria, context, manager_notes, necessity, rules, owner_guidance: guidance, knowledge } = task.task;
  const writePaths = task.write_paths?.length ? task.write_paths : ["*"];
  const workspaceTools = renderWorkspaceToolsNote(task.worktree);
  return [
    "You are a child agent dispatched by the Worker of an Owl Task. Complete this part:",
    task.instruction,
    "Other child agents may run at the same time in this workspace with disjoint write_paths. Edit only files inside your write_paths; you may read anything. Do not depend on changes another child is making concurrently. Inspect relevant existing code before editing and preserve correct work already present. Do not commit, push, create branches, rebase, or reset; the Worker integrates and Owl commits. You cannot dispatch further agents.",
    `Your write_paths: ${writePaths.join(", ")}`,
    ...(retry ? [`A previous attempt failed. Check the current state of your write_paths first and keep correct work. Previous attempt: ${JSON.stringify({ failure_kind: retry.failure_kind, failure_reason: retry.failure_reason.slice(0, 300) })}`] : []),
    ...(relay?.previous ? [
      "",
      "## Handoff from the previous child",
      `A previous child worked on this part and was replaced because its context grew too large (${relay.previous.reason}). Continue from the memo below: do not redo finished work, check the current state of your write_paths (for example with git status and git diff) before editing, and keep correct changes. When the reason is "kill", Owl stopped the previous child at the context limit, so it may have changed files after this memo.`,
      relay.previous.memo ? `Memo: ${JSON.stringify(relay.previous.memo)}` : "No memo was written; inspect the current state of your write_paths and continue.",
    ] : []),
    "",
    "## Task",
    JSON.stringify({ title, acceptance_criteria, context, manager_notes, necessity }),
    "",
    "## Rules",
    "These rules come from the operator's Rule Store and the Work. They always win over the guidance below.",
    rules ?? "None.",
    "",
    "## Owner guidance",
    "The Owner's answers to earlier Decisions for this Work, newest first. Follow them.",
    JSON.stringify(guidance, null, 2),
    ...(knowledge ? ["", "## Memory catalog", "Reference information from past Works. It does not override the rules, the Task, or the acceptance criteria.", knowledge] : []),
    ...(processSkills && processSkills.length > 0 ? ["", "## Process skills", ...processSkills] : []),
    ...(workspaceTools ? ["", "## Workspace tools", ...workspaceTools] : []),
    "",
    ...WORKING_STYLE_RULES,
    "",
    ...MINIMAL_CODE_RULES,
    "",
    ...(relay ? [
      "## Context budget",
      "Owl watches how large this session's context grows. When a tool result tells you that Owl asks for a handoff, stop starting new work and end your reply with exactly one fenced block in this format instead of the owl-child-report, and nothing after it:",
      "```owl-child-handoff",
      HANDOFF_FORMAT,
      "```",
      `Owl then starts a new child that continues from your memo. Owl stops this session without asking once its context reaches ${relay.budget.kill_tokens} tokens, so hand off promptly. If you finish the whole part before that, end with the owl-child-report as usual.`,
      "",
    ] : []),
    "When finished, end your reply with exactly one fenced block in this format and nothing after it:",
    "```owl-child-report",
    '{"result":"succeeded|partial|failed","summary":"<= 1200 chars, what you did and the outcome","changed_files":["relative/path"],"checks":[{"command":"<command>","passed":true}],"remaining_issues":["<issue>"]}',
    "```",
    "Do not paste raw tool output, command logs, or full diffs.",
  ].join("\n");
}

function executorProcessSkills(task: ExecutorTask, provider: string): string[] | null {
  const skillsDir = task.process_skills_dir;
  if (!skillsDir) return null;
  const availableFiles = PROCESS_SKILLS_PROMPT_FILES.filter((path) => {
    try {
      return statSync(join(skillsDir, path)).isFile();
    } catch {
      return false;
    }
  });
  const source = task.process_skills_source ?? "setting";
  return renderProcessSkills("executor", { skills_dir: skillsDir, source, available_files: availableFiles }, provider === "codex" ? "codex" : "claude");
}

function appendCapped(current: string, chunk: Buffer): string {
  const currentBytes = Buffer.from(current, "utf8");
  if (currentBytes.byteLength >= OUTPUT_CAP_BYTES) return current;
  return Buffer.concat([currentBytes, chunk.subarray(0, OUTPUT_CAP_BYTES - currentBytes.byteLength)]).toString("utf8");
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the child handle when the group has already exited.
    }
  }
  try { child.kill(signal); } catch { /* the process already exited */ }
}

function safeExecutorFailure(reason: string, config: ExecutorConfig, details = ""): string {
  return formatRuntimeFailure(
    new Error(reason, { cause: details }),
    `${config.provider} Executor`,
  );
}

/**
 * Optional lifecycle callbacks for one Executor process, so Core can record
 * the process as an AgentRun and show it while it runs. Callbacks must not
 * throw; the Executor result never depends on them.
 */
export interface ExecutorRunObserver {
  /** The AgentRun id tracking this attempt, if the caller records one. */
  agent_run_id?: string;
  /** Aborting stops the process (SIGTERM, then SIGKILL after the grace period); the result is `cancelled`. */
  signal?: AbortSignal;
  /** Failure of the previous attempt, shown to a retried child. */
  retry?: { readonly failure_kind: string; readonly failure_reason: string };
  /** Where the previous relay segment left off, shown to the next one. */
  relayResume?: RelayResume;
  /** One Claude request with its final usage. Must not throw. */
  onRequestUsage?(usage: RequestTokenUsage): void;
  onSpawn?(pid: number): void;
  onOutput?(): void;
  /**
   * Resolves true when the run was cancelled, which suppresses its retry.
   * `usage` stays out of the child summary returned to the parent Worker.
   */
  finish?(result: ExecutorResult, usage: TokenUsage | null): Promise<boolean>;
}

export async function runExecutor(
  task: ExecutorTask,
  config: ExecutorConfig = DEFAULT_EXECUTOR_CONFIG,
  observer: ExecutorRunObserver = {},
  runtime: ExecutorRuntime = defaultExecutorRuntime(),
): Promise<ExecutorResult> {
  return runExecutorProcess(task, config, observer, { usage: null }, runtime);
}

/**
 * One Executor run. The token usage its successful process reported is left
 * in `sink` (null when none); a missing or malformed usage never fails a run.
 */
export async function runExecutorProcess(
  task: ExecutorTask,
  config: ExecutorConfig,
  observer: ExecutorRunObserver,
  sink: { usage: TokenUsage | null },
  runtime: ExecutorRuntime,
): Promise<ExecutorResult> {
  const started = Date.now();
  if (task.subtask_id.length === 0 || task.instruction.length === 0 || task.workspace_dir.length === 0) {
    return {
      subtask_id: task.subtask_id,
      success: false,
      output: "Executor task fields must be non-empty.",
      exit_code: -1,
      duration_ms: 0,
      failure_kind: "spawn_error",
    };
  }
  if (config.model.trim().length === 0 || !Number.isSafeInteger(config.timeout_ms) || config.timeout_ms < 0) {
    return {
      subtask_id: task.subtask_id,
      success: false,
      output: "Executor configuration is invalid.",
      exit_code: -1,
      duration_ms: 0,
      failure_kind: "spawn_error",
    };
  }
  try {
    await mkdir(task.workspace_dir, { recursive: true });
  } catch (error) {
    return {
      subtask_id: task.subtask_id,
      success: false,
      output: safeExecutorFailure("Executor workspace could not be prepared", config, error instanceof Error ? error.message : String(error)),
      exit_code: -1,
      duration_ms: Date.now() - started,
      failure_kind: "spawn_error",
    };
  }
  // Both one-shot CLIs stream progress events; long silence means the run is stuck.
  let idleTimeoutMs = 0;
  if (config.provider === "codex" || config.provider === "claude") {
    try {
      idleTimeoutMs = agentIdleTimeoutMs(runtime.env);
    } catch (error) {
      if (!(error instanceof AgentTimeoutSettingError)) throw error;
      return {
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor configuration is invalid", config, error.message),
        exit_code: -1,
        duration_ms: 0,
        failure_kind: "spawn_error",
      };
    }
  }
  return new Promise<ExecutorResult>((resolve) => {
    let guardLease: GuardTokenLease | undefined;
    try {
      guardLease = runtime.guardToken?.({ agent_run_id: observer.agent_run_id ?? task.subtask_id, role: "worker" });
    } catch (error) {
      resolve({
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor guard token could not be prepared", config, error instanceof Error ? error.message : String(error)),
        exit_code: -1,
        duration_ms: Date.now() - started,
        failure_kind: "spawn_error",
      });
      return;
    }
    // Owl counts the prompt size from Claude's stream; the hook only relays what this state file says.
    const relay = config.provider === "claude" ? config.relay : undefined;
    let relayDir: string | undefined;
    let relayStateFile: string | undefined;
    if (relay) {
      try {
        relayDir = mkdtempSync(join(tmpdir(), "owl-relay-"));
        relayStateFile = join(relayDir, "state.json");
        writeFileSync(relayStateFile, JSON.stringify({ phase: "running" }));
      } catch (error) {
        console.warn(`[owl] Relay state file could not be prepared; only the stop limit applies: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const removeRelayDir = (): void => { if (relayDir) rmSync(relayDir, { recursive: true, force: true }); };
    const processEnv = environment(task, runtime, guardLease, observer.agent_run_id, config.provider, relayStateFile);
    let command: string[];
    try {
      command = argv(config, runtime, task.workspace_dir, processEnv);
    } catch (error) {
      guardLease?.release();
      removeRelayDir();
      resolve({
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor configuration is invalid", config, error instanceof Error ? error.message : String(error)),
        exit_code: -1,
        duration_ms: Date.now() - started,
        failure_kind: "spawn_error",
      });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd: task.workspace_dir,
        env: processEnv,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      guardLease?.release();
      removeRelayDir();
      resolve({
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor process could not be started", config, error instanceof Error ? error.message : String(error)),
        exit_code: -1,
        duration_ms: Date.now() - started,
        failure_kind: "spawn_error",
      });
      return;
    }
    activeExecutorChildren.add(child);
    if (child.pid !== undefined && child.pid > 0) observer.onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut: AgentTimeoutKind | null = null;
    let outputTooLarge = false;
    let cancelled = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ExecutorResult): void => {
      if (settled) return;
      settled = true;
      activeExecutorChildren.delete(child);
      void reapProcessGroup(child.pid);
      guardLease?.release();
      if (timer !== undefined) clearTimeout(timer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      observer.signal?.removeEventListener("abort", cancel);
      removeRelayDir();
      resolve(result);
    };
    const cancel = (): void => {
      if (settled || cancelled) return;
      cancelled = true;
      signalProcessGroup(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) signalProcessGroup(child, "SIGKILL");
      }, KILL_GRACE_MS).unref();
    };
    const timeOut = (kind: AgentTimeoutKind): void => {
      if (settled || timedOut !== null) return;
      timedOut = kind;
      signalProcessGroup(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) signalProcessGroup(child, "SIGKILL");
      }, KILL_GRACE_MS).unref();
    };
    const armIdleTimer = (): void => {
      if (idleTimeoutMs <= 0 || settled || timedOut !== null) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => timeOut("idle"), idleTimeoutMs);
      idleTimer.unref();
    };
    const notifyProgress = (): void => { armIdleTimer(); observer.onOutput?.(); };
    const progress = new CodexProgressTracker(armIdleTimer);
    let peakPromptTokens = 0;
    let relayKilled = false;
    let handoffRequested = false;
    let lastMemo: HandoffMemo | null = null;
    const totals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    const relayStop = (): void => {
      if (settled || relayKilled) return;
      relayKilled = true;
      signalProcessGroup(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) signalProcessGroup(child, "SIGKILL");
      }, KILL_GRACE_MS).unref();
    };
    const requestHandoff = (promptTokens: number): void => {
      handoffRequested = true;
      if (!relay || !relayStateFile) return;
      // Write then rename so the hook never reads half a JSON document.
      try {
        writeFileSync(`${relayStateFile}.tmp`, JSON.stringify({ phase: "handoff", message: relayHandoffMessage(promptTokens, relay) }));
        renameSync(`${relayStateFile}.tmp`, relayStateFile);
      } catch (error) {
        console.warn(`[owl] Relay state file could not be written; only the stop limit applies: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // Every Claude child's requests are recorded; only relay-watched ones are judged, by the child's own (non-subagent) requests.
    const tracker = new RequestUsageTracker({
      onRequest: (usage) => {
        if (!relay || usage.subagent) return;
        peakPromptTokens = Math.max(peakPromptTokens, usage.prompt_tokens);
        if (usage.prompt_tokens >= relay.kill_tokens) relayStop();
        else if (usage.prompt_tokens >= relay.handoff_tokens && !handoffRequested) requestHandoff(usage.prompt_tokens);
      },
      onFlush: (usage) => {
        totals.input_tokens += usage.input_tokens;
        totals.output_tokens += usage.output_tokens;
        totals.cache_read_tokens += usage.cache_read_tokens;
        totals.cache_write_tokens += usage.cache_write_tokens;
        observer.onRequestUsage?.(usage);
      },
    }, config.model);
    const onAssistant = (event: Record<string, unknown>): void => {
      tracker.accept(event);
      if (!relay || event.parent_tool_use_id) return;
      const content = (event.message as { content?: unknown } | undefined)?.content;
      const text = Array.isArray(content)
        ? content.map((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("\n")
        : "";
      // Keep the latest memo seen mid-stream, so a child stopped right after writing one still hands it on.
      if (text.includes("```owl-child-handoff")) lastMemo = parseHandoffMemo(text) ?? lastMemo;
    };
    const claudeStream = config.provider === "claude" ? new ClaudeStreamReader(notifyProgress, { onAssistant }) : null;
    const capture = (which: "stdout" | "stderr", chunk: Buffer): void => {
      if (which === "stdout" && claudeStream) { claudeStream.push(chunk); return; }
      const current = which === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(current, "utf8") + chunk.byteLength > OUTPUT_CAP_BYTES && !outputTooLarge) {
        outputTooLarge = true;
        signalProcessGroup(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) signalProcessGroup(child, "SIGKILL");
        }, KILL_GRACE_MS);
        killTimer.unref();
      }
      const next = appendCapped(current, chunk);
      if (which === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      capture("stdout", chunk);
      if (claudeStream) return;
      if (idleTimeoutMs > 0) progress.push(chunk.toString("utf8"));
      observer.onOutput?.();
    });
    child.stderr!.on("data", (chunk: Buffer) => { capture("stderr", chunk); observer.onOutput?.(); });
    if (config.timeout_ms > 0) {
      timer = setTimeout(() => timeOut("wall"), config.timeout_ms);
      timer.unref();
    }
    armIdleTimer();
    if (observer.signal?.aborted) cancel();
    else observer.signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", (error) => finish({
      subtask_id: task.subtask_id,
      success: false,
      output: safeExecutorFailure("Executor process error", config, `${stderr}\n${error.message}`),
      exit_code: -1,
      duration_ms: Date.now() - started,
      failure_kind: "spawn_error",
    }));
    child.once("close", (code) => {
      if (claudeStream) { stdout = claudeStream.output(); outputTooLarge ||= claudeStream.retainedBytes() + Buffer.byteLength(stderr) > OUTPUT_CAP_BYTES; }
      tracker.flush();
      if (relay && relayKilled && !cancelled) {
        // A killed process emits no result line, so its usage comes from the tracked requests.
        sink.usage = totals;
        finish({
          subtask_id: task.subtask_id,
          success: false,
          output: `Executor was stopped at ${peakPromptTokens} prompt tokens (token relay stop limit ${relay.kill_tokens}).`,
          exit_code: code ?? -1,
          duration_ms: Date.now() - started,
          failure_kind: "exit_code",
          relay: { reason: "kill", memo: lastMemo, peak_prompt_tokens: peakPromptTokens },
        });
        return;
      }
      const processSucceeded = code === 0 && timedOut === null && !outputTooLarge;
      const report = processSucceeded ? executorFinalReport(config.provider, stdout) : null;
      const success = processSucceeded && report !== null && !report.is_error;
      if (processSucceeded) sink.usage = extractExecutorUsage(config.provider, stdout);
      // A child-report means the part is done even after a handoff request; otherwise a handoff block, or silence after the request, is a handoff.
      if (relay && processSucceeded && !report?.is_error && !report?.text.includes("```owl-child-report")
        && (handoffRequested || report?.text.includes("```owl-child-handoff"))) {
        finish({
          subtask_id: task.subtask_id,
          success: true,
          output: report ? compactExecutorOutput(report.text) : "Executor handed off without a final reply.",
          exit_code: code ?? 0,
          duration_ms: Date.now() - started,
          relay: { reason: "handoff", memo: (report ? parseHandoffMemo(report.text) : null) ?? lastMemo, peak_prompt_tokens: peakPromptTokens },
        });
        return;
      }
      const output = success
        ? compactExecutorOutput(report.text)
        : processSucceeded && report !== null && report.is_error
          ? safeExecutorFailure("Executor reported an error", config, report.text)
          : processSucceeded
            ? "Executor exited successfully but did not emit a parseable final assistant report."
            : safeExecutorFailure(
                timedOut === "idle"
                  ? `Executor stopped after ${Math.round(idleTimeoutMs / 60_000)} minutes without progress`
                  : timedOut === "wall" ? "Executor timed out" : outputTooLarge ? "Executor output exceeded the 4 MiB safety limit" : `Executor exited with code ${String(code ?? "unknown")}`,
                config,
                `${stderr}${timedOut === "idle" ? "\nprovider_idle_timeout" : timedOut === "wall" ? "\nprovider_timeout" : ""}${outputTooLarge ? "\nprovider_output_too_large" : ""}\n${stdout}`,
              );
      const failure_kind: ChildRunFailureKind | undefined = success ? undefined
        : cancelled ? "cancelled"
        : timedOut === "idle" ? "idle_timeout"
        : timedOut === "wall" ? "timeout"
        : outputTooLarge ? "output_limit"
        : !processSucceeded ? "exit_code"
        : report === null ? "no_final_report" : "reported_error";
      const rate_limit = failure_kind === undefined || failure_kind === "cancelled"
        ? null
        : runtime.detectRateLimit?.(config.provider, stdout, stderr) ?? null;
      finish({
        subtask_id: task.subtask_id,
        success,
        output,
        exit_code: timedOut !== null || outputTooLarge ? -1 : (code ?? -1),
        duration_ms: Date.now() - started,
        ...(failure_kind ? { failure_kind } : {}),
        ...(rate_limit ? { rate_limit } : {}),
      });
    });
    try {
      // Keep instructions out of argv: prompts may exceed the OS command-line
      // size limit. Codex's `-` marker reads the prompt from stdin.
      // A process cancelled while the prompt is still being written can close
      // stdin first; the close handler remains responsible for classifying it.
      child.stdin!.on("error", () => {});
      child.stdin!.end(buildChildRunPrompt(task, executorProcessSkills(task, config.provider), observer.retry ?? null, relay ? { budget: relay, previous: observer.relayResume ?? null } : null));
    } catch (error) {
      signalProcessGroup(child, "SIGTERM");
      finish({
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor stdin could not be closed", config, error instanceof Error ? error.message : String(error)),
        exit_code: -1,
        duration_ms: Date.now() - started,
        failure_kind: "spawn_error",
      });
    }
  });
}

export function normalizeWritePaths(task: { readonly write_paths?: readonly string[] }): readonly string[] {
  const paths = task.write_paths?.length ? task.write_paths : ["*"];
  const normalized = paths.map((path) => {
    const raw = path.trim().replaceAll("\\", "/");
    if (!raw || raw.startsWith("/")) return "*";
    const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
    if (raw === "*" || parts.includes("..") || parts.some((part) => /[*?\[\]{}]/u.test(part))) return "*";
    return parts.join("/").toLocaleLowerCase("en-US") || "*";
  });
  return [...new Set(normalized)];
}

export function writeScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) =>
    a === "*" || b === "*" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
  ));
}
