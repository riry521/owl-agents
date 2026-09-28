import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type AgentPermissionAdapter = "claude" | "codex";
export type AgentPermissionRole = "advisor" | "manager" | "designer" | "worker" | "reviewer" | "curator";

export interface AgentGuardConfiguration {
  readonly owlRoot: string;
  readonly role: AgentPermissionRole;
}

/** Work roles whose Claude sessions may save WebFetch and WebSearch results. */
export const RESEARCH_CAPTURE_ROLES: ReadonlySet<AgentPermissionRole> = new Set([
  "manager",
  "designer",
  "worker",
  "reviewer",
]);

/** Both CLIs read `*` as every tool, MCP and web tools included. */
const ALL_TOOLS_MATCHER = "*";
const RESEARCH_TOOLS_MATCHER = "WebFetch|WebSearch";
const RESEARCH_HOOK_TIMEOUT_SECONDS = 10;

/**
 * CLI arguments that install Owl's synchronous PreToolUse guard hook for
 * every tool. The hook only checks arguments against the block rules; it
 * never limits which tools or MCP servers an agent can use.
 */
export function buildPreToolUseHookArgs(
  adapter: AgentPermissionAdapter,
  configuration: AgentGuardConfiguration,
): string[] {
  const hookPath = resolve(configuration.owlRoot, "apps/server/dist/permission-hook.js");
  if (!existsSync(hookPath) || !statSync(hookPath).isFile()) {
    throw new Error(`Owl permission hook is missing at ${hookPath}; build Owl before starting an agent.`);
  }
  const command = `${quoteShell(process.execPath)} ${quoteShell(hookPath)}`;
  if (adapter === "claude") {
    const researchHookPath = resolve(configuration.owlRoot, "apps/server/dist/research-hook.js");
    const researchHookExists = RESEARCH_CAPTURE_ROLES.has(configuration.role)
      && existsSync(researchHookPath)
      && statSync(researchHookPath).isFile();
    return [
      "--settings",
      JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: ALL_TOOLS_MATCHER,
            hooks: [{ type: "command", command }],
          }],
          ...(researchHookExists ? {
            PostToolUse: [{
              matcher: RESEARCH_TOOLS_MATCHER,
              hooks: [{
                type: "command",
                command: `${quoteShell(process.execPath)} ${quoteShell(researchHookPath)}`,
                timeout: RESEARCH_HOOK_TIMEOUT_SECONDS,
              }],
            }],
          } : {}),
        },
      }),
    ];
  }
  const hooks = `hooks.PreToolUse=[{matcher=${tomlString(ALL_TOOLS_MATCHER)},hooks=[{type="command",command=${tomlString(command)}}]}]`;
  return ["--config", "features.hooks=true", "--config", hooks];
}

/** Complete CLI permission configuration; the hooks remain the sole policy gate. */
export function buildAgentPermissionArgs(
  role: AgentPermissionRole,
  adapter: AgentPermissionAdapter,
  configuration: { readonly owlRoot: string; readonly resume?: boolean },
): string[] {
  const guardConfiguration: AgentGuardConfiguration = { owlRoot: configuration.owlRoot, role };
  if (adapter === "claude") {
    return ["--permission-mode", "bypassPermissions", ...buildPreToolUseHookArgs(adapter, guardConfiguration)];
  }
  return [
    "--dangerously-bypass-hook-trust",
    ...(configuration.resume
      ? ["--config", `sandbox_mode=${tomlString("danger-full-access")}`]
      : ["--sandbox", "danger-full-access"]),
    "--config",
    `approval_policy=${tomlString("never")}`,
    ...buildPreToolUseHookArgs(adapter, guardConfiguration),
  ];
}

function quoteShell(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
