import { execFileSync } from "node:child_process";
import { accessSync, realpathSync, constants } from "node:fs";
import { basename, delimiter, join } from "node:path";

/**
 * Harness-independent subagent detection.
 *
 * An agent may start another agent CLI on its own (a Claude Worker running
 * `codex exec` from its shell tool, a Codex Worker running `claude -p`, ...).
 * Owl did not spawn those processes, so the only signal that works for every
 * provider and harness is the OS process tree: a process below an active
 * AgentRun's pid running a known, installed agent CLI is a subagent of the
 * nearest AgentRun above it.
 */

/** Agent CLI executable names recognised by default. */
export const DEFAULT_AGENT_CLI_NAMES: readonly string[] = [
  "claude",
  "codex",
  "gemini",
  "qwen",
  "opencode",
  "aider",
  "amp",
  "goose",
  "crush",
  "cursor-agent",
  "copilot",
  "droid",
  "kiro-cli",
];

/** Extra names come from OWL_SUBAGENT_CLI_NAMES (comma separated). */
export function agentCliNames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const extra = (env.OWL_SUBAGENT_CLI_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z0-9._-]{1,64}$/u.test(name));
  return new Set([...DEFAULT_AGENT_CLI_NAMES, ...extra]);
}

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly args: string;
}

/** One `ps` snapshot of every process; null when `ps` is unavailable. */
export function listProcesses(): readonly ProcessEntry[] | null {
  if (process.platform === "win32") return null;
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid=,args="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const entries: ProcessEntry[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  return entries;
}

const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "ruby", "npx", "bunx", "pnpm", "sh", "bash", "zsh"]);

export type InstalledAgentCliCheck = (name: string, path: string) => boolean;

const installedCliPaths = new Map<string, string | null>();
let installedCliPathEnv: string | undefined;
let installedCliPathsAt = 0;

/** Compare path-invoked CLIs with executable names found on PATH. */
export function installedAgentCliMatches(name: string, path: string): boolean {
  const pathEnv = process.env.PATH;
  if (pathEnv !== installedCliPathEnv || Date.now() - installedCliPathsAt >= 60_000) {
    installedCliPaths.clear();
    installedCliPathEnv = pathEnv;
    installedCliPathsAt = Date.now();
  }
  if (!installedCliPaths.has(name)) {
    let installed: string | null = null;
    for (const directory of (pathEnv ?? "").split(delimiter)) {
      try {
        const candidate = join(directory || ".", name);
        accessSync(candidate, constants.X_OK);
        installed = realpathSync(candidate);
        break;
      } catch {
        // Continue to the next PATH entry.
      }
    }
    installedCliPaths.set(name, installed);
  }
  try {
    return installedCliPaths.get(name) !== null && installedCliPaths.get(name) === realpathSync(path);
  } catch {
    return false;
  }
}

function executableName(token: string): string {
  return basename(token).replace(/\.(?:c|m)?js$|\.ts$|\.py$|\.exe$/u, "");
}

/**
 * The agent CLI a process is running, or null. Script launchers
 * (`node /usr/local/bin/codex ...`) are resolved to the script's name and
 * checked against PATH; a shell running a CLI through `-c` is not itself a
 * subagent.
 */
export function agentCliOf(args: string, names: ReadonlySet<string>, installedCliMatches: InstalledAgentCliCheck): string | null {
  const tokens = args.trim().split(/\s+/u);
  if (tokens.length === 0 || tokens[0].length === 0) return null;
  const first = executableName(tokens[0]);
  if (names.has(first)) return !tokens[0].includes("/") || installedCliMatches(first, tokens[0]) ? first : null;
  if (!INTERPRETERS.has(first)) return null;
  const scriptIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith("-"));
  // Only the interpreter's own `-c` (before the script) means inline code; a CLI's `-c` option (codex `-c key=value`) does not.
  if (scriptIndex < 0 || tokens.slice(1, scriptIndex).includes("-c")) return null;
  const script = tokens[scriptIndex];
  const scriptName = executableName(script);
  return names.has(scriptName) && (!script.includes("/") || installedCliMatches(scriptName, script)) ? scriptName : null;
}

const SAFE_TOKEN = /^[A-Za-z0-9._:/@-]{1,80}$/u;

/** `--model X`, `--model=X` or `-m X`; only a plain model-name token is kept. */
export function modelFromArgs(args: string): string | null {
  const tokens = args.trim().split(/\s+/u);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = token.startsWith("--model=")
      ? token.slice("--model=".length)
      : token === "--model" || token === "-m"
        ? tokens[index + 1]
        : undefined;
    if (value !== undefined) return SAFE_TOKEN.test(value) ? value : null;
  }
  return null;
}

/**
 * A short, secret-free label: the CLI name plus its subcommand when the first
 * argument is a plain lowercase word (`codex exec`). Prompts and flag values
 * are never copied.
 */
export function subagentLabel(name: string, args: string): string {
  const tokens = args.trim().split(/\s+/u);
  const nameIndex = tokens.findIndex((token) => executableName(token) === name);
  const next = nameIndex >= 0 ? tokens[nameIndex + 1] : undefined;
  if (next && /^[a-z][a-z-]{1,19}$/u.test(next)) return `${name} ${next}`;
  if (tokens.includes("-p") || tokens.includes("--print")) return `${name} -p`;
  return name;
}

export interface ActiveRunRef {
  readonly id: string;
  readonly pid: number | null;
  readonly origin: string | null;
}

export interface DetectedSubagent {
  readonly pid: number;
  readonly parent_run_id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly label: string;
}

export interface SubagentReconciliation {
  readonly detected: readonly DetectedSubagent[];
  /** Observed runs whose process is gone. */
  readonly exited: readonly string[];
}

/**
 * Compare one process snapshot with the active AgentRuns. A process counts
 * as a new subagent when it runs a known agent CLI, has an active AgentRun
 * above it, and is not merely the native binary of its parent's launcher
 * (`node codex` → `codex`, which is the same agent).
 */
export function planSubagentReconciliation(
  processes: readonly ProcessEntry[],
  runs: readonly ActiveRunRef[],
  names: ReadonlySet<string>,
  installedCliMatches: InstalledAgentCliCheck,
): SubagentReconciliation {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const runByPid = new Map<number, ActiveRunRef>();
  for (const run of runs) if (run.pid !== null && run.pid > 0) runByPid.set(run.pid, run);

  const exited = runs
    .filter((run) => run.origin === "observed")
    .filter((run) => {
      const entry = run.pid === null ? undefined : byPid.get(run.pid);
      return entry === undefined || agentCliOf(entry.args, names, installedCliMatches) === null;
    })
    .map((run) => run.id);

  const detected: DetectedSubagent[] = [];
  if (runByPid.size === 0) return { detected, exited };
  for (const entry of processes) {
    if (runByPid.has(entry.pid)) continue;
    const provider = agentCliOf(entry.args, names, installedCliMatches);
    if (provider === null) continue;
    const parent = byPid.get(entry.ppid);
    if (parent && agentCliOf(parent.args, names, installedCliMatches) === provider) continue;
    const owner = nearestRun(entry, byPid, runByPid);
    if (!owner) continue;
    detected.push({
      pid: entry.pid,
      parent_run_id: owner.id,
      provider,
      model: modelFromArgs(entry.args),
      label: subagentLabel(provider, entry.args),
    });
  }
  return { detected, exited };
}

function nearestRun(
  entry: ProcessEntry,
  byPid: ReadonlyMap<number, ProcessEntry>,
  runByPid: ReadonlyMap<number, ActiveRunRef>,
): ActiveRunRef | null {
  const seen = new Set<number>([entry.pid]);
  let current = byPid.get(entry.ppid);
  while (current && !seen.has(current.pid)) {
    const run = runByPid.get(current.pid);
    if (run) return run;
    seen.add(current.pid);
    if (current.ppid <= 1) return null;
    current = byPid.get(current.ppid);
  }
  return null;
}
