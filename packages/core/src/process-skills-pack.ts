import * as nodeFs from "node:fs";
import { basename, join } from "node:path";
import { compareClaudeEntries, compareSemver, parseSemver, type ClaudePluginEntry, type ProcessSkillsSettings } from "@owl/shared";

export interface DetectedProcessSkillsPack {
  readonly skills_dir: string;
  readonly version: string | null;
  readonly source: "setting" | "claude" | "codex";
}

interface DirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface FileStat {
  readonly mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ProcessSkillsFileSystem {
  readdirSync(path: string, options: { withFileTypes: true }): DirectoryEntry[];
  statSync(path: string): FileStat;
  readFileSync(path: string, encoding: "utf8"): string;
  realpathSync(path: string): string;
}

export interface DetectProcessSkillsPackInput {
  readonly env: NodeJS.ProcessEnv;
  readonly settings: ProcessSkillsSettings;
  readonly homedir: string;
  readonly fs?: ProcessSkillsFileSystem;
}

const REQUIRED_SKILLS = [
  "brainstorming",
  "test-driven-development",
  "verification-before-completion",
] as const;

interface Candidate {
  readonly skills_dir: string;
  readonly version: string;
  readonly modified_at: number;
}

function statOrNull(fs: ProcessSkillsFileSystem, path: string): FileStat | null {
  try {
    return fs.statSync(path);
  } catch {
    return null;
  }
}

function isDirectory(fs: ProcessSkillsFileSystem, path: string): boolean {
  return statOrNull(fs, path)?.isDirectory() === true;
}

function isValidSkillsDir(fs: ProcessSkillsFileSystem, skillsDir: string): boolean {
  if (!isDirectory(fs, skillsDir)) return false;
  return REQUIRED_SKILLS.every((name) => statOrNull(fs, join(skillsDir, name, "SKILL.md"))?.isFile() === true);
}

function configuredSkillsDir(fs: ProcessSkillsFileSystem, configuredPath: string): string | null {
  const nestedSkills = join(configuredPath, "skills");
  if (isValidSkillsDir(fs, nestedSkills)) return nestedSkills;
  return isValidSkillsDir(fs, configuredPath) ? configuredPath : null;
}

function readDirEntries(fs: ProcessSkillsFileSystem, path: string): DirectoryEntry[] {
  try {
    return fs.readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJsonFile(fs: ProcessSkillsFileSystem, path: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const leftVersion = parseSemver(left.version);
  const rightVersion = parseSemver(right.version);
  if (leftVersion && rightVersion) {
    const byVersion = compareSemver(leftVersion, rightVersion);
    if (byVersion !== 0) return byVersion;
  } else if (leftVersion || rightVersion) {
    return leftVersion ? 1 : -1;
  }
  return left.modified_at - right.modified_at;
}

// --- Claude: <configDir>/plugins/installed_plugins.json + settings.json ---

/** `superpowers@<any marketplace>` entries from installed_plugins.json, honoring settings.json's enabledPlugins. */
function claudeSuperpowersEntries(fs: ProcessSkillsFileSystem, configDir: string): ClaudePluginEntry[] {
  const installed = readJsonFile(fs, join(configDir, "plugins", "installed_plugins.json"));
  if (!isRecord(installed) || !isRecord(installed.plugins)) return [];
  const settings = readJsonFile(fs, join(configDir, "settings.json"));
  const enabledPlugins = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};

  const entries: ClaudePluginEntry[] = [];
  for (const [key, value] of Object.entries(installed.plugins)) {
    if (!/^superpowers@/u.test(key)) continue;
    if (enabledPlugins[key] === false) continue; // explicit false disables; a missing key is enabled by default
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const installPath = typeof entry.installPath === "string" ? entry.installPath : null;
      const version = typeof entry.version === "string" ? entry.version : null;
      if (!installPath || !version) continue;
      entries.push({ scope: typeof entry.scope === "string" ? entry.scope : "", installPath, version });
    }
  }
  return entries;
}

/** The highest-ranked entry whose skills directory holds a complete pack. */
function detectClaudePack(fs: ProcessSkillsFileSystem, configDir: string): DetectedProcessSkillsPack | null {
  const ranked = claudeSuperpowersEntries(fs, configDir).sort(compareClaudeEntries).reverse();
  for (const entry of ranked) {
    const skillsDir = join(entry.installPath, "skills");
    if (isValidSkillsDir(fs, skillsDir)) return { skills_dir: skillsDir, version: entry.version, source: "claude" };
  }
  return null;
}

// --- Codex: <home>/config.toml + <home>/plugins/cache/<marketplace>/superpowers/{.codex-remote-plugin-install.json,<version>} ---

const CODEX_REMOTE_INSTALL_MARKER = ".codex-remote-plugin-install.json";

/**
 * Reads table headers `[plugins."name@marketplace"]` and `enabled = true|false`
 * inside them; nothing else in the TOML file is read. Any other line starting
 * with `[` (a table or array-of-tables header) ends the current plugin table.
 * Comments and surrounding whitespace are allowed. Each plugin name maps to its
 * `enabled` value, or null when the table does not set it.
 */
function pluginEnabledStates(content: string): Map<string, boolean | null> {
  const headerPattern = /^\s*\[plugins\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*(?:#.*)?$/u;
  const enabledPattern = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/u;
  const states = new Map<string, boolean | null>();
  let current: { name: string; enabled: boolean | null } | null = null;
  const flush = (): void => {
    if (current) states.set(current.name, current.enabled);
    current = null;
  };
  for (const line of content.split(/\r?\n/u)) {
    const header = headerPattern.exec(line);
    if (header) {
      flush();
      current = { name: (header[1] ?? header[2] ?? "").replace(/\\"/gu, "\""), enabled: null };
      continue;
    }
    if (line.trimStart().startsWith("[")) {
      flush();
      continue;
    }
    if (current) {
      const enabledMatch = enabledPattern.exec(line);
      if (enabledMatch) current.enabled = enabledMatch[1] === "true";
    }
  }
  flush();
  return states;
}

/**
 * Marketplaces whose superpowers plugin Codex records as installed and enabled.
 * config.toml records a plugin with a `[plugins."superpowers@<marketplace>"]`
 * table, which counts only with `enabled = true`. A plugin installed from a
 * remote marketplace has no config.toml table; its record is the
 * `.codex-remote-plugin-install.json` file in its cache directory, which counts
 * unless config.toml sets `enabled = false` for that plugin.
 */
function enabledCodexMarketplaces(fs: ProcessSkillsFileSystem, codexHome: string): string[] {
  let states = new Map<string, boolean | null>();
  try {
    states = pluginEnabledStates(fs.readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
    // Without config.toml only remote install markers remain.
  }
  const marketplaces = new Set<string>();
  for (const [name, enabled] of states) {
    const marketplace = /^superpowers@(.+)$/u.exec(name)?.[1];
    if (marketplace !== undefined && enabled === true) marketplaces.add(marketplace);
  }
  const cacheDir = join(codexHome, "plugins", "cache");
  for (const entry of readDirEntries(fs, cacheDir)) {
    const marker = join(cacheDir, entry.name, "superpowers", CODEX_REMOTE_INSTALL_MARKER);
    if (statOrNull(fs, marker)?.isFile() !== true) continue;
    if (states.get(`superpowers@${entry.name}`) === false) continue;
    marketplaces.add(entry.name);
  }
  return [...marketplaces];
}

/**
 * Version directories of one Codex pack in preference order: a `latest` link
 * first (its skills path stays under `latest`, its version is the link
 * target's name), then the others by highest semver, then newest mtime.
 * Dot-named directories are skipped.
 */
function rankedCodexVersions(fs: ProcessSkillsFileSystem, packDir: string): Candidate[] {
  const entries = readDirEntries(fs, packDir);
  const ranked: Candidate[] = [];
  if (entries.some((entry) => entry.name === "latest")) {
    try {
      const target = fs.realpathSync(join(packDir, "latest"));
      ranked.push({
        skills_dir: join(packDir, "latest", "skills"),
        version: basename(target),
        modified_at: statOrNull(fs, target)?.mtimeMs ?? 0,
      });
    } catch {
      // A broken `latest` link leaves only the version directories.
    }
  }
  const versionDirs = entries.filter((entry) => entry.name !== "latest" && !entry.name.startsWith(".") &&
    (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(fs, join(packDir, entry.name)))));
  const others = versionDirs.map((entry) => ({
    skills_dir: join(packDir, entry.name, "skills"),
    version: entry.name,
    modified_at: statOrNull(fs, join(packDir, entry.name))?.mtimeMs ?? 0,
  }));
  return [...ranked, ...others.sort(compareCandidates).reverse()];
}

function detectCodexPack(fs: ProcessSkillsFileSystem, codexHome: string): DetectedProcessSkillsPack | null {
  const marketplaces = enabledCodexMarketplaces(fs, codexHome);
  if (marketplaces.length === 0) return null;

  const candidates: Candidate[] = [];
  for (const marketplace of marketplaces) {
    const packDir = join(codexHome, "plugins", "cache", marketplace, "superpowers");
    const valid = rankedCodexVersions(fs, packDir).find((candidate) => isValidSkillsDir(fs, candidate.skills_dir));
    if (valid) candidates.push(valid);
  }
  const best = candidates.sort(compareCandidates).at(-1);
  return best ? { skills_dir: best.skills_dir, version: best.version, source: "codex" } : null;
}

/**
 * Locates an installed process skills pack without reading its skill files.
 * A pack counts as installed only when its harness has an installed and
 * enabled record of the plugin; cache directories without such a record are
 * ignored. Malformed or missing JSON/TOML counts as not installed, and this
 * never throws.
 */
export function detectProcessSkillsPack(input: DetectProcessSkillsPackInput): DetectedProcessSkillsPack | null {
  if (!input.settings.enabled) return null;
  const fs = input.fs ?? nodeFs;
  if (input.settings.path !== null) {
    const skillsDir = configuredSkillsDir(fs, input.settings.path);
    return skillsDir ? { skills_dir: skillsDir, version: null, source: "setting" } : null;
  }

  const claudeConfigDir = input.env.CLAUDE_CONFIG_DIR || join(input.homedir, ".claude");
  const claude = detectClaudePack(fs, claudeConfigDir);
  if (claude) return claude;

  const codexHome = input.env.CODEX_HOME || join(input.homedir, ".codex");
  const codex = detectCodexPack(fs, codexHome);
  if (codex) return codex;

  return null;
}
