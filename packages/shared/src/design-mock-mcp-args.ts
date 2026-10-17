import { DESIGN_MOCK_MCP_SERVER_NAME, mcpArgsFor, type OwlMcpConfiguration } from "./owl-mcp-servers.js";

export { DESIGN_MOCK_MCP_ENABLE_ENV, DESIGN_MOCK_MCP_SERVER_NAME, DESIGN_MOCK_MCP_TOOL_TIMEOUT_MS, DESIGN_MOCK_MCP_ENV_NAMES } from "./owl-mcp-servers.js";

/** Designer runs of a screen design Task only; return no args unless every registration condition is met. */
export function buildDesignMockMcpArgs(adapter: "claude" | "codex", configuration: OwlMcpConfiguration): string[] {
  return mcpArgsFor(DESIGN_MOCK_MCP_SERVER_NAME, adapter, configuration);
}
