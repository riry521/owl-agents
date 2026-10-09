import { createHash } from "node:crypto";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const OWL_API_MCP_SERVER_NAME = "owl-api";
export const OWL_API_MCP_TOOL_TIMEOUT_MS = 90_000;
export const OWL_API_MCP_ENV_NAMES = ["OWL_AGENT_RUN_ID", "OWL_GUARD_API_BASE", "OWL_GUARD_TOKEN_FILE"] as const;

/** Advisor only. The env carries paths and ids, never the token value, so the config file holds no secret. */
export function buildOwlApiMcpArgs(
  adapter: "claude" | "codex",
  configuration: { readonly owlRoot: string; readonly role: string; readonly env?: Readonly<Record<string, string | undefined>> },
): string[] {
  if (configuration.role !== "advisor") return [];
  const serverPath = resolve(configuration.owlRoot, "apps/server/dist/owl-api-mcp.js");
  if (!existsSync(serverPath) || !statSync(serverPath).isFile()) return [];

  const serverEnv: Record<string, string> = { OWL_ROLE: "advisor" };
  for (const name of OWL_API_MCP_ENV_NAMES) {
    const value = configuration.env?.[name];
    if (!value) return [];
    serverEnv[name] = value;
  }

  if (adapter === "claude") {
    const content = JSON.stringify({
      mcpServers: {
        [OWL_API_MCP_SERVER_NAME]: { command: process.execPath, args: [serverPath], env: serverEnv, timeout: OWL_API_MCP_TOOL_TIMEOUT_MS },
      },
    });
    const path = join(tmpdir(), `owl-api-mcp-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.json`);
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    return ["--mcp-config", path];
  }

  const prefix = `mcp_servers.${OWL_API_MCP_SERVER_NAME}`;
  const tomlEnv = Object.entries(serverEnv).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",");
  return [
    "--config", `${prefix}.command=${JSON.stringify(process.execPath)}`,
    "--config", `${prefix}.args=[${JSON.stringify(serverPath)}]`,
    "--config", `${prefix}.env={${tomlEnv}}`,
    "--config", `${prefix}.tool_timeout_sec=${OWL_API_MCP_TOOL_TIMEOUT_MS / 1000}`,
    "--config", `${prefix}.startup_timeout_sec=20`,
  ];
}
