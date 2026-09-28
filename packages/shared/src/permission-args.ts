import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type AgentPermissionAdapter = "claude" | "codex";
export type AgentPermissionRole = "advisor" | "manager" | "designer" | "worker" | "reviewer" | "curator";

export interface AgentGuardConfiguration {
  readonly owlRoot: string;
  readonly role: AgentPermissionRole;
  readonly env?: Readonly<Record<string, string | undefined>>;
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
    const configDir = configuration.env?.CLAUDE_CONFIG_DIR || join(configuration.env?.HOME || homedir(), ".claude");
    const researchHookPath = resolve(configuration.owlRoot, "apps/server/dist/research-hook.js");
    const researchHookExists = RESEARCH_CAPTURE_ROLES.has(configuration.role)
      && existsSync(researchHookPath)
      && statSync(researchHookPath).isFile();
    return [
      "--settings",
      JSON.stringify({
        claudeMdExcludes: [resolve(configDir, "CLAUDE.md")],
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
  configuration: { readonly owlRoot: string; readonly resume?: boolean; readonly env?: Readonly<Record<string, string | undefined>> },
): string[] {
  const guardConfiguration: AgentGuardConfiguration = { owlRoot: configuration.owlRoot, role, env: configuration.env };
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
    "--config",
    `marketplaces.openai-bundled.source=${tomlString(codexBundledMarketplaceSource(configuration.env))}`,
  ];
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

function isExcludedCodexEntry(name: string): boolean {
  return name === "AGENTS.md" || name === "AGENTS.override.md";
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
  for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}
