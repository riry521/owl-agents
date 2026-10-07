import { OWL_INSTANCE_ID_ENV } from "@owl/shared";
import { createUlid } from "../../db/dist/index.js";
import type { TestRunSettings } from "../../shared/dist/test-run-settings.js";
import { spawnTestCommand, testFailureKey, type TestFailure } from "./nightly-tests";
import { ownerLanguage } from "./owner-language";
import {
  registerQuarantineBacklogInTransaction,
  pruneMissingQuarantineInTransaction,
  quarantineFilesInTransaction,
  quarantinedFiles,
  releaseQuarantinedFilesInTransaction,
} from "./test-quarantine";
import { ensureBaselineRun, triageTestFailures } from "./test-failure-triage";
import {
  latestTestRun,
  listTestFiles,
  recordTestRunInTransaction,
  runTestFiles,
  runWholeSuite,
  selectTests,
  WHOLE_RUN_FILE,
  testFailureBriefs,
  testRunStatus,
  type ClassifiedFailure,
  type TestCommandRunner,
  type TestFailureBriefs,
  type TestSelection,
} from "./test-runs";
import type { CoreDatabase } from "./types";
import { workVerificationMarker } from "./workspace-process-sweeper";

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
  readonly run: TestCommandRunner;
  readonly signal?: AbortSignal;
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
  /** Why no tests ran (not_applicable only). */
  readonly reason?: string | null;
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
  const previous = latestTestRun(deps.db, req.scope === "task" && req.task_id !== null ? { scope: "task", task_id: req.task_id } : { scope: "work", work_id: req.work_id });
  const whole = req.settings.mode === "whole";
  const allTestFiles = whole ? [] : await listTestFiles(req.root, req.settings);
  const selected: TestSelection = whole
    ? { mode: "full", files: [WHOLE_RUN_FILE], previous_failed: [], changed_tests: [], related: [], required: [], full_reason: "whole_command", changed_files_count: req.changed_files.length }
    : await selectTests({
      scope: req.scope,
      root: req.root,
      testFiles: allTestFiles,
      changedFiles: req.changed_files,
      previous,
      requiredTests: req.required_tests,
      forceFull: req.force_full,
      settings: req.settings,
    });
  // Only the Work-level run skips quarantined files, and never one the Work touched (it may have fixed it).
  const workChangedSet = new Set(req.work_changed_files);
  const skipped = whole || req.scope !== "work" ? [] : quarantinedFiles(deps.db, req.project_id).filter((file) => selected.files.includes(file) && !workChangedSet.has(file));
  const selection: TestSelection = {
    ...selected,
    ...(skipped.length > 0 ? { files: selected.files.filter((file) => !skipped.includes(file)), quarantined: skipped } : {}),
    ...(req.dirty ? { dirty: true } : {}), ...(req.change_digest ? { change_digest: req.change_digest } : {}),
  };
  if (selection.files.length === 0) {
    return { run_id: null, status: "skipped", mode: selection.mode, selection, passed_files: [], failed_files: [], in_scope: [], pre_existing: [], error: null };
  }

  const startedAt = new Date().toISOString();
  const execution = whole
    ? await runWholeSuite({ root: req.root, settings: req.settings, run: req.run, signal: req.signal })
    : await runTestFiles({ root: req.root, files: selection.files, settings: req.settings, run: req.run, signal: req.signal });
  // A whole-command run is judged by its exit code alone: no nightly or baseline triage.
  const nightlyKeys = whole ? new Set<string>() : latestNightlyKeys(deps.db, req.project_id);
  const workChanged = new Set(req.work_changed_files);
  // A baseline is only worth taking for failures that could be old ones: not in the latest nightly, in a test file the Work left alone.
  const candidates = [...new Set(execution.files.flatMap((file) => file.failures
    .filter((failure) => failure.name !== "" && !nightlyKeys.has(testFailureKey(failure)) && !workChanged.has(failure.file))
    .map((failure) => failure.file)))];
  let baseline = null;
  if (!whole && execution.status === "completed" && candidates.length > 0 && req.base_commit !== null) {
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
  const classified = triageTestFailures({ files: execution.files, nightlyKeys, baseline, workChangedFiles: workChanged });
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
      if (!whole) {
        const now = new Date().toISOString();
        const entries = execution.files.flatMap((file) => {
          const old = (classified.get(file.file) ?? []).filter((f) => f.classification === "pre_existing");
          return file.status !== "passed" && old.length > 0 ? [{ file: file.file, classified_by: old[0].pre_existing_by ?? "baseline", failures: old }] : [];
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
        if (req.scope === "work") pruneMissingQuarantineInTransaction(tx, req.project_id, allTestFiles);
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
  return { run_id: runId, status, mode: selection.mode, selection, passed_files: passedFiles, failed_files: failedFiles, in_scope: inScope, pre_existing: preExisting, error: execution.error };
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
  return { run_id: null, status: "not_applicable", mode: "full", selection, passed_files: [], failed_files: [], in_scope: [], pre_existing: [], error: null, reason };
}

/** The run could not start (Git failed); it counts as failing, never as skipped. */
export function coreTestErrorOutcome(error: unknown): CoreTestRunOutcome {
  return { ...notApplicableTestRun(""), status: "error", reason: null, error: error instanceof Error ? error.message : String(error) };
}

/**
 * A runner that starts real processes for a Work-level or baseline run. The marker env
 * lets the workspace sweeper reclaim them after a crash.
 */
export function workTestRunner(input: { readonly workId: string; readonly envAllowlist: readonly string[]; readonly instanceId: string; readonly signal?: AbortSignal }): TestCommandRunner {
  const env: Record<string, string> = {};
  for (const key of new Set(["PATH", "HOME", ...input.envAllowlist])) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env[OWL_INSTANCE_ID_ENV] = input.instanceId;
  env.OWL_AGENT_RUN_ID = workVerificationMarker(input.workId);
  return (argv, cwd, timeoutMs, outputLimitBytes, onOutput) => spawnTestCommand(argv, cwd, env, timeoutMs, outputLimitBytes, input.signal, onOutput);
}
