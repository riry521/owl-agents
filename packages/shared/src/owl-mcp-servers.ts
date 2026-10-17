import { createHash } from "node:crypto";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const DESIGN_MOCK_MCP_ENABLE_ENV = "OWL_DESIGN_MOCK_MCP";
export const DESIGN_MOCK_MCP_SERVER_NAME = "owl-design";
export const DESIGN_MOCK_MCP_TOOL_TIMEOUT_MS = 60_000;
export const DISPATCH_MCP_ENABLE_ENV = "OWL_DISPATCH_MCP";
export const DISPATCH_MCP_SERVER_NAME = "owl-dispatch";
export const DISPATCH_MCP_TOOL_TIMEOUT_MS = 330_000;
export const OWL_API_MCP_SERVER_NAME = "owl-api";
export const OWL_API_MCP_TOOL_TIMEOUT_MS = 90_000;
export const MEMORY_MCP_SERVER_NAME = "owl-memory";
/** Env a guarded MCP server needs to reach Owl's guard API; the token itself stays in a file. */
export const GUARDED_MCP_ENV_NAMES = ["OWL_AGENT_RUN_ID", "OWL_GUARD_API_BASE", "OWL_GUARD_TOKEN_FILE"] as const;
export const DESIGN_MOCK_MCP_ENV_NAMES = GUARDED_MCP_ENV_NAMES;
export const OWL_API_MCP_ENV_NAMES = GUARDED_MCP_ENV_NAMES;
export const DISPATCH_MCP_ENV_NAMES = GUARDED_MCP_ENV_NAMES;
/** Env the owl-memory MCP server needs to identify the agent and reach Owl's HTTP API. */
const MEMORY_MCP_ENV_NAMES = [
  "OWL_AGENT_RUN_ID",
  "OWL_WORK_ID",
  "OWL_TASK_ID",
  "OWL_PROJECT_ID",
  "OWL_API_BASE",
  "OWL_GUARD_API_BASE",
  "OWL_GUARD_TOKEN_FILE",
] as const;
const STARTUP_TIMEOUT_MS = 20_000;

export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly toolTimeoutMs?: number;
  readonly startupTimeoutMs: number;
  /** Set only where Codex gets an explicit startup_timeout_sec; owl-memory keeps Codex's default so its argv stays unchanged. */
  readonly codexStartupTimeoutMs?: number;
  /** Claude config file name stem under the temp dir. */
  readonly configFilePrefix: string;
}

export interface OwlMcpConfiguration {
  readonly owlRoot: string;
  readonly role: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function serverScript(owlRoot: string, file: string): string | null {
  const path = resolve(owlRoot, "apps/server/dist", file);
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

/** Guarded servers are skipped unless every guard env value is present. */
function guardedServer(
  configuration: OwlMcpConfiguration,
  spec: { name: string; script: string; role: string; toolTimeoutMs: number; configFilePrefix: string },
): McpServerSpec | null {
  const serverPath = serverScript(configuration.owlRoot, spec.script);
  if (!serverPath) return null;
  const env: Record<string, string> = { OWL_ROLE: spec.role };
  for (const name of GUARDED_MCP_ENV_NAMES) {
    const value = configuration.env?.[name];
    if (!value) return null;
    env[name] = value;
  }
  return {
    name: spec.name,
    command: process.execPath,
    args: [serverPath],
    env,
    toolTimeoutMs: spec.toolTimeoutMs,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    codexStartupTimeoutMs: STARTUP_TIMEOUT_MS,
    configFilePrefix: spec.configFilePrefix,
  };
}

/**
 * Every Owl MCP server the role gets, in registration order, independent of the harness.
 * owl-memory: all roles. owl-api: advisor. owl-dispatch: worker with OWL_DISPATCH_MCP=1.
 * owl-design: designer with OWL_DESIGN_MOCK_MCP=1. Servers whose script is not built are left out.
 */
export function owlMcpServers(configuration: OwlMcpConfiguration): McpServerSpec[] {
  const servers: McpServerSpec[] = [];
  const memoryPath = serverScript(configuration.owlRoot, "memory-mcp.js");
  if (memoryPath) {
    // Ids are left out when the role has none: an Advisor has no Work yet, a Curator no Task.
    const env: Record<string, string> = { OWL_ROLE: configuration.role };
    for (const name of MEMORY_MCP_ENV_NAMES) {
      const value = configuration.env?.[name];
      if (value) env[name] = value;
    }
    servers.push({ name: MEMORY_MCP_SERVER_NAME, command: process.execPath, args: [memoryPath], env, startupTimeoutMs: STARTUP_TIMEOUT_MS, configFilePrefix: "owl-memory-mcp" });
  }
  const candidates = [
    configuration.role === "advisor"
      ? guardedServer(configuration, { name: OWL_API_MCP_SERVER_NAME, script: "owl-api-mcp.js", role: "advisor", toolTimeoutMs: OWL_API_MCP_TOOL_TIMEOUT_MS, configFilePrefix: "owl-api-mcp" })
      : null,
    configuration.role === "worker" && configuration.env?.[DISPATCH_MCP_ENABLE_ENV] === "1"
      ? guardedServer(configuration, { name: DISPATCH_MCP_SERVER_NAME, script: "dispatch-mcp.js", role: "worker", toolTimeoutMs: DISPATCH_MCP_TOOL_TIMEOUT_MS, configFilePrefix: "owl-dispatch-mcp" })
      : null,
    configuration.role === "designer" && configuration.env?.[DESIGN_MOCK_MCP_ENABLE_ENV] === "1"
      ? guardedServer(configuration, { name: DESIGN_MOCK_MCP_SERVER_NAME, script: "design-mock-mcp.js", role: "designer", toolTimeoutMs: DESIGN_MOCK_MCP_TOOL_TIMEOUT_MS, configFilePrefix: "owl-design-mock-mcp" })
      : null,
  ];
  for (const server of candidates) if (server) servers.push(server);
  return servers;
}

/** One temporary --mcp-config per server; never --strict-mcp-config, so user-scope servers stay available. */
export function claudeMcpArgs(servers: readonly McpServerSpec[]): string[] {
  return servers.flatMap((server) => {
    const content = JSON.stringify({
      mcpServers: {
        [server.name]: {
          command: server.command,
          args: server.args,
          env: server.env,
          ...(server.toolTimeoutMs === undefined ? {} : { timeout: server.toolTimeoutMs }),
        },
      },
    });
    const path = join(tmpdir(), `${server.configFilePrefix}-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.json`);
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    return ["--mcp-config", path];
  });
}

export function codexMcpArgs(servers: readonly McpServerSpec[]): string[] {
  return servers.flatMap((server) => {
    const prefix = `mcp_servers.${server.name}`;
    const env = Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",");
    return [
      "--config", `${prefix}.command=${JSON.stringify(server.command)}`,
      "--config", `${prefix}.args=[${server.args.map((arg) => JSON.stringify(arg)).join(",")}]`,
      "--config", `${prefix}.env={${env}}`,
      ...(server.toolTimeoutMs === undefined ? [] : ["--config", `${prefix}.tool_timeout_sec=${server.toolTimeoutMs / 1000}`]),
      ...(server.codexStartupTimeoutMs === undefined ? [] : ["--config", `${prefix}.startup_timeout_sec=${server.codexStartupTimeoutMs / 1000}`]),
    ];
  });
}

/** opencode v2 `mcp` config block. codemode stays off so the tools reach the model directly; `execution` is set only where the server has a tool timeout. */
export function opencodeMcpConfig(servers: readonly McpServerSpec[]): {
  servers: Record<string, {
    type: "local";
    command: string[];
    environment: Record<string, string>;
    codemode: false;
    timeout: { startup: number; catalog: number; execution?: number };
  }>;
} {
  return {
    servers: Object.fromEntries(servers.map((server) => [server.name, {
      type: "local" as const,
      command: [server.command, ...server.args],
      environment: { ...server.env },
      codemode: false as const,
      timeout: {
        startup: server.startupTimeoutMs,
        catalog: server.startupTimeoutMs,
        ...(server.toolTimeoutMs === undefined ? {} : { execution: server.toolTimeoutMs }),
      },
    }])),
  };
}

/** Args for one named server only, for call sites that place each server separately. */
export function mcpArgsFor(
  name: string,
  adapter: "claude" | "codex",
  configuration: OwlMcpConfiguration,
): string[] {
  const servers = owlMcpServers(configuration).filter((server) => server.name === name);
  return adapter === "claude" ? claudeMcpArgs(servers) : codexMcpArgs(servers);
}
