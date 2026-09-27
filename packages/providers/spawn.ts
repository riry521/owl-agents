import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { kill as killProcess } from "node:process";
import {
  outputTooLarge,
  spawnFailed,
  utf8DecodeFailed,
} from "./errors.js";
import type {
  AdapterId,
  CapturedStream,
  IdleAlert,
  ProviderProcessResult,
} from "./types.js";

export const STREAM_CAP_BYTES = 4 * 1024 * 1024;
export const WALL_TIMEOUT_SECONDS = 0;
export const IDLE_ALERT_SECONDS = 1800;
export const SIGTERM_GRACE_SECONDS = 30;

export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface SpawnRequest {
  readonly adapter: AdapterId;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logPath?: string;
  readonly secrets?: readonly string[];
  readonly onIdleAlert?: (alert: IdleAlert) => void;
  readonly cancellation?: CancellationSignal;
}

export interface RawProviderProcessResult extends ProviderProcessResult {
  readonly rawStdout: string;
  readonly rawStderr: string;
}

interface ReadableLike {
  on(event: string, listener: (...args: any[]) => void): ReadableLike;
  destroy(): void;
}

interface WritableLike {
  end(): void;
}

interface ChildLike {
  readonly pid?: number;
  readonly stdin: WritableLike;
  readonly stdout: ReadableLike;
  readonly stderr: ReadableLike;
  on(event: string, listener: (...args: any[]) => void): ChildLike;
  kill(signal?: string): boolean;
}

function killProcessGroup(child: ChildLike, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid !== undefined) {
    try {
      killProcess(-child.pid, signal);
      return;
    } catch {
      try {
        killProcess(child.pid, signal);
        return;
      } catch {
        // Fall through to the child handle when the process already exited or
        // the platform does not support process-group signalling.
      }
    }
  }
  try { child.kill(signal); } catch { /* the process already exited */ }
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  return new TextEncoder().encode(String(chunk));
}

function joinBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function decodeUtf8(bytes: Uint8Array, adapter: AdapterId, stream: "stdout" | "stderr"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw utf8DecodeFailed(adapter, stream, cause);
  }
}

export function maskSecrets(text: string, secrets: readonly string[] = []): string {
  const usable = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  let masked = text;
  for (const secret of usable) {
    masked = masked.split(secret).join("***");
  }
  return masked;
}

interface StreamCapture {
  readonly bytes: number;
  readonly sha256: string;
  readonly rawText: string;
  readonly text: string;
}

function captureStream(
  stream: ReadableLike,
  adapter: AdapterId,
  name: "stdout" | "stderr",
  secrets: readonly string[],
  onData: () => void,
  onLimit: (error: Error) => void,
): Promise<StreamCapture> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const hash = createHash("sha256");
    let size = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        const bytes = joinBytes(chunks, size);
        const rawText = decodeUtf8(bytes, adapter, name);
        resolve({
          bytes: size,
          sha256: hash.digest("hex"),
          rawText,
          text: maskSecrets(rawText, secrets),
        });
      } catch (error) {
        reject(error);
      }
    };
    stream.on("data", (chunk: unknown) => {
      onData();
      const bytes = toBytes(chunk);
      hash.update(bytes);
      if (size + bytes.length > STREAM_CAP_BYTES) {
        const error = outputTooLarge(adapter, name);
        settled = true;
        onLimit(error);
        reject(error);
        stream.destroy();
        return;
      }
      chunks.push(bytes);
      size += bytes.length;
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(spawnFailed(adapter, `${name}_stream_error`, error));
      }
    });
  });
}

function capturedStream(value: StreamCapture): CapturedStream {
  return {
    bytes: value.bytes,
    sha256: value.sha256,
    text: value.text,
  };
}

export function spawnProvider(request: SpawnRequest): Promise<RawProviderProcessResult> {
  if (request.argv.length === 0 || !isAbsolute(request.argv[0])) {
    return Promise.reject(spawnFailed(request.adapter, "argv_zero_not_absolute"));
  }

  let child: ChildLike;
  try {
    child = spawn(request.argv[0], [...request.argv.slice(1)], {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as unknown as ChildLike;
  } catch (cause) {
    return Promise.reject(spawnFailed(request.adapter, "spawn_call_failed", cause));
  }

  let closeResolve: (value: { code: number | null; signal: string | null }) => void;
  let closeReject: (reason: unknown) => void;
  let closed = false;
  let cancelled = false;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (markCancelled = false): void => {
    if (closed) {
      return;
    }
    if (markCancelled) cancelled = true;
    killProcessGroup(child, "SIGTERM");
    if (terminationTimer === undefined) {
      terminationTimer = setTimeout(() => {
        if (!closed) {
          killProcessGroup(child, "SIGKILL");
        }
      }, SIGTERM_GRACE_SECONDS * 1000);
    }
  };
  const closePromise = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      closeResolve = resolve;
      closeReject = reject;
    },
  );
  let childError: unknown = null;
  child.on("error", (error: unknown) => {
    childError = error;
    closeReject(spawnFailed(request.adapter, "child_process_error", error));
  });
  child.on("close", (code: number | null, signal: string | null) => {
    closed = true;
    if (terminationTimer !== undefined) {
      clearTimeout(terminationTimer);
      terminationTimer = undefined;
    }
    closeResolve({ code, signal });
  });

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleAlerted = false;
  const armIdleAlert = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      if (idleAlerted) {
        return;
      }
      idleAlerted = true;
      try {
        request.onIdleAlert?.({
          adapter: request.adapter,
          executablePath: request.argv[0],
          idleSeconds: IDLE_ALERT_SECONDS,
        });
      } catch {
        // Observability must never terminate the provider process.
      }
    }, IDLE_ALERT_SECONDS * 1000);
  };
  armIdleAlert();

  let cancellationListener: (() => void) | undefined;
  if (request.cancellation !== undefined) {
    cancellationListener = () => terminate(true);
    request.cancellation.addEventListener("abort", cancellationListener);
    if (request.cancellation.aborted) {
      cancellationListener();
    }
  }

  let limitError: Error | null = null;
  const onLimit = (error: Error): void => {
    if (limitError === null) {
      limitError = error;
      terminate();
    }
  };
  const stdoutPromise = captureStream(
    child.stdout,
    request.adapter,
    "stdout",
    request.secrets ?? [],
    armIdleAlert,
    onLimit,
  );
  const stderrPromise = captureStream(
    child.stderr,
    request.adapter,
    "stderr",
    request.secrets ?? [],
    armIdleAlert,
    onLimit,
  );

  return (async (): Promise<RawProviderProcessResult> => {
    try {
      // Attach stdout/stderr listeners before closing stdin so short-lived
      // providers cannot exit and emit their complete report before capture
      // is installed.
      child.stdin.end();
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      const closed = await closePromise;
      if (cancelled) {
        throw spawnFailed(request.adapter, "cancelled");
      }
      if (childError !== null) {
        throw spawnFailed(request.adapter, "child_process_error", childError);
      }
      if (limitError !== null) {
        throw limitError;
      }
      if (request.logPath !== undefined) {
        writeFileSync(
          request.logPath,
          `${JSON.stringify({
            stdout: stdout.text,
            stderr: stderr.text,
            stdout_sha256: stdout.sha256,
            stderr_sha256: stderr.sha256,
          })}\n`,
        );
      }
      return {
        exitCode: closed.code,
        signal: closed.signal,
        stdout: capturedStream(stdout),
        stderr: capturedStream(stderr),
        rawStdout: stdout.rawText,
        rawStderr: stderr.rawText,
      };
    } catch (error) {
      terminate();
      throw error;
    } finally {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      if (cancellationListener !== undefined && request.cancellation !== undefined) {
        request.cancellation.removeEventListener("abort", cancellationListener);
      }
    }
  })();
}
