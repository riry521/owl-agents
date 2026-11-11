import { randomUUID } from "node:crypto";
import { guardConfig, guardRequest } from "./guard-client.js";
import { serveMcp } from "./stdio-jsonrpc.js";
import { redactProviderOutput } from "@owl/shared/advisor-response";
import { validateOwnApiPath } from "@owl/shared/advisor-api-policy";

const OWL_API_MCP_TIMEOUT_MS = 60_000;
const OWL_API_MCP_MAX_RESPONSE_CHARS = 100_000;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const TOOLS = [
  {
    name: "request",
    description:
      "Call this Owl server's own REST API (/api/v1/...) as the Advisor. Returns {status, body}; status >= 400 is returned as an error with the server's body (a 403 advisor_action_required lists alternative_actions). Only the local Owl server can be reached.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["method", "api_path"],
      properties: {
        method: { type: "string", enum: METHODS },
        api_path: { type: "string", minLength: 1, maxLength: 2000, description: "Path starting with /api/v1/, query allowed. Not a URL." },
        json_body: { type: "object", description: "Optional JSON body. A command body with `payload` gets request_id / idempotency_key filled in when missing." },
      },
    },
  },
];

type Json = Record<string, unknown>;
class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

// shared の errorCode は error.code を文字列で返し、無ければ undefined。ここは cause.code を先に見て、無ければ空文字を返すので別に持つ。
function errorCode(error: unknown): string {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code ?? "";
}

// The token is only sent to a loopback origin, so a misconfigured base can never leak it elsewhere.
function loopbackBase(base: string): URL | null {
  try {
    const url = new URL(base);
    const host = url.hostname;
    const loopback = host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
    return loopback && (url.protocol === "http:" || url.protocol === "https:") ? url : null;
  } catch {
    return null;
  }
}

async function request(args: Json): Promise<{ status: number; body: unknown }> {
  const guard = guardConfig({ roleVar: "OWL_ROLE", role: "advisor" });
  if (!guard) {
    throw new ToolError("owl_api_unavailable", "Advisor の OWL_ROLE / OWL_GUARD_API_BASE / OWL_GUARD_TOKEN_FILE が設定されていません。");
  }
  const baseUrl = loopbackBase(guard.base);
  if (!baseUrl) throw new ToolError("owl_api_unavailable", "OWL_GUARD_API_BASE がループバックではありません。");

  const method = args.method;
  if (typeof method !== "string" || !METHODS.includes(method)) throw new ToolError("owl_api_invalid_method", `method must be one of ${METHODS.join(", ")}`);
  const checked = validateOwnApiPath(args.api_path as string, { allowQuery: true });
  if (!checked.ok) throw new ToolError("owl_api_invalid_path", checked.reason);
  const jsonBody = args.json_body;
  if (jsonBody !== undefined && (typeof jsonBody !== "object" || jsonBody === null || Array.isArray(jsonBody))) {
    throw new ToolError("owl_api_invalid_body", "json_body must be a JSON object");
  }
  let body: string | undefined;
  if (jsonBody !== undefined) {
    const value = { ...(jsonBody as Json) };
    if ("payload" in value) {
      value.request_id ??= randomUUID();
      value.idempotency_key ??= randomUUID();
    }
    body = JSON.stringify(value);
  }
  const target = new URL(checked.pathname + checked.search, baseUrl.origin);

  for (let attempt = 0; ; attempt += 1) {
    try {
      const { response, token } = await guardRequest(guard, target, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body,
        redirect: "error",
        authorizeEmptyToken: true,
        timeoutMs: Number(process.env.OWL_GUARD_API_TIMEOUT_MS) || OWL_API_MCP_TIMEOUT_MS,
      });
      // Strip the token from the raw text so neither the JSON nor the string path can echo it back.
      const text = token ? (await response.text()).split(token).join("[redacted]") : await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = redactProviderOutput(text).slice(0, OWL_API_MCP_MAX_RESPONSE_CHARS); }
      // JSON escapes (a) only turn back into the token after parsing, so strip again on the parsed values.
      const scrub = (v: unknown): unknown => typeof v === "string" ? (token ? v.split(token).join("[redacted]") : v)
        : Array.isArray(v) ? v.map(scrub)
        : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k) as string, scrub(x)])) : v;
      return { status: response.status, body: scrub(parsed) };
    } catch (error) {
      // Only a refused connection proves the request never arrived; anything else may have been applied.
      if (errorCode(error) === "ECONNREFUSED") {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw new ToolError("owl_api_unavailable", "Owl サーバーに接続できません。");
      }
      throw new ToolError("owl_api_result_unknown", "要求の結果が不明です（時間切れ・切断・リダイレクト）。再送せず、GET で状態を確かめてください。");
    }
  }
}

async function callTool(name: string, args: Json): Promise<Json> {
  try {
    if (name !== "request") throw new ToolError("unknown_tool", `Unknown tool: ${name}`);
    const result = await request(args);
    return { content: [{ type: "text", text: JSON.stringify(result) }], ...(result.status >= 400 ? { isError: true } : {}) };
  } catch (error) {
    const e = error instanceof ToolError ? error : new ToolError("owl_api_unavailable", "owl-api で予期しないエラーが起きました。");
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: e.code, message: e.message } }) }], isError: true };
  }
}

serveMcp({ name: "owl-api", version: "1.0.0", tools: () => TOOLS, callTool: (_id, name, args) => callTool(name, args) });
