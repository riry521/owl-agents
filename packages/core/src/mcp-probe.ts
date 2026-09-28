import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

/** Outcome of rehearsing one MCP server's startup handshake. */
export type ProbeStatus = "ok" | "failed" | "timeout" | "unverified";

export interface ProbeResult {
  readonly status: ProbeStatus;
  readonly detail: string;
}

export interface StdioServerTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export interface HttpServerTarget {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "owl", version: "1.0.0" } },
};

function initializeLine(): string {
  return `${JSON.stringify(INITIALIZE_REQUEST)}\n`;
}

/** Whether a parsed JSON value is the initialize response Owl is waiting for. */
function isInitializeReply(value: unknown): value is { id: unknown; result?: unknown; error?: unknown } {
  return typeof value === "object" && value !== null && "id" in value && (value as { id: unknown }).id === 1;
}

function errorDetail(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return JSON.stringify(error);
}

/**
 * Launches a stdio MCP server the way an agent harness would, sends a single
 * `initialize` request, and classifies whether it comes up cleanly. The
 * child (and its process group) is always killed before this resolves, so a
 * probe never leaves a server running or a handle open. `command` is
 * resolved against `cwd` only when it contains a `/`; a bare command name
 * (e.g. `npx`) is left to `PATH` lookup, matching how the harnesses launch it.
 */
export async function probeStdioServer(server: StdioServerTarget, timeoutMs: number): Promise<ProbeResult> {
  const command = server.command.includes("/") ? resolve(server.cwd, server.command) : server.command;

  return new Promise((resolveProbe) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrTail = "";
    let child: ChildProcess;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child?.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* already exited */ }
      }
    };

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 1_000).unref();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      try { child?.stdin?.destroy(); } catch { /* already closed */ }
      resolveProbe(result);
    };

    try {
      child = spawn(command, server.args, { cwd: server.cwd, env: server.env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolveProbe({ status: "failed", detail: errorDetail(error) });
      return;
    }

    const timer = setTimeout(() => finish({ status: "timeout", detail: `no response to initialize within ${timeoutMs}ms` }), timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString("utf8")).slice(-300); });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineAt: number;
      while ((newlineAt = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newlineAt).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineAt + 1);
        if (line.length === 0) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        if (!isInitializeReply(message)) continue;
        if ("error" in message && message.error !== undefined) { finish({ status: "failed", detail: errorDetail(message.error) }); return; }
        if ("result" in message) { finish({ status: "ok", detail: "initialize accepted" }); return; }
      }
    });

    child.once("error", (error) => finish({ status: "failed", detail: error.message }));
    child.once("close", (code, signal) => {
      const tail = stderrTail.length > 0 ? `: ${stderrTail}` : "";
      finish({ status: "failed", detail: `process exited before responding (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})${tail}` });
    });

    try {
      child.stdin?.write(initializeLine());
    } catch { /* the process may already have exited; the close handler covers that */ }
  });
}

/** Reads a fetch response body until it contains an initialize reply (JSON or SSE `data:` framing), then cancels the reader. */
async function readInitializeReply(response: Response): Promise<{ id: unknown; result?: unknown; error?: unknown } | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "";
  let found: { id: unknown; result?: unknown; error?: unknown } | null = null;
  try {
    while (found === null) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      found = extractInitializeReply(text);
      if (done) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return found;
}

function extractInitializeReply(text: string): { id: unknown; result?: unknown; error?: unknown } | null {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isInitializeReply(parsed)) return parsed;
    } catch { /* not a single JSON document; try SSE framing below */ }
  }
  for (const line of text.split("\n")) {
    const dataLine = line.trim();
    if (!dataLine.startsWith("data:")) continue;
    const payload = dataLine.slice("data:".length).trim();
    if (payload.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isInitializeReply(parsed)) return parsed;
    } catch { continue; }
  }
  return null;
}

/**
 * Sends a single `initialize` request to a streamable-HTTP MCP server and
 * classifies the response. A 401/403 is reported as `unverified` rather than
 * `failed`: authentication for the server is the harness CLI's job, not
 * Owl's, so this only confirms the endpoint is reachable.
 */
export async function probeHttpServer(server: HttpServerTarget, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...server.headers },
      body: JSON.stringify(INITIALIZE_REQUEST),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      await readInitializeReply(response).catch(() => null);
      return { status: "unverified", detail: `HTTP ${response.status}` };
    }
    if (response.status < 200 || response.status >= 300) {
      await readInitializeReply(response).catch(() => null);
      return { status: "failed", detail: `HTTP ${response.status}` };
    }
    const message = await readInitializeReply(response);
    if (message && "error" in message && message.error !== undefined) return { status: "failed", detail: errorDetail(message.error) };
    if (message && "result" in message) return { status: "ok", detail: "initialize accepted" };
    return { status: "failed", detail: "response did not contain an initialize result" };
  } catch (error) {
    if (controller.signal.aborted) return { status: "timeout", detail: `no response within ${timeoutMs}ms` };
    return { status: "failed", detail: errorDetail(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** One server's rehearsal outcome, from either harness's own health check. */
export interface McpServerStatus {
  readonly harness: "claude" | "codex";
  readonly name: string;
  readonly status: "ok" | "failed" | "timeout" | "unverified" | "skipped";
  readonly detail: string;
}

/**
 * Parses `claude mcp list` output. Each server line ends with the LAST
 * ` - <status text>` in the line (server names and command targets may
 * contain almost anything, including dashes, so only the rightmost
 * separator is trustworthy); the name is whatever precedes the first `: `
 * in what remains. Lines that do not fit this shape (banners, blank lines)
 * are ignored.
 */
export function parseClaudeMcpList(stdout: string): McpServerStatus[] {
  const results: McpServerStatus[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.lastIndexOf(" - ");
    if (separator < 0) continue;
    const left = line.slice(0, separator);
    const statusText = line.slice(separator + 3).trim();
    const nameEnd = left.indexOf(": ");
    if (nameEnd < 0) continue;
    const name = left.slice(0, nameEnd).trim();
    if (name.length === 0 || statusText.length === 0) continue;
    results.push({ harness: "claude", name, status: classifyClaudeStatus(statusText), detail: statusText });
  }
  return results;
}

function classifyClaudeStatus(statusText: string): McpServerStatus["status"] {
  const lower = statusText.toLowerCase();
  if (/(?<!dis|not )connected/u.test(lower)) return "ok";
  if (lower.includes("auth")) return "unverified";
  if (lower.includes("approval") || lower.includes("pending")) return "skipped";
  return "failed";
}

/** A server `codex mcp list --json` reports as enabled, with its transport normalized for probing. */
export interface CodexMcpServer {
  readonly name: string;
  readonly transport:
    | { readonly type: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: Record<string, string>; readonly cwd: string | null }
    | { readonly type: "http"; readonly url: string; readonly headers: Record<string, string>; readonly bearer_token_env_var: string | null };
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * Parses `codex mcp list --json`, keeping only enabled servers and
 * normalizing every non-stdio transport (http, sse, ...) into the `http`
 * shape used for probing. Returns null when `stdout` is not the expected
 * JSON array, so the caller can tell "no servers" from "could not read it".
 */
export function parseCodexMcpList(stdout: string): CodexMcpServer[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(parsed)) return null;

  const servers: CodexMcpServer[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.enabled !== true) continue;
    const name = typeof record.name === "string" ? record.name : null;
    const transport = record.transport;
    if (!name || !transport || typeof transport !== "object") continue;
    const transportRecord = transport as Record<string, unknown>;

    if (transportRecord.type === "stdio") {
      const command = typeof transportRecord.command === "string" ? transportRecord.command : null;
      if (!command) continue;
      const args = Array.isArray(transportRecord.args) ? transportRecord.args.filter((value): value is string => typeof value === "string") : [];
      const cwd = typeof transportRecord.cwd === "string" ? transportRecord.cwd : null;
      servers.push({ name, transport: { type: "stdio", command, args, env: stringRecord(transportRecord.env), cwd } });
      continue;
    }

    const url = typeof transportRecord.url === "string" ? transportRecord.url : null;
    if (!url) continue;
    const bearerTokenEnvVar = typeof transportRecord.bearer_token_env_var === "string" ? transportRecord.bearer_token_env_var : null;
    servers.push({
      name,
      transport: { type: "http", url, headers: stringRecord(transportRecord.http_headers ?? transportRecord.headers), bearer_token_env_var: bearerTokenEnvVar },
    });
  }
  return servers;
}
