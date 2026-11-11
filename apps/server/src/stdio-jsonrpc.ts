import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export interface McpServerSpec {
  readonly name: string;
  readonly version: string;
  readonly tools: () => readonly unknown[];
  readonly callTool: (id: unknown, name: string, args: Json) => Promise<Json>;
}

/** Serves a line-delimited JSON-RPC MCP server on stdin/stdout; each server passes only its tool definitions. */
export function serveMcp(spec: McpServerSpec): void {
  const send = (message: Json): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const handle = async (line: string): Promise<void> => {
    let request: { id?: unknown; method?: string; params?: Json };
    if (line.trim() === "") return;
    try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
    // A line such as `null` parses but cannot be destructured; an unhandled rejection would end the server.
    if (typeof request !== "object" || request === null) return;
    const { id, method, params } = request;
    if (id === undefined) return; // notifications
    if (method === "initialize") {
      send({ id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: spec.name, version: spec.version } } });
    } else if (method === "ping") {
      send({ id, result: {} });
    } else if (method === "tools/list") {
      send({ id, result: { tools: spec.tools() } });
    } else if (method === "tools/call") {
      const args = params?.arguments && typeof params.arguments === "object" ? (params.arguments as Json) : {};
      send({ id, result: await spec.callTool(id, String(params?.name ?? ""), args) });
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };
  createInterface({ input: process.stdin }).on("line", (line) => { void handle(line); });
}
