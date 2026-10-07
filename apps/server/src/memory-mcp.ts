import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/**
 * owl-memory: a stdio MCP server exposing the read-only memory page API to agents.
 * The Owl server address and guard token file come from the agent environment
 * (OWL_GUARD_API_BASE, OWL_GUARD_TOKEN_FILE); nothing is stored in source.
 */

interface Tool { readonly name: string; readonly route?: string; readonly method: "GET" | "POST"; readonly description: string; readonly inputSchema: Record<string, unknown> }

/** Theme-page tools (design §3.7): descriptions total at most 350 tokens (a test counts them). */
export const PAGE_TOOLS: readonly Tool[] = [
  {
    name: "index", method: "POST",
    description: "Project の目次を読む。どのページを読むか決める前に呼ぶ。読む量には数えない。",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } } },
  },
  {
    name: "page", method: "POST",
    description: "目次のテーマページを開く。回数と量に上限がある。超えたら見出しの一覧が返るので、sections で絞って開き直す。",
    inputSchema: { type: "object", required: ["page"], properties: { page: { type: "string" }, sections: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "search", route: "pages/search", method: "POST",
    description: "切り抜き資料を探す。作業記録も探すなら include_work_log。目次に無い話だけに使う。",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, include_work_log: { type: "boolean" } } },
  },
];

const nullProto = (tools: readonly Tool[]): Record<string, Tool> => Object.assign(Object.create(null) as Record<string, Tool>, Object.fromEntries(tools.map((t) => [t.name, t])));
// Null-prototype map: agent-supplied tool names such as "toString" or "__proto__" must not resolve.
const PAGES_BY_NAME = nullProto(PAGE_TOOLS);

const CONTEXT_HEADERS: readonly (readonly [string, string])[] = [
  ["OWL_AGENT_RUN_ID", "x-owl-agent-run-id"], ["OWL_ROLE", "x-owl-role"], ["OWL_WORK_ID", "x-owl-work-id"],
  ["OWL_TASK_ID", "x-owl-task-id"], ["OWL_PROJECT_ID", "x-owl-project-id"],
];

async function request(): Promise<{ root: string; headers: Record<string, string> } | null> {
  const base = process.env.OWL_GUARD_API_BASE ?? process.env.OWL_API_BASE;
  if (!base) return null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const tokenFile = process.env.OWL_GUARD_TOKEN_FILE;
  const token = tokenFile ? (await readFile(tokenFile, "utf8")).trim() : process.env.OWL_API_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  for (const [env, header] of CONTEXT_HEADERS) if (process.env[env]) headers[header] = process.env[env]!;
  return { root: base.replace(/\/$/u, "").replace(/\/api\/v1$/u, ""), headers };
}

export async function callTool(name: unknown, args: unknown): Promise<unknown> {
  if (typeof name !== "string" || !Object.hasOwn(PAGES_BY_NAME, name)) return { error: "unknown_tool" };
  const tool = PAGES_BY_NAME[name];
  try {
    const target = await request();
    if (!target) return { error: "owl_unreachable" };
    const { root, headers } = target;
    const response = await fetch(`${root}/api/v1/memory/${tool.route ?? tool.name}`, {
      method: tool.method, headers, ...(tool.method === "POST" ? { body: JSON.stringify(typeof args === "object" && args !== null ? args : {}) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return await response.json();
  } catch (error) {
    console.error(`[owl-memory] ${name} failed`, error);
    return { error: "owl_unreachable" };
  }
}

async function handle(message: { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } }): Promise<unknown> {
  const reply = (result: unknown): unknown => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "owl-memory", version: "0.1.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: PAGE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true } })) });
    case "tools/call": {
      const result = await callTool(message.params?.name, message.params?.arguments);
      const failed = typeof result === "object" && result !== null && Object.hasOwn(result, "error");
      return reply({ content: [{ type: "text", text: JSON.stringify(result) }], ...(failed ? { isError: true } : {}) });
    }
    default:
      return message.id === undefined ? null : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let out: unknown;
    try { out = await handle(JSON.parse(line)); } catch (error) { console.error("[owl-memory] request handling failed", error); out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }; }
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}
