import { join } from "node:path";
import type { TestRunSettings } from "../../shared/dist/test-run-settings.js";
import { testFailureKey, withDetachedWorktree } from "./nightly-tests";
import {
  baselineTestRun,
  recordTestRunInTransaction,
  runTestFiles,
  type ClassifiedFailure,
  type TestCommandRunner,
  type TestFileResult,
  type TestRunRecord,
} from "./test-runs";
import type { CoreDatabase } from "./types";

export interface TriageInput {
  readonly files: readonly TestFileResult[];
  /** Failure keys (testFailureKey) of the Project's latest passed/failed nightly run. */
  readonly nightlyKeys: ReadonlySet<string>;
  /** Result at the base commit; null = no baseline could be taken (everything is in_scope). */
  readonly baseline: TestRunRecord | null;
  /** Files the Work changed from the base. */
  readonly workChangedFiles: ReadonlySet<string>;
}

/** Pure. file -> classified failures. A failure of a whole file (no test name) is pre-existing only through the nightly run. */
export function triageTestFailures(input: TriageInput): Map<string, ClassifiedFailure[]> {
  const baselineKeys = new Map<string, Set<string>>();
  for (const entry of input.baseline?.files ?? []) baselineKeys.set(entry.file, new Set(entry.failures.map(testFailureKey)));
  const result = new Map<string, ClassifiedFailure[]>();
  for (const file of input.files) {
    result.set(file.file, file.failures.map((failure): ClassifiedFailure => {
      const key = testFailureKey(failure);
      if (input.nightlyKeys.has(key)) return { ...failure, classification: "pre_existing", pre_existing_by: "nightly" };
      if (failure.name !== "" && !input.workChangedFiles.has(failure.file) && baselineKeys.get(failure.file)?.has(key) === true) {
        return { ...failure, classification: "pre_existing", pre_existing_by: "baseline" };
      }
      return { ...failure, classification: "in_scope", pre_existing_by: null };
    }));
  }
  return result;
}

export interface EnsureBaselineDeps {
  readonly db: Pick<CoreDatabase, "get" | "all">;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly settings: TestRunSettings;
  readonly projectId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly files: readonly string[];
  readonly workspaceRoot: string;
  readonly run: TestCommandRunner;
  readonly locks: Map<string, Promise<unknown>>;
}

/** Returns the baseline result covering `files`, running only the missing files; null when no usable baseline exists. */
export async function ensureBaselineRun(deps: EnsureBaselineDeps): Promise<TestRunRecord | null> {
  const previous = deps.locks.get(deps.projectId) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => runBaseline(deps));
  deps.locks.set(deps.projectId, task);
  try {
    return await task;
  } finally {
    if (deps.locks.get(deps.projectId) === task) deps.locks.delete(deps.projectId);
  }
}

async function runBaseline(deps: EnsureBaselineDeps): Promise<TestRunRecord | null> {
  const cached = baselineTestRun(deps.db, deps.projectId, deps.baseCommit);
  const have = new Set(cached?.files.map((entry) => entry.file));
  const missing = deps.files.filter((file) => !have.has(file));
  if (cached !== null && missing.length === 0) return cached;

  const path = join(deps.workspaceRoot, "test-baseline", deps.projectId.replace(/[^A-Za-z0-9_-]/gu, "_"));
  const startedAt = new Date().toISOString();
  const execution = await withDetachedWorktree(
    { repo: deps.repo, commit: deps.baseCommit, path },
    (root) => runTestFiles({ root, files: missing, settings: deps.settings, run: deps.run }),
  );
  await deps.writeLane.transact((tx) => {
    recordTestRunInTransaction(tx, {
      project_id: deps.projectId,
      work_id: null,
      task_id: null,
      agent_run_id: null,
      scope: "baseline",
      mode: "selected",
      commit_sha: deps.baseCommit,
      base_commit: null,
      selection: { mode: "selected", files: missing, previous_failed: [], changed_tests: [], related: [], required: [], full_reason: null, changed_files_count: 0 },
      started_at: startedAt,
      execution,
      classified: new Map(),
    }, new Date().toISOString());
  });
  if (execution.status === "error") return null;
  // Covers the cached files too: baselineTestRun gathers every run at the commit.
  return baselineTestRun(deps.db, deps.projectId, deps.baseCommit);
}
