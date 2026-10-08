import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Layer order: server wait 240s < fetch 270s < undici default 300s < CLI tool timeout 330s.
const DISPATCH_FETCH_TIMEOUT_MS = 30_000;
const WAIT_MAX_SECONDS = 240;
const nonce = `${process.pid}-${Date.now().toString(36)}`;

const TOOLS = [
  {
    name: "dispatch",
    description:
      "Start a child agent for one independent, bounded part of your Task and return its child_id immediately (does not wait). Core runs the child as a separate process and automatically gives it the Task, Owl rules, Owner guidance and working rules; write only what is specific to this part. Children whose write_paths overlap run one after another. Provider, model, and effort can be specified independently; each field is optional. Omitted fields use the defaults for the harness different from the parent, as configured in child-run settings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "instruction", "write_paths"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "Short label shown in the UI." },
        instruction: { type: "string", minLength: 1, maxLength: 20000, description: "Self-contained instruction: goal, files to read, expected change, how to check it." },
        write_paths: {
          type: "array", minItems: 1, maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 300 },
          description: "Workspace-relative files or directories the child may edit. Use \"*\" only when the child must edit anywhere (it then runs alone).",
        },
        provider: { type: "string", enum: ["claude", "codex"], description: "Optional; can be specified independently of model and effort." },
        model: { type: "string", minLength: 1, maxLength: 100, description: "Optional; can be specified independently of provider and effort." },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Optional; can be specified independently of provider and model." },
        timeout_minutes: { type: "integer", minimum: 5, maximum: 1440 },
      },
    },
  },
  {
    name: "wait",
    description:
      "Wait for child agents and get their short reports. Returns when the condition is met or after timeout_seconds (max 240), whichever is first; call it again for children that are still queued or running. Calling wait for a finished child returns its report again.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["child_ids"],
      properties: {
        child_ids: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 64 } },
        return_when: {
          type: "string", enum: ["all", "any"], default: "all",
          description: "all: return when every listed child has finished. any: return as soon as at least one listed child has finished (immediately if one already has).",
        },
        timeout_seconds: { type: "integer", minimum: 0, maximum: WAIT_MAX_SECONDS, default: WAIT_MAX_SECONDS, description: "0 = check status without waiting." },
      },
    },
  },
];

type Json = Record<string, unknown>;
class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function errorCode(error: unknown): string {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code ?? "";
}

async function post(path: string, id: unknown, payload: Json, timeoutMs: number): Promise<unknown> {
  const role = process.env.OWL_ROLE;
  const base = process.env.OWL_GUARD_API_BASE;
  const tokenFile = process.env.OWL_GUARD_TOKEN_FILE;
  if (role !== "worker" || !process.env.OWL_AGENT_RUN_ID || !base || !tokenFile) {
    throw new ToolError("owl_dispatch_unavailable", "Worker の OWL_ROLE / OWL_AGENT_RUN_ID / OWL_GUARD_API_BASE / OWL_GUARD_TOKEN_FILE が設定されていません。");
  }
  const key = `${nonce}:${String(id)}`;
  const body = JSON.stringify({ request_id: key, idempotency_key: key, expected_version: 0, payload });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const token = readFileSync(tokenFile, "utf8").trim();
      const response = await fetch(`${base.replace(/\/+$/, "")}/api/v1/agent/child-runs${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let parsed: { data?: unknown; error?: { code?: string; message?: string } } = {};
      try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
      if (!response.ok) {
        throw new ToolError(parsed.error?.code ?? `http_${response.status}`, parsed.error?.message ?? (text.slice(0, 300) || `HTTP ${response.status}`));
      }
      return parsed.data ?? parsed;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      const name = (error as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ToolError("owl_dispatch_timeout", "Core への要求がタイムアウトしました。状態は wait で確かめてください。");
      }
      if (attempt === 0 && ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(errorCode(error))) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw new ToolError("owl_dispatch_unavailable", `Core に接続できません: ${(error as Error)?.message ?? String(error)}`);
    }
  }
}

async function callTool(id: unknown, name: string, args: Json): Promise<Json> {
  try {
    let data: unknown;
    if (name === "dispatch") {
      data = await post("", id, args, DISPATCH_FETCH_TIMEOUT_MS);
    } else if (name === "wait") {
      const raw = args.timeout_seconds;
      const seconds = typeof raw === "number" && Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), WAIT_MAX_SECONDS) : WAIT_MAX_SECONDS;
      data = await post("/wait", id, { ...args, timeout_seconds: seconds }, (seconds + 30) * 1000);
    } else {
      throw new ToolError("unknown_tool", `Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (error) {
    const e = error instanceof ToolError ? error : new ToolError("owl_dispatch_unavailable", String((error as Error)?.message ?? error));
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: e.code, message: e.message } }) }], isError: true };
  }
}

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function handle(line: string): Promise<void> {
  let request: { id?: unknown; method?: string; params?: Json };
  try { request = JSON.parse(line); } catch { return; }
  // A line such as `null` parses but cannot be destructured; an unhandled rejection would end the server.
  if (typeof request !== "object" || request === null) return;
  const { id, method, params } = request;
  if (id === undefined) return; // notifications
  if (method === "initialize") {
    send({ id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "owl-dispatch", version: "1.0.0" } } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (method === "tools/list") {
    send({ id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    const args = params?.arguments && typeof params.arguments === "object" ? (params.arguments as Json) : {};
    send({ id, result: await callTool(id, String(params?.name ?? ""), args) });
  } else {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => { void handle(line); });
