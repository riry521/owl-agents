import { execFile, spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Grace between SIGTERM and SIGKILL when reaping an agent's process group. */
export const PROCESS_GROUP_REAP_GRACE_MS = 5_000;

const POLL_INTERVAL_MS = 50;

export interface ReapProcessGroupOptions {
  readonly graceMs?: number;
  readonly pollMs?: number;
}

/** True when at least one member of the process group still exists. */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminates every remaining member of a process group: SIGTERM first, then
 * SIGKILL once the grace period elapses with members still alive. The returned
 * promise resolves when the group is gone or the SIGKILL has been sent. Never
 * rejects; a vanished or foreign group is treated as already reaped.
 */
export function reapProcessGroup(pgid: number | undefined, options: ReapProcessGroupOptions = {}): Promise<void> {
  if (process.platform === "win32" || pgid === undefined || !Number.isInteger(pgid) || pgid <= 1) {
    return Promise.resolve();
  }
  if (!signalGroup(pgid, "SIGTERM")) return Promise.resolve();
  const graceMs = Math.max(0, options.graceMs ?? PROCESS_GROUP_REAP_GRACE_MS);
  const pollMs = Math.max(1, options.pollMs ?? POLL_INTERVAL_MS);
  const deadline = Date.now() + graceMs;
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (!isProcessGroupAlive(pgid)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        signalGroup(pgid, "SIGKILL");
        resolve();
        return;
      }
      setTimeout(check, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    };
    setTimeout(check, Math.min(pollMs, Math.max(1, graceMs)));
  });
}

/** Appends `text` to `current`, keeping only the last `cap` bytes without splitting a UTF-8 code point. The one tail-keeping rule for captured process output. */
export function appendCapped(current: string, text: string | Buffer, cap: number): string {
  if (cap <= 0) return "";
  const combined = Buffer.concat([Buffer.from(current), typeof text === "string" ? Buffer.from(text) : text]);
  if (combined.byteLength <= cap) return combined.toString("utf8");
  let start = combined.byteLength - cap;
  while (start < combined.byteLength && (combined[start]! & 0xc0) === 0x80) start += 1;
  return combined.subarray(start).toString("utf8");
}

/** True when a process with this pid exists. `epermAlive` says whether a pid owned by someone else counts as alive. */
export function isPidAlive(pid: number, options: { readonly epermAlive: boolean }): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return options.epermAlive && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SignalableProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SignalProcessGroupOptions {
  /** For a child handle: skip the direct-child fallback when the group is already gone (ESRCH). */
  readonly skipFallbackWhenGone?: boolean;
  /** Never signal the leader alone: if the group cannot be signalled (or there is no pid), do nothing. */
  readonly groupOnly?: boolean;
}

/**
 * Sends `signal` to a detached process group, given its leader's pid or the
 * child handle. When the group cannot be signalled, the leader alone is
 * signalled instead, so platforms without negative-pid groups still stop.
 * Never throws for a process that has already exited.
 */
export function signalProcessGroup(target: number | SignalableProcess, signal: NodeJS.Signals, options: SignalProcessGroupOptions = {}): void {
  const pid = typeof target === "number" ? target : target.pid;
  const direct = (): void => {
    try {
      if (typeof target === "number") process.kill(target, signal);
      else target.kill(signal);
    } catch { /* already exited */ }
  };
  if (pid === undefined) {
    if (options.groupOnly !== true) direct();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (options.groupOnly === true) return;
    if (options.skipFallbackWhenGone === true && (error as NodeJS.ErrnoException).code === "ESRCH") return;
    direct();
  }
}

/** Collects one output stream under a byte limit: keeps the start (`head`, with a truncated flag) or the end (`tail`, never splitting a UTF-8 code point). */
export function createOutputCapture(limit: number, keep: "head" | "tail", options: { readonly decodeChunks?: boolean } = {}) {
  let text = "";
  let head = Buffer.alloc(0);
  let truncated = false;
  const decoder = options.decodeChunks === true ? new StringDecoder("utf8") : null;
  return {
    push(chunk: Buffer): void {
      if (keep === "tail") {
        text = appendCapped(text, decoder ? decoder.write(chunk) : chunk, limit);
        return;
      }
      if (head.length + chunk.length > limit) truncated = true;
      if (head.length < limit) head = Buffer.concat([head, chunk]).subarray(0, limit);
    },
    text: (): string => (keep === "tail" ? text : head.toString("utf8")),
    truncated: (): boolean => truncated,
  };
}

export interface RunProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Grace between SIGTERM and SIGKILL once the timeout or abort stops the group. */
  readonly killGraceMs: number;
  /** Written to stdin, which is then closed; without it stdin is not connected. */
  readonly input?: string;
  readonly signal?: AbortSignal;
  /** Called with the child right after it spawns, before any output. */
  readonly onSpawn?: (child: ChildProcess) => void;
  readonly onData: (stream: "stdout" | "stderr", chunk: Buffer) => void;
  /** Called once when the run ends, before the result resolves. */
  readonly onSettled?: (child: ChildProcess) => void;
  /** Reap leftover group members (SIGTERM, then SIGKILL) when the child ends. */
  readonly reapOnClose?: boolean;
  /**
   * How a timeout or abort stops the group. "kill" (default) sends SIGTERM, then an unref'd SIGKILL timer.
   * "reap" polls the group with reapProcessGroup, which sends SIGKILL only while members are still alive.
   */
  readonly stopMode?: "kill" | "reap";
  /** With stopMode "kill": hold the SIGKILL timer referenced and cancel it when the child closes. */
  readonly cancelKillOnClose?: boolean;
  /** With stopMode "kill": signal only the process group, never the child alone when the group send fails. */
  readonly groupOnly?: boolean;
}

export interface RunProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Set when the process could not be started or reported an error event. */
  readonly error?: string;
  /** True when spawn() itself threw (no child exists), as opposed to an error event. */
  readonly spawnThrew?: boolean;
}

/**
 * Runs a command with no shell in its own process group and resolves once it
 * closes. A timeout or abort sends SIGTERM to the group and SIGKILL after
 * `killGraceMs`. Output goes to `onData`, so callers choose how to keep it.
 * Never rejects.
 */
export function runProcess(command: string, args: readonly string[], options: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, aborted: false, error: error instanceof Error ? error.message : String(error), spawnThrew: true });
      return;
    }
    options.onSpawn?.(child);
    if (options.input !== undefined) {
      // A process that exits without reading its stdin ends the pipe with EPIPE; the exit code already says what happened.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    child.stdout?.on("data", (chunk: Buffer) => options.onData("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => options.onData("stderr", chunk));
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = (): void => {
      if (options.stopMode === "reap") {
        void reapProcessGroup(child.pid, { graceMs: options.killGraceMs });
        return;
      }
      const groupOptions = { groupOnly: options.groupOnly === true };
      signalProcessGroup(child, "SIGTERM", groupOptions);
      killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL", groupOptions), options.killGraceMs);
      if (options.cancelKillOnClose !== true) killTimer.unref();
    };
    const onAbort = (): void => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: Pick<RunProcessResult, "code" | "signal" | "error">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.cancelKillOnClose === true && killTimer !== null) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.reapOnClose === true) void reapProcessGroup(child.pid);
      options.onSettled?.(child);
      resolve({ ...result, timedOut, aborted });
    };
    child.once("error", (error) => finish({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

export interface CliVersionResult {
  readonly stdout: string;
  /** Exit code; null when the process was killed (for example by the timeout) or never started. */
  readonly exitCode: number | null;
  /** The spawn failure (for example ENOENT), when the command could not be started. */
  readonly spawnError: Error | null;
}

/** Runs `command args` (default `--version`) once and reports its exit code and stdout. A `timeoutMs` of 0 or none means no timeout. Never rejects. */
export function runCliVersion(command: string, args: readonly string[] = ["--version"], timeoutMs?: number, options: { readonly ignoreStdio?: boolean } = {}): Promise<CliVersionResult> {
  return new Promise((resolve) => {
    if (options.ignoreStdio === true) {
      // stdin, stdout and stderr all ignored: no pipe to close and no output-size limit; stdout stays empty.
      let child: ChildProcess;
      try {
        child = spawn(command, [...args], { stdio: "ignore", ...(timeoutMs ? { timeout: timeoutMs } : {}) });
      } catch (error) {
        resolve({ stdout: "", exitCode: null, spawnError: error instanceof Error ? error : new Error(String(error)) });
        return;
      }
      let done = false;
      child.once("error", (error) => { if (!done) { done = true; resolve({ stdout: "", exitCode: null, spawnError: error }); } });
      child.once("close", (code) => { if (!done) { done = true; resolve({ stdout: "", exitCode: code, spawnError: null }); } });
      return;
    }
    execFile(command, [...args], timeoutMs ? { timeout: timeoutMs } : {}, (error, stdout) => {
      if (!error) {
        resolve({ stdout, exitCode: 0, spawnError: null });
        return;
      }
      const code: unknown = (error as { code?: unknown }).code;
      if (typeof code === "number") resolve({ stdout: "", exitCode: code, spawnError: null });
      else if ((error as { killed?: boolean }).killed === true) resolve({ stdout: "", exitCode: null, spawnError: null });
      else resolve({ stdout: "", exitCode: null, spawnError: error });
    });
  });
}
