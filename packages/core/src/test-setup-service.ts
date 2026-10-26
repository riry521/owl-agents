import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { createUlid } from "../../db/dist/index.js";
import { DEFAULT_TEST_RUN_SETTINGS, readTestRunSettings, validateTestRunSettings, type TestRunSettings } from "../../shared/dist/test-run-settings.js";
import { REGEX_FLAGS, type TestSetupSettings } from "../../shared/dist/test-setup-settings.js";
import { matchesGlobWithDots } from "./glob.js";
import { childEnv } from "./core-test-run.js";
import { detectTestRun, markerReader, testDetectionMarkerDigest, testDetectionRulesVersion } from "./test-detection.js";
import { DEFAULT_TEST_DETECTION_RULES, type TestDetectionRules } from "./test-detection-rules.js";
import { execInstallQuery, gatedTestRunner, type TestSetupRunEntry } from "./test-setup-install-guard.js";
import { approvedInstallArgvs } from "./test-environment.js";
import { testSetupSettings } from "./test-setup-settings.js";
import {
  diffSnapshots,
  listCheckoutFiles,
  newUntrackedPaths,
  removeUntrackedFiles,
  explicitTestRunDigest,
  readStoredTestSetup,
  snapshotCheckout,
  testSetupDigests,
  withExecutables,
  type StoredTestSetup,
  type TestSetupDigests,
  type TestSetupStatus,
} from "./test-setup.js";
import { listTestFiles, prepareCheckout, runTestFiles, runWholeSuite, type TestCommandResult, type TestCommandRunner } from "./test-runs.js";
import type { CoreDatabase, JsonObject } from "./types.js";

export type TestSetupScope = "project" | "work" | "task";
export type TestSetupTrigger = "project_registered" | "project_path_changed" | "inputs_changed" | "environment_failure" | "core_confirmed" | "manual";
export const TEST_SETUP_MANUAL_TRIGGER = "manual" satisfies TestSetupTrigger;
export const TEST_SETUP_UNAVAILABLE_REASON = { explicitTestRun: "explicit_test_run", runnerUnavailable: "runner_unavailable", providerPaused: "provider_paused" } as const;
export type TestSetupUnavailableReason = (typeof TEST_SETUP_UNAVAILABLE_REASON)[keyof typeof TEST_SETUP_UNAVAILABLE_REASON];
export type TestSetupStart = { readonly started: true } | { readonly started: false; readonly reason: TestSetupUnavailableReason | "project_not_found" };

const SCOPE_TABLE: Readonly<Record<TestSetupScope, string>> = { project: "projects", work: "works", task: "tasks" };
const PROBE_OUTPUT_LIMIT_BYTES = 65_536;
const EVIDENCE_CHARS = 500;
const SAFETY_MARGIN_MS = 60_000;

interface AgentOutput {
  readonly verdict: string;
  readonly setup_argvs: readonly (readonly string[])[];
  readonly setup_inputs: readonly string[];
  readonly setup_outputs: readonly string[];
  readonly test_run: { readonly mode: "per_file" | "whole"; readonly whole_argv: readonly string[]; readonly file_argv: readonly string[]; readonly prepare_argv: readonly string[]; readonly test_patterns: readonly string[]; readonly cwd: string } | null;
  readonly executables: readonly { readonly name: string; readonly path: string; readonly probe_argv: readonly string[] }[];
  readonly confirm_files: readonly string[];
  readonly probe_argvs: readonly (readonly string[])[];
  readonly sources: readonly string[];
  readonly attempts: readonly { readonly argv: readonly string[]; readonly cwd: string; readonly exit_code: number | null; readonly summary: string }[];
  readonly installed: readonly { readonly argv: readonly string[] }[];
  readonly outside_installs: readonly { readonly argv: readonly string[]; readonly reason: string }[];
  readonly missing: readonly string[];
  readonly notes?: string;
}

type AgentResult = { readonly ok: true; readonly investigation: AgentOutput; readonly invocation_id: string } | { readonly ok: false; readonly error: string; readonly invocation_id?: string };

interface AgentRunner {
  runTestSetupInvestigation?(request: Record<string, unknown>): Promise<AgentResult>;
  cancelAgent?(invocationId: string, force?: boolean): Promise<void>;
}

export interface TestSetupServiceDeps {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  /** Read at each use: the runner may be replaced after the service is made. */
  readonly agentRunner: () => unknown;
  readonly rules?: TestDetectionRules;
  /** The runner for Core's own confirmation; the env_allowlist of the test run settings is passed for the real one. */
  readonly commandRunner: (projectId: string, envAllowlist: readonly string[]) => TestCommandRunner;
  readonly registerRun: (invocationId: string, entry: TestSetupRunEntry) => () => void;
  readonly isPaused: (provider: string) => boolean;
  readonly roleModel: (role: string) => { readonly model: string; readonly provider: string; readonly effort?: string } | undefined;
  readonly now: () => string;
  readonly log?: (message: string) => void;
}

export interface InvestigateInput {
  readonly project_id: string;
  readonly scope: TestSetupScope;
  /** The id of the row the record is written to (the Project, Work or Task). */
  readonly place_id: string;
  readonly work_id?: string;
  readonly task_id?: string;
  /** Absolute path of the folder to investigate. */
  readonly checkout: string;
  readonly trigger: TestSetupTrigger;
  readonly mode?: "find" | "repair_explicit";
  readonly failure?: { readonly argv: readonly string[]; readonly exit_code: number | null; readonly signal: string; readonly evidence: string } | null;
}

export type InvestigateOutcome =
  | {
      readonly saved: true;
      readonly status: TestSetupStatus;
      /** The agent judged the failure to be the code's, not the environment's. */
      readonly code_problem: boolean;
      /** What this investigation tried, one line each. */
      readonly tried: readonly string[];
      readonly missing: readonly string[];
      /** Installs outside the Project that still wait for an approval. */
      readonly outside_installs: readonly { readonly argv: readonly string[]; readonly reason: string }[];
    }
  | { readonly saved: false; readonly reason: string };

/** What a Project's latest investigation is doing; kept in memory only, so it is gone after a restart. */
export type TestSetupRunState = { readonly running: true } | { readonly running: false; readonly outcome: { readonly saved: boolean; readonly status: TestSetupStatus | null; readonly reason: string | null } };

type Attempt = { by: "agent" | "core"; argv: readonly string[]; cwd: string; exit_code: number | null; result: string; summary: string; at: string };

/** The reason stored with an install Core saw run onto the Mac. */
const MAC_INSTALL_REASON = "mac_wide_install";

const tail = (text: string, chars: number): string => text.trim().slice(-chars);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class TestSetupService {
  private readonly inflight = new Map<string, Promise<InvestigateOutcome>>();
  /** Task id of each running investigation, by invocation id; an Owner stop cancels them through the runner. */
  private readonly taskInvestigations = new Map<string, string>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly runStates = new Map<string, TestSetupRunState>();
  private readonly rules: TestDetectionRules;

  constructor(private readonly deps: TestSetupServiceDeps) {
    this.rules = deps.rules ?? DEFAULT_TEST_DETECTION_RULES;
  }

  private agent(): AgentRunner | null {
    const runner = this.deps.agentRunner() as AgentRunner | null | undefined;
    return runner && typeof runner.runTestSetupInvestigation === "function" ? runner : null;
  }

  /** Whether the agent runner can investigate (a stub without runTestSetupInvestigation cannot). */
  public available(): boolean {
    return this.agent() !== null;
  }

  /** Waits for every scheduled investigation; for shutdown and tests. */
  public async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Starts a Project-level investigation without waiting. Does nothing for an Owner-specified test_run, a runner without the method, or a paused provider. */
  public schedule(projectId: string, input: { readonly trigger: TestSetupTrigger }): void {
    this.start(projectId, input);
  }

  /**
   * Same checks as schedule, but says why nothing started.
   * Why not change schedule itself: its callers (createProject and others) are fire-and-forget and must keep their return type and silence.
   */
  public start(projectId: string, input: { readonly trigger: TestSetupTrigger }): TestSetupStart {
    // available() first: without an investigating runner there is nothing to read, and a DB not yet migrated to test_run_json must not fail createProject.
    if (!this.available()) return { started: false, reason: TEST_SETUP_UNAVAILABLE_REASON.runnerUnavailable };
    const row = this.deps.db.get<{ canonical_path: string; test_run_json: string | null }>("SELECT canonical_path, test_run_json FROM projects WHERE id = ?", projectId);
    if (!row) return { started: false, reason: "project_not_found" };
    if (row.test_run_json !== null) return { started: false, reason: TEST_SETUP_UNAVAILABLE_REASON.explicitTestRun };
    const model = this.deps.roleModel(testSetupSettings(this.deps.db).role);
    if (model && this.deps.isPaused(model.provider)) return { started: false, reason: TEST_SETUP_UNAVAILABLE_REASON.providerPaused };
    this.runStates.set(projectId, { running: true });
    const run = this.investigate({ project_id: projectId, scope: "project", place_id: projectId, checkout: row.canonical_path, trigger: input.trigger })
      .then((outcome) => { this.runStates.set(projectId, { running: false, outcome: outcome.saved ? { saved: true, status: outcome.status, reason: null } : { saved: false, status: null, reason: outcome.reason } }); })
      .catch((error: unknown) => {
        this.deps.log?.(`test setup investigation failed: ${error instanceof Error ? error.message : String(error)}`);
        this.runStates.set(projectId, { running: false, outcome: { saved: false, status: null, reason: "investigation_failed" } });
      });
    this.background.add(run);
    void run.finally(() => this.background.delete(run));
    return { started: true };
  }

  /** The latest investigation started by start() for a Project; null when none ran since Core started. */
  public runState(projectId: string): TestSetupRunState | null {
    return this.runStates.get(projectId) ?? null;
  }

  private readRecord(scope: TestSetupScope, placeId: string): { readonly record: StoredTestSetup | null; readonly raw: Record<string, unknown> | null } {
    const row = this.deps.db.get<{ test_setup_json: string | null }>(`SELECT test_setup_json FROM ${SCOPE_TABLE[scope]} WHERE id = ?`, placeId);
    const record = readStoredTestSetup(row?.test_setup_json ?? null, this.deps.log);
    if (record === null || row?.test_setup_json == null) return { record, raw: null };
    const raw: unknown = JSON.parse(row.test_setup_json);
    return { record, raw: isRecord(raw) ? raw : null };
  }

  /** The record in use at a place: its own, or else the Project's (a Task's first investigation starts from the Project's setup). */
  private readInUse(input: Pick<InvestigateInput, "scope" | "place_id" | "project_id">): { readonly record: StoredTestSetup | null; readonly raw: Record<string, unknown> | null } {
    const own = this.readRecord(input.scope, input.place_id);
    return own.record !== null || input.scope === "project" ? own : this.readRecord("project", input.project_id);
  }

  private digestsOf(checkout: string, settings: TestSetupSettings, sources: readonly string[]): Promise<TestSetupDigests | null> {
    const read = markerReader(checkout, this.rules.max_file_bytes);
    return testSetupDigests({
      root: checkout,
      rules_version: testDetectionRulesVersion(this.rules),
      settings,
      sources,
      marker_digest: testDetectionMarkerDigest(read, this.rules),
      max_file_bytes: this.rules.max_file_bytes,
    });
  }

  /** Investigates one place and saves the record there. Investigations of the same place and inputs share one run. */
  public async investigate(input: InvestigateInput): Promise<InvestigateOutcome> {
    const settings = testSetupSettings(this.deps.db);
    const { record } = this.readInUse(input);
    const digests = await this.digestsOf(input.checkout, settings, record?.sources ?? []);
    if (digests === null) return { saved: false, reason: "not_a_git_checkout" };
    const key = [input.project_id, input.scope, input.place_id, digests.layout, digests.sources, digests.settings].join(":");
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.runInvestigation(input, settings).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Cancels the running investigations of the given Tasks; the runner ends their Agent processes. */
  public cancelInvestigations(taskIds: ReadonlySet<string>, force: boolean): void {
    const agent = this.agent();
    if (agent?.cancelAgent === undefined) return;
    for (const [invocationId, taskId] of this.taskInvestigations) {
      if (taskIds.has(taskId)) void agent.cancelAgent(invocationId, force).catch(() => {});
    }
  }

  private async runInvestigation(input: InvestigateInput, settings: TestSetupSettings): Promise<InvestigateOutcome> {
    const agent = this.agent();
    if (agent === null) return { saved: false, reason: "investigation_unavailable" };
    const project = this.deps.db.get<{ name: string; test_run_json: string | null }>("SELECT name, test_run_json FROM projects WHERE id = ?", input.project_id);
    if (!project) return { saved: false, reason: "project_not_found" };
    const mode = input.mode ?? "find";
    if (mode === "find" && project.test_run_json !== null) return { saved: false, reason: "explicit_test_run" };
    const model = this.deps.roleModel(settings.role);
    if (model && this.deps.isPaused(model.provider)) return { saved: false, reason: "provider_paused" };

    const { record: current, raw: currentRaw } = this.readInUse(input);
    const approved = input.work_id
      ? approvedInstallArgvs(this.deps.db, input.work_id)
      : (current?.outside_installs ?? []).filter((entry) => typeof entry.approved_at === "string" && entry.approved_at !== "").map((entry) => entry.argv);
    const roots = [input.checkout];
    const env = childEnv(DEFAULT_TEST_RUN_SETTINGS.env_allowlist, settings.run_env);
    const invocationId = createUlid();
    const installs: (readonly string[])[] = [];
    const unregisterRun = this.deps.registerRun(invocationId, { project_id: input.project_id, roots, env, approved, installs });
    if (input.task_id !== undefined) this.taskInvestigations.set(invocationId, input.task_id);
    const unregister = (): void => { this.taskInvestigations.delete(invocationId); unregisterRun(); };
    const detection = detectTestRun(markerReader(input.checkout, this.rules.max_file_bytes), this.rules);
    const first = detection.enabled && detection.settings !== null
      ? {
          rule_id: detection.rule_id,
          mode: detection.settings.mode,
          prepare_argv: withExecutables(detection.settings.prepare_argv, settings.default_executables),
          argv: withExecutables(detection.settings.mode === "whole" ? detection.settings.whole_argv : detection.settings.file_argv, settings.default_executables),
        }
      : detection.enabled ? null : { rule_id: detection.rule_id, mode: "off" as const, prepare_argv: [], argv: [] };

    const before = await snapshotCheckout(input.checkout, settings.environment_dirs);
    const existedBefore = await listCheckoutFiles(input.checkout);
    const timeoutMs = settings.timeout_seconds * 1000;
    let timer: NodeJS.Timeout | undefined;
    let result: AgentResult;
    try {
      const stuck = new Promise<AgentResult>((resolveStuck) => { timer = setTimeout(() => resolveStuck({ ok: false, error: "timeout", invocation_id: invocationId }), timeoutMs + SAFETY_MARGIN_MS); });
      result = await Promise.race([
        agent.runTestSetupInvestigation!({
          invocation_id: invocationId,
          project: { id: input.project_id, name: project.name },
          scope: input.scope,
          checkout: input.checkout,
          trigger: input.trigger,
          mode,
          explicit_test_run: mode === "repair_explicit" && project.test_run_json !== null ? JSON.parse(project.test_run_json) as JsonObject : null,
          first_candidate: first,
          current: currentRaw,
          failure: input.failure ?? null,
          approved_installs: approved,
          bootstrap: settings.bootstrap,
          provider: model?.provider,
          model: model?.model,
          effort: model?.effort,
          role: settings.role,
          timeout_ms: timeoutMs,
          env: settings.run_env,
        }),
        stuck,
      ]).catch((error: unknown): AgentResult => ({ ok: false, error: `provider_failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 200), invocation_id: invocationId }));
    } finally {
      clearTimeout(timer);
      unregister();
    }
    const after = await snapshotCheckout(input.checkout, settings.environment_dirs);
    // New untracked files are what the tests leave behind, so they are removed below instead of making the record unresolved; rewritten old files and tracked changes still do.
    const oldFile = (entry: { kind: string; path: string }): boolean => entry.kind !== "left" || before.has(`left\0${entry.path}`);
    const differences = diffSnapshots(before, after).filter(oldFile);
    let confirmed = await this.confirm(input, settings, mode, project.test_run_json, result, differences, approved, current, installs);
    // Core's own test run inside confirm() can change or leave files too, so the checkout is looked at again after it.
    const last = await snapshotCheckout(input.checkout, settings.environment_dirs);
    const { removed, failed } = removeUntrackedFiles(input.checkout, newUntrackedPaths(existedBefore, last));
    const seen = new Set(differences.map((entry) => `${entry.kind}\0${entry.path}`));
    const late = diffSnapshots(before, last).filter((entry) => oldFile(entry) && !seen.has(`${entry.kind}\0${entry.path}`));
    const problems = [
      ...late.map((entry) => entry.kind === "tracked" ? `確認実行が追跡済みファイルを変えた: ${entry.path}` : entry.kind === "left" ? `確認実行が Project のファイルを書き換えた: ${entry.path}` : `確認実行が Project のファイルを消した: ${entry.path}`),
      ...failed.map((path) => `新しいファイルを消せなかった: ${path}`),
    ];
    if (problems.length > 0) {
      // Why confirmed/test_run are cleared: an unresolved record must not look like a confirmed setup.
      confirmed = { ...confirmed, status: "unresolved", fields: { ...confirmed.fields, confirmed: null, test_run: null, missing: [...((confirmed.fields as { missing?: string[] }).missing ?? []), ...problems] } };
    }
    await this.save(input, { ...confirmed, fields: { ...confirmed.fields, removed_files: removed } }, result.invocation_id ?? invocationId, model);
    const fields = confirmed.fields as { attempts?: readonly Attempt[]; missing?: readonly string[]; outside_installs?: readonly { argv: readonly string[]; reason: string; approved_at?: string | null }[] };
    return {
      saved: true,
      status: confirmed.status,
      code_problem: confirmed.code_problem === true,
      tried: (fields.attempts ?? []).map((entry) => `${entry.argv.join(" ")}: ${entry.result}${entry.summary === "" ? "" : ` ${entry.summary}`}`),
      missing: fields.missing ?? [],
      outside_installs: (fields.outside_installs ?? []).filter((entry) => !entry.approved_at).map((entry) => ({ argv: entry.argv, reason: entry.reason })),
    };
  }

  /** The Core-only record: a passing run of the setup in use makes it the record of this place. */
  public async adopt(input: Omit<InvestigateInput, "trigger" | "mode" | "failure"> & { readonly record: StoredTestSetup; readonly argv: readonly string[] }): Promise<void> {
    const settings = testSetupSettings(this.deps.db);
    const digests = await this.digestsOf(input.checkout, settings, input.record.sources);
    if (digests === null) return;
    const at = this.deps.now();
    const run = input.record.test_run ?? {};
    const body = this.recordBody(input, {
      status: "ready",
      test_run: run,
      setup_argvs: Array.isArray(run.setup_argvs) ? run.setup_argvs : [],
      executables: input.record.executables,
      sources: input.record.sources,
      digests,
      confirmed: { by: "core", argv: input.argv, cwd: typeof run.cwd === "string" ? run.cwd : ".", files: ["*"], exit_code: 0, at },
      candidate: null,
      probes: [],
      attempts: [],
      installed: [],
      outside_installs: input.record.outside_installs,
      missing: [],
      trigger: "core_confirmed",
      agent_run: null,
      explicit_digest: input.record.explicit_digest,
      whole_reason: input.record.whole_reason,
    }, at);
    await this.write(input, body, "ready");
  }

  private recordBody(input: Pick<InvestigateInput, "scope">, fields: Record<string, unknown>, at: string): Record<string, unknown> {
    return { schema_version: 1, scope: input.scope, ...fields, confirmed_at: (fields.confirmed as { at?: string } | null)?.at ?? null, investigated_at: at };
  }

  private async write(input: InvestigateInput | (Omit<InvestigateInput, "trigger">), body: Record<string, unknown>, status: string): Promise<void> {
    await this.deps.writeLane.write({
      mutateState: (tx: { run: (sql: string, ...parameters: unknown[]) => unknown }) => {
        tx.run(`UPDATE ${SCOPE_TABLE[input.scope]} SET test_setup_json = ? WHERE id = ?`, JSON.stringify(body), input.place_id);
        return {};
      },
      event: {
        idempotencyKey: `test-setup-saved:${createUlid()}`,
        type: "test_setup.saved",
        ...(input.work_id ? { workId: input.work_id } : {}),
        ...(input.task_id ? { taskId: input.task_id } : {}),
        payload: { schema_version: "1.0.0", project_id: input.project_id, scope: input.scope, place_id: input.place_id, status },
      },
      outbox: [{ provider: "websocket" }],
    } as never);
  }

  private async save(input: InvestigateInput, confirmed: Confirmed, invocationId: string, model: { provider: string; model: string } | undefined): Promise<void> {
    const at = this.deps.now();
    const body = this.recordBody(input, {
      ...confirmed.fields,
      status: confirmed.status,
      trigger: input.trigger,
      agent_run: confirmed.agent_ran ? { invocation_id: invocationId, role: testSetupSettings(this.deps.db).role, provider: model?.provider ?? null, model: model?.model ?? null } : null,
    }, at);
    await this.write(input, body, confirmed.status);
  }

  private async confirm(
    input: InvestigateInput,
    settings: TestSetupSettings,
    mode: "find" | "repair_explicit",
    explicitJson: string | null,
    result: AgentResult,
    differences: ReturnType<typeof diffSnapshots>,
    approved: readonly (readonly string[])[],
    current: StoredTestSetup | null,
    installs: (readonly string[])[],
  ): Promise<Confirmed> {
    const at = (): string => this.deps.now();
    const output: AgentOutput | null = result.ok ? result.investigation : null;
    const sources = output?.sources ?? current?.sources ?? [];
    const agentAttempts: Attempt[] = (output?.attempts ?? []).map((entry) => ({ by: "agent", argv: entry.argv, cwd: entry.cwd, exit_code: entry.exit_code, result: entry.exit_code === 0 ? "passed" : "failed", summary: entry.summary, at: at() }));
    const coreAttempts: Attempt[] = [];
    const digestsFor = async (): Promise<TestSetupDigests> => (await this.digestsOf(input.checkout, settings, sources)) ?? { layout: "", tests: "", sources: "", settings: "" };
    const explicitDigest = mode === "repair_explicit" && explicitJson !== null ? explicitTestRunDigest(explicitJson) : null;
    const finish = async (status: TestSetupStatus, extra: { missing?: string[]; fields?: Record<string, unknown> } = {}): Promise<Confirmed> => {
      const attempts = [...coreAttempts.reverse(), ...agentAttempts.reverse()].slice(0, settings.max_attempts_recorded).map((entry) => ({ ...entry, summary: entry.summary.slice(0, settings.summary_chars) }));
      const missing = [...(output?.missing ?? []), ...(extra.missing ?? [])];
      return {
        status,
        agent_ran: result.ok,
        code_problem: output?.verdict === "code_problem",
        fields: {
          explicit_digest: explicitDigest,
          whole_reason: output?.test_run?.mode === "whole" ? (output.notes ?? "").trim() : "",
          digests: await digestsFor(),
          setup_argvs: output?.setup_argvs ?? [],
          test_run: null,
          executables: {},
          confirmed: null,
          candidate: null,
          probes: [],
          known_failures: [],
          sources,
          attempts,
          installed: output?.installed ?? [],
          outside_installs: [
            ...(output?.outside_installs ?? []).map((entry) => ({ ...entry, decision_id: null, approved_at: null })),
            ...(current?.outside_installs ?? []).filter((entry) => typeof entry.approved_at === "string"),
            // Why approved_at is set: Mac-wide installs are let through, so they are history, not a request.
            ...installs.map((argv) => ({ argv, reason: MAC_INSTALL_REASON, decision_id: null, approved_at: at() })),
          ],
          missing: status === "ready" || status === "no_tests" || status === "no_language" ? [] : missing,
          ...extra.fields,
        },
      };
    };

    if (!result.ok) return finish("unresolved", { missing: [`調査できませんでした: ${result.error}`] });
    if (differences.length > 0) {
      return finish("unresolved", {
        missing: differences.map((entry) => entry.kind === "tracked" ? `追跡済みファイルを変えた: ${entry.path}` : entry.kind === "left" ? `Project に残したファイル: ${entry.path}` : `Project のファイルを消した: ${entry.path}`),
      });
    }
    if (output === null) return finish("unresolved");
    if (output.verdict === "needs_owner") return finish(output.outside_installs.length > 0 ? "needs_approval" : "unresolved");
    if (output.verdict === "code_problem") return finish("unresolved", { missing: ["コードの問題と判定されました"] });
    if (output.verdict === "no_language") {
      const detection = detectTestRun(markerReader(input.checkout, this.rules.max_file_bytes), this.rules);
      const catchAll = this.rules.rules.at(-1)?.id;
      return detection.rule_id === catchAll ? finish("no_language") : finish("unresolved", { missing: [`言語を示すファイルがあります（${detection.rule_id}）`] });
    }

    // Shape of the test run: the Owner's own command is kept as it is in repair_explicit.
    const explicit = mode === "repair_explicit" && explicitJson !== null ? JSON.parse(explicitJson) as Record<string, unknown> : null;
    const agentRun = output.test_run;
    if (explicit === null && agentRun === null) return finish("unresolved", { missing: ["test_run がありません"] });
    const nonEmpty = (entries: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(entries).filter(([, value]) => !(Array.isArray(value) && value.length === 0) && value !== ""));
    const runInput = explicit ?? nonEmpty({ ...agentRun });
    // The cache describes the setup_argvs the agent recorded, which repair_explicit also keeps, so it is saved in both modes.
    const withSetup = {
      ...runInput,
      ...(output.setup_argvs.length > 0 ? { setup_argvs: output.setup_argvs } : {}),
      setup_cache: { inputs: output.setup_inputs, outputs: output.setup_outputs },
    };
    const problems = validateTestRunSettings(withSetup);
    if (problems.length > 0) return finish("unresolved", { missing: problems });
    if (output.verdict === "no_tests" && (explicit !== null || !Array.isArray(runInput.test_patterns) || runInput.test_patterns.length === 0)) {
      return finish("unresolved", { missing: ["no_tests には test_run.test_patterns が必要です"] });
    }

    const executables: Record<string, string> = { ...settings.default_executables };
    const storedExecutables: Record<string, { path: string; relative_to: "checkout" | null; version: string | null; probe: { argv: readonly string[]; exit_code: number | null; at: string } | null }> = {};
    for (const entry of output.executables) {
      const absolute = isAbsolute(entry.path) || !entry.path.includes("/") ? entry.path : resolve(input.checkout, entry.path);
      executables[entry.name] = absolute;
      storedExecutables[entry.name] = { path: entry.path, relative_to: isAbsolute(entry.path) || !entry.path.includes("/") ? null : "checkout", version: null, probe: null };
    }
    const replace = (argv: readonly string[]): string[] => withExecutables(argv, executables);
    const testSettings = readTestRunSettings(withSetup);
    const resolved: TestRunSettings = {
      ...testSettings,
      prepare_argv: replace(testSettings.prepare_argv),
      file_argv: replace(testSettings.file_argv),
      whole_argv: replace(testSettings.whole_argv),
      setup_argvs: testSettings.setup_argvs.map(replace),
    };

    // Every command Core runs is judged by the install guard; in repair_explicit only the agent's own commands are (the Owner's test command is theirs).
    const trace: Array<{ argv: readonly string[]; cwd: string; result: TestCommandResult }> = [];
    const base = this.deps.commandRunner(input.project_id, resolved.env_allowlist);
    const gated = gatedTestRunner(base, {
      gate: explicit === null ? "all" : { only: [...resolved.setup_argvs, ...output.probe_argvs.map(replace)] },
      roots: () => [input.checkout],
      env: childEnv(resolved.env_allowlist, settings.run_env),
      approved,
      settings: settings.install,
      query: execInstallQuery(settings.probe_timeout_seconds * 1000),
      onInstall: (argv) => { installs.push(argv); },
    });
    const run: TestCommandRunner = async (argv, cwd, timeoutMs, limit, onOutput) => {
      const outcome = await gated(argv, cwd, timeoutMs, limit, onOutput);
      trace.push({ argv, cwd, result: outcome });
      coreAttempts.push({ by: "core", argv, cwd, exit_code: outcome.exit_code, result: outcome.exit_code === 0 && outcome.error === undefined ? "passed" : "failed", summary: tail(outcome.error ?? outcome.stderr, EVIDENCE_CHARS), at: at() });
      return outcome;
    };
    const failureOf = (): (typeof trace)[number] | undefined => trace.find((entry) => entry.result.error !== undefined || entry.result.timed_out || entry.result.exit_code !== 0);
    const isEnvironment = (entry: (typeof trace)[number], byOutput = true): boolean => {
      if (entry.result.timed_out) return false;
      if (entry.result.error !== undefined) return true;
      if (entry.result.exit_code !== null && settings.environment.exit_codes.includes(entry.result.exit_code)) return true;
      if (!byOutput) return false;
      const text = `${entry.result.stdout}\n${entry.result.stderr}`;
      return settings.environment.patterns.some((pattern) => new RegExp(pattern, REGEX_FLAGS).test(text));
    };
    const outsideOf = (): { argv: readonly string[]; reason: string; decision_id: null; approved_at: null }[] =>
      trace.flatMap((entry) => (entry.result.error?.startsWith("install_needs_approval") ? [{ argv: entry.argv, reason: "install_needs_approval", decision_id: null, approved_at: null }] : []));
    const unresolvedByCommand = async (label: string): Promise<Confirmed> => {
      const failed = failureOf();
      const outside = outsideOf();
      const fields = { test_run: { ...withSetup }, executables: storedExecutables };
      if (outside.length > 0) {
        const done = await finish("needs_approval", { missing: [`Project の外のインストールに承認が必要です: ${outside.map((entry) => entry.argv.join(" ")).join(", ")}`], fields });
        return { ...done, fields: { ...done.fields, outside_installs: [...(done.fields.outside_installs as unknown[]), ...outside] } };
      }
      const why = failed === undefined ? label : `${failed.argv.join(" ")} (${failed.result.error ?? `exit ${failed.result.exit_code}`})`;
      return finish("unresolved", { missing: [`${label}: ${why}`], fields });
    };

    // Setup once, then the executables are probed, so the tests can run without repeating the setup.
    const setupError = await prepareCheckout({ root: input.checkout, settings: resolved, run });
    if (setupError !== null) return unresolvedByCommand("環境を用意できませんでした");
    for (const entry of output.executables) {
      const path = executables[entry.name];
      if (path.includes("/")) {
        try { accessSync(path, constants.X_OK); } catch { return finish("unresolved", { missing: [`実行ファイルが見つかりません: ${entry.path}`] }); }
      }
      const probe = await run(replace(entry.probe_argv), input.checkout, settings.probe_timeout_seconds * 1000, PROBE_OUTPUT_LIMIT_BYTES);
      const stored = storedExecutables[entry.name];
      stored.probe = { argv: entry.probe_argv, exit_code: probe.exit_code, at: at() };
      if (probe.error !== undefined || probe.timed_out || probe.exit_code !== 0) return unresolvedByCommand(`${entry.name} の確認に失敗しました`);
      stored.version = (probe.stdout.trim() || probe.stderr.trim()).split("\n")[0]?.slice(0, 200) || null;
    }

    const runOnly: TestRunSettings = { ...resolved, setup_argvs: [], prepare_argv: [] };
    const existing = await listTestFiles(input.checkout, runOnly).catch(() => [] as string[]);
    const storedRun = { ...withSetup };
    if (output.verdict === "no_tests" && existing.length === 0) {
      const probes: { argv: readonly string[]; exit_code: number | null; at: string }[] = [];
      for (const argv of output.probe_argvs) {
        const probe = await run(replace(argv), input.checkout, settings.probe_timeout_seconds * 1000, PROBE_OUTPUT_LIMIT_BYTES);
        probes.push({ argv, exit_code: probe.exit_code, at: at() });
        if (probe.error !== undefined || probe.timed_out || probe.exit_code !== 0) return unresolvedByCommand("実行器の確認に失敗しました");
      }
      if (probes.length === 0) return finish("unresolved", { missing: ["no_tests には実行器の確認コマンド（probe_argvs）が必要です"] });
      return finish("no_tests", { fields: { test_run: storedRun, executables: storedExecutables, probes } });
    }

    const execution = runOnly.mode === "whole"
      ? await runWholeSuite({ root: input.checkout, settings: runOnly, run })
      : await (async () => {
          const wanted = output.confirm_files.filter((file) => existing.includes(file) || runOnly.test_patterns.some((glob) => matchesGlobWithDots(file, glob)));
          const files = (wanted.length > 0 ? wanted : existing).slice(0, settings.max_confirm_files);
          return files.length === 0 ? null : runTestFiles({ root: input.checkout, files, settings: runOnly, run });
        })();
    if (execution === null) return finish("unresolved", { missing: ["確かめに使うテストファイルがありません"], fields: { test_run: storedRun, executables: storedExecutables } });
    const failed = failureOf();
    const passed = execution.status === "completed" && execution.files.length > 0 && execution.files.every((file) => file.status === "passed");
    const argv = runOnly.mode === "whole" ? runOnly.whole_argv : runOnly.file_argv;
    if (passed) {
      return finish("ready", {
        fields: {
          test_run: storedRun,
          executables: storedExecutables,
          confirmed: { by: "core", argv, cwd: runOnly.cwd, files: runOnly.mode === "whole" ? ["*"] : execution.files.map((file) => file.file), exit_code: 0, at: at() },
        },
      });
    }
    if (failed !== undefined && outsideOf().length > 0) return unresolvedByCommand("テストを動かせませんでした");
    const failedFiles = execution.files.filter((file) => file.status !== "passed");
    // Some tests pass and every failure has a test name: the failures are old ones, so the setup is usable and later runs tell them from new ones.
    // This comes before the environment check: a failing test's own output may look like an environment problem.
    const knownFailures = failedFiles.flatMap((file) => file.failures.map(({ file: path, name }) => ({ file: path, name })));
    // A whole run is one file and a failing file may hold passing tests, so "some passed" is also read from the runner's summary line.
    const somePassed = failedFiles.length < execution.files.length
      || failedFiles.some((file) => settings.passed_count_patterns.some((pattern) => Number(new RegExp(pattern, `${REGEX_FLAGS}m`).exec(file.output_tail)?.[1] ?? 0) > 0));
    if (execution.status === "completed" && somePassed && knownFailures.length > 0 && knownFailures.every((entry) => entry.name !== "")) {
      return finish("ready", {
        fields: {
          test_run: storedRun,
          executables: storedExecutables,
          confirmed: { by: "core", argv, cwd: runOnly.cwd, files: runOnly.mode === "whole" ? ["*"] : execution.files.map((file) => file.file), exit_code: 0, at: at() },
          known_failures: knownFailures,
        },
      });
    }
    // Tests that ran and failed are code failures even when their output looks like an environment problem; only a start-up failure is the environment.
    if (failed !== undefined && isEnvironment(failed, execution.status !== "completed")) return unresolvedByCommand("テストを動かせませんでした");
    return finish("tests_failing", {
      fields: {
        test_run: storedRun,
        executables: storedExecutables,
        candidate: {
          argv,
          cwd: runOnly.cwd,
          exit_code: failedFiles[0]?.exit_code ?? null,
          evidence: tail(failedFiles[0]?.output_tail ?? execution.error ?? "", EVIDENCE_CHARS),
          failed_files: failedFiles.map((file) => file.file),
          at: at(),
        },
      },
    });
  }
}

interface Confirmed {
  readonly status: TestSetupStatus;
  readonly agent_ran: boolean;
  readonly code_problem?: boolean;
  readonly fields: Record<string, unknown>;
}
