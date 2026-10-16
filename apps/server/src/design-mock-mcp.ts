import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const FETCH_TIMEOUT_MS = 30_000;
const nonce = `${process.pid}-${Date.now().toString(36)}`;

const TOOLS = [
  {
    name: "save_design_mock",
    description:
      "Save one standalone HTML mock of a screen. Owl stores it and writes it into the Task's mock directory; saving the same name again replaces it. Put all CSS and JavaScript inline and embed images as data: URLs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "html"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}\\.html$", description: "File name such as 01-sign-in.html: lowercase letters, digits and hyphens, then .html." },
        html: { type: "string", minLength: 1, description: "The complete HTML document." },
      },
    },
  },
  {
    name: "delete_design_mock",
    description: "Delete a saved mock of a screen that no longer exists.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string", description: "File name of a mock saved earlier." } },
    },
  },
];

const ROUTES: Readonly<Record<string, string>> = {
  save_design_mock: "/api/v1/agent/design-mocks",
  delete_design_mock: "/api/v1/agent/design-mocks/delete",
};

type Json = Record<string, unknown>;
class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function errorCode(error: unknown): string {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code ?? "";
}

async function post(path: string, id: unknown, payload: Json): Promise<unknown> {
  const role = process.env.OWL_ROLE;
  const base = process.env.OWL_GUARD_API_BASE;
  const tokenFile = process.env.OWL_GUARD_TOKEN_FILE;
  if (role !== "designer" || !process.env.OWL_AGENT_RUN_ID || !base || !tokenFile) {
    throw new ToolError("owl_design_unavailable", "Designer の OWL_ROLE / OWL_AGENT_RUN_ID / OWL_GUARD_API_BASE / OWL_GUARD_TOKEN_FILE が設定されていません。");
  }
  const key = `${nonce}:${String(id)}`;
  const body = JSON.stringify({ request_id: key, idempotency_key: key, expected_version: 0, payload });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const token = readFileSync(tokenFile, "utf8").trim();
      const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
        throw new ToolError("owl_design_timeout", "Core への要求がタイムアウトしました。");
      }
      if (attempt === 0 && ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(errorCode(error))) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw new ToolError("owl_design_unavailable", `Core に接続できません: ${(error as Error)?.message ?? String(error)}`);
    }
  }
}

async function callTool(id: unknown, name: string, args: Json): Promise<Json> {
  try {
    if (!Object.hasOwn(ROUTES, name)) throw new ToolError("unknown_tool", `Unknown tool: ${name}`);
    const payload: Json = name === "save_design_mock" ? { name: args.name, html: args.html } : { name: args.name };
    const data = await post(ROUTES[name], id, payload);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (error) {
    const e = error instanceof ToolError ? error : new ToolError("owl_design_unavailable", String((error as Error)?.message ?? error));
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
    send({ id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "owl-design", version: "1.0.0" } } });
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
