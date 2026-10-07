import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { GitLanes } from "./git-lane.js";
import {
  parseClaudeMcpList,
  parseCodexMcpList,
  probeHttpServer,
  probeStdioServer,
  type CodexMcpServer,
  type McpServerStatus,
  type ProbeResult,
} from "./mcp-probe.js";

/**
 * A finished (or never-started) child process. `exit_code` is null when the
 * process could not be spawned or was killed by a signal instead of exiting.
 */
export interface CommandResult {
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly error?: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeout_ms: number; readonly input?: string },
) => Promise<CommandResult>;

const OUTPUT_CAP_BYTES = 1024 * 1024;

/** Appends `chunk` to `current`, keeping only the last `cap` bytes without splitting a UTF-8 code point. */
function appendCapped(current: string, chunk: Buffer, cap: number): string {
  if (cap <= 0) return current;
  const combined = Buffer.concat([Buffer.from(current), chunk]);
  if (combined.byteLength <= cap) return combined.toString("utf8");
  let start = combined.byteLength - cap;
  while (start < combined.byteLength && (combined[start]! & 0xc0) === 0x80) start += 1;
  return combined.subarray(start).toString("utf8");
}

/**
 * Runs a command with no shell involved, capping each output stream at
 * ~1 MB. `input`, when given, is written to stdin and the pipe is closed;
 * otherwise stdin is not connected at all. On timeout the whole process
 * group is killed (SIGTERM, then SIGKILL after 2s if it is still alive).
 * Never rejects: spawn failures and signal kills both come back as a result.
 */
export const runCommand: CommandRunner = (command, args, options) => {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolveResult({ exit_code: null, stdout: "", stderr: "", timed_out: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (options.input !== undefined) {
      child.stdin?.on("error", () => { /* the process may exit before consuming its input */ });
      child.stdin?.end(options.input);
    }

    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendCapped(stdout, chunk, OUTPUT_CAP_BYTES); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendCapped(stderr, chunk, OUTPUT_CAP_BYTES); });

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already exited */ } }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2_000).unref();
    }, Math.max(1, options.timeout_ms));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ exit_code: null, stdout, stderr, timed_out: timedOut, error: error.message });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ exit_code: code, stdout, stderr, timed_out: timedOut });
    });
  });
};

function splitNul(text: string): string[] {
  return text.split("\0").filter((entry) => entry.length > 0);
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

function isInside(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface CopyWorktreeIncludesResult {
  readonly copied: string[];
  readonly skipped: Array<{ path: string; reason: string }>;
}

/**
 * Copies files a `.worktreeinclude` file (gitignore-format patterns, same
 * feature as Claude Code's own worktree includes) opts into a fresh
 * worktree. A candidate only qualifies when it is both matched by
 * `.worktreeinclude` and independently ignored by the repository's own
 * standard rules (`.gitignore`, `.git/info/exclude`, `core.excludesFile`);
 * a tracked file can never qualify, since `ls-files --others` already
 * excludes tracked paths. Never overwrites an existing destination file,
 * never follows a symlinked source, and never writes outside the worktree.
 */
export async function copyWorktreeIncludes(sourceRoot: string, worktree: string, run: CommandRunner = runCommand): Promise<CopyWorktreeIncludesResult> {
  const includeFile = resolve(sourceRoot, ".worktreeinclude");
  if (!(await pathExists(includeFile))) return { copied: [], skipped: [] };

  const listed = await run("git", ["-C", sourceRoot, "ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"], {
    cwd: sourceRoot,
    env: process.env,
    timeout_ms: 30_000,
  });
  const candidates = splitNul(listed.stdout);
  if (candidates.length === 0) return { copied: [], skipped: [] };

  // A second, independent check-ignore pass (no --exclude-from) confirms
  // each candidate is also ignored by the repository's own rules, not just
  // listed in .worktreeinclude.
  const checked = await run("git", ["-C", sourceRoot, "check-ignore", "--stdin", "-z"], {
    cwd: sourceRoot,
    env: process.env,
    timeout_ms: 30_000,
    input: `${candidates.join("\0")}\0`,
  });
  const ignoredByStandardRules = new Set(splitNul(checked.stdout));

  const copied: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const worktreeReal = await realpath(worktree).catch(() => resolve(worktree));

  for (const relPath of candidates) {
    if (!ignoredByStandardRules.has(relPath)) continue;
    const source = resolve(sourceRoot, relPath);
    const destination = resolve(worktree, relPath);

    const sourceStat = await lstat(source).catch(() => null);
    if (!sourceStat) { skipped.push({ path: relPath, reason: "source is missing" }); continue; }
    if (sourceStat.isSymbolicLink()) { skipped.push({ path: relPath, reason: "source is a symlink" }); continue; }
    if (await pathExists(destination)) { skipped.push({ path: relPath, reason: "destination already exists" }); continue; }

    const destinationDir = dirname(destination);
    await mkdir(destinationDir, { recursive: true });
    const destinationDirReal = await realpath(destinationDir).catch(() => destinationDir);
    if (!isInside(worktreeReal, destinationDirReal)) { skipped.push({ path: relPath, reason: "destination escapes the worktree" }); continue; }

    await copyFile(source, destination);
    await chmod(destination, sourceStat.mode).catch(() => { /* best effort; the copy itself already succeeded */ });
    copied.push(relPath);
  }
  return { copied, skipped };
}

/**
 * Untracked paths in a worktree, one entry per file plus one `dir/` entry
 * per untracked directory (`--directory`), excluding anything git itself
 * ignores. Used to snapshot a worktree before and after a step that might
 * create files, so new entries can be attributed to that step.
 */
export async function listUntrackedEntries(worktree: string, run: CommandRunner = runCommand): Promise<string[]> {
  const result = await run("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "--directory", "-z"], {
    cwd: worktree,
    env: process.env,
    timeout_ms: 30_000,
  });
  return splitNul(result.stdout);
}

/**
 * Ignored untracked paths in a worktree, with one `dir/` entry per wholly
 * ignored directory. Tool output such as an index cache or `node_modules` is
 * usually ignored, and still has to be attributed to the step that made it.
 */
export async function listIgnoredEntries(worktree: string, run: CommandRunner = runCommand): Promise<string[]> {
  const result = await run("git", ["-C", worktree, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
    cwd: worktree,
    env: process.env,
    timeout_ms: 30_000,
  });
  return splitNul(result.stdout);
}

/** Every path a step could have created: untracked entries plus ignored ones. */
async function listCreatableEntries(worktree: string, run: CommandRunner): Promise<string[]> {
  const [untracked, ignored] = await Promise.all([listUntrackedEntries(worktree, run), listIgnoredEntries(worktree, run)]);
  return [...untracked, ...ignored];
}

/** Entries present in `after` but not `before`, sorted for stable output. */
export function newEntries(before: readonly string[], after: readonly string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((entry) => !beforeSet.has(entry)).sort();
}

/**
 * `:(exclude)` pathspecs for a commit that should skip tool-created paths,
 * limited to paths not already tracked in HEAD (excluding a path git already
 * tracks would just make the commit silently drop real changes to it).
 * A `dir/` entry is matched without its trailing slash. Pure: the caller
 * supplies `trackedInHead` however it likes, e.g. by checking
 * `git ls-tree -r --name-only HEAD -- <path>`.
 */
export function commitExcludePathspecs(toolStatePaths: readonly string[], trackedInHead: (path: string) => boolean): string[] {
  const pathspecs: string[] = [];
  for (const entry of toolStatePaths) {
    const path = entry.replace(/\/+$/u, "");
    if (path.length === 0 || trackedInHead(path)) continue;
    pathspecs.push(`:(exclude,literal)${path}`);
  }
  return pathspecs;
}

export type Harness = "claude" | "codex";

export interface WorkspaceToolingDeps {
  readonly run?: CommandRunner;
  readonly probeStdio?: typeof probeStdioServer;
  readonly probeHttp?: typeof probeHttpServer;
  /** The same environment agents get; used for setup/refresh commands and rehearsal. */
  readonly env: () => NodeJS.ProcessEnv;
  /** Harnesses currently used by configured roles; rehearsal only exercises these. */
  readonly harnesses: () => readonly Harness[];
  readonly home: string;
  readonly now?: () => number;
}

export interface WorkspaceSetupCommands {
  readonly setup: readonly string[] | null;
  readonly refresh: readonly string[] | null;
}

export interface PrepareWorkspaceInput {
  readonly projectKey: string;
  readonly sourceRoot: string;
  readonly worktree: string;
  readonly commands: WorkspaceSetupCommands;
}

export interface ToolingProblem {
  /** null for problems not tied to one harness, such as a failed setup command. */
  readonly harness: Harness | null;
  readonly server: string | null;
  readonly kind: "failed" | "timeout" | "missing_in_worktree" | "codex_project_untrusted" | "setup_failed" | "refresh_failed" | "rehearsal_failed";
  readonly detail: string;
}

export interface RehearsalReport {
  readonly fingerprint: string;
  readonly servers: readonly McpServerStatus[];
  readonly problems: readonly ToolingProblem[];
}

export interface RefreshOutcome {
  readonly result: CommandResult;
  readonly tool_state_paths: readonly string[];
}

export interface PrepareWorkspaceOutcome {
  readonly copied: readonly string[];
  readonly skipped: ReadonlyArray<{ path: string; reason: string }>;
  /** null when there was no setup command to run. */
  readonly setup: CommandResult | null;
  /** null when this Project's fingerprint was already rehearsed in this process. */
  readonly rehearsal: RehearsalReport | null;
  /** Untracked or ignored paths that the include copy, setup and rehearsal created. */
  readonly tool_state_paths: readonly string[];
  /** A failed/timed-out setup command, reported here only when no rehearsal ran this time (otherwise it is folded into rehearsal.problems). */
  readonly setup_problem?: ToolingProblem;
}

const FINGERPRINT_FILES = [".mcp.json", join(".claude", "settings.json"), join(".claude", "settings.local.json"), join(".codex", "config.toml"), ".worktreeinclude"];

async function mtimeStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${path}:${info.mtimeMs}`;
  } catch {
    return `${path}:absent`;
  }
}

/** `[mcp_servers.<name>]` table headers in a Codex config.toml, matched with a simple line regex rather than a full TOML parse. */
function codexConfiguredServerNames(text: string): string[] {
  return [...text.matchAll(/^\[mcp_servers\.([^\]\s]+)\]/gm)].map((match) => match[1]!.replace(/^"|"$/g, ""));
}

/**
 * Orchestrates the per-Task-worktree setup Owl runs before an agent starts:
 * copying opted-in ignored files, running the Project's setup/refresh
 * commands, and rehearsing MCP server startup so a broken server (or an
 * untrusted/stale worktree config) is caught before the agent relies on it.
 */
export class WorkspaceTooling {
  private readonly deps: WorkspaceToolingDeps;
  private readonly run: CommandRunner;
  private readonly probeStdio: typeof probeStdioServer;
  private readonly probeHttp: typeof probeHttpServer;
  private readonly refreshLanes = new GitLanes();
  private readonly freshWorktrees = new Set<string>();
  private readonly rehearsedFingerprints = new Map<string, string>();
  private readonly alertSignatures = new Map<string, string | null>();

  constructor(deps: WorkspaceToolingDeps) {
    this.deps = deps;
    this.run = deps.run ?? runCommand;
    this.probeStdio = deps.probeStdio ?? probeStdioServer;
    this.probeHttp = deps.probeHttp ?? probeHttpServer;
  }

  public async prepareNewWorktree(input: PrepareWorkspaceInput): Promise<PrepareWorkspaceOutcome> {
    const before = await listCreatableEntries(input.worktree, this.run);
    const { copied, skipped } = await copyWorktreeIncludes(input.sourceRoot, input.worktree, this.run);

    let setup: CommandResult | null = null;
    let setupProblem: ToolingProblem | undefined;
    if (input.commands.setup && input.commands.setup.length > 0) {
      setup = await this.runProjectCommand(input.commands.setup, input.sourceRoot, input.worktree, 120_000);
      if (setup.exit_code !== 0 || setup.timed_out) {
        setupProblem = {
          harness: null,
          server: null,
          kind: "setup_failed",
          detail: setup.timed_out ? "the setup command timed out" : `the setup command exited with code ${setup.exit_code ?? "null"}${setup.error ? `: ${setup.error}` : ""}`,
        };
      }
      this.freshWorktrees.add(input.worktree);
    }

    const fingerprint = await this.computeFingerprint(input);
    let rehearsal: RehearsalReport | null = null;
    if (this.rehearsedFingerprints.get(input.projectKey) !== fingerprint) {
      rehearsal = await this.rehearse(input, fingerprint);
      this.rehearsedFingerprints.set(input.projectKey, fingerprint);
      if (setupProblem) rehearsal = { ...rehearsal, problems: [setupProblem, ...rehearsal.problems] };
    }

    const after = await listCreatableEntries(input.worktree, this.run);
    return {
      copied,
      skipped,
      setup,
      rehearsal,
      tool_state_paths: newEntries(before, after),
      ...(setupProblem && rehearsal === null ? { setup_problem: setupProblem } : {}),
    };
  }

  /**
   * Runs the Project's refresh command before an agent run, unless this
   * worktree was just prepared by `prepareNewWorktree` (its setup command
   * already covers a first run). Calls for the same worktree are serialized;
   * different worktrees run concurrently. `tool_state_paths` lists what the
   * refresh command created, so it can be kept out of commits like setup output.
   */
  public async refreshBeforeRun(input: { worktree: string; sourceRoot: string; commands: WorkspaceSetupCommands }): Promise<RefreshOutcome | null> {
    return this.refreshLanes.run(input.worktree, async () => {
      if (this.freshWorktrees.has(input.worktree)) {
        this.freshWorktrees.delete(input.worktree);
        return null;
      }
      if (!input.commands.refresh || input.commands.refresh.length === 0) return null;
      const before = await listCreatableEntries(input.worktree, this.run);
      const result = await this.runProjectCommand(input.commands.refresh, input.sourceRoot, input.worktree, 60_000);
      const after = await listCreatableEntries(input.worktree, this.run);
      return { result, tool_state_paths: newEntries(before, after) };
    });
  }

  /** Dedupe: returns the alert to emit for this project, or null when nothing changed since the last call. */
  public alertFor(
    projectKey: string,
    problems: readonly ToolingProblem[],
  ): { kind: "agent_tooling_mismatch"; problems: readonly ToolingProblem[] } | { kind: "agent_tooling_recovered" } | null {
    const signature = problems.length === 0 ? null : [...problems].map((problem) => `${problem.harness}|${problem.server ?? ""}|${problem.kind}`).sort().join(",");
    const previous = this.alertSignatures.get(projectKey) ?? null;
    if (signature === null) {
      if (previous === null) return null;
      this.alertSignatures.set(projectKey, null);
      return { kind: "agent_tooling_recovered" };
    }
    if (signature === previous) return null;
    this.alertSignatures.set(projectKey, signature);
    return { kind: "agent_tooling_mismatch", problems };
  }

  private async runProjectCommand(argv: readonly string[], sourceRoot: string, worktree: string, timeoutMs: number): Promise<CommandResult> {
    const env: NodeJS.ProcessEnv = { ...this.deps.env(), OWL_SOURCE_ROOT: sourceRoot, OWL_WORKTREE: worktree };
    return this.run(argv[0]!, argv.slice(1), { cwd: worktree, env, timeout_ms: timeoutMs });
  }

  /** sha256 over the configured harnesses, the setup/refresh commands, and the mtime of every config file that could change what rehearsal would find. */
  private async computeFingerprint(input: PrepareWorkspaceInput): Promise<string> {
    const env = this.deps.env();
    const claudeConfigDir = env.CLAUDE_CONFIG_DIR || join(this.deps.home, ".claude");
    const codexHome = env.CODEX_HOME || join(this.deps.home, ".codex");
    const paths = [
      join(this.deps.home, ".claude.json"),
      join(claudeConfigDir, "settings.json"),
      join(codexHome, "config.toml"),
      ...FINGERPRINT_FILES.map((relPath) => join(input.sourceRoot, relPath)),
    ];
    const stamps = await Promise.all(paths.map(mtimeStamp));
    const hash = createHash("sha256");
    hash.update(JSON.stringify([...this.deps.harnesses()].sort()));
    hash.update(JSON.stringify(input.commands));
    hash.update(stamps.join("|"));
    return hash.digest("hex");
  }

  private async rehearse(input: PrepareWorkspaceInput, fingerprint: string): Promise<RehearsalReport> {
    const servers: McpServerStatus[] = [];
    const problems: ToolingProblem[] = [];
    const env = this.deps.env();

    await Promise.all(this.deps.harnesses().map(async (harness) => {
      if (harness === "claude") {
        await this.rehearseClaude(input, env, servers, problems);
      } else {
        await this.rehearseCodex(input, env, servers, problems);
      }
    }));

    return { fingerprint, servers, problems };
  }

  private async rehearseClaude(input: PrepareWorkspaceInput, env: NodeJS.ProcessEnv, servers: McpServerStatus[], problems: ToolingProblem[]): Promise<void> {
    const result = await this.run("claude", ["mcp", "list"], { cwd: input.worktree, env, timeout_ms: 60_000 });
    if (result.exit_code !== 0 || result.timed_out) {
      problems.push({
        harness: "claude",
        server: null,
        kind: "rehearsal_failed",
        detail: result.timed_out ? "claude mcp list timed out" : `claude mcp list exited with code ${result.exit_code ?? "null"}: ${result.stderr.slice(-300)}`,
      });
      return;
    }
    const parsed = parseClaudeMcpList(result.stdout);
    servers.push(...parsed);
    for (const server of parsed) problemFor("claude", server.name, server.status, server.detail, problems);
  }

  private async rehearseCodex(input: PrepareWorkspaceInput, env: NodeJS.ProcessEnv, servers: McpServerStatus[], problems: ToolingProblem[]): Promise<void> {
    const [worktreeList, sourceList] = await Promise.all([
      this.run("codex", ["mcp", "list", "--json"], { cwd: input.worktree, env, timeout_ms: 20_000 }),
      this.run("codex", ["mcp", "list", "--json"], { cwd: input.sourceRoot, env, timeout_ms: 20_000 }),
    ]);
    if (worktreeList.exit_code !== 0 || worktreeList.timed_out) {
      problems.push({
        harness: "codex",
        server: null,
        kind: "rehearsal_failed",
        detail: worktreeList.timed_out ? "codex mcp list timed out" : `codex mcp list exited with code ${worktreeList.exit_code ?? "null"}: ${worktreeList.stderr.slice(-300)}`,
      });
      return;
    }
    const worktreeServers = parseCodexMcpList(worktreeList.stdout);
    if (worktreeServers === null) {
      problems.push({ harness: "codex", server: null, kind: "rehearsal_failed", detail: "codex mcp list --json returned output that could not be parsed" });
      return;
    }
    const sourceServers = !sourceList.timed_out && sourceList.exit_code === 0 ? parseCodexMcpList(sourceList.stdout) : null;

    const probed = await Promise.all(worktreeServers.map(async (server): Promise<McpServerStatus> => {
      const result: ProbeResult = await this.probeCodexServer(server, env, input.worktree);
      return { harness: "codex", name: server.name, status: result.status, detail: result.detail };
    }));
    servers.push(...probed);
    for (const server of probed) problemFor("codex", server.name, server.status, server.detail, problems);

    if (sourceServers !== null) {
      const worktreeNames = new Set(worktreeServers.map((server) => server.name));
      for (const server of sourceServers) {
        if (!worktreeNames.has(server.name)) {
          problems.push({ harness: "codex", server: server.name, kind: "missing_in_worktree", detail: `${server.name} is configured for ${input.sourceRoot} but is not visible from the worktree` });
        }
      }
    }

    if (await this.codexProjectUntrusted(input.sourceRoot, sourceServers)) {
      problems.push({
        harness: "codex",
        server: null,
        kind: "codex_project_untrusted",
        detail: `.codex/config.toml at ${input.sourceRoot} defines MCP servers that codex mcp list does not report as configured; the project directory is likely not trusted`,
      });
    }
  }

  private probeCodexServer(server: CodexMcpServer, env: NodeJS.ProcessEnv, worktree: string): Promise<ProbeResult> {
    const timeoutMs = 20_000;
    if (server.transport.type === "stdio") {
      return this.probeStdio({ command: server.transport.command, args: server.transport.args, env: { ...env, ...server.transport.env }, cwd: server.transport.cwd ?? worktree }, timeoutMs);
    }
    const bearerVar = server.transport.bearer_token_env_var;
    const bearerToken = bearerVar ? env[bearerVar] : undefined;
    const headers = { ...server.transport.headers, ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}) };
    return this.probeHttp({ url: server.transport.url, headers }, timeoutMs);
  }

  /** Config-only: does the source root's own config.toml name MCP servers that `codex mcp list` there does not report, suggesting the project is not trusted? */
  private async codexProjectUntrusted(sourceRoot: string, sourceServers: readonly CodexMcpServer[] | null): Promise<boolean> {
    if (sourceServers === null) return false;
    let text: string;
    try { text = await readFile(join(sourceRoot, ".codex", "config.toml"), "utf8"); } catch { return false; }
    const configuredNames = codexConfiguredServerNames(text);
    if (configuredNames.length === 0) return false;
    const reportedNames = new Set(sourceServers.map((server) => server.name));
    return !configuredNames.some((name) => reportedNames.has(name));
  }
}

function problemFor(harness: Harness, server: string, status: McpServerStatus["status"], detail: string, problems: ToolingProblem[]): void {
  if (status === "failed") problems.push({ harness, server, kind: "failed", detail });
  else if (status === "timeout") problems.push({ harness, server, kind: "timeout", detail });
}

/** A one-line startup log summary, e.g. `agent tools: claude=[serena, x] codex=[code-review-graph]`. Omits servers that rehearsal reported as failed/timed out. */
export function describeServers(report: RehearsalReport): string {
  const byHarness = new Map<Harness, string[]>();
  for (const server of report.servers) {
    if (server.status === "failed" || server.status === "timeout") continue;
    const names = byHarness.get(server.harness) ?? [];
    names.push(server.name);
    byHarness.set(server.harness, names);
  }
  const parts = [...byHarness.entries()].map(([harness, names]) => `${harness}=[${names.join(", ")}]`);
  return `agent tools: ${parts.join(" ")}`;
}
