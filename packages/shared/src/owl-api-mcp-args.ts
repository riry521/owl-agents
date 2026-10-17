import { OWL_API_MCP_SERVER_NAME, mcpArgsFor, type OwlMcpConfiguration } from "./owl-mcp-servers.js";

export { OWL_API_MCP_SERVER_NAME, OWL_API_MCP_TOOL_TIMEOUT_MS, OWL_API_MCP_ENV_NAMES } from "./owl-mcp-servers.js";

/** Advisor only. The env carries paths and ids, never the token value, so the config file holds no secret. */
export function buildOwlApiMcpArgs(adapter: "claude" | "codex", configuration: OwlMcpConfiguration): string[] {
  return mcpArgsFor(OWL_API_MCP_SERVER_NAME, adapter, configuration);
}
