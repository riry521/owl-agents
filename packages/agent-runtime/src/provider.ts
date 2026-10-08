import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reapProcessGroup } from "@owl/shared";
import { providerConfigInvalid, providerFailed } from "./errors";
import { AdvisorSessionDriver } from "./advisor-session-driver.js";
import { CodexSessionDriver } from "./codex-session-driver.js";
import {
  AgentTimeoutSettingError,
  agentUserInstructionEnv,
  agentIdleTimeoutMs,
  agentWallTimeoutMs,
  buildAgentPermissionArgs,
  buildDispatchMcpArgs,
  buildResearchSubagentArgs,
  buildCodexCustomProviderArgs,
  CODEX_PROVIDER_API_KEY_ENV,
  CODEX_PROVIDER_BASE_URL_ENV,
  CodexProgressTracker,
  ClaudeStreamReader,
  GUARD_TOKEN_FILE_ENV,
  type AgentTimeoutKind,
  type GuardTokenIssuer,
  type GuardTokenLease,
} from "@owl/shared";
import {
  type AdapterId,
  type AgentRunnerOptions,
  type ProviderClient,
  type ProviderExecutionRequest,
  type ProviderResponse,
  type ProviderSession,
  type ProviderSessionRequest,
} from "./types";

interface StreamLike {
  on(event: string, listener: (...args: any[]) => void): StreamLike;
}

interface ChildLike {
  readonly pid?: number;
  readonly stdin: { end(chunk?: string): void };
  readonly stdout: StreamLike;
  readonly stderr: StreamLike;
  on(event: string, listener: (...args: any[]) => void): ChildLike;
  once(event: string, listener: (...args: any[]) => void): ChildLike;
  kill(signal?: string): boolean;
}

function isAbsoluteExecutable(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function isClaudeAdapter(adapter: string): boolean {
  return adapter === "claude-cli/v1" || adapter === "claude" || adapter.startsWith("claude/");
}

function isCodexAdapter(adapter: string): boolean {
  return adapter === "codex" || adapter === "codex-cli/v1" || adapter.startsWith("codex/");
}

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const AGENT_IDENTITY_ENV_NAMES = ["OWL_AGENT_ROLE", "OWL_AGENT_RUN_ID", "OWL_AGENT_CWD"] as const;
/** A custom provider's endpoint/key for the harness the session's adapter selects. */
const PROVIDER_CONNECTION_ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  CODEX_PROVIDER_BASE_URL_ENV,
  CODEX_PROVIDER_API_KEY_ENV,
] as const;

/**
 * A guard token for one agent process, or undefined when the runner was
 * configured without a guard.
 */
function issueGuardToken(
  issuer: GuardTokenIssuer | undefined,
  role: ProviderExecutionRequest["role"],
  agentRunId: string,
): GuardTokenLease | undefined {
  if (issuer === undefined) return undefined;
  try {
    return issuer({ agent_run_id: agentRunId, role });
  } catch (cause) {
    throw providerFailed("guard_token_unavailable", cause);
  }
}

/** Releases the token when the session is stopped or terminated. */
function releaseWithSession(session: ProviderSession, lease: GuardTokenLease): ProviderSession {
  const stop = session.stop.bind(session);
  const terminateImmediately = session.terminateImmediately?.bind(session);
  session.stop = async (reason: string, graceMs?: number): Promise<void> => {
    try {
      await stop(reason, graceMs);
    } finally {
      lease.release();
    }
  };
  if (terminateImmediately) {
    session.terminateImmediately = (): void => {
      try {
        terminateImmediately();
      } finally {
        lease.release();
      }
    };
  }
  return session;
}

function killProcessGroup(child: ChildLike, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      try { process.kill(child.pid, signal); return; } catch { /* fall through to the child handle */ }
    }
  }
  try { child.kill(signal); } catch { /* the process already exited */ }
}

/**
 * Limits for one provider process. The wall-clock limit applies to every run.
 * The no-output limit applies to both streaming one-shot CLIs.
 */
function processTimeouts(env: Readonly<Record<string, string>>, adapter: string): { wallMs: number; idleMs: number } {
  try {
    return { wallMs: agentWallTimeoutMs(env, env.OWL_AGENT_ROLE), idleMs: (isCodexAdapter(adapter) || isClaudeAdapter(adapter)) ? agentIdleTimeoutMs(env, env.OWL_AGENT_ROLE) : 0 };
  } catch (error) {
    if (error instanceof AgentTimeoutSettingError) throw providerConfigInvalid(`${error.setting.toLowerCase()}_invalid`);
    throw error;
  }
}

export function buildArgv(request: ProviderExecutionRequest, outputSchemaPath?: string): string[] {
  const owlRoot = request.env.OWL_ROOT ?? process.env.OWL_ROOT ?? process.cwd();
  if (isClaudeAdapter(request.adapter)) {
    return [
      request.env.OWL_CLAUDE_EXECUTABLE ?? "",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(request.provider_session_id ? ["--resume", request.provider_session_id] : []),
      ...(request.structured_output_schema
        ? ["--json-schema", JSON.stringify(request.structured_output_schema)]
        : []),
      ...buildAgentPermissionArgs(request.role, "claude", { owlRoot, env: request.env, cwd: request.cwd }),
      ...buildDispatchMcpArgs("claude", { owlRoot, role: request.role, env: request.env }),
      ...(request.role === "worker" && request.research_subagent ? buildResearchSubagentArgs("claude", request.research_subagent) : []),
      "--model",
      request.model,
      ...(request.effort ? ["--effort", request.effort] : []),
    ];
  }
  if (!isCodexAdapter(request.adapter)) {
    throw providerConfigInvalid("adapter_not_in_allowlist");
  }
  if (request.structured_output_schema && !outputSchemaPath) {
    throw providerConfigInvalid("structured_output_schema_path_required");
  }
  return [
      request.env.OWL_CODEX_EXECUTABLE ?? "",
      "exec",
      ...(request.provider_session_id ? ["resume"] : []),
      "--json",
      ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
      ...buildAgentPermissionArgs(request.role, "codex", {
        owlRoot,
        resume: Boolean(request.provider_session_id),
        env: request.env,
      }),
      ...buildDispatchMcpArgs("codex", { owlRoot, role: request.role, env: request.env }),
      ...(request.role === "worker" && request.research_subagent ? buildResearchSubagentArgs("codex", request.research_subagent) : []),
      ...buildCodexCustomProviderArgs(request.env),
      "--skip-git-repo-check",
      "--model",
      request.model,
      ...(request.effort ? ["--config", `model_reasoning_effort=${request.effort}`] : []),
      ...(request.provider_session_id ? [request.provider_session_id] : []),
      "--",
      "-",
  ];
}

/**
 * Minimal local launcher used only when no already-built providers adapter is
 * injected. It owns argv construction and process I/O, while report parsing
 * remains in protocol.ts. It never retries or switches to the stub runner.
 */
export function createCliProvider(options: AgentRunnerOptions): ProviderClient {
  const executablePath = options.executablePath;
  const model = options.model;
  if (executablePath === undefined || !isAbsoluteExecutable(executablePath)) {
    throw providerConfigInvalid("absolute_executable_path_required");
  }
  if (model === undefined || model.length === 0) {
    throw providerConfigInvalid("model_required");
  }
  if (options.env === undefined) {
    throw providerConfigInvalid("environment_allowlist_required");
  }
  if (
    typeof options.env.PATH !== "string" ||
    options.env.PATH.length === 0 ||
    typeof options.env.HOME !== "string" ||
    options.env.HOME.length === 0
  ) {
    throw providerConfigInvalid("environment_path_home_required");
  }
  const env = options.env;
  const adapter: AdapterId = options.adapter ?? "claude-cli/v1";

  const createSession = async (request: ProviderSessionRequest): Promise<ProviderSession> => {
    if (typeof request.model !== "string" || request.model.trim().length === 0) {
      throw providerConfigInvalid("model_required");
    }
    if (typeof request.cwd !== "string" || request.cwd.trim().length === 0) {
      throw providerConfigInvalid("working_directory_required");
    }
    const requestIsClaude = typeof request.adapter === "string" && isClaudeAdapter(request.adapter);
    const requestIsCodex = typeof request.adapter === "string" && isCodexAdapter(request.adapter);
    if (!requestIsClaude && !requestIsCodex) {
      throw providerConfigInvalid("adapter_not_in_allowlist");
    }
    // This provider owns the agent environment and the resolved CLI paths.
    // The session request contributes only the agent identity plus, when the
    // caller resolved one, a custom provider's endpoint/key, so the
    // executable is always selected from the provider's own configuration
    // (a role-specific Advisor request cannot fall back to the globally
    // selected provider executable, for example launching Codex with Claude
    // argv) and nothing else from the caller's process reaches the child.
    const sessionEnv: Record<string, string> = { ...env };
    for (const key of PROVIDER_CONNECTION_ENV_NAMES) {
      const value = request.env?.[key];
      if (typeof value === "string") sessionEnv[key] = value;
    }
    for (const key of AGENT_IDENTITY_ENV_NAMES) {
      const value = request.env?.[key];
      if (typeof value === "string") sessionEnv[key] = value;
    }
    const selectedExecutable = requestIsClaude
      ? sessionEnv.OWL_CLAUDE_EXECUTABLE ?? (isClaudeAdapter(adapter) ? executablePath : undefined)
      : sessionEnv.OWL_CODEX_EXECUTABLE ?? (isCodexAdapter(adapter) ? executablePath : undefined);
    if (selectedExecutable === undefined || !isAbsoluteExecutable(selectedExecutable) || selectedExecutable.length === 0) {
      throw providerConfigInvalid("argv_executable_not_absolute");
    }
    mkdirSync(request.cwd, { recursive: true });
    const lease = issueGuardToken(options.guardToken, request.role, sessionEnv.OWL_AGENT_RUN_ID ?? "");
    if (lease) sessionEnv[GUARD_TOKEN_FILE_ENV] = lease.file;
    const sessionRequest = { ...request, env: sessionEnv };
    let session: ProviderSession;
    try {
      session = requestIsClaude
        ? await AdvisorSessionDriver.create(sessionRequest, selectedExecutable, { reapGraceMs: options.reapGraceMs })
        : await CodexSessionDriver.create(sessionRequest, selectedExecutable, { reapGraceMs: options.reapGraceMs });
    } catch (error) {
      lease?.release();
      throw error;
    }
    return lease ? releaseWithSession(session, lease) : session;
  };

  return {
    toolNamesInLine,
    async execute(request: ProviderExecutionRequest): Promise<ProviderResponse> {
      const requestAdapter = typeof request.adapter === "string" ? request.adapter.trim() : "";
      if (requestAdapter.length === 0) {
        throw providerConfigInvalid("adapter_required");
      }
      const requestModel = typeof request.model === "string" ? request.model.trim() : "";
      if (requestModel.length === 0) {
        throw providerConfigInvalid("model_required");
      }
      const requestCwd = typeof request.cwd === "string" ? request.cwd.trim() : "";
      if (requestCwd.length === 0) {
        throw providerConfigInvalid("working_directory_required");
      }
      const executionEnv = {
        ...env,
        ...request.env,
        OWL_CLAUDE_EXECUTABLE: env.OWL_CLAUDE_EXECUTABLE ?? (isClaudeAdapter(requestAdapter) ? executablePath : ""),
        OWL_CODEX_EXECUTABLE: env.OWL_CODEX_EXECUTABLE ?? (isCodexAdapter(requestAdapter) ? executablePath : ""),
      };
      let outputSchemaDirectory: string | undefined;
      let guardLease: GuardTokenLease | undefined;
      try {
        let outputSchemaPath: string | undefined;
        if (request.structured_output_schema && isCodexAdapter(requestAdapter)) {
          outputSchemaDirectory = mkdtempSync(join(tmpdir(), "owl-agent-output-schema-"));
          outputSchemaPath = join(outputSchemaDirectory, "schema.json");
          writeFileSync(outputSchemaPath, JSON.stringify(request.structured_output_schema), { encoding: "utf8", mode: 0o600 });
        }
        const workspaceCwd = resolve(requestCwd);
        // The guard token is issued before argv so the owl-memory MCP config can name its token file.
        guardLease = issueGuardToken(options.guardToken, request.role, request.env.OWL_AGENT_RUN_ID || request.invocation_id);
        const argv = buildArgv({
          ...request,
          adapter: requestAdapter,
          model: requestModel,
          cwd: workspaceCwd,
          env: guardLease ? { ...executionEnv, [GUARD_TOKEN_FILE_ENV]: guardLease.file } : executionEnv,
        }, outputSchemaPath);
        if (!isAbsoluteExecutable(argv[0]) || argv[0].length === 0) {
          throw providerConfigInvalid("argv_executable_not_absolute");
        }
        const timeouts = processTimeouts(executionEnv, requestAdapter);
        const agentEnv = isCodexAdapter(requestAdapter)
          ? { ...executionEnv, ...agentUserInstructionEnv("codex", executionEnv) }
          : executionEnv;
        const processEnv = guardLease ? { ...agentEnv, [GUARD_TOKEN_FILE_ENV]: guardLease.file } : agentEnv;
        let child: ChildLike;
        try {
          child = spawn(argv[0], argv.slice(1), {
            cwd: workspaceCwd,
            env: processEnv,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          }) as unknown as ChildLike;
        } catch (cause) {
          throw providerFailed("spawn_call_failed", cause);
        }
        request.on_spawn?.(child.pid ?? 0);
        const resultPromise = new Promise<{
          readonly stdout: string;
          readonly stderr: string;
          readonly code: number | null;
          readonly signal: string | null;
          readonly outputTooLarge: boolean;
          readonly timedOut: AgentTimeoutKind | null;
          readonly cancelled: boolean;
        }>((resolveResult, rejectResult) => {
          let stdout = "";
          let stderr = "";
          let stdoutLinePending = "";
          let byteCount = 0;
          let outputTooLarge = false;
          let timedOut: AgentTimeoutKind | null = null;
          let cancelled = false;
          let settled = false;
          let wallTimer: ReturnType<typeof setTimeout> | undefined;
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const finish = (code: number | null, signal: string | null): void => {
            if (settled) return;
            settled = true;
            if (wallTimer !== undefined) clearTimeout(wallTimer);
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            if (killTimer !== undefined) clearTimeout(killTimer);
            if (request.signal) request.signal.removeEventListener("abort", abort);
            void reapProcessGroup(child.pid, { graceMs: options.reapGraceMs });
            if (claudeStream) stdout = claudeStream.output();
            resolveResult({ stdout, stderr, code, signal, outputTooLarge: outputTooLarge || Buffer.byteLength(stderr) + (claudeStream ? claudeStream.retainedBytes() : Buffer.byteLength(stdout)) > MAX_CAPTURE_BYTES, timedOut, cancelled });
          };
          const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            if (wallTimer !== undefined) clearTimeout(wallTimer);
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            if (killTimer !== undefined) clearTimeout(killTimer);
            if (request.signal) request.signal.removeEventListener("abort", abort);
            void reapProcessGroup(child.pid, { graceMs: options.reapGraceMs });
            rejectResult(error);
          };
          const terminate = (): void => {
            killProcessGroup(child, "SIGTERM");
            if (killTimer === undefined) {
              killTimer = setTimeout(() => {
                killProcessGroup(child, "SIGKILL");
              }, 30_000);
              killTimer.unref();
            }
          };
          const timeOut = (kind: AgentTimeoutKind): void => {
            if (settled || timedOut !== null) return;
            timedOut = kind;
            terminate();
          };
          const armIdleTimer = (): void => {
            if (timeouts.idleMs <= 0 || settled || timedOut !== null) return;
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => timeOut("idle"), timeouts.idleMs);
            idleTimer.unref();
          };
          const notifyProgress = (): void => {
            armIdleTimer();
            try { request.on_output?.(); } catch { /* telemetry must not break I/O */ }
          };
          const notifyStdoutLines = (text: string, final = false): void => {
            if (!request.on_stdout_line) return;
            const lines = `${stdoutLinePending}${text}`.split(/\r?\n/u);
            stdoutLinePending = lines.pop() ?? "";
            for (const line of lines) {
              try { request.on_stdout_line(line); } catch { /* telemetry must not break provider I/O */ }
            }
            if (final && stdoutLinePending.trim()) {
              try { request.on_stdout_line(stdoutLinePending); } catch { /* telemetry must not break provider I/O */ }
              stdoutLinePending = "";
            }
          };
          const progress = new CodexProgressTracker(armIdleTimer);
          const claudeStream = isClaudeAdapter(requestAdapter) ? new ClaudeStreamReader(notifyProgress) : null;
          const append = (which: "stdout" | "stderr", chunk: unknown): void => {
            if (which === "stdout") {
              const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
              notifyStdoutLines(text);
              if (claudeStream) { claudeStream.push(Buffer.isBuffer(chunk) ? chunk : text); return; }
            }
            try {
              request.on_output?.();
            } catch {
              // Output observation is telemetry; it must never break provider I/O.
            }
            const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
            if (which === "stdout" && timeouts.idleMs > 0) progress.push(text);
            byteCount += Buffer.byteLength(text);
            if (byteCount > MAX_CAPTURE_BYTES) {
              outputTooLarge = true;
              terminate();
              return;
            }
            if (which === "stdout") stdout += text;
            else stderr += text;
          };
          const abort = (): void => {
            cancelled = true;
            terminate();
          };
          if (timeouts.wallMs > 0) {
            wallTimer = setTimeout(() => timeOut("wall"), timeouts.wallMs);
            wallTimer.unref();
          }
          armIdleTimer();
          child.stdout.on("data", (chunk: unknown) => append("stdout", chunk));
          child.stderr.on("data", (chunk: unknown) => append("stderr", chunk));
          child.once("error", (cause: unknown) => {
            fail(providerFailed("child_process_error", cause));
          });
          child.once("close", (code: number | null, signal: string | null) => {
            notifyStdoutLines("", true);
            finish(code, signal);
          });
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
        try {
          // Send prompts on stdin so large Tasks do not hit the OS argument
          // size limit (Codex uses the explicit `-` marker above).
          child.stdin.end(request.prompt);
        } catch (cause) {
          void reapProcessGroup(child.pid, { graceMs: options.reapGraceMs });
          throw providerFailed("stdin_close_failed", cause);
        }
        const result = await resultPromise;
        if (result.outputTooLarge) {
          throw providerFailed("provider_output_too_large", { stdout: result.stdout, stderr: result.stderr });
        }
        if (result.cancelled) {
          throw providerFailed("provider_cancelled", {
            exit_code: result.code,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        }
        if (result.timedOut !== null) {
          throw providerFailed("provider_timeout", {
            exit_code: result.code,
            signal: result.signal,
            timeout_kind: result.timedOut,
            stdout: result.stdout,
            stderr: `${result.stderr}\nprovider_timeout`,
          });
        }
        // Return the captured response together with the process outcome. The
        // role runtime rejects non-zero exits before parsing any report, so a
        // provider cannot appear successful merely because stdout happened to
        // contain a parseable JSON object.
        return {
          adapter: requestAdapter,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.code,
          signal: result.signal,
          pid: child.pid,
          provider_session_id: providerSessionId(requestAdapter, result.stdout),
          format: "provider-json" as const,
        };
      } finally {
        guardLease?.release();
        if (outputSchemaDirectory) {
          try {
            rmSync(outputSchemaDirectory, { recursive: true, force: true });
          } catch {
            // Schema temp files contain only contract metadata; cleanup must not hide the provider result.
          }
        }
      }
    },
    createSession,
  };
}

function providerSessionId(adapter: string, stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    try {
      const event: unknown = JSON.parse(line);
      if (typeof event !== "object" || event === null) continue;
      const record = event as Record<string, unknown>;
      if (isClaudeAdapter(adapter) && typeof record.session_id === "string") return record.session_id;
      if (isCodexAdapter(adapter) && record.type === "thread.started" && typeof record.thread_id === "string") return record.thread_id;
    } catch {
      continue;
    }
  }
  return undefined;
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Tool names called in one raw stdout line. Each adapter's stream shape is handled here, in the provider adapter, and nowhere else. */
export function toolNamesInLine(adapter: string, line: string): string[] {
  const event = parseRecord(line);
  if (!event) return [];
  if (adapter === "codex" || adapter.startsWith("codex")) {
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type !== "item.started" && event.type !== "item.completed" || !item || typeof item !== "object") return [];
    if (item.type === "mcp_tool_call") return [`mcp__${String(item.server)}__${String(item.tool)}`];
    if (item.type === "command_execution") return ["Bash"]; // codex shell call, normalized to the shared shell tool name
    return typeof item.type === "string" ? [item.type] : [];
  }
  const message = event.message as Record<string, unknown> | undefined;
  if (event.type !== "assistant" || !message || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part: unknown) => {
    const block = part as Record<string, unknown> | null;
    return block && block.type === "tool_use" && typeof block.name === "string" ? [block.name] : [];
  });
}
