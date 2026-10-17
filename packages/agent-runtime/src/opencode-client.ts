import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { OPENCODE_EVENT_STALL_MS, OPENCODE_MIN_SUPPORTED_VERSION, OPENCODE_STARTUP_TIMEOUT_MS, isSupportedOpencodeVersion, reapProcessGroup } from "@owl/shared";

// Written on node:http: @opencode/client needs effect and solid-js as peers and calls itself a private generation target.

const STDERR_TAIL_BYTES = 4_096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const BASIC_USER = "opencode";

export class OpencodeHttpError extends Error {
  public constructor(public readonly status: number, public readonly body: string) {
    super(`opencode responded ${status}`);
    this.name = "OpencodeHttpError";
  }
}

export type OpencodeStartErrorCode = "opencode_start_failed" | "opencode_version_unsupported" | "opencode_non_loopback" | "opencode_external_plugin";

export class OpencodeStartError extends Error {
  public constructor(public readonly code: OpencodeStartErrorCode, message: string) {
    super(message);
    this.name = "OpencodeStartError";
  }
}

export interface OpencodeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface OpencodeClient {
  /** Resolves with the parsed JSON body (undefined for an empty body); any non-2xx status throws OpencodeHttpError. */
  request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  /** SSE stream. Ends when `signal` aborts, the server closes it, or nothing (not even a heartbeat) arrives for the stall time. */
  events(signal: AbortSignal): AsyncIterable<OpencodeEvent>;
  /** Heartbeat comment lines seen on the event streams so far. */
  readonly heartbeats: number;
}

export interface OpencodeServer {
  readonly url: string;
  readonly pid: number;
  readonly version: string;
  readonly client: OpencodeClient;
  readonly exited: Promise<{ exit_code: number | null; signal: string | null; stderr_tail: string }>;
  /** Closes stdin, then SIGTERM, then SIGKILL after `graceMs`, all to the process group. */
  stop(graceMs: number): Promise<void>;
  kill(): void;
}

export interface StartOpencodeServerInput {
  readonly executable: string;
  readonly cwd: string;
  /** Must hold OPENCODE_PASSWORD; the same value authenticates the client. */
  readonly env: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly eventStallMs?: number;
}

export function createOpencodeClient(url: string, password: string, eventStallMs: number = OPENCODE_EVENT_STALL_MS): OpencodeClient {
  const base = new URL(url);
  const authorization = `Basic ${Buffer.from(`${BASIC_USER}:${password}`).toString("base64")}`;
  let heartbeats = 0;

  function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // An abort destroys the socket, so a serve that never answers cannot hold the caller.
      if (signal?.aborted) return reject(new Error("opencode request aborted"));
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(new URL(path, base), {
        method,
        headers: {
          authorization,
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new OpencodeHttpError(status, text));
          if (text.length === 0) return resolve(undefined as T);
          try {
            resolve(JSON.parse(text) as T);
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      const onAbort = (): void => {
        req.destroy();
        reject(new Error("opencode request aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal?.removeEventListener("abort", onAbort));
      req.end(payload);
    });
  }

  async function* events(signal: AbortSignal): AsyncGenerator<OpencodeEvent> {
    const queue: OpencodeEvent[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const resume = wake;
      wake = null;
      resume?.();
    };
    const req = http.request(new URL("/api/event", base), { method: "GET", headers: { authorization, accept: "text/event-stream" } });
    let stallTimer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      clearTimeout(stallTimer);
      req.destroy();
      notify();
    };
    const armStall = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(finish, eventStallMs);
    };
    armStall();
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
    let failure: unknown = null;
    req.on("error", (error) => {
      if (!ended) failure = error;
      finish();
    });
    req.on("response", (res) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          failure = new OpencodeHttpError(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"));
          finish();
        });
        return;
      }
      res.setEncoding("utf8");
      let pending = "";
      res.on("data", (chunk: string) => {
        armStall();
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        let dataLines: string[] = [];
        for (const raw of lines) {
          const line = raw.replace(/\r$/u, "");
          if (line.startsWith(":")) {
            if (line.slice(1).trim() === "heartbeat") heartbeats += 1;
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /u, ""));
          } else if (line === "" && dataLines.length > 0) {
            try {
              const parsed = JSON.parse(dataLines.join("\n")) as OpencodeEvent;
              if (typeof parsed.type === "string") queue.push({ id: String(parsed.id), type: parsed.type, data: parsed.data ?? {} });
            } catch {
              // A line that is not JSON is not an event.
            }
            dataLines = [];
          }
        }
        // A data line whose blank terminator has not arrived yet waits for the next chunk.
        if (dataLines.length > 0) pending = `${dataLines.map((line) => `data: ${line}`).join("\n")}\n${pending}`;
        notify();
      });
      res.on("end", finish);
      res.on("error", finish);
    });
    req.end();
    try {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw failure;
    } finally {
      finish();
      signal.removeEventListener("abort", finish);
    }
  }

  return {
    request,
    events,
    get heartbeats() {
      return heartbeats;
    },
  };
}

/** Starts `opencode serve --stdio --port 0`, reads its URL from stdout and checks loopback, version and plugins. */
export async function startOpencodeServer(input: StartOpencodeServerInput): Promise<OpencodeServer> {
  const password = input.env.OPENCODE_PASSWORD;
  if (!password) throw new OpencodeStartError("opencode_start_failed", "OPENCODE_PASSWORD is missing from the serve environment.");
  const child = spawn(input.executable, ["serve", "--stdio", "--port", "0", "--print-logs", "--log-level", "warn"], {
    cwd: input.cwd,
    env: { ...input.env },
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as ChildProcess;
  const pid = child.pid;
  let stderrTail = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  child.stdin!.on("error", () => undefined);
  const exited = new Promise<{ exit_code: number | null; signal: string | null; stderr_tail: string }>((resolve) => {
    child.once("close", (code, signal) => resolve({ exit_code: code, signal, stderr_tail: stderrTail }));
    child.once("error", (error) => resolve({ exit_code: null, signal: null, stderr_tail: `${stderrTail}${error.message}` }));
  });
  const kill = (): void => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  };
  if (pid === undefined) {
    const result = await exited;
    throw new OpencodeStartError("opencode_start_failed", `opencode could not be started: ${result.stderr_tail}`);
  }
  const startupTimeoutMs = input.startupTimeoutMs ?? OPENCODE_STARTUP_TIMEOUT_MS;
  const eventStallMs = input.eventStallMs ?? OPENCODE_EVENT_STALL_MS;
  const deadline = Date.now() + startupTimeoutMs;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OpencodeStartError("opencode_start_failed", `opencode serve printed no URL within ${startupTimeoutMs}ms.`)), startupTimeoutMs);
      let buffer = "";
      let found = false;
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (found) return; // Later output is drained and dropped.
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        found = true;
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as { url?: unknown };
          if (typeof parsed.url !== "string") throw new Error("no url");
          resolve(parsed.url);
        } catch {
          reject(new OpencodeStartError("opencode_start_failed", "opencode serve did not print a JSON line with a url."));
        }
      });
      void exited.then((result) => {
        clearTimeout(timer);
        reject(new OpencodeStartError("opencode_start_failed", `opencode serve exited before it was ready (code ${result.exit_code}): ${result.stderr_tail}`));
      });
    });
    if (!LOOPBACK_HOSTS.has(new URL(url).hostname)) throw new OpencodeStartError("opencode_non_loopback", `opencode listens on a non-loopback address: ${new URL(url).hostname}`);
    const client = createOpencodeClient(url, password, eventStallMs);
    const checks = (async () => {
      // v2.0.30 answers /api/info without the data wrapper the other endpoints have.
      const info = await client.request<{ version: string }>("GET", "/api/info");
      const version = String(info.version);
      if (!isSupportedOpencodeVersion(version)) {
        throw new OpencodeStartError("opencode_version_unsupported", `opencode ${version} is older than ${OPENCODE_MIN_SUPPORTED_VERSION}.`);
      }
      const plugins = await client.request<{ data: { id: string; source: { type: string } }[] }>("GET", "/api/plugin");
      const external = plugins.data.find((plugin) => plugin.source.type !== "builtin");
      if (external) throw new OpencodeStartError("opencode_external_plugin", `opencode loaded an external plugin: ${external.id}`);
      return version;
    })();
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new OpencodeStartError("opencode_start_failed", "opencode serve did not pass its startup checks in time.")), Math.max(1, deadline - Date.now()));
      void checks.then(() => clearTimeout(timer), () => clearTimeout(timer));
    });
    const version = await Promise.race([checks, timeout]);
    return {
      url,
      pid,
      version,
      client,
      exited,
      async stop(graceMs: number) {
        child.stdin!.end();
        await reapProcessGroup(pid, { graceMs });
        await exited;
      },
      kill,
    };
  } catch (error) {
    kill();
    await exited;
    throw error;
  }
}
