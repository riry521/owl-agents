import { OWL_INSTANCE_ID_ENV } from "@owl/shared";
import { createUlid } from "../../db/dist/index.js";
import type { TestRunSettings } from "../../shared/dist/test-run-settings.js";
import type { TestSetupSettings } from "../../shared/dist/test-setup-settings.js";
import { spawnTestCommand, testFailureKey, type TestFailure } from "./nightly-tests";
import { ownerLanguage } from "./owner-language";
import { executionEnvironmentFailure, type TestEnvironmentFailure } from "./test-environment";
import {
  registerQuarantineBacklogInTransaction,
  pruneMissingQuarantineInTransaction,
  quarantineFilesInTransaction,
  quarantinedFiles,
  releaseQuarantinedFilesInTransaction,
} from "./test-quarantine";
import { ensureBaselineRun, triageTestFailures } from "./test-failure-triage";
import {
  invalidateSetupCache,
  latestTestRun,
  listTestTargets,
  targetCommand,
  recordTestRunInTransaction,
  runTestFiles,
  runWholeSuite,
  selectTests,
  WHOLE_RUN_FILE,
  WHOLE_DEFERRED_REASON,
  testFailureBriefs,
  testRunStatus,
  type ClassifiedFailure,
  type TestCommandRunner,
  type TestExecution,
  type TestFileResult,
  type TestFailureBriefs,
  type TestSelection,
} from "./test-runs";
import type { CoreDatabase } from "./types";
import { workVerificationMarker } from "./workspace-process-sweeper";

export { WHOLE_DEFERRED_REASON };

export interface CoreTestRunRequest {
  readonly scope: "task" | "work";
  readonly project_id: string;
  readonly work_id: string;
  readonly task_id: string | null;
  readonly agent_run_id: string | null;
  /** Checkout the tests run in. */
  readonly root: string;
  readonly commit: string;
  readonly base_commit: string | null;
  /** The Project's canonical repository (the baseline checkout is made from it). */
  readonly repo: string;
  /** What the selection is based on. */
  readonly changed_files: readonly string[];
  /** What the Work changed against the base; a failure in an unchanged test file can be pre-existing. */
  readonly work_changed_files: readonly string[];
  readonly required_tests: readonly string[];
  readonly force_full: string | null;
  readonly dirty?: boolean;
  readonly change_digest?: Readonly<Record<string, string>>;
  readonly settings: TestRunSettings;
  /** Failures the Project's test setup recorded as already failing. */
  readonly known_failures?: readonly { readonly file: string; readonly name: string }[];
  readonly run: TestCommandRunner;
  readonly signal?: AbortSignal;
  /** Tells an environment failure from a code failure; without it nothing is classified. */
  readonly environment_signals?: TestSetupSettings["environment"];
}

export interface CoreTestRunOutcome {
  /** null when nothing was selected: no run was recorded. */
  readonly run_id: string | null;
  readonly status: "passed" | "failed" | "error" | "skipped" | "not_applicable";
  readonly mode: "full" | "selected";
  readonly selection: TestSelection;
  /** Includes files whose only failures are pre-existing. */
  readonly passed_files: readonly string[];
  /** Files with an in_scope failure (error and timed_out included). */
  readonly failed_files: readonly string[];
  readonly in_scope: readonly ClassifiedFailure[];
  readonly pre_existing: readonly ClassifiedFailure[];
  readonly error: string | null;
  /** The failure came from the test environment, not the code: the baseline was not consulted. */
  readonly environment: TestEnvironmentFailure | null;
  /** Why no tests ran (not_applicable only). */
  readonly reason?: string | null;
  /** Test files inside the folder or package units of passed_files / failed_files; absent for unit file and whole, where those lists already name the files. */
  readonly test_files?: { readonly passed: readonly string[]; readonly failed: readonly string[] };
}

export interface CoreTestRunBrief {
  readonly run_id: string | null;
  readonly status: CoreTestRunOutcome["status"];
  readonly mode: "full" | "selected";
  readonly files_run: number;
  readonly failed_files: readonly string[];
  /** in_scope only. */
  readonly failures: TestFailureBriefs;
  /** Reference only; these are backlogged. */
  readonly pre_existing: TestFailureBriefs;
  readonly error: string | null;
  readonly reason?: string | null;
}

export interface CoreTestRunDeps {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly workspaceRoot: string;
  readonly baselineRunner: TestCommandRunner;
  readonly baselineLocks: Map<string, Promise<unknown>>;
}

function latestNightlyKeys(db: Pick<CoreDatabase, "get">, projectId: string): Set<string> {
  const row = db.get<{ failures_json: string }>(
    "SELECT failures_json FROM nightly_test_runs WHERE project_id = ? AND status IN ('passed', 'failed') ORDER BY rowid DESC LIMIT 1",
    projectId,
  );
  if (!row) return new Set();
  try {
    return new Set((JSON.parse(row.failures_json) as TestFailure[]).map(testFailureKey));
  } catch {
    return new Set();
  }
}

/** Select, run, triage and record: the one path both a Task check and a Work check take. */
export async function runCoreTests(deps: CoreTestRunDeps, req: CoreTestRunRequest): Promise<CoreTestRunOutcome> {
  // Why not run it at Task level: a whole suite costs minutes per Task; the Work-level run still covers every change.
  if (req.settings.mode === "whole" && req.scope === "task") {
    return { ...notApplicableTestRun(WHOLE_DEFERRED_REASON), status: "skipped" };
  }
  const previous = latestTestRun(deps.db, req.scope === "task" && req.task_id !== null ? { scope: "task", task_id: req.task_id } : { scope: "work", work_id: req.work_id });
  const whole = req.settings.mode === "whole";
  const targets = whole ? null : await listTestTargets(req.root, req.settings);
  const selected: TestSelection = whole
    ? { mode: "full", files: [WHOLE_RUN_FILE], previous_failed: [], changed_tests: [], related: [], required: [], full_reason: "whole_command", changed_files_count: req.changed_files.length }
    : await selectTests({
      scope: req.scope,
      root: req.root,
      testFiles: targets?.files ?? [],
      targets: targets ?? undefined,
      changedFiles: req.changed_files,
      previous,
      requiredTests: req.required_tests,
      forceFull: req.force_full,
      settings: req.settings,
    });
  // Only the Work-level run skips quarantined files, and never one the Work touched (it may have fixed it).
  // A file holding a known failure always runs: the known failure only hides itself, and skipping the file would hide new failures in it too.
  const unitOf = (path: string): string | null => targets?.targetOf(path) ?? null;
  const touched = new Set(req.work_changed_files.flatMap((file) => unitOf(file) ?? []));
  const knownFiles = new Set(whole ? [] : (req.known_failures ?? []).map((failure) => unitOf(failure.file) ?? failure.file));
  const skipped = whole || req.scope !== "work" ? [] : quarantinedFiles(deps.db, req.project_id).filter((file) => selected.files.includes(file) && !touched.has(file) && !knownFiles.has(file));
  const selection: TestSelection = {
    ...selected,
    ...(skipped.length > 0 ? { files: selected.files.filter((file) => !skipped.includes(file)), quarantined: skipped } : {}),
    ...(req.dirty ? { dirty: true } : {}), ...(req.change_digest ? { change_digest: req.change_digest } : {}),
  };
  if (selection.files.length === 0) {
    return { run_id: null, status: "skipped", mode: selection.mode, selection, passed_files: [], failed_files: [], in_scope: [], pre_existing: [], error: null, environment: null, ...(!whole && req.settings.unit !== "file" ? { test_files: { passed: [], failed: [] } } : {}) };
  }

  const startedAt = new Date().toISOString();
  const execute = (): Promise<TestExecution> => whole
    ? runWholeSuite({ root: req.root, settings: req.settings, run: req.run, signal: req.signal })
    : runTestFiles({ root: req.root, files: selection.files, settings: req.settings, run: req.run, signal: req.signal });
  // Before the baseline: a missing tool fails the base commit the same way, and would read as an old failure.
  const environmentOf = (result: TestExecution): TestEnvironmentFailure | null => req.environment_signals === undefined ? null : executionEnvironmentFailure(
    result,
    (file) => (whole ? req.settings.whole_argv : targetCommand(req.root, req.settings, file.file).argv),
    req.environment_signals,
    new Set((req.known_failures ?? []).map(testFailureKey)),
  );
  let ran = await execute();
  let environment = environmentOf(ran);
  // A skipped prepare may have left a broken environment (a half-deleted .venv): prepare once more and run again. A run that prepared is not repeated.
  if (environment !== null && ran.prepare_skipped === true) {
    await invalidateSetupCache(req.root);
    ran = await execute();
    environment = environmentOf(ran);
  }
  const execution = environment === null || ran.status === "error" ? ran : { ...ran, status: "error" as const, error: `test environment: ${environment.signal}` };
  // A whole-command run is judged by its exit code alone: no nightly or baseline triage.
  const nightlyKeys = whole ? new Set<string>() : latestNightlyKeys(deps.db, req.project_id);
  const workChanged = new Set(req.work_changed_files);
  const knownKeys = new Set((req.known_failures ?? []).map(testFailureKey));
  // A baseline is only worth taking for failures that could be old ones: not in the latest nightly, in a test file the Work left alone.
  // A folder or package unit is the baseline row, so the candidate is the unit that produced the failure, not the file inside it.
  const byUnit = !whole && req.settings.unit !== "file";
  const candidates = [...new Set(execution.files.flatMap((file) => file.failures
    .filter((failure) => failure.name !== "" && !nightlyKeys.has(testFailureKey(failure)) && !knownKeys.has(testFailureKey(failure)) && !workChanged.has(failure.file))
    .map((failure) => (byUnit ? file.file : failure.file))))];
  let baseline = null;
  if (!whole && environment === null && execution.status === "completed" && candidates.length > 0 && req.base_commit !== null) {
    baseline = await ensureBaselineRun({
      db: deps.db,
      writeLane: deps.writeLane,
      settings: req.settings,
      projectId: req.project_id,
      repo: req.repo,
      baseCommit: req.base_commit,
      files: candidates,
      workspaceRoot: deps.workspaceRoot,
      run: deps.baselineRunner,
      locks: deps.baselineLocks,
    }).catch((error: unknown) => {
      console.warn("[owl-core] The baseline test run failed; failures are treated as in scope.", error);
      return null;
    });
  }
  const classified = triageTestFailures({ files: execution.files, nightlyKeys, baseline, workChangedFiles: workChanged, knownKeys, ...(byUnit ? { baselineFileOf: (entry: TestFileResult) => entry.file } : {}) });
  const status = testRunStatus(execution, classified);
  const runId = createUlid();
  const passedFiles: string[] = [];
  const failedFiles: string[] = [];
  const inScope: ClassifiedFailure[] = [];
  const preExisting: ClassifiedFailure[] = [];
  for (const file of execution.files) {
    const failures = file.status === "passed" ? [] : classified.get(file.file) ?? [];
    inScope.push(...failures.filter((f) => f.classification === "in_scope"));
    preExisting.push(...failures.filter((f) => f.classification === "pre_existing"));
    const failing = file.status !== "passed" && (failures.length === 0 || failures.some((f) => f.classification === "in_scope"));
    (failing ? failedFiles : passedFiles).push(file.file);
  }
  const record = {
    id: runId,
    project_id: req.project_id,
    work_id: req.work_id,
    task_id: req.scope === "task" ? req.task_id : null,
    agent_run_id: req.agent_run_id,
    scope: req.scope,
    mode: selection.mode,
    commit_sha: req.commit,
    base_commit: req.base_commit,
    selection,
    started_at: startedAt,
    execution,
    classified,
  } as const;
  await deps.writeLane.write({
    mutateState: (tx) => {
      recordTestRunInTransaction(tx, record, new Date().toISOString());
      // Files that fail on the base too are quarantined (and listed in one backlog item per Project); a whole-command run cannot name files.
      // A file that also has a new failure stays out: quarantining it would hide that failure from the next Work-level run.
      if (targets !== null && environment === null) {
        const now = new Date().toISOString();
        const entries = execution.files.flatMap((file) => {
          const failures = classified.get(file.file) ?? [];
          const old = failures.filter((f) => f.classification === "pre_existing");
          // Matched by the recorded files, not pre_existing_by: a known failure the nightly run also names is triaged as nightly.
          if (knownFiles.has(file.file)) return [];
          return file.status !== "passed" && old.length > 0 && old.length === failures.length ? [{ file: file.file, classified_by: old[0].pre_existing_by === "nightly" ? "nightly" as const : "baseline" as const, failures: old }] : [];
        });
        quarantineFilesInTransaction(tx, req.project_id, entries, now);
        if (entries.length > 0) {
          try {
            registerQuarantineBacklogInTransaction(tx, req.project_id, ownerLanguage(deps.db), now);
          } catch (error) {
            // The test result is already decided; the next quarantine registers the item again.
            console.warn("[owl-core] Registering the quarantine backlog item failed.", error);
          }
        }
        releaseQuarantinedFilesInTransaction(tx, req.project_id, execution.files.filter((file) => file.status === "passed").map((file) => file.file));
        if (req.scope === "work") pruneMissingQuarantineInTransaction(tx, req.project_id, targets.targets);
      }
    },
    event: {
      idempotencyKey: `test-run-completed:${runId}`,
      type: "test_run.completed",
      workId: req.work_id,
      taskId: record.task_id,
      payload: {
        schema_version: "1.0.0",
        run_id: runId,
        project_id: req.project_id,
        work_id: req.work_id,
        task_id: record.task_id,
        scope: req.scope,
        mode: selection.mode,
        status,
        file_count: execution.files.length,
        failed_file_count: failedFiles.length,
        pre_existing_count: preExisting.length,
        quarantined_count: skipped.length,
      },
    },
    outbox: [{ provider: "websocket" }],
  });
  const testFilesIn = (units: readonly string[]): string[] => (targets?.files ?? []).filter((file) => units.includes(unitOf(file) ?? ""));
  return {
    run_id: runId, status, mode: selection.mode, selection, passed_files: passedFiles, failed_files: failedFiles, in_scope: inScope, pre_existing: preExisting, error: execution.error, environment,
    ...(byUnit ? { test_files: { passed: testFilesIn(passedFiles), failed: testFilesIn(failedFiles) } } : {}),
  };
}

/** The shape an agent (and the event log) gets: names and message summaries, never raw output. */
export function coreTestRunBrief(outcome: CoreTestRunOutcome, settings: TestRunSettings): CoreTestRunBrief {
  return {
    run_id: outcome.run_id,
    status: outcome.status,
    mode: outcome.mode,
    files_run: outcome.passed_files.length + outcome.failed_files.length,
    failed_files: outcome.failed_files,
    failures: testFailureBriefs(outcome.in_scope, settings),
    pre_existing: testFailureBriefs(outcome.pre_existing, settings),
    error: outcome.error,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

/** No test ran because the Project has none (or Core is told not to run them); nothing is recorded in test_runs. */
export function notApplicableTestRun(reason: string): CoreTestRunOutcome {
  const selection: TestSelection = { mode: "full", files: [], previous_failed: [], changed_tests: [], related: [], required: [], full_reason: null, changed_files_count: 0 };
  return { run_id: null, status: "not_applicable", mode: "full", selection, passed_files: [], failed_files: [], in_scope: [], pre_existing: [], error: null, environment: null, reason };
}

/** The run could not start (Git failed); it counts as failing, never as skipped. */
export function coreTestErrorOutcome(error: unknown): CoreTestRunOutcome {
  return { ...notApplicableTestRun(""), status: "error", reason: null, error: error instanceof Error ? error.message : String(error) };
}

/** The environment a Core child process gets: PATH, HOME and the allowlisted variables from Core's own, then the settings' run_env on top. */
export function childEnv(envAllowlist: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of new Set(["PATH", "HOME", ...envAllowlist])) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extraEnv };
}

/**
 * A runner that starts real processes for a Work-level or baseline run. The marker env
 * lets the workspace sweeper reclaim them after a crash.
 */
export function workTestRunner(input: { readonly workId: string; readonly envAllowlist: readonly string[]; readonly extraEnv?: Readonly<Record<string, string>>; readonly instanceId: string; readonly signal?: AbortSignal }): TestCommandRunner {
  const env = childEnv(input.envAllowlist, input.extraEnv);
  env[OWL_INSTANCE_ID_ENV] = input.instanceId;
  env.OWL_AGENT_RUN_ID = workVerificationMarker(input.workId);
  return (argv, cwd, timeoutMs, outputLimitBytes, onOutput) => spawnTestCommand(argv, cwd, env, timeoutMs, outputLimitBytes, input.signal, onOutput);
}
