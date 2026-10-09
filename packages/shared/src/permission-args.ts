import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { compareClaudeEntries } from "./semver.js";
import { buildOwlApiMcpArgs } from "./owl-api-mcp-args.js";

export type AgentPermissionAdapter = "claude" | "codex";
export type AgentPermissionRole = "advisor" | "manager" | "designer" | "worker" | "reviewer" | "curator" | "librarian";

export interface AgentGuardConfiguration {
  readonly owlRoot: string;
  readonly role: AgentPermissionRole;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Adds the relay hook (PostToolUse handoff notice and PreCompact block); only relay-watched Claude children get it. */
  readonly tokenRelay?: boolean;
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
const SUBAGENT_HOOK_TIMEOUT_SECONDS = 5;
const RELAY_HOOK_TIMEOUT_SECONDS = 5;

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
    const configDir = configuration.env?.CLAUDE_CONFIG_DIR || join(configuration.env?.HOME || homedir(), ".claude");
    const researchHookPath = resolve(configuration.owlRoot, "apps/server/dist/research-hook.js");
    const researchHookExists = RESEARCH_CAPTURE_ROLES.has(configuration.role)
      && existsSync(researchHookPath)
      && statSync(researchHookPath).isFile();
    const subagentHookPath = resolve(configuration.owlRoot, "apps/server/dist/subagent-hook.js");
    const subagentHooks = configuration.role === "worker" && existsSync(subagentHookPath) && statSync(subagentHookPath).isFile()
      ? [{
        hooks: [{
          type: "command",
          command: `${quoteShell(process.execPath)} ${quoteShell(subagentHookPath)}`,
          timeout: SUBAGENT_HOOK_TIMEOUT_SECONDS,
        }],
      }]
      : null;
    let relayCommand: string | null = null;
    if (configuration.tokenRelay) {
      const relayHookPath = resolve(configuration.owlRoot, "apps/server/dist/relay-hook.js");
      if (!existsSync(relayHookPath) || !statSync(relayHookPath).isFile()) {
        throw new Error(`Owl relay hook is missing at ${relayHookPath}; build Owl before starting an agent.`);
      }
      relayCommand = `${quoteShell(process.execPath)} ${quoteShell(relayHookPath)}`;
    }
    const postToolUse = [
      ...(researchHookExists ? [{
        matcher: RESEARCH_TOOLS_MATCHER,
        hooks: [{
          type: "command",
          command: `${quoteShell(process.execPath)} ${quoteShell(researchHookPath)}`,
          timeout: RESEARCH_HOOK_TIMEOUT_SECONDS,
        }],
      }] : []),
      ...(relayCommand ? [{ matcher: ALL_TOOLS_MATCHER, hooks: [{ type: "command", command: relayCommand, timeout: RELAY_HOOK_TIMEOUT_SECONDS }] }] : []),
    ];
    return [
      "--settings",
      JSON.stringify({
        claudeMdExcludes: [resolve(configDir, "CLAUDE.md")],
        autoMemoryEnabled: false,
        hooks: {
          PreToolUse: [{
            matcher: ALL_TOOLS_MATCHER,
            hooks: [{ type: "command", command }],
          }],
          ...(postToolUse.length > 0 ? { PostToolUse: postToolUse } : {}),
          // No matcher: blocks both manual and automatic compaction.
          ...(relayCommand ? { PreCompact: [{ hooks: [{ type: "command", command: relayCommand }] }] } : {}),
          ...(subagentHooks ? { SubagentStart: subagentHooks, SubagentStop: subagentHooks } : {}),
        },
      }),
    ];
  }
  const hooks = `hooks.PreToolUse=[{matcher=${tomlString(ALL_TOOLS_MATCHER)},hooks=[{type="command",command=${tomlString(command)}}]}]`;
  return ["--config", "features.hooks=true", "--config", "features.memories=false", "--config", hooks];
}

/** Environment the owl-memory MCP server needs to identify the agent and reach Owl's HTTP API. */
const MEMORY_MCP_ENV_NAMES = [
  "OWL_AGENT_RUN_ID",
  "OWL_WORK_ID",
  "OWL_TASK_ID",
  "OWL_PROJECT_ID",
  "OWL_API_BASE",
  "OWL_GUARD_API_BASE",
  "OWL_GUARD_TOKEN_FILE",
] as const;

/**
 * CLI arguments that register the read-only owl-memory MCP server. Claude gets
 * a temporary --mcp-config (never --strict-mcp-config, so user-scope MCP servers
 * stay available); Codex gets --config overrides. Empty when the server is not built.
 * OWL_ROLE is always set. The ids come from the launch path's env and are left out when the
 * role has none: an Advisor has no Work yet, a Curator no Task, and a Work may have no Project.
 */
function buildMemoryMcpArgs(adapter: AgentPermissionAdapter, configuration: AgentGuardConfiguration): string[] {
  const serverPath = resolve(configuration.owlRoot, "apps/server/dist/memory-mcp.js");
  if (!existsSync(serverPath) || !statSync(serverPath).isFile()) return [];
  const env: Record<string, string> = { OWL_ROLE: configuration.role };
  for (const name of MEMORY_MCP_ENV_NAMES) {
    const value = configuration.env?.[name];
    if (value) env[name] = value;
  }
  if (adapter === "claude") {
    const content = JSON.stringify({ mcpServers: { "owl-memory": { command: process.execPath, args: [serverPath], env } } });
    const configPath = join(tmpdir(), `owl-memory-mcp-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.json`);
    writeFileSync(configPath, content, { mode: 0o600 });
    return ["--mcp-config", configPath];
  }
  const envTable = `{${Object.entries(env).map(([name, value]) => `${name}=${tomlString(value)}`).join(",")}}`;
  return [
    "--config", `mcp_servers.owl-memory.command=${tomlString(process.execPath)}`,
    "--config", `mcp_servers.owl-memory.args=[${tomlString(serverPath)}]`,
    "--config", `mcp_servers.owl-memory.env=${envTable}`,
  ];
}

/** Complete CLI permission configuration; the hooks remain the sole policy gate. */
export function buildAgentPermissionArgs(
  role: AgentPermissionRole,
  adapter: AgentPermissionAdapter,
  configuration: { readonly owlRoot: string; readonly resume?: boolean; readonly cwd?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly tokenRelay?: boolean },
): string[] {
  const guardConfiguration: AgentGuardConfiguration = { owlRoot: configuration.owlRoot, role, env: configuration.env, tokenRelay: configuration.tokenRelay };
  if (adapter === "claude") {
    return [
      "--permission-mode", "bypassPermissions",
      ...buildPreToolUseHookArgs(adapter, guardConfiguration),
      ...(role === "librarian" ? ["--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task"] : []),
      ...buildMemoryMcpArgs(adapter, guardConfiguration),
      ...buildOwlApiMcpArgs(adapter, guardConfiguration),
      ...superpowersWithoutHooksArgs(configuration.env, configuration.cwd),
    ];
  }
  return [
    "--dangerously-bypass-hook-trust",
    ...(configuration.resume
      ? ["--config", `sandbox_mode=${tomlString("danger-full-access")}`]
      : ["--sandbox", "danger-full-access"]),
    "--config",
    `approval_policy=${tomlString("never")}`,
    ...buildPreToolUseHookArgs(adapter, guardConfiguration),
    ...buildMemoryMcpArgs(adapter, guardConfiguration),
    ...buildOwlApiMcpArgs(adapter, guardConfiguration),
    "--config",
    `marketplaces.openai-bundled.source=${tomlString(codexBundledMarketplaceSource(configuration.env))}`,
  ];
}

/** Only a missing file is expected; every other read or parse error propagates. */
function readJsonIfPresent(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Load superpowers from an Owl-owned plugin directory that carries its skills but no hooks, so its
 * SessionStart injection (duplicating Owl's process skills) never runs. A `--plugin-dir` plugin
 * replaces the installed plugin of the same name; other plugins and `~/.claude` are untouched.
 */
function superpowersWithoutHooksArgs(env?: Readonly<Record<string, string | undefined>>, cwd?: string): string[] {
  const configDir = env?.CLAUDE_CONFIG_DIR || join(env?.HOME || homedir(), ".claude");
  try {
    // Not installed (or no registry yet) is a normal setup: launch without the isolation view.
    const installed = readJsonIfPresent(join(configDir, "plugins", "installed_plugins.json"));
    if (!installed) return [];
    // A missing settings.json means no plugin was disabled.
    const enabled: Record<string, unknown> = readJsonIfPresent(join(configDir, "settings.json"))?.enabledPlugins ?? {};
    // Same pick as core's process-skills-pack: any marketplace, user scope first, then highest version.
    const entries = Object.entries<unknown>(installed.plugins ?? {})
      .filter(([key]) => key.startsWith("superpowers@") && enabled[key] !== false)
      .flatMap(([, value]) => (Array.isArray(value) ? value : []))
      .filter((entry) => typeof entry?.installPath === "string" && typeof entry.version === "string"
        && existsSync(join(entry.installPath, ".claude-plugin", "plugin.json"))
        && (!entry.projectPath || !cwd || cwd === entry.projectPath || cwd.startsWith(`${entry.projectPath}/`)));
    entries.sort(compareClaudeEntries).reverse();
    const installPath: string | undefined = entries[0]?.installPath;
    if (!installPath) return [];
    const view = join(homedir(), ".owl", "superpowers-plugin-views", createHash("sha256").update(installPath).digest("hex").slice(0, 16));
    mkdirSync(join(view, ".claude-plugin"), { recursive: true });
    const manifest = join(view, ".claude-plugin", "plugin.json");
    const temporary = `${manifest}.${randomUUID()}`;
    writeFileSync(temporary, readFileSync(join(installPath, ".claude-plugin", "plugin.json")));
    renameSync(temporary, manifest);
    if (!existsSync(join(view, "skills"))) {
      try {
        symlinkSync(join(installPath, "skills"), join(view, "skills"), "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return ["--plugin-dir", view];
  } catch (error) {
    // A failure after the plugin was found would silently launch without isolation, so fail the launch instead.
    console.error("superpowers isolation setup failed", error);
    throw new Error(`superpowers isolation setup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Use a CODEX_HOME view that leaves the user's global AGENTS instructions out. */
export function agentUserInstructionEnv(
  adapter: AgentPermissionAdapter,
  env?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (adapter === "claude") return {};

  const originalHome = codexHome(env);
  const owlDirectory = join(homedir(), ".owl");
  ensureCodexOverlayDirectory(owlDirectory, false);
  const overlayRoot = join(owlDirectory, "codex-home-overlays");
  ensureCodexOverlayDirectory(overlayRoot, true);
  const overlayName = `owl-codex-home-${createHash("sha256").update(originalHome).digest("hex").slice(0, 12)}`;

  let entries: Dirent[];
  try {
    entries = readdirSync(originalHome, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  const sourceNames = new Set(entries.map((entry) => entry.name));
  for (let generation = 0; ; generation += 1) {
    const overlayHome = join(overlayRoot, generation === 0 ? overlayName : `${overlayName}-${generation}`);
    ensureCodexOverlayDirectory(overlayHome, true);
    if (!removeExcludedCodexLinks(overlayHome)) continue;

    for (const entry of entries) {
      if (isExcludedCodexEntry(entry.name)) continue;
      const source = join(originalHome, entry.name);
      let linkType: "dir" | "file" = entry.isDirectory() ? "dir" : "file";
      try {
        if (statSync(source).isDirectory()) linkType = "dir";
      } catch (error) {
        // Keep dangling source symlinks available through the overlay.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      syncCodexOverlayEntry(source, join(overlayHome, entry.name), overlayHome, linkType);
    }
    for (const entry of readdirSync(overlayHome, { withFileTypes: true })) {
      if (entry.isSymbolicLink() && !isExcludedCodexEntry(entry.name) && !sourceNames.has(entry.name)) {
        unlinkCodexSourceLink(join(overlayHome, entry.name), join(originalHome, entry.name), overlayHome);
      }
    }
    if (removeExcludedCodexLinks(overlayHome)) return { CODEX_HOME: overlayHome };
  }
}

const EXCLUDED_CODEX_ENTRIES = ["AGENTS.md", "AGENTS.override.md", "memories"];

function isExcludedCodexEntry(name: string): boolean {
  return EXCLUDED_CODEX_ENTRIES.includes(name);
}

function ensureCodexOverlayDirectory(directory: string, privateDirectory: boolean): void {
  let created = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (created) chmodSync(directory, 0o700);

  const info = lstatSync(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const permissionMask = privateDirectory ? 0o077 : 0o022;
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & permissionMask) !== 0) {
    throw new Error(`Unsafe Codex overlay directory at ${directory}: expected an owned real directory with protected permissions.`);
  }
}

/** Remove excluded links, but leave real entries intact and use another overlay generation. */
function removeExcludedCodexLinks(overlayHome: string): boolean {
  let canUse = true;
  for (const name of EXCLUDED_CODEX_ENTRIES) {
    const entryPath = join(overlayHome, name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(entryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      try {
        unlinkSync(entryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else canUse = false;
  }
  return canUse;
}

function syncCodexOverlayEntry(source: string, overlayPath: string, overlayHome: string, linkType: "dir" | "file"): void {
  let existing: ReturnType<typeof lstatSync>;
  try {
    existing = lstatSync(overlayPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      symlinkSync(source, overlayPath, linkType);
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
    }
    return;
  }
  if (!existing.isSymbolicLink()) return;
  let existingSource: string | undefined;
  try {
    existingSource = resolve(overlayHome, readlinkSync(overlayPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      symlinkSync(source, overlayPath, linkType);
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
    }
    return;
  }
  if (existingSource === source) return;

  const temporaryPath = join(overlayHome, `.owl-link-${randomUUID()}`);
  let temporaryLinkCreated = false;
  try {
    symlinkSync(source, temporaryPath, linkType);
    temporaryLinkCreated = true;
    try {
      const current = lstatSync(overlayPath);
      if (!current.isSymbolicLink()) return;
      if (resolve(overlayHome, readlinkSync(overlayPath)) === source) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      renameSync(temporaryPath, overlayPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (temporaryLinkCreated) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function unlinkCodexSourceLink(overlayPath: string, expectedSource: string, overlayHome: string): void {
  try {
    if (!lstatSync(overlayPath).isSymbolicLink()) return;
    if (resolve(overlayHome, readlinkSync(overlayPath)) !== expectedSource) return;
    unlinkSync(overlayPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function codexHome(env?: Readonly<Record<string, string | undefined>>): string {
  return resolve(env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex"));
}

function codexBundledMarketplaceSource(env?: Readonly<Record<string, string | undefined>>): string {
  const originalHome = codexHome(env);
  try {
    const lines = readFileSync(join(originalHome, "config.toml"), "utf8").split(/\r?\n/u);
    let inMarketplaceTable = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        inMarketplaceTable = trimmed === "[marketplaces.openai-bundled]";
      } else if (inMarketplaceTable) {
        const match = /^source\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/u.exec(trimmed);
        if (match) {
          const source = JSON.parse(match[1]) as string;
          if (source) return isAbsolute(source) ? source : resolve(originalHome, source);
        }
      }
    }
  } catch {
    // Fall back to Codex's standard bundled marketplace location.
  }
  return join(originalHome, ".tmp", "bundled-marketplaces", "openai-bundled");
}

function quoteShell(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}
