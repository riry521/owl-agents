import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { reapProcessGroup } from "@owl/shared";
import type { TestCommandResult } from "./test-runs";

const execFileAsync = promisify(execFile);

export const NIGHTLY_TEST_TIMEOUT_MS = 2 * 60 * 60_000;
export const DEFAULT_NIGHTLY_TEST_TIME = "04:00";
export const NIGHTLY_TEST_SETTINGS_KEY = "nightly_tests";
const OUTPUT_TAIL_CHARS = 8_000;
const KILL_GRACE_MS = 5_000;

export interface TestFailure {
  /** Path relative to the worktree; "" when TAP gave no location. */
  readonly file: string;
  /** Nested test names joined with " > ". */
  readonly name: string;
  readonly line: number | null;
  readonly message: string;
}

export interface NightlyProject {
  readonly id: string;
  readonly name: string;
  readonly canonical_path: string;
  readonly base_branch: string;
  readonly argv: readonly string[];
}

export interface NightlyExecution {
  /** error = the command could not run to its end (no worktree, spawn failure, timeout, abort). */
  readonly status: "completed" | "error";
  readonly base_commit: string | null;
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  readonly error: string | null;
  readonly failures: readonly TestFailure[];
  readonly output_tail: string;
}

/** Replaceable in tests so no real command runs. */
export type NightlyTestExecutor = (project: NightlyProject, signal: AbortSignal) => Promise<NightlyExecution>;

export function testFailureKey(failure: Pick<TestFailure, "file" | "name">): string {
  return `${failure.file}\u0000${failure.name}`;
}

/** Reads bun test's `(fail) name` lines; without any, its `error:` lines. [] when neither is there. */
export function parseBunFailures(text: string): TestFailure[] {
  const lines = text.split(/\r?\n/u).map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "").trim());
  const names = lines.flatMap((line) => /^\(fail\) (.+?)(?: \[[\d.]+ms\])?$/u.exec(line)?.[1] ?? []);
  const errors = lines.filter((line) => line.startsWith("error:"));
  if (names.length > 0) return [...new Set(names)].map((name) => ({ file: "", name, line: 0, message: errors[0] ?? "" }));
  return [...new Set(errors)].map((message) => ({ file: "", name: "", line: 0, message }));
}

/** Reads the failures out of Node's `--test-reporter=tap` output. */
export function parseTapFailures(text: string, root: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const names: string[] = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const indent = (/^ */u.exec(line)?.[0].length ?? 0);
    const level = Math.floor(indent / 4);
    const body = line.slice(indent);
    const subtest = /^# Subtest: (.*)$/u.exec(body);
    if (subtest) {
      names.length = level;
      names[level] = subtest[1] ?? "";
      continue;
    }
    const notOk = /^not ok \d+ - (.*)$/u.exec(body);
    if (!notOk) continue;
    const title = notOk[1] ?? "";
    if (/(?<!\\) # (?:TODO|SKIP)\b/iu.test(title)) continue;
    const name = [...names.slice(0, level), title.replace(/\\#/gu, "#").replace(/\\\\/gu, "\\")].join(" > ");
    let location: string | null = null;
    let failureType = "";
    let message = "";
    if ((lines[i + 1] ?? "").trim() === "---") {
      for (let j = i + 2; j < lines.length && (lines[j] ?? "").trim() !== "..."; j += 1) {
        const yaml = (lines[j] ?? "").trim();
        const loc = /^location: '(.*)'$/u.exec(yaml);
        if (loc) location = (loc[1] ?? "").replace(/''/gu, "'");
        const type = /^failureType: '?([A-Za-z]+)'?$/u.exec(yaml);
        if (type) failureType = type[1] ?? "";
        const error = /^error: (.*)$/u.exec(yaml);
        if (error) message = error[1] === "|-" || error[1] === "|" ? (lines[j + 1] ?? "").trim() : (error[1] ?? "").replace(/^'|'$/gu, "");
      }
    }
    // The parent of a failed child, or a child cancelled by its parent, is recorded through that other failure.
    if (failureType === "subtestsFailed" || failureType === "cancelledByParent") continue;
    let file = "";
    let lineNumber: number | null = null;
    const match = location === null ? null : /^(.*):(\d+):\d+$/u.exec(location);
    if (match) {
      const path = match[1] ?? "";
      file = isAbsolute(path) ? relative(root, path) : path;
      lineNumber = Number(match[2]);
    }
    failures.push({ file, name, line: lineNumber, message: message.slice(0, 500) });
  }
  return failures;
}

export function classifyNightlyRun(execution: NightlyExecution): "passed" | "failed" | "error" {
  if (execution.status === "error") return "error";
  if (execution.failures.length > 0) return "failed";
  return execution.exit_code === 0 ? "passed" : "error";
}

export function newNightlyFailures(current: readonly TestFailure[], previous: readonly TestFailure[]): TestFailure[] {
  const seen = new Set(previous.map(testFailureKey));
  const added = new Set<string>();
  return current.filter((failure) => {
    const key = testFailureKey(failure);
    if (seen.has(key) || added.has(key)) return false;
    added.add(key);
    return true;
  });
}

export function nightlyTestDedupeKey(file: string, name: string): string {
  return createHash("sha256").update(`nightly-test\u0000${file}\u0000${name}`, "utf8").digest("hex");
}

export interface NightlyBacklogEntry {
  readonly file: string;
  readonly line: number;
  readonly problem: string;
  readonly reason: string;
  readonly suggestion: string;
  readonly dedupe_key: string;
}

export function nightlyBacklogEntries(failures: readonly TestFailure[], language: string): NightlyBacklogEntry[] {
  const ja = language === "ja";
  return failures.map((failure) => ({
    file: failure.file,
    line: failure.line ?? 0,
    problem: `${ja ? "夜間テストで失敗" : "Failed in the nightly test run"}: ${failure.name.slice(0, 300)}`,
    reason: failure.message,
    suggestion: ja
      ? `${failure.file} を単独で実行して原因を調べ、直してください。`
      : `Run ${failure.file} on its own, find the cause and fix it.`,
    dedupe_key: nightlyTestDedupeKey(failure.file, failure.name),
  }));
}

export function nightlyError(error: string, extra: Partial<NightlyExecution> = {}): NightlyExecution {
  return { status: "error", base_commit: null, exit_code: null, timed_out: false, error, failures: [], output_tail: "", ...extra };
}

/**
 * Runs the Project's test command in a fresh detached checkout of the base
 * branch (rebuilt every night, kept afterwards for inspection). No model is used.
 */
export function createNightlyTestExecutor(deps: { readonly workspaceRoot: string; readonly timeoutMs: number }): NightlyTestExecutor {
  return async (project, signal) => {
    const path = join(deps.workspaceRoot, "nightly", project.id.replace(/[^A-Za-z0-9_-]/gu, "_"));
    let baseCommit: string;
    try {
      const git = (args: string[]) => execFileAsync("git", args, { cwd: project.canonical_path }).then((r) => r.stdout.trim());
      baseCommit = await git(["rev-parse", "--verify", `refs/heads/${project.base_branch}^{commit}`]);
    } catch (error) {
      return nightlyError(`Could not prepare the nightly worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      // The checkout is kept afterwards for inspection (no cleanup). The command never rejects.
      return await withDetachedWorktree({ repo: project.canonical_path, commit: baseCommit, path }, (worktree) => runNightlyCommand(project, worktree, baseCommit, deps.timeoutMs, signal));
    } catch (error) {
      return nightlyError(`Could not prepare the nightly worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

function runNightlyCommand(project: NightlyProject, path: string, baseCommit: string, timeoutMs: number, signal: AbortSignal): Promise<NightlyExecution> {
  {
    const [command, ...args] = project.argv;
    return new Promise<NightlyExecution>((resolve) => {
      let tail = "";
      let stdout = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const child = spawn(command ?? "", args, {
        cwd: path,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer, isStdout: boolean) => {
        const text = chunk.toString("utf8");
        if (isStdout) stdout += text;
        tail = (tail + text).slice(-OUTPUT_TAIL_CHARS);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
      const killGroup = (signalName: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signalName);
        } catch {
          // already gone
        }
      };
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const stopChild = () => {
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => { timedOut = true; stopChild(); }, timeoutMs);
      const onAbort = () => { aborted = true; stopChild(); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      const finish = (result: NightlyExecution) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer !== null) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      child.on("error", (error) => finish(nightlyError(`Could not start the test command: ${error.message}`, { base_commit: baseCommit, output_tail: tail })));
      child.on("close", (code) => {
        if (timedOut || aborted) {
          finish(nightlyError(timedOut ? `Timed out after ${timeoutMs} ms` : "aborted", { base_commit: baseCommit, timed_out: timedOut, output_tail: tail }));
          return;
        }
        finish({
          status: "completed",
          base_commit: baseCommit,
          exit_code: code,
          timed_out: false,
          error: null,
          failures: parseTapFailures(stdout, path),
          output_tail: tail,
        });
      });
    });
  }
}

/**
 * Checks out `commit` detached at `path` (a stale worktree there is removed
 * first), runs `fn`, and removes the checkout afterwards only with `cleanup`.
 * Preparation failures reject with git's own message.
 */
export async function withDetachedWorktree<T>(input: { readonly repo: string; readonly commit: string; readonly path: string; readonly cleanup?: boolean }, fn: (path: string) => Promise<T>): Promise<T> {
  const git = (args: string[]) => execFileAsync("git", args, { cwd: input.repo }).then((r) => r.stdout.trim());
  await git(["worktree", "remove", "--force", input.path]).catch(() => undefined);
  await rm(input.path, { recursive: true, force: true });
  await mkdir(dirname(input.path), { recursive: true });
  await git(["worktree", "add", "--detach", input.path, input.commit]);
  try {
    return await fn(input.path);
  } finally {
    if (input.cleanup === true) {
      await git(["worktree", "remove", "--force", input.path]).catch(() => undefined);
      await rm(input.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Runs one argv without a shell in its own process group. stdout and stderr are
 * kept apart, each cut to outputLimitBytes. A timeout or abort stops the group
 * (SIGTERM, then SIGKILL after the grace period); a timeout sets timed_out.
 */
export function spawnTestCommand(argv: readonly string[], cwd: string, env: Record<string, string>, timeoutMs: number, outputLimitBytes: number, signal?: AbortSignal, onOutput?: () => void): Promise<TestCommandResult> {
  return new Promise<TestCommandResult>((resolve) => {
    const startedAt = Date.now();
    const [command, ...args] = argv;
    const out = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let timedOut = false;
    let settled = false;
    const child = spawn(command ?? "", args, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (key: "stdout" | "stderr") => (chunk: Buffer) => {
      onOutput?.();
      if (out[key].length < outputLimitBytes) out[key] = Buffer.concat([out[key], chunk]).subarray(0, outputLimitBytes);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const stop = () => { void reapProcessGroup(child.pid, { graceMs: KILL_GRACE_MS }); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      stop();
      resolve({
        exit_code: code,
        timed_out: timedOut,
        stdout: out.stdout.toString("utf8"),
        stderr: out.stderr.toString("utf8"),
        duration_ms: Date.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      });
    };
    child.on("error", (spawnError) => finish(null, spawnError.message));
    child.on("close", (code) => finish(code));
  });
}

export interface NightlyRunSummary {
  readonly project_id: string;
  readonly run_id: string;
  readonly status: "passed" | "failed" | "error";
  readonly failure_count: number;
  readonly new_failure_count: number;
  readonly backlog_item_ids: string[];
}
