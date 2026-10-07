import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { OWL_INSTANCE_ID_ENV, OWL_MARKER_PATTERN, PROCESS_GROUP_REAP_GRACE_MS } from "@owl/shared";
import type { WorkspaceEntry } from "./types.js";
import { safeSegment } from "./workspace-layout.js";

/** One row of the process table with the Owl markers found in its environment. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Controlling terminal as printed by ps; null when the process has none. */
  readonly tty: string | null;
  readonly args: string;
  /** OWL_INSTANCE_ID of the process environment; null when absent. */
  readonly instanceId: string | null;
  /** OWL_AGENT_RUN_ID of the process environment; null when absent. */
  readonly runId: string | null;
}

/** Which workspace directories currently must not be touched. */
export interface WorkspaceActivity {
  /** Work ids (as directory names) that have an active agent run or an in-progress verification. */
  readonly works: ReadonlySet<string>;
  /** `<work>/<task>` directory keys that have an active agent run or an in-progress verification. */
  readonly tasks: ReadonlySet<string>;
}

/** What this instance's database knows about one agent run. */
export interface SweepRunInfo {
  /** Null for a run that belongs to no Work (an Advisor session); such a run is only swept globally. */
  readonly work_id: string | null;
  readonly task_id: string | null;
  readonly active: boolean;
}

export interface SweptProcess {
  readonly pid: number;
  readonly args: string;
  readonly run_id: string;
}

export interface WorkspaceSweepScope {
  /** Only runs of this Work (directory name). */
  readonly workId?: string;
  /** Only runs of the Tasks whose directories are this one or below it. */
  readonly path?: string;
}

export interface WorkspaceProcessSweeperDeps {
  listWorkspaces(): Promise<readonly WorkspaceEntry[]>;
  activity(): WorkspaceActivity;
  /** Id of this Owl instance; only processes carrying it are ever candidates. */
  instanceId: string;
  /** This instance's runs by id; ids it does not know are left out. */
  runs(ids: readonly string[]): ReadonlyMap<string, SweepRunInfo>;
  /** Pid of the Owl server; it and every descendant of it are never swept. Defaults to this process. */
  ownerPid?: number;
  snapshot?: () => Promise<readonly ProcessRow[] | null>;
  /** Sends a signal; a negative pid addresses a process group. Returns false when the target is gone. */
  signal?: (pid: number, signal: NodeJS.Signals) => boolean;
  isAlive?: (pid: number) => boolean;
  graceMs?: number;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
}

const VERIFICATION_TASK_PREFIX = "verification-task-";
const VERIFICATION_WORK_PREFIX = "verification-work-";

/** Run id marker for the commands of a Task's verification. */
export function taskVerificationMarker(taskId: string): string {
  return `${VERIFICATION_TASK_PREFIX}${taskId}`;
}

/** Run id marker for the commands that verify a Work before it is merged. */
export function workVerificationMarker(workId: string): string {
  return `${VERIFICATION_WORK_PREFIX}${workId}`;
}

/** The Task or Work a verification marker names; null when the id is not a verification marker. */
export function parseVerificationMarker(runId: string): { readonly taskId: string } | { readonly workId: string } | null {
  if (runId.startsWith(VERIFICATION_TASK_PREFIX)) return { taskId: runId.slice(VERIFICATION_TASK_PREFIX.length) };
  if (runId.startsWith(VERIFICATION_WORK_PREFIX)) return { workId: runId.slice(VERIFICATION_WORK_PREFIX.length) };
  return null;
}

const NO_TTY = new Set(["", "?", "??", "-"]);
const ARGS_LOG_LIMIT = 160;

function execFileText(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolveText) => {
    execFile(file, [...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error && (stdout === undefined || stdout.length === 0)) resolveText(null);
      else resolveText(stdout);
    });
  });
}

function lastMarker(text: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${name}=(\\S+)`, "gu");
  let value: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (OWL_MARKER_PATTERN.test(match[1])) value = match[1];
  }
  return value;
}

/**
 * Markers found in `ps -E` output: the environment follows the arguments on
 * the same line, so the last occurrence is the environment's. A process whose
 * own arguments contain both marker tokens with this instance's id could
 * still be mistaken for a marked one; the id is a random value that only
 * Owl's own processes carry.
 */
export function markersFromPsLine(text: string): { instanceId: string | null; runId: string | null } {
  return { instanceId: lastMarker(text, OWL_INSTANCE_ID_ENV), runId: lastMarker(text, "OWL_AGENT_RUN_ID") };
}

function markersFromEnviron(pid: number): { instanceId: string | null; runId: string | null } {
  try {
    const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const find = (name: string): string | null => {
      const entry = entries.find((item) => item.startsWith(`${name}=`));
      const value = entry?.slice(name.length + 1) ?? null;
      return value !== null && OWL_MARKER_PATTERN.test(value) ? value : null;
    };
    return { instanceId: find(OWL_INSTANCE_ID_ENV), runId: find("OWL_AGENT_RUN_ID") };
  } catch {
    return { instanceId: null, runId: null };
  }
}

/**
 * One process-table snapshot with each process's Owl markers: `ps -E` on
 * macOS (environment printed after the arguments), `/proc/<pid>/environ` on
 * Linux. Only same-user, non-platform binaries expose their environment. Null when the
 * table is unavailable; on other platforms no process carries markers.
 */
export async function snapshotProcessTable(platform: NodeJS.Platform = process.platform): Promise<readonly ProcessRow[] | null> {
  if (platform === "win32") return null;
  const darwin = platform === "darwin";
  const columns = "pid=,ppid=,pgid=,tty=,args=";
  const output = await execFileText("ps", darwin ? ["-axEww", "-o", columns] : ["-axo", columns]);
  if (output === null) return null;
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const markers = darwin ? markersFromPsLine(match[5]) : platform === "linux" ? markersFromEnviron(pid) : { instanceId: null, runId: null };
    rows.push({ pid, ppid: Number(match[2]), pgid: Number(match[3]), tty: NO_TTY.has(match[4]) ? null : match[4], args: match[5], ...markers });
  }
  return rows;
}

function isInside(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

/** The executable of a ps line. `ps -E` prints the environment after the arguments, so nothing past the first word is ever logged. */
function commandOf(args: string): string {
  const first = args.trim().split(/\s+/u)[0] ?? "";
  return first.length > ARGS_LOG_LIMIT ? `${first.slice(0, ARGS_LOG_LIMIT)}...` : first;
}

function defaultSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Terminates processes that outlived the agent run that started them. A
 * process is only a candidate when its environment carries this instance's
 * OWL_INSTANCE_ID and an OWL_AGENT_RUN_ID, so nothing Owl did not start is
 * ever touched. The Owl server, its descendants, and processes with a
 * controlling terminal are never swept, nor are processes of runs, Tasks or
 * Works that are still active.
 */
export class WorkspaceProcessSweeper {
  private chain: Promise<unknown> = Promise.resolve();

  public constructor(private readonly deps: WorkspaceProcessSweeperDeps) {}

  /** Sweeps one scope (everything when empty); sweeps never overlap. Never rejects. */
  public sweep(scope: WorkspaceSweepScope = {}): Promise<readonly SweptProcess[]> {
    const run = this.chain.then(() => this.sweepNow(scope)).catch((error: unknown) => {
      this.log(`[owl-core] Workspace process sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      return [] as readonly SweptProcess[];
    });
    this.chain = run;
    return run;
  }

  private log(message: string): void {
    (this.deps.log ?? ((text: string) => console.log(text)))(message);
  }

  private async sweepNow(scope: WorkspaceSweepScope): Promise<readonly SweptProcess[]> {
    const platform = this.deps.platform ?? process.platform;
    if (platform === "win32") return [];
    const scoped = scope.workId !== undefined || scope.path !== undefined;
    let selected: readonly WorkspaceEntry[] = [];
    if (scoped) {
      const scopePath = scope.path === undefined ? null : resolve(scope.path);
      selected = (await this.deps.listWorkspaces()).filter((entry) =>
        (scope.workId === undefined || entry.work_id === scope.workId)
        && (scopePath === null || isInside(scopePath, resolve(entry.path))),
      );
      if (selected.length === 0) return [];
    }

    const table = await (this.deps.snapshot ?? (() => snapshotProcessTable(platform)))();
    if (table === null) return [];
    const ownerPid = this.deps.ownerPid ?? process.pid;
    const byPid = new Map(table.map((row) => [row.pid, row]));
    const shielded = (row: ProcessRow): boolean => {
      if (row.pid <= 1 || row.pid === process.pid || row.tty !== null) return true;
      const seen = new Set<number>();
      for (let current: ProcessRow | undefined = row; current !== undefined && !seen.has(current.pid); current = byPid.get(current.ppid)) {
        if (current.pid === ownerPid) return true;
        seen.add(current.pid);
      }
      return false;
    };

    const marked = table.filter((row) => row.instanceId === this.deps.instanceId && row.runId !== null && !shielded(row));
    if (marked.length === 0) return [];
    const runs = this.deps.runs([...new Set(marked.map((row) => row.runId!))]);
    const activity = this.deps.activity();
    const runOfAncestor = (row: ProcessRow): string => {
      for (let current = byPid.get(row.ppid); current !== undefined; current = byPid.get(current.ppid)) {
        if (current.runId !== null) return current.runId;
      }
      return "";
    };
    const isRunVictim = (row: ProcessRow): boolean => {
      const run = runs.get(row.runId!);
      // A run this instance does not know (a deleted run) is only swept globally.
      if (run === undefined) return !scoped;
      if (run.active) return false;
      if (run.work_id === null) return !scoped;
      const work = safeSegment(run.work_id);
      const task = run.task_id === null ? null : safeSegment(run.task_id);
      if (task === null ? activity.works.has(work) : activity.tasks.has(`${work}/${task}`)) return false;
      return !scoped || selected.some((entry) => entry.work_id === work && (entry.task_id === null ? task === null : entry.task_id === task));
    };
    const victims: ProcessRow[] = marked.filter(isRunVictim);
    // Platform binaries (sh, make, python3) expose no environment on macOS: an
    // unmarked process below a victim in the same snapshot is a victim too.
    const victimPids = new Set(victims.map((row) => row.pid));
    for (let grew = true; grew;) {
      grew = false;
      for (const row of table) {
        if (victimPids.has(row.pid) || row.instanceId !== null || row.runId !== null || shielded(row) || !victimPids.has(row.ppid)) continue;
        victimPids.add(row.pid);
        victims.push(row);
        grew = true;
      }
    }
    if (victims.length === 0) return [];

    const signal = this.deps.signal ?? defaultSignal;
    const isAlive = this.deps.isAlive ?? defaultIsAlive;
    const send = (row: ProcessRow, name: NodeJS.Signals): void => {
      // A group is signalled as a whole only when every member is a victim.
      const members = table.filter((other) => other.pgid === row.pgid);
      if (row.pgid === row.pid && row.pgid > 1 && members.every((member) => victimPids.has(member.pid))) {
        signal(-row.pgid, name);
      } else {
        signal(row.pid, name);
      }
    };
    for (const row of victims) send(row, "SIGTERM");

    const graceMs = this.deps.graceMs ?? PROCESS_GROUP_REAP_GRACE_MS;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && victims.some((row) => isAlive(row.pid))) {
      await new Promise<void>((done) => setTimeout(done, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    for (const row of victims) {
      if (isAlive(row.pid)) send(row, "SIGKILL");
    }

    const swept: SweptProcess[] = victims.map((row) => ({ pid: row.pid, args: row.args, run_id: row.runId ?? runOfAncestor(row) }));
    for (const item of swept) {
      this.log(`[owl-core] Workspace sweep terminated leftover process ${item.pid} (${commandOf(item.args)}) of agent run ${item.run_id}`);
    }
    return swept;
  }
}
