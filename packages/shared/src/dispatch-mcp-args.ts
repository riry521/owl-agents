import { createHash } from "node:crypto";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const DISPATCH_MCP_ENABLE_ENV = "OWL_DISPATCH_MCP";
export const DISPATCH_MCP_SERVER_NAME = "owl-dispatch";
export const DISPATCH_MCP_TOOL_TIMEOUT_MS = 330_000;
export const DISPATCH_MCP_ENV_NAMES = ["OWL_AGENT_RUN_ID", "OWL_GUARD_API_BASE", "OWL_GUARD_TOKEN_FILE"] as const;

/** Worker parent processes only; return no args unless every registration condition is met. */
export function buildDispatchMcpArgs(
  adapter: "claude" | "codex",
  configuration: { readonly owlRoot: string; readonly role: string; readonly env?: Readonly<Record<string, string | undefined>> },
): string[] {
  const env = configuration.env;
  if (configuration.role !== "worker" || env?.[DISPATCH_MCP_ENABLE_ENV] !== "1") return [];

  const serverPath = resolve(configuration.owlRoot, "apps/server/dist/dispatch-mcp.js");
  if (!existsSync(serverPath) || !statSync(serverPath).isFile()) return [];

  const serverEnv: Record<string, string> = { OWL_ROLE: "worker" };
  for (const name of DISPATCH_MCP_ENV_NAMES) {
    const value = env[name];
    if (!value) return [];
    serverEnv[name] = value;
  }

  if (adapter === "claude") {
    const content = JSON.stringify({
      mcpServers: {
        [DISPATCH_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [serverPath],
          env: serverEnv,
          timeout: DISPATCH_MCP_TOOL_TIMEOUT_MS,
        },
      },
    });
    const path = join(tmpdir(), `owl-dispatch-mcp-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.json`);
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    return ["--mcp-config", path];
  }

  const prefix = `mcp_servers.${DISPATCH_MCP_SERVER_NAME}`;
  const tomlEnv = Object.entries(serverEnv).map(([key, value]) => `${key}=${tomlString(value)}`).join(",");
  return [
    "--config", `${prefix}.command=${tomlString(process.execPath)}`,
    "--config", `${prefix}.args=[${tomlString(serverPath)}]`,
    "--config", `${prefix}.env={${tomlEnv}}`,
    "--config", `${prefix}.tool_timeout_sec=${DISPATCH_MCP_TOOL_TIMEOUT_MS / 1000}`,
    "--config", `${prefix}.startup_timeout_sec=20`,
  ];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
