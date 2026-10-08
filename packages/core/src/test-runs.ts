import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, posix } from "node:path";
import { matchesGlobWithDots } from "./glob.js";
import { promisify } from "node:util";
import { createUlid } from "../../db/dist/index.js";
import { readTestRunSettings, type TestRunSettings } from "../../shared/dist/test-run-settings.js";
import { parseBunFailures, parseTapFailures, type TestFailure } from "./nightly-tests";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

const execFileAsync = promisify(execFile);
const SYNTHETIC_MESSAGE_CHARS = 500;

export type TestRunScope = "task" | "work" | "baseline";
export type TestFileStatus = "passed" | "failed" | "error" | "timed_out";

export interface TestCommandResult {
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
  /** The process could not be started. */
  readonly error?: string;
}

/** Starts one process; replaceable in tests. The caller owns the environment and process tracking. */
export type TestCommandRunner = (argv: readonly string[], cwd: string, timeoutMs: number, outputLimitBytes: number, onOutput?: () => void) => Promise<TestCommandResult>;

export interface TestSelection {
  readonly mode: "full" | "selected";
  readonly files: readonly string[];
  readonly previous_failed: readonly string[];
  readonly changed_tests: readonly string[];
  readonly related: readonly string[];
  readonly required: readonly string[];
  readonly full_reason: string | null;
  readonly changed_files_count: number;
  /** Quarantined files the Work-level run left out. */
  readonly quarantined?: readonly string[];
  /** The Task worktree had uncommitted changes when the run started. */
  readonly dirty?: boolean;
  /** Content digest of each file the Task changed when the run started; the next run selects from what differs. */
  readonly change_digest?: Readonly<Record<string, string>>;
}

export interface TestFileResult {
  readonly file: string;
  readonly status: TestFileStatus;
  readonly duration_ms: number;
  readonly exit_code: number | null;
  readonly attempts: number;
  readonly failures: readonly TestFailure[];
  readonly output_tail: string;
}

export interface TestExecution {
  /** error = the run could not go through (prepare failed, aborted). */
  readonly status: "completed" | "error";
  readonly error: string | null;
  readonly files: readonly TestFileResult[];
  readonly duration_ms: number;
}

export interface ClassifiedFailure extends TestFailure {
  readonly classification: "in_scope" | "pre_existing";
  readonly pre_existing_by: "nightly" | "baseline" | null;
}

export interface TestRunRecord {
  readonly id: string;
  readonly project_id: string;
  readonly work_id: string | null;
  readonly task_id: string | null;
  readonly scope: TestRunScope;
  readonly mode: "full" | "selected";
  readonly commit_sha: string;
  readonly status: "passed" | "failed" | "error";
  readonly finished_at: string;
  readonly files: ReadonlyArray<{ file: string; status: TestFileStatus; failures: readonly ClassifiedFailure[] }>;
}

export interface NewTestRun {
  /** Chosen by the caller when the same id must appear in an event written with the row. */
  readonly id?: string;
  readonly project_id: string;
  readonly work_id: string | null;
  readonly task_id: string | null;
  readonly agent_run_id: string | null;
  readonly scope: TestRunScope;
  readonly mode: "full" | "selected";
  readonly commit_sha: string;
  readonly base_commit: string | null;
  readonly selection: TestSelection;
  readonly started_at: string;
  readonly execution: TestExecution;
  /** file -> classified failures; a file without an entry has all its failures in_scope. */
  readonly classified: ReadonlyMap<string, readonly ClassifiedFailure[]>;
}

export interface TestFailureBrief {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly message: string;
}
export interface TestFailureBriefs {
  readonly failures: readonly TestFailureBrief[];
  readonly omitted_count: number;
}

const inScope = (failure: TestFailure): ClassifiedFailure => ({ ...failure, classification: "in_scope", pre_existing_by: null });

/** projects.test_run_json -> settings; NULL or broken JSON = null (Core does not run tests). */
export function testRunSettingsFromJson(json: string | null, warn?: (message: string) => void): TestRunSettings | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return readTestRunSettings(value, warn);
  } catch {
    warn?.("Invalid projects.test_run_json; Core does not run tests for this Project.");
    return null;
  }
}

const matchesAny = (file: string, patterns: readonly string[]): boolean => patterns.some((pattern) => matchesGlobWithDots(file, pattern));

/** Test files of a checkout: tracked and untracked (not ignored) files that match test_patterns. */
export async function listTestFiles(root: string, settings: TestRunSettings): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter((file) => file !== "" && matchesAny(file, settings.test_patterns)).sort();
}

const IMPORT_PATTERN = /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*["'](\.{1,2}\/[^"']*)["']/gu;

function mapSource(path: string, settings: TestRunSettings): string {
  for (const rule of settings.source_map) {
    const re = new RegExp(rule.from);
    if (re.test(path)) return path.replace(re, rule.to);
  }
  return path;
}

/**
 * R1: the changed file is itself a test. R2: the test directly imports (one level) a relative module
 * that, after source_map, is a changed file.
 */
export async function relatedTests(input: {
  root: string;
  changedFiles: readonly string[];
  testFiles: readonly string[];
  settings: TestRunSettings;
}): Promise<{ changed_tests: string[]; related: string[] }> {
  const changed = new Set(input.changedFiles);
  const changedTests = input.testFiles.filter((file) => changed.has(file));
  const related: string[] = [];
  for (const file of input.testFiles) {
    if (changed.has(file)) continue;
    const text = await readFile(`${input.root}/${file}`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") console.warn(`[owl-core] Could not read test file ${file} to find related tests:`, error);
      return "";
    });
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const target = posix.normalize(posix.join(dirname(file), match[1] ?? ""));
      if (changed.has(target) || changed.has(mapSource(target, input.settings))) {
        related.push(file);
        break;
      }
    }
  }
  return { changed_tests: [...changedTests], related };
}

/** Chooses the test files to run (nothing is executed). */
export async function selectTests(input: {
  scope: "task" | "work";
  root: string;
  testFiles: readonly string[];
  changedFiles: readonly string[];
  previous: TestRunRecord | null;
  requiredTests: readonly string[];
  /** Reason to run every file regardless of the changes (a Work's first run). */
  forceFull: string | null;
  settings: TestRunSettings;
}): Promise<TestSelection> {
  const base = { changed_files_count: input.changedFiles.length };
  let fullReason = input.forceFull;
  if (fullReason === null && input.scope === "work") {
    const hit = input.changedFiles.find((file) => matchesAny(file, input.settings.full_run_patterns));
    if (hit !== undefined) fullReason = `full_run_pattern:${hit}`;
  }
  const empty = { previous_failed: [], changed_tests: [], related: [], required: [] };
  if (fullReason !== null) return { ...base, ...empty, mode: "full", files: [...input.testFiles].sort(), full_reason: fullReason };

  const known = new Set(input.testFiles);
  const previousFailed = (input.previous?.files ?? [])
    .filter((entry) => entry.status !== "passed" && entry.failures.some((f) => f.classification === "in_scope"))
    .map((entry) => entry.file)
    .filter((file) => known.has(file));
  const { changed_tests, related } = await relatedTests(input);
  const required = input.requiredTests.filter((file) => known.has(file));
  const files = [...new Set([...previousFailed, ...changed_tests, ...related, ...required])].sort();
  return { ...base, mode: "selected", files, previous_failed: previousFailed, changed_tests, related, required, full_reason: null };
}

const lastLine = (text: string): string => text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).pop() ?? "";

async function runOneFile(file: string, root: string, settings: TestRunSettings, run: TestCommandRunner): Promise<Omit<TestFileResult, "attempts">> {
  const argv = settings.file_argv.map((arg) => (arg === "{file}" ? file : arg));
  const result = await run(argv, root, settings.file_timeout_seconds * 1000, settings.output_limit_bytes);
  const tail = `${result.stdout}${result.stderr}`.slice(-settings.output_tail_chars);
  const base = { file, duration_ms: result.duration_ms, exit_code: result.exit_code, output_tail: tail };
  if (result.timed_out) {
    const message = `timed out after ${settings.file_timeout_seconds}s`;
    return { ...base, status: "timed_out", failures: [{ file, name: "", line: 0, message }] };
  }
  if (result.error !== undefined) return { ...base, status: "error", failures: [{ file, name: "", line: 0, message: result.error.slice(0, SYNTHETIC_MESSAGE_CHARS) }] };
  if (result.exit_code === 0) return { ...base, status: "passed", failures: [] };
  const parsed = parseTapFailures(result.stdout, root);
  const failures = parsed.length > 0
    ? parsed.map((failure) => (failure.file === "" ? { ...failure, file } : failure))
    : [{ file, name: "", line: 0, message: (lastLine(result.stderr) || lastLine(result.stdout)).slice(0, SYNTHETIC_MESSAGE_CHARS) }];
  return { ...base, status: "failed", failures };
}

/** Runs prepare_argv once in the checkout; returns the error text, or null when it passed or there is nothing to run. */
export async function prepareCheckout(input: { root: string; settings: TestRunSettings; run: TestCommandRunner }): Promise<string | null> {
  const { root, settings, run } = input;
  if (settings.prepare_argv.length === 0) return null;
  const prepared = await run(settings.prepare_argv, root, settings.prepare_timeout_seconds * 1000, settings.output_limit_bytes);
  if (prepared.error === undefined && !prepared.timed_out && prepared.exit_code === 0) return null;
  const why = prepared.error ?? (prepared.timed_out ? "timed out" : `exit ${prepared.exit_code}`);
  return `prepare failed (${why}): ${lastLine(prepared.stderr)}`.trimEnd();
}

/** The one row a whole-command run records in test_run_files. */
export const WHOLE_RUN_FILE = "*";

/** Runs prepare once, then whole_argv once; pass = exit code 0. */
export async function runWholeSuite(input: { root: string; settings: TestRunSettings; run: TestCommandRunner; signal?: AbortSignal }): Promise<TestExecution> {
  const { root, settings, run, signal } = input;
  const started = Date.now();
  const done = (status: TestExecution["status"], error: string | null, files: readonly TestFileResult[] = []): TestExecution => ({ status, error, files, duration_ms: Date.now() - started });
  const prepareError = await prepareCheckout({ root, settings, run });
  if (prepareError !== null) return done("error", prepareError);
  if (signal?.aborted === true) return done("error", "aborted");
  const file = WHOLE_RUN_FILE;
  const result = await run(settings.whole_argv, root, settings.whole_timeout_seconds * 1000, settings.output_limit_bytes);
  const base = { file, duration_ms: result.duration_ms, exit_code: result.exit_code, attempts: 1, output_tail: `${result.stdout}${result.stderr}`.slice(-settings.output_tail_chars) };
  const synthetic = (message: string): TestFailure[] => [{ file, name: "", line: 0, message: message.slice(0, SYNTHETIC_MESSAGE_CHARS) }];
  if (result.timed_out) return done("completed", null, [{ ...base, status: "timed_out", failures: synthetic(`timed out after ${settings.whole_timeout_seconds}s`) }]);
  if (result.error !== undefined) return done("completed", null, [{ ...base, status: "error", failures: synthetic(result.error) }]);
  if (result.exit_code === 0) return done("completed", null, [{ ...base, status: "passed", failures: [] }]);
  const tap = parseTapFailures(result.stdout, root);
  const parsed = (tap.length > 0 ? tap : parseBunFailures(`${result.stderr}\n${result.stdout}`)).map((failure) => ({ ...failure, file }));
  return done("completed", null, [{ ...base, status: "failed", failures: parsed.length > 0 ? parsed : synthetic(lastLine(result.stderr) || lastLine(result.stdout)) }]);
}

/** Runs prepare once, then each file in its own process (concurrency at a time); failed files are re-run alone up to flaky_retries times. */
export async function runTestFiles(input: {
  root: string;
  files: readonly string[];
  settings: TestRunSettings;
  run: TestCommandRunner;
  signal?: AbortSignal;
}): Promise<TestExecution> {
  const { root, files, settings, run, signal } = input;
  const started = Date.now();
  const fail = (error: string, results: readonly TestFileResult[] = []): TestExecution => ({ status: "error", error, files: results, duration_ms: Date.now() - started });
  const prepareError = await prepareCheckout({ root, settings, run });
  if (prepareError !== null) return fail(prepareError);
  const aborted = (): boolean => signal?.aborted === true;
  const results: TestFileResult[] = [];
  const queue = [...files];
  const workers = Math.min(queue.length, settings.concurrency ?? Math.max(1, Math.floor(availableParallelism() / 2)));
  await Promise.all(Array.from({ length: workers }, async () => {
    for (let file = queue.shift(); file !== undefined && !aborted(); file = queue.shift()) {
      let result = await runOneFile(file, root, settings, run);
      let attempts = 1;
      let duration_ms = result.duration_ms;
      while (result.status !== "passed" && attempts <= settings.flaky_retries && !aborted()) {
        result = await runOneFile(file, root, settings, run);
        duration_ms += result.duration_ms;
        attempts += 1;
      }
      results.push({ ...result, duration_ms, attempts });
    }
  }));
  results.sort((a, b) => a.file.localeCompare(b.file));
  return aborted() ? fail("aborted", results) : { status: "completed", error: null, files: results, duration_ms: Date.now() - started };
}

/** error: the run did not go through; failed: some file has an in_scope failure; otherwise passed. */
export function testRunStatus(execution: TestExecution, classified: NewTestRun["classified"]): "passed" | "failed" | "error" {
  if (execution.status === "error") return "error";
  const failing = execution.files.some((file) => {
    if (file.status === "passed") return false;
    const failures = classified.get(file.file) ?? file.failures.map(inScope);
    return failures.length === 0 || failures.some((f) => f.classification === "in_scope");
  });
  return failing ? "failed" : "passed";
}

/** Writes test_runs and its test_run_files rows; returns the run id. */
export function recordTestRunInTransaction(tx: CoreWriteLaneTransaction, run: NewTestRun, now: string): string {
  const id = run.id ?? createUlid();
  tx.run(
    `INSERT INTO test_runs (id, project_id, work_id, task_id, agent_run_id, scope, mode, commit_sha, base_commit, status, selection_json, started_at, finished_at, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, run.project_id, run.work_id, run.task_id, run.agent_run_id, run.scope, run.mode, run.commit_sha, run.base_commit,
    testRunStatus(run.execution, run.classified), JSON.stringify(run.selection), run.started_at, now, run.execution.duration_ms, run.execution.error,
  );
  for (const file of run.execution.files) {
    const failures = run.classified.get(file.file) ?? file.failures.map(inScope);
    tx.run(
      `INSERT INTO test_run_files (run_id, file, status, duration_ms, exit_code, attempts, failures_json, output_tail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, file.file, file.status, file.duration_ms, file.exit_code, file.attempts, JSON.stringify(failures), file.output_tail,
    );
  }
  return id;
}

interface RunRow { id: string; project_id: string; work_id: string | null; task_id: string | null; scope: TestRunScope; mode: "full" | "selected"; commit_sha: string; status: "passed" | "failed" | "error"; finished_at: string }
interface FileRow { file: string; status: TestFileStatus; failures_json: string }

function loadRecord(db: Pick<CoreDatabase, "all">, row: RunRow | undefined): TestRunRecord | null {
  if (row === undefined) return null;
  const files = db.all<FileRow>("SELECT file, status, failures_json FROM test_run_files WHERE run_id = ? ORDER BY file", row.id);
  return { ...row, files: files.map((f) => ({ file: f.file, status: f.status, failures: JSON.parse(f.failures_json) as ClassifiedFailure[] })) };
}

const RUN_COLUMNS = "id, project_id, work_id, task_id, scope, mode, commit_sha, status, finished_at";

/** The newest passed/failed run of a Task or a Work (error runs are not a basis for the next selection). */
export function latestTestRun(db: Pick<CoreDatabase, "get" | "all">, filter: { scope: "task"; task_id: string } | { scope: "work"; work_id: string }): TestRunRecord | null {
  const row = filter.scope === "task"
    ? db.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM test_runs WHERE scope = 'task' AND task_id = ? AND status IN ('passed', 'failed') ORDER BY rowid DESC LIMIT 1`, filter.task_id)
    : db.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM test_runs WHERE scope = 'work' AND work_id = ? AND status IN ('passed', 'failed') ORDER BY rowid DESC LIMIT 1`, filter.work_id);
  return loadRecord(db, row);
}

/** The baseline result at a commit: the newest passed/failed run's fields, with every file any such run covered (newest result per file). */
export function baselineTestRun(db: Pick<CoreDatabase, "get" | "all">, projectId: string, commit: string): TestRunRecord | null {
  const rows = db.all<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM test_runs WHERE scope = 'baseline' AND project_id = ? AND commit_sha = ? AND status IN ('passed', 'failed') ORDER BY rowid DESC`,
    projectId, commit,
  );
  const newest = loadRecord(db, rows[0]);
  if (newest === null) return null;
  const files = new Map(newest.files.map((entry) => [entry.file, entry]));
  for (const row of rows.slice(1)) {
    for (const entry of loadRecord(db, row)?.files ?? []) if (!files.has(entry.file)) files.set(entry.file, entry);
  }
  return { ...newest, files: [...files.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)) };
}

/** Failure summaries for an agent: messages cut to brief_message_chars, at most brief_max_failures. */
export function testFailureBriefs(failures: readonly TestFailure[], settings: TestRunSettings): TestFailureBriefs {
  return {
    failures: failures.slice(0, settings.brief_max_failures).map((f) => ({ file: f.file, name: f.name, line: f.line ?? 0, message: f.message.slice(0, settings.brief_message_chars) })),
    omitted_count: Math.max(0, failures.length - settings.brief_max_failures),
  };
}
