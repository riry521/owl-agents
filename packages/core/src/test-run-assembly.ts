import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveInstanceId } from "@owl/shared";
import { GitWorktreeGateway } from "./git-gateway.js";
import { type CoreActivityReporter } from "./core-activity.js";
import { childEnv, coreTestErrorOutcome, notApplicableTestRun, runCoreTests, workTestRunner, type CoreTestRunDeps, type CoreTestRunOutcome } from "./core-test-run.js";
import { DEFAULT_TEST_RUN_SETTINGS, runArgvOf, type TestRunSettings } from "../../shared/dist/test-run-settings.js";
import { type TestDetectionRules } from "./test-detection-rules.js";
import { markerReader, reportCheckCommands, resolveTestRun, testDetectionMarkerDigest, testDetectionRulesVersion, type TestRunResolution } from "./test-detection.js";
import { explicitTestRunDigest, isLegacyWholeSetup, readStoredTestSetup, selectTestSetupInCheckout, testExecutables, testSetupDigests, type KnownFailure, type StoredTestSetup, type TestSetupSelection } from "./test-setup.js";
import { testSetupSettings } from "./test-setup-settings.js";
import type { TestSetupSettings } from "../../shared/dist/test-setup-settings.js";
import type { TestSetupService } from "./test-setup-service.js";
import { execInstallQuery, gatedTestRunner } from "./test-setup-install-guard.js";
import { latestTestRun, type TestCommandRunner } from "./test-runs.js";
import { type TaskVerificationSpec } from "./task-verification-policy.js";
import type { CoreDatabase, GitGateway, JsonObject, TaskRow } from "./types";
import { approvedInstallArgvs, type TestEnvironmentBlock, type TestEnvironmentFailure } from "./test-environment";

export type TestRunResolutionWithExecutables = TestRunResolution & {
  readonly executables: Record<string, string>;
  /** Commands outside the Project that the Owner has approved in the saved setup. */
  readonly approved_installs: readonly (readonly string[])[];
  /** The record a passing run makes the record of this place; null when none is to be adopted. */
  readonly adopt_record: StoredTestSetup | null;
  /** Failures the used record knows were already failing. */
  readonly known_failures: readonly KnownFailure[];
};

/** Where a test run happens: the Task worktree or the Work checkout. */
export interface TestRunPlace {
  readonly scope: "work" | "task";
  readonly work_id: string;
  readonly task_id: string | null;
}

export interface ProjectTestRunRow {
  readonly id: string;
  readonly canonical_path: string;
  readonly test_run_json: string | null;
  readonly test_run_detected_json: string | null;
  readonly report_check_commands_json: string | null;
  readonly setup_records: readonly StoredTestSetup[];
}

const execFileAsync = promisify(execFile);

export interface TestRunAssemblerDeps {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly git: GitGateway;
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly testCommandRunner?: TestCommandRunner;
  readonly coreActivity: CoreActivityReporter;
  readonly testDetectionRules: TestDetectionRules;
  readonly testSetup?: TestSetupService;
  /** Serialises baseline checkouts per Project (one path each). */
  readonly baselineLocks: Map<string, Promise<unknown>>;
  readonly taskIsVerifying: (taskId: string) => boolean;
  readonly runVerificationCommand: (
    taskId: string,
    argv: readonly string[],
    cwd: string,
    envAllowlist: readonly string[],
    timeoutMs: number,
    stdoutLimit: number,
    stderrLimit: number,
    expectedExitCodes: readonly number[],
    taskMustBeVerifying: boolean,
  ) => Promise<JsonObject>;
}

/** Resolves a Project's test run and runs Core's tests for a Task or a Work. Split out of WorkflowEngine; behaviour is unchanged. */
export class TestRunAssembler {
  public constructor(private readonly deps: TestRunAssemblerDeps) {}

  /**
   * Core's own run of the tests related to what the Task changed (and the ones that failed last time).
   * null when the Project has no test_run settings; a non-Git checkout runs without a commit record.
   */
  public async runTaskCoreTests(workId: string, task: TaskRow, root: string, files: readonly string[], spec: TaskVerificationSpec, agentRunId: string | null, preResolved: TestRunResolutionWithExecutables | null = null): Promise<{ outcome: CoreTestRunOutcome; settings: TestRunSettings } | null> {
    const project = this.projectTestRunRow(workId, task.id);
    if (!project) return null;
    const git =(args: string[]): Promise<string> => execFileAsync("git", args, { cwd: root }).then((result) => result.stdout.trim());
    let commit: string;
    let dirty: boolean;
    let isGit = true;
    try {
      commit = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
      dirty = (await git(["status", "--porcelain"])).length > 0;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (/not a git repository/iu.test(stderr)) {
        // Why not skip the run: the Project's test settings still decide the verification; only the commit record is empty.
        console.warn(`[owl-core] Task ${task.id} is not in a Git checkout; running the Core tests without a commit.`);
        commit = "";
        dirty = false;
        isGit = false;
      } else {
        // A git failure (timeout, lock, I/O) is not proof of "no checkout": fail the verification instead of skipping the tests.
        console.error(`[owl-core] Task ${task.id}: git failed before the Core test run; verification fails.`, error);
        const message = `Core tests could not be started because git failed: ${error instanceof Error ? error.message : String(error)}`;
        return { outcome: { ...notApplicableTestRun(message), status: "error", error: message, reason: undefined }, settings: DEFAULT_TEST_RUN_SETTINGS };
      }
    }
    const resolved = preResolved ?? await this.resolveTaskVerificationTestRun(project, root, { scope: "task", work_id: workId, task_id: task.id });
    if (!resolved.enabled) return { outcome: notApplicableTestRun(resolved.reason), settings: DEFAULT_TEST_RUN_SETTINGS };
    const settings = resolved.settings;
    let baseCommit: string | null = null;
    try {
      // A non-Git checkout has no merge-base to compare against; git would throw here.
      if (isGit) baseCommit = await this.deps.git.projectBaseCommit?.({ work_id: workId, task_id: task.id, worktree_path: root }) ?? null;
    } catch (error) {
      return { outcome: coreTestErrorOutcome(error), settings };
    }
    const baseRun: TestCommandRunner = this.deps.testCommandRunner ?? (async (argv, cwd, timeoutMs, limit) => {
      const started = Date.now();
      const result = await this.deps.runVerificationCommand(task.id, argv, cwd, [...settings.env_allowlist, "HOME"], timeoutMs, limit, limit, [0], true);
      const error = typeof result.error === "string" ? result.error : undefined;
      return {
        exit_code: error !== undefined || typeof result.exit_code !== "number" ? null : result.exit_code,
        timed_out: result.timed_out === true,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        duration_ms: Date.now() - started,
        ...(error !== undefined ? { error } : {}),
      };
    });
    const run = this.gateTestRunner(baseRun, resolved, [...settings.env_allowlist, "HOME"], () => [root]);
    // Selection follows what changed since the previous check (committed or not); the Work-level change set stays cumulative.
    const digest: Record<string, string> = {};
    for (const file of files) {
      digest[file] = await readFile(join(root, file)).then((data) => createHash("sha256").update(data).digest("hex"), () => "");
    }
    const previousRun = latestTestRun(this.deps.db, { scope: "task", task_id: task.id });
    const previousRow = previousRun ? this.deps.db.get<{ selection_json: string }>("SELECT selection_json FROM test_runs WHERE id = ?", previousRun.id) : undefined;
    const before = previousRow ? (JSON.parse(previousRow.selection_json) as { change_digest?: Record<string, string> }).change_digest : undefined;
    const sinceChecked = before === undefined ? files : [...new Set([...Object.keys(digest), ...Object.keys(before)])].filter((file) => digest[file] !== before[file]);
    const outcome = await runCoreTests(this.coreTestRunDeps(workId, settings, (runner) => this.gateTestRunner(runner, resolved, settings.env_allowlist, (cwd) => [cwd])), {
      scope: "task",
      project_id: project.id,
      work_id: workId,
      task_id: task.id,
      agent_run_id: agentRunId,
      root,
      commit,
      base_commit: baseCommit,
      repo: project.canonical_path,
      changed_files: sinceChecked,
      change_digest: digest,
      // The Task's worktree forks from the Work branch, so its own change set is what decides "not changed by the Work" here.
      work_changed_files: files,
      required_tests: spec.required_tests ?? [],
      force_full: null,
      dirty,
      settings,
      known_failures: resolved.known_failures,
      run,
      environment_signals: this.environmentSignals(),
    });
    await this.adoptPassedSetup(resolved, outcome, settings, project.id, root, { scope: "task", work_id: workId, task_id: task.id });
    return { outcome, settings };
  }

  /**
   * Core's test run on the integrated Work branch. The first run selects the tests related to what the Work changed
   * against its base (the whole suite when the diff is unavailable or a full_run_pattern matches); later ones are the tests
   * that failed last time plus those related to what changed since. Pre-existing failures are triaged and
   * backlogged inside runCoreTests. null when the Project has no test_run settings or the checkout is unavailable.
   */
  public async runWorkCoreTests(workId: string): Promise<{ outcome: CoreTestRunOutcome; settings: TestRunSettings; environment_blocked: TestEnvironmentBlock | null } | null> {
    const project = this.projectTestRunRow(workId, null);
    const gateway = this.deps.git;
    if (!project || !gateway.withWorkCheckout || !gateway.diffPaths) return null;
    const previous = latestTestRun(this.deps.db, { scope: "work", work_id: workId });
    let settings: TestRunSettings = DEFAULT_TEST_RUN_SETTINGS;
    let blocked: TestEnvironmentBlock | null = null;
    // A checkout that cannot be prepared or restored is an error outcome, never a skipped run that lets the Work proceed.
    const outcome = await gateway.withWorkCheckout({ work_id: workId }, async (checkout) => {
      // The re-investigation and the run again finish here, before the checkout is cleaned up.
      const place: TestRunPlace = { scope: "work", work_id: workId, task_id: null };
      const recovered = await this.withTestSetupRecovery({
        project,
        place,
        checkout: checkout.path,
        run: () => this.runWorkCoreTestsIn(workId, this.projectTestRunRow(workId, null) ?? project, checkout, previous, (value) => { settings = value; }),
        environmentOf: (result) => result.environment,
      });
      blocked = recovered.blocked;
      return recovered.result;
    }).catch(coreTestErrorOutcome);
    return outcome === null ? null : { outcome, settings, environment_blocked: blocked };
  }

  private async runWorkCoreTestsIn(
    workId: string,
    project: ProjectTestRunRow,
    checkout: Parameters<NonNullable<GitWorktreeGateway["withWorkCheckout"]>>[1] extends (checkout: infer C) => unknown ? C : never,
    previous: ReturnType<typeof latestTestRun>,
    useSettings: (settings: TestRunSettings) => void,
  ): Promise<CoreTestRunOutcome> {
    const gateway = this.deps.git;
    {
      const resolved = await this.resolveProjectTestRun(project, checkout.path, { investigate: true, place: { scope: "work", work_id: workId, task_id: null } });
      if (!resolved.enabled) return notApplicableTestRun(resolved.reason);
      const settings = resolved.settings;
      useSettings(settings);
      // The baseline run happens in another checkout, so its roots are the place it runs in.
      const baseDeps = this.coreTestRunDeps(workId, settings, (runner) => this.gateTestRunner(runner, resolved, settings.env_allowlist, (cwd) => [cwd]));
      const baseRun: TestCommandRunner = this.gateTestRunner(
        this.deps.testCommandRunner ?? workTestRunner({ workId, envAllowlist: settings.env_allowlist, extraEnv: testSetupSettings(this.deps.db).run_env, instanceId: resolveInstanceId(this.deps.dataDir) }),
        resolved,
        settings.env_allowlist,
        () => [checkout.path],
      );
      const activity = this.deps.coreActivity(workId, "core_tests");
      // The baseline run (failure triage) is also Core's test command; report it so the activity does not look stalled.
      const deps: CoreTestRunDeps = {
        ...baseDeps,
        baselineRunner: (argv, cwd, timeoutMs, limit) => {
          activity.command(argv);
          return baseDeps.baselineRunner(argv, cwd, timeoutMs, limit, () => activity.output());
        },
      };
      let workChanged: readonly string[] | null;
      let sincePrevious: readonly string[] | null;
      try {
        workChanged = await gateway.diffPaths!({ work_id: workId, from: checkout.base_commit, to: checkout.commit });
        sincePrevious = previous === null ? workChanged : await gateway.diffPaths!({ work_id: workId, from: previous.commit_sha, to: checkout.commit });
      } catch (error) {
        await activity.end("error");
        throw error;
      }
      const run: TestCommandRunner = (argv, cwd, timeoutMs, limit) => {
        activity.command(argv);
        return baseRun(argv, cwd, timeoutMs, limit, () => activity.output());
      };
      const place: TestRunPlace = { scope: "work", work_id: workId, task_id: null };
      return runCoreTests(deps, {
        scope: "work",
        project_id: project.id,
        work_id: workId,
        task_id: null,
        agent_run_id: null,
        root: checkout.path,
        commit: checkout.commit,
        base_commit: checkout.base_commit,
        repo: checkout.repo,
        changed_files: sincePrevious ?? [],
        work_changed_files: workChanged ?? [],
        required_tests: [],
        force_full: previous === null ? "first_work_run" : sincePrevious === null ? "diff_unavailable" : this.deps.db.get<{ full_test_run_at_end: number }>("SELECT full_test_run_at_end FROM works WHERE id = ?", workId)?.full_test_run_at_end === 1 ? "work_full_test_run" : null,
        settings,
        known_failures: resolved.known_failures,
        run,
        environment_signals: this.environmentSignals(),
      }).then(
        async (result) => {
          await this.adoptPassedSetup(resolved, result, settings, project.id, checkout.path, place);
          await activity.end(result.status === "passed" || result.status === "failed" || result.status === "error" ? result.status : "done");
          return result;
        },
        async (error: unknown) => { await activity.end("error"); throw error; },
      );
    }
  }

  /**
   * The Project row with the setup records of this place, in the order they are tried: for a Task its own record, the Work's,
   * the Work's other Tasks', then the Project's; for the Work (taskId null) its own, its Tasks', then the Project's.
   */
  public projectTestRunRow(workId: string, taskId: string | null): ProjectTestRunRow | undefined {
    const project = this.deps.db.get<Omit<ProjectTestRunRow, "setup_records"> & { test_setup_json: string | null }>(
      "SELECT p.id, p.canonical_path, p.test_run_json, p.test_run_detected_json, p.report_check_commands_json, p.test_setup_json FROM projects p JOIN works w ON w.project_id = p.id WHERE w.id = ?",
      workId,
    );
    if (!project) return undefined;
    const warn = (message: string): void => console.warn(`[owl-core] ${message}`);
    const own = taskId === null ? undefined : this.deps.db.get<{ test_setup_json: string | null }>("SELECT test_setup_json FROM tasks WHERE id = ?", taskId);
    const work = this.deps.db.get<{ test_setup_json: string | null }>("SELECT test_setup_json FROM works WHERE id = ?", workId);
    const others = this.deps.db.all<{ test_setup_json: string | null }>(
      "SELECT test_setup_json FROM tasks WHERE work_id = ? AND id IS NOT ? AND test_setup_json IS NOT NULL ORDER BY updated_at DESC, id",
      workId,
      taskId,
    );
    const json = taskId === null
      ? [work?.test_setup_json, ...others.map((row) => row.test_setup_json), project.test_setup_json]
      : [own?.test_setup_json, work?.test_setup_json, ...others.map((row) => row.test_setup_json), project.test_setup_json];
    const setup_records = json.flatMap((text) => {
      const record = readStoredTestSetup(text ?? null, warn);
      return record === null ? [] : [record];
    });
    const { test_setup_json: _ignored, ...row } = project;
    return { ...row, setup_records };
  }

  /** The signals that mark a test failure as the environment's; absent without an investigation service, so nothing is classified then. */
  public environmentSignals(): TestSetupSettings["environment"] | undefined {
    return this.deps.testSetup?.available() === true ? testSetupSettings(this.deps.db).environment : undefined;
  }

  /**
   * Runs the tests; a failure that came from the environment is investigated again and the tests run again, up to
   * `max_reinvestigations` times in this one verification (the count is not stored). `blocked` is set when the
   * environment is still broken, or an install outside the Project waits for the Owner.
   */
  public async withTestSetupRecovery<T>(input: {
    readonly project: ProjectTestRunRow;
    readonly place: TestRunPlace;
    readonly checkout: string;
    readonly run: () => Promise<T>;
    readonly environmentOf: (result: T) => TestEnvironmentFailure | null;
  }): Promise<{ result: T; blocked: TestEnvironmentBlock | null }> {
    const { project, place } = input;
    const tried: string[] = [];
    const missing: string[] = [];
    const installs = new Map<string, { argv: readonly string[]; reason: string }>();
    const maxRounds = testSetupSettings(this.deps.db).max_reinvestigations;
    let rounds = 0;
    let result = await input.run();
    for (;;) {
      const failure = input.environmentOf(result);
      const service = this.deps.testSetup;
      if (failure === null || service === undefined || !service.available()) return { result, blocked: null };
      const current = this.projectTestRunRow(place.work_id, place.task_id) ?? project;
      const explicit = current.test_run_json !== null;
      const block = (): TestEnvironmentBlock => ({ ...failure, explicit, tried: [...tried], missing: [...missing], outside_installs: [...installs.values()] });
      if (failure.signal === "needs_approval") {
        for (const record of current.setup_records) {
          for (const entry of record.outside_installs) {
            if (typeof entry.approved_at !== "string" || entry.approved_at === "") installs.set(entry.argv.join("\0"), { argv: entry.argv, reason: entry.reason });
          }
        }
        // The refused command itself is what the Owner approves, even when no investigation recorded it.
        if (!installs.has(failure.argv.join("\0"))) installs.set(failure.argv.join("\0"), { argv: failure.argv, reason: failure.evidence });
        return { result, blocked: block() };
      }
      if (rounds >= maxRounds) return { result, blocked: block() };
      // Why not investigate anyway: an Owner stop ends the command in failure, which reads as an environment failure,
      // and the investigation (an Agent outside agent_runs) would keep this pipeline, and so the stop, pending.
      if (place.task_id !== null && !this.deps.taskIsVerifying(place.task_id)) return { result, blocked: null };
      rounds += 1;
      const outcome = await service.investigate({
        project_id: project.id,
        scope: place.scope,
        place_id: place.scope === "task" ? place.task_id ?? "" : place.work_id,
        work_id: place.work_id,
        ...(place.task_id === null ? {} : { task_id: place.task_id }),
        checkout: input.checkout,
        trigger: "environment_failure",
        mode: explicit ? "repair_explicit" : "find",
        failure: { argv: failure.argv, exit_code: null, signal: failure.signal, evidence: failure.evidence },
      }).catch((error: unknown) => ({ saved: false as const, reason: error instanceof Error ? error.message : String(error) }));
      if (!outcome.saved) {
        tried.push(`investigation did not run: ${outcome.reason}`);
      } else {
        tried.push(...outcome.tried);
        missing.push(...outcome.missing);
        for (const install of outcome.outside_installs) installs.set(install.argv.join("\0"), install);
        if (outcome.code_problem) return { result, blocked: null };
        if (outcome.status === "needs_approval") return { result, blocked: block() };
      }
      // Why not run again: the stop cancelled the investigation, and a new run would outlive the stop.
      if (place.task_id !== null && !this.deps.taskIsVerifying(place.task_id)) return { result, blocked: null };
      result = await input.run();
    }
  }

  /** The test run of a Task's verification: a whole Project defers to the Work, so it is resolved without investigating. */
  public async resolveTaskVerificationTestRun(project: ProjectTestRunRow, root: string, place: TestRunPlace): Promise<TestRunResolutionWithExecutables> {
    // Why not investigate first: the investigation runs setup, prepare and the whole suite, which a whole Project leaves to the Work.
    const known = await this.resolveProjectTestRun(project, root, { investigate: false });
    return known.enabled && known.settings.mode === "whole" ? known : this.resolveProjectTestRun(project, root, { investigate: true, place });
  }

  /** The test run Core uses for a Task's worktree, read-only (nothing is investigated or stored); null without a Project. */
  public async resolveTaskTestRun(workId: string, taskId: string, worktree: string | null): Promise<TestRunResolution | null> {
    const project = this.projectTestRunRow(workId, taskId);
    return project ? this.resolveProjectTestRun(project, worktree ?? project.canonical_path, { investigate: false }) : null;
  }

  /** Commands the Worker runs before reporting, resolved in the Task worktree; [] without a Project. */
  public async workerReportCheckCommands(workId: string, taskId: string, worktree: string | null, options: { readonly resolvedOnly?: boolean } = {}): Promise<string[]> {
    const project = this.projectTestRunRow(workId, taskId);
    if (!project) return [];
    const root = worktree ?? project.canonical_path;
    const settings = testSetupSettings(this.deps.db);
    const setup = await this.selectProjectTestSetup(project, root);
    return reportCheckCommands({
      configured: project.report_check_commands_json === null || options.resolvedOnly === true ? [] : JSON.parse(project.report_check_commands_json) as string[],
      explicit_json: project.test_run_json,
      detected_json: project.test_run_detected_json,
      root,
      rules: this.deps.testDetectionRules,
      setup,
      default_executables: settings.default_executables,
    });
  }

  /** The record this checkout uses (null = none), by the digests of the checkout. */
  public async selectProjectTestSetup(project: ProjectTestRunRow, root: string): Promise<TestSetupSelection | null> {
    if (project.setup_records.length === 0) return null;
    const rules = this.deps.testDetectionRules;
    return selectTestSetupInCheckout({
      root,
      records: project.setup_records,
      rules_version: testDetectionRulesVersion(rules),
      settings: testSetupSettings(this.deps.db),
      marker_digest: testDetectionMarkerDigest(markerReader(root, rules.max_file_bytes), rules),
      explicitDigest: project.test_run_json === null ? null : explicitTestRunDigest(project.test_run_json),
      max_file_bytes: rules.max_file_bytes,
    });
  }

  /**
   * Owner's test_run > saved setup record > saved detection > detection now (stored for the next check).
   * `investigate` is the hook for finding a setup when none matches; no investigation exists yet, so it changes nothing.
   */
  public async resolveProjectTestRun(project: ProjectTestRunRow, root: string, options: { readonly investigate: boolean; readonly place?: TestRunPlace } = { investigate: true }): Promise<TestRunResolutionWithExecutables> {
    const settings = testSetupSettings(this.deps.db);
    if (options.investigate && options.place !== undefined && project.test_run_json === null) {
      project = await this.ensureTestSetup(project, root, options.place);
    }
    const setup = await this.selectProjectTestSetup(project, root);
    const resolved = resolveTestRun({
      explicit_json: project.test_run_json,
      detected_json: project.test_run_detected_json,
      root,
      rules: this.deps.testDetectionRules,
      now: new Date().toISOString(),
      warn: (message) => console.warn(`[owl-core] ${message}`),
      setup,
      default_executables: settings.default_executables,
    });
    if (options.investigate && resolved.save !== null) {
      await this.deps.writeLane.transact((tx) => {
        tx.run("UPDATE projects SET test_run_detected_json = ? WHERE id = ? AND test_run_json IS NULL", JSON.stringify(resolved.save), project.id);
      });
    }
    const approved_installs = options.place === undefined
      ? (setup?.setup.outside_installs ?? []).filter((entry) => typeof entry.approved_at === "string" && entry.approved_at !== "").map((entry) => entry.argv)
      : approvedInstallArgvs(this.deps.db, options.place.work_id);
    return { ...resolved, executables: testExecutables(setup?.setup ?? null, root, settings.default_executables), approved_installs, adopt_record: resolved.adopt_on_pass ? setup?.setup ?? null : null, known_failures: resolved.setup_match !== null || (resolved.source === "explicit" && setup?.match === "explicit") ? setup?.setup.known_failures ?? [] : [] };
  }

  /**
   * Origin 2 of the test setup: the Project record is re-investigated (not waited for) when the canonical checkout's
   * inputs changed; a checkout whose inputs differ from the canonical ones and that has no matching record waits for an
   * investigation at its own place. Returns the row with the records read again.
   */
  public async ensureTestSetup(project: ProjectTestRunRow, root: string, place: TestRunPlace): Promise<ProjectTestRunRow> {
    const service = this.deps.testSetup;
    if (service === undefined || !service.available()) return project;
    const settings = testSetupSettings(this.deps.db);
    const rules = this.deps.testDetectionRules;
    const projectRecord = readStoredTestSetup(this.deps.db.get<{ test_setup_json: string | null }>("SELECT test_setup_json FROM projects WHERE id = ?", project.id)?.test_setup_json ?? null);
    const sources = projectRecord?.sources ?? [];
    const digestsOf = (dir: string) => testSetupDigests({
      root: dir,
      rules_version: testDetectionRulesVersion(rules),
      settings,
      sources,
      marker_digest: testDetectionMarkerDigest(markerReader(dir, rules.max_file_bytes), rules),
      max_file_bytes: rules.max_file_bytes,
    });
    const sameKey = (a: { layout: string; sources: string; settings: string }, b: { layout: string; sources: string; settings: string }): boolean =>
      a.layout === b.layout && a.sources === b.sources && a.settings === b.settings;
    const canonical = await digestsOf(project.canonical_path);
    if (canonical === null) return project;
    if (projectRecord === null || !sameKey(projectRecord.digests, canonical) || isLegacyWholeSetup(projectRecord)) service.schedule(project.id, { trigger: "inputs_changed" });
    if (root === project.canonical_path) return project;
    const here = await digestsOf(root);
    if (here === null || sameKey(here, canonical)) return project;
    const selected = await this.selectProjectTestSetup(project, root);
    if (selected !== null && selected.match !== "stale") return project;
    await service.investigate({
      project_id: project.id,
      scope: place.scope,
      place_id: place.scope === "task" ? place.task_id ?? "" : place.work_id,
      work_id: place.work_id,
      ...(place.task_id === null ? {} : { task_id: place.task_id }),
      checkout: root,
      trigger: "inputs_changed",
    });
    return this.projectTestRunRow(place.work_id, place.task_id) ?? project;
  }

  /** A passing run of a setup that was never confirmed for this checkout (tests changed, or it had failed before) is written as this place's record. */
  public async adoptPassedSetup(resolved: TestRunResolutionWithExecutables, outcome: CoreTestRunOutcome, settings: TestRunSettings, projectId: string, root: string, place: TestRunPlace): Promise<void> {
    if (this.deps.testSetup === undefined || resolved.adopt_record === null || outcome.status !== "passed") return;
    await this.deps.testSetup.adopt({
      project_id: projectId,
      scope: place.scope,
      place_id: place.scope === "task" ? place.task_id ?? "" : place.work_id,
      work_id: place.work_id,
      ...(place.task_id === null ? {} : { task_id: place.task_id }),
      checkout: root,
      record: resolved.adopt_record,
      argv: runArgvOf(settings),
    }).catch((error: unknown) => console.warn(`[owl-core] Could not save the confirmed test setup: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * Stops an install outside the Project that the Owner has not approved before it starts a process.
   * The environment the judgement assumes is the one the child process gets.
   */
  public gateTestRunner(run: TestCommandRunner, resolved: TestRunResolutionWithExecutables, envAllowlist: readonly string[], roots: (cwd: string) => readonly string[]): TestCommandRunner {
    const setupSettings = testSetupSettings(this.deps.db);
    return gatedTestRunner(run, {
      gate: resolved.gate,
      roots,
      env: childEnv(envAllowlist, setupSettings.run_env),
      approved: resolved.approved_installs,
      settings: setupSettings.install,
      query: execInstallQuery(setupSettings.probe_timeout_seconds * 1000),
    });
  }

  public coreTestRunDeps(workId: string, settings: TestRunSettings, wrap: (runner: TestCommandRunner) => TestCommandRunner = (runner) => runner): CoreTestRunDeps {
    return {
      db: this.deps.db,
      writeLane: this.deps.writeLane,
      workspaceRoot: this.deps.workspaceRoot,
      baselineRunner: wrap(this.deps.testCommandRunner ?? workTestRunner({ workId, envAllowlist: settings.env_allowlist, extraEnv: testSetupSettings(this.deps.db).run_env, instanceId: resolveInstanceId(this.deps.dataDir) })),
      baselineLocks: this.deps.baselineLocks,
    };
  }
}
