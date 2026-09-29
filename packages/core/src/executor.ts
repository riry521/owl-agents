import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_IDLE_TIMEOUT_ENV,
  AgentTimeoutSettingError,
  agentUserInstructionEnv,
  agentIdleTimeoutMs,
  buildAgentPermissionArgs,
  cliTokenUsage,
  CodexProgressTracker,
  ClaudeStreamReader,
  DEFAULT_AGENT_WALL_TIMEOUT_MS,
  DEFAULT_HARNESS_MODELS,
  GUARD_TOKEN_FILE_ENV,
  MINIMAL_CODE_RULES,
  PROCESS_SKILLS_PROMPT_FILES,
  renderProcessSkills,
  renderWorkspaceToolsNote,
  WORKING_STYLE_RULES,
  type AgentTimeoutKind,
  type ExecutorConfig,
  type ExecutorResult,
  type ExecutorTask,
  type GuardTokenIssuer,
  type GuardTokenLease,
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

/** Kill every Hybrid Executor process group owned by this Core instance. */
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
): Record<string, string> {
  const instructionEnv = provider === "claude" || provider === "codex"
    ? agentUserInstructionEnv(provider, runtime.env)
    : {};
  return {
    ...runtime.env,
    ...instructionEnv,
    OWL_AGENT_ROLE: "worker",
    OWL_AGENT_RUN_ID: runId ?? task.subtask_id,
    OWL_AGENT_SUBTASK_ID: task.subtask_id,
    OWL_AGENT_CWD: task.workspace_dir,
    ...(guardLease ? { [GUARD_TOKEN_FILE_ENV]: guardLease.file } : {}),
  };
}

function argv(config: ExecutorConfig, runtime: ExecutorRuntime): string[] {
  const guard = { owlRoot: runtime.owlRoot, role: "worker" as const, env: runtime.env };
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

export function buildExecutorPrompt(task: ExecutorTask, processSkills: readonly string[] | null = null): string {
  const { title, acceptance, context, rules, owner_guidance: guidance } = task.task;
  const writePaths = task.write_paths?.length ? task.write_paths : ["*"];
  const workspaceTools = renderWorkspaceToolsNote(task.worktree);
  return [
    "Complete this subtask:",
    task.instruction,
    "Hybrid subtasks with disjoint declared write scopes may run at the same time in this shared Task workspace. Work only within your declared write_paths; avoid touching another Executor's files. Do not depend on changes another subtask is making concurrently. Inspect relevant existing code before editing and preserve correct work already present.",
    `Your write_paths: ${writePaths.join(", ")}`,
    "",
    "## Task",
    `Title: ${title}`,
    "Acceptance criteria:",
    acceptance.trim().length > 0 ? acceptance : "None.",
    "Context:",
    context.trim().length > 0 ? context : "None.",
    "",
    "## Rules",
    "These rules come from the operator's Rule Store and the Work. They always win over the guidance below.",
    rules ?? "None.",
    "",
    "## Owner guidance",
    "The Owner's answers to earlier Decisions for this Work, newest first. Follow them.",
    ...(guidance.length > 0 ? guidance.map((entry) => `- ${JSON.stringify(entry)}`) : ["None."]),
    ...(processSkills && processSkills.length > 0 ? ["", "## Process skills", ...processSkills] : []),
    ...(workspaceTools ? ["", "## Workspace tools", ...workspaceTools] : []),
    "",
    ...WORKING_STYLE_RULES,
    "",
    ...MINIMAL_CODE_RULES,
    "",
    "When finished, return a concise completion report with:",
    "- files changed or reports produced (relative paths and a brief description), or say that no files were changed;",
    "- checks/tests run and their results;",
    "- any remaining issues or blockers.",
    "Do not paste raw tool output, command logs, or full diffs. Summarize them.",
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
  onSpawn?(pid: number): void;
  onOutput?(): void;
  /**
   * Resolves true when the run was cancelled, which suppresses its retry.
   * `usage` stays out of ExecutorResult, which the verdict prompt reads.
   */
  finish?(result: ExecutorResult, usage: TokenUsage | null): Promise<boolean>;
}

/** Called before every Executor attempt (attempt 1 is the first run). */
export type ExecutorRunTracker = (task: ExecutorTask, attempt: number) => Promise<ExecutorRunObserver>;

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
async function runExecutorProcess(
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
    };
  }
  if (config.model.trim().length === 0 || !Number.isSafeInteger(config.timeout_ms) || config.timeout_ms < 0) {
    return {
      subtask_id: task.subtask_id,
      success: false,
      output: "Executor configuration is invalid.",
      exit_code: -1,
      duration_ms: 0,
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
      };
    }
  }
  return new Promise<ExecutorResult>((resolve) => {
    let command: string[];
    try {
      command = argv(config, runtime);
    } catch (error) {
      resolve({
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor configuration is invalid", config, error instanceof Error ? error.message : String(error)),
        exit_code: -1,
        duration_ms: Date.now() - started,
      });
      return;
    }
    let guardLease: GuardTokenLease | undefined;
    try {
      guardLease = runtime.guardToken?.({ agent_run_id: task.subtask_id, role: "worker" });
    } catch (error) {
      resolve({
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor guard token could not be prepared", config, error instanceof Error ? error.message : String(error)),
        exit_code: -1,
        duration_ms: Date.now() - started,
      });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd: task.workspace_dir,
        env: environment(task, runtime, guardLease, observer.agent_run_id, config.provider),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      guardLease?.release();
      resolve({
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor process could not be started", config, error instanceof Error ? error.message : String(error)),
        exit_code: -1,
        duration_ms: Date.now() - started,
      });
      return;
    }
    activeExecutorChildren.add(child);
    if (child.pid !== undefined && child.pid > 0) observer.onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut: AgentTimeoutKind | null = null;
    let outputTooLarge = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ExecutorResult): void => {
      if (settled) return;
      settled = true;
      activeExecutorChildren.delete(child);
      guardLease?.release();
      if (timer !== undefined) clearTimeout(timer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(result);
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
    const claudeStream = config.provider === "claude" ? new ClaudeStreamReader(notifyProgress) : null;
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
    child.once("error", (error) => finish({
      subtask_id: task.subtask_id,
      success: false,
      output: safeExecutorFailure("Executor process error", config, `${stderr}\n${error.message}`),
      exit_code: -1,
      duration_ms: Date.now() - started,
    }));
    child.once("close", (code) => {
      if (claudeStream) { stdout = claudeStream.output(); outputTooLarge ||= claudeStream.retainedBytes() + Buffer.byteLength(stderr) > OUTPUT_CAP_BYTES; }
      const processSucceeded = code === 0 && timedOut === null && !outputTooLarge;
      const report = processSucceeded ? executorFinalReport(config.provider, stdout) : null;
      const success = processSucceeded && report !== null && !report.is_error;
      if (processSucceeded) sink.usage = extractExecutorUsage(config.provider, stdout);
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
      finish({
        subtask_id: task.subtask_id,
        success,
        output,
        exit_code: timedOut !== null || outputTooLarge ? -1 : (code ?? -1),
        duration_ms: Date.now() - started,
      });
    });
    try {
      // Keep instructions out of argv: prompts may exceed the OS command-line
      // size limit. Codex's `-` marker reads the prompt from stdin.
      child.stdin!.end(buildExecutorPrompt(task, executorProcessSkills(task, config.provider)));
    } catch (error) {
      signalProcessGroup(child, "SIGTERM");
      finish({
        subtask_id: task.subtask_id,
        success: false,
        output: safeExecutorFailure("Executor stdin could not be closed", config, error instanceof Error ? error.message : String(error)),
        exit_code: -1,
        duration_ms: Date.now() - started,
      });
    }
  });
}

export async function runExecutorsParallel(
  tasks: readonly ExecutorTask[],
  config: ExecutorConfig = DEFAULT_EXECUTOR_CONFIG,
  maxRetries = 1,
  tracker?: ExecutorRunTracker,
  runtime: ExecutorRuntime = defaultExecutorRuntime(),
): Promise<readonly ExecutorResult[]> {
  const resultsById = new Map<string, ExecutorResult>();
  for (const wave of executorWaves(tasks)) {
    const results = await Promise.all(wave.map(async (task) => {
      let attempt = 1;
      let run = await runTrackedExecutor(task, config, attempt, tracker, runtime);
      while (!run.result.success && !run.cancelled && attempt <= maxRetries) {
        attempt += 1;
        run = await runTrackedExecutor(task, config, attempt, tracker, runtime);
      }
      return run.result;
    }));
    for (const result of results) resultsById.set(result.subtask_id, result);
  }
  return tasks.flatMap((task) => {
    const result = resultsById.get(task.subtask_id);
    return result ? [result] : [];
  });
}

/**
 * Run independent Hybrid subtasks concurrently, scheduling overlapping
 * declared write scopes into later waves. Each Executor gets a fresh CLI
 * process; sequential waves can see completed changes from earlier waves.
 */
function executorWaves(tasks: readonly ExecutorTask[]): ExecutorTask[][] {
  const waves: ExecutorTask[][] = [];
  for (const task of tasks) {
    const scope = executorWritePaths(task);
    let wave = waves.find((candidate) => candidate.every((sibling) =>
      !writeScopesOverlap(scope, executorWritePaths(sibling)),
    ));
    if (!wave) {
      wave = [];
      waves.push(wave);
    }
    wave.push(task);
  }
  return waves;
}

function executorWritePaths(task: ExecutorTask): readonly string[] {
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

function writeScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) =>
    a === "*" || b === "*" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
  ));
}

async function runTrackedExecutor(
  task: ExecutorTask,
  config: ExecutorConfig,
  attempt: number,
  tracker: ExecutorRunTracker | undefined,
  runtime: ExecutorRuntime,
): Promise<{ result: ExecutorResult; cancelled: boolean }> {
  const observer = tracker ? await tracker(task, attempt) : {};
  const sink: { usage: TokenUsage | null } = { usage: null };
  const result = await runExecutorProcess(task, config, observer, sink, runtime);
  const cancelled = observer.finish ? await observer.finish(result, sink.usage) : false;
  return { result, cancelled };
}
