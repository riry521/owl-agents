import { DISPATCH_MCP_SERVER_NAME, mcpArgsFor, type OwlMcpConfiguration } from "./owl-mcp-servers.js";

export { DISPATCH_MCP_ENABLE_ENV, DISPATCH_MCP_SERVER_NAME, DISPATCH_MCP_TOOL_TIMEOUT_MS, DISPATCH_MCP_ENV_NAMES } from "./owl-mcp-servers.js";

/** Worker parent processes only; return no args unless every registration condition is met. */
export function buildDispatchMcpArgs(adapter: "claude" | "codex", configuration: OwlMcpConfiguration): string[] {
  return mcpArgsFor(DISPATCH_MCP_SERVER_NAME, adapter, configuration);
}
