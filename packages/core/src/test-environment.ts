import { TEST_SETUP_APPROVE_OPTION_KEY } from "@owl/shared";
import { REGEX_FLAGS, type TestSetupSettings } from "../../shared/dist/test-setup-settings.js";
import { testFailureKey } from "./nightly-tests";
import type { TestExecution, TestFileResult } from "./test-runs";
import type { TypePolicyResult } from "./task-verification-policy.js";
import type { CoreWriteLaneTransaction } from "./types";

/** The prefix gatedTestRunner puts in `error` when an install outside the Project is not approved. */
export const INSTALL_NEEDS_APPROVAL_PREFIX = "install_needs_approval:";

export interface TestFailureEvidence {
  readonly phase: "setup" | "prepare" | "run";
  readonly argv: readonly string[];
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  /** TestCommandResult.error / CommandOutcome.error: the process did not start. */
  readonly spawn_error: string | null;
  /** The end of stdout and stderr. */
  readonly output_tail: string;
}

export type TestFailureClass =
  | { readonly kind: "code" }
  | { readonly kind: "environment"; readonly signal: string; readonly evidence: string };

/** The failure Core hands to the re-investigation. */
export interface TestEnvironmentFailure {
  readonly signal: string;
  readonly evidence: string;
  readonly argv: readonly string[];
}

/** What the Owner is told when the re-investigations did not fix a test environment. */
export interface TestEnvironmentBlock {
  readonly signal: string;
  readonly evidence: string;
  readonly argv: readonly string[];
  /** The failing command was set by the Owner (the Project's test_run). */
  readonly explicit: boolean;
  /** Each investigation's attempts, and Core's own confirmation. */
  readonly tried: readonly string[];
  readonly missing: readonly string[];
  readonly outside_installs: readonly { readonly argv: readonly string[]; readonly reason: string }[];
}

export function classifyTestFailure(input: TestFailureEvidence, signals: TestSetupSettings["environment"]): TestFailureClass {
  const environment = (signal: string, evidence: string): TestFailureClass => ({ kind: "environment", signal, evidence });
  if (input.spawn_error?.startsWith(INSTALL_NEEDS_APPROVAL_PREFIX)) return environment("needs_approval", input.spawn_error);
  if (input.timed_out) return { kind: "code" };
  if (input.spawn_error !== null) return environment("spawn_error", input.spawn_error);
  if (input.phase !== "run") return environment(`${input.phase}_failed`, input.output_tail);
  if (input.exit_code !== null && signals.exit_codes.includes(input.exit_code)) return environment(`exit_code_${input.exit_code}`, input.output_tail);
  const pattern = signals.patterns.find((source) => new RegExp(source, REGEX_FLAGS).test(input.output_tail));
  if (pattern !== undefined) return environment("output_pattern", input.output_tail);
  return { kind: "code" };
}

/** The first environment failure of a finished execution: its setup or prepare step, then each test file. */
export function executionEnvironmentFailure(
  execution: TestExecution,
  argvOfFile: (file: TestFileResult) => readonly string[],
  signals: TestSetupSettings["environment"],
  knownKeys: ReadonlySet<string> = new Set(),
): TestEnvironmentFailure | null {
  const step = execution.prepare_failure;
  if (step !== undefined) {
    const found = classifyTestFailure({ ...step, spawn_error: step.error }, signals);
    if (found.kind === "environment") return { signal: found.signal, evidence: found.evidence, argv: step.argv };
  }
  for (const file of execution.files) {
    if (file.status === "passed") continue;
    // A recorded failure's own output may look like an environment problem; it is not one.
    // The output tail mixes every failure's output, so a file holding recorded ones is read from the other failures' messages only.
    const named = file.status === "failed" && file.failures.length > 0 && file.failures.every((failure) => failure.name !== "");
    const unknown = file.failures.filter((failure) => !knownKeys.has(testFailureKey(failure)));
    if (named && unknown.length === 0) continue;
    const found = classifyTestFailure({
      phase: "run",
      argv: argvOfFile(file),
      exit_code: file.exit_code,
      timed_out: file.status === "timed_out",
      spawn_error: file.status === "error" ? file.failures[0]?.message ?? "" : null,
      output_tail: named && unknown.length < file.failures.length ? unknown.map((failure) => failure.message).join("\n") : file.output_tail,
    }, signals);
    if (found.kind === "environment") return { signal: found.signal, evidence: found.evidence, argv: argvOfFile(file) };
  }
  return null;
}

/** The first policy:test command (one Core did not run itself) whose failure came from the environment. */
export function policyTestEnvironment(policy: TypePolicyResult, signals: TestSetupSettings["environment"]): TestEnvironmentFailure | null {
  for (const check of policy.checks) {
    if (check.command_id !== "policy:test" || check.passed || check.argv === undefined) continue;
    const found = classifyTestFailure({
      phase: "run",
      argv: check.argv,
      exit_code: check.exit_code ?? null,
      timed_out: check.timed_out === true,
      spawn_error: check.spawn_error ?? null,
      output_tail: `${check.stdout ?? ""}\n${check.stderr ?? ""}`.slice(-2000),
    }, signals);
    if (found.kind === "environment") return { signal: found.signal, evidence: found.evidence, argv: check.argv };
  }
  return null;
}

const SETUP_TABLES =["projects", "works", "tasks"] as const;
type OutsideInstall = { argv?: readonly string[]; reason?: string; decision_id?: string | null; approved_at?: string | null };
type RecordRow = { table: (typeof SETUP_TABLES)[number]; id: string };

/** Rewrites outside_installs of each stored record; `edit` returns the new list, or null to leave the record as it is. */
function rewriteOutsideInstalls(transaction: CoreWriteLaneTransaction, rows: readonly RecordRow[], edit: (installs: readonly OutsideInstall[]) => OutsideInstall[] | null): number {
  let changed = 0;
  for (const { table, id } of rows) {
    const text = transaction.get<{ test_setup_json: string | null }>(`SELECT test_setup_json FROM ${table} WHERE id = ?`, id)?.test_setup_json;
    if (text == null) continue;
    const record = JSON.parse(text) as { outside_installs?: readonly OutsideInstall[] };
    const next = edit(Array.isArray(record.outside_installs) ? record.outside_installs : []);
    if (next === null) continue;
    transaction.run(`UPDATE ${table} SET test_setup_json = ? WHERE id = ?`, JSON.stringify({ ...record, outside_installs: next }), id);
    changed += 1;
  }
  return changed;
}

/** The records a Decision of this Work may have named: the Project's, the Work's and its Tasks'. */
function recordRows(transaction: Pick<CoreWriteLaneTransaction, "get" | "all">, workId: string): RecordRow[] {
  const project = transaction.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id ?? null;
  return [
    ...(project === null ? [] : [{ table: "projects" as const, id: project }]),
    { table: "works" as const, id: workId },
    ...transaction.all<{ id: string }>("SELECT id FROM tasks WHERE work_id = ?", workId).map((task) => ({ table: "tasks" as const, id: task.id })),
  ];
}

const sameArgv = (a: readonly string[] | undefined, b: readonly unknown[]): boolean => a !== undefined && a.length === b.length && a.every((part, index) => part === b[index]);

/** Writes the Decision id on the installs it asks about, in the same write that opens it. */
export function tagOutsideInstalls(transaction: CoreWriteLaneTransaction, workId: string, decisionId: string, installs: readonly { readonly argv: readonly string[]; readonly reason?: string }[]): void {
  const rows = recordRows(transaction, workId);
  const stored: (readonly string[] | undefined)[] = [];
  const asked = (entry: OutsideInstall): boolean => installs.some((install) => sameArgv(entry.argv, install.argv));
  rewriteOutsideInstalls(transaction, rows, (existing) => {
    stored.push(...existing.filter(asked).map((entry) => entry.argv));
    return existing.some(asked) ? existing.map((entry) => (asked(entry) ? { ...entry, decision_id: decisionId } : entry)) : null;
  });
  // A command the gate refused may be in no record yet; it is added to the first existing record (the Project's) so an approval has somewhere to be written.
  const unrecorded = installs.filter((install) => !stored.some((argv) => sameArgv(argv, install.argv)));
  if (unrecorded.length === 0) return;
  const added = unrecorded.map((install) => ({ argv: [...install.argv], reason: install.reason ?? "install_needs_approval", decision_id: decisionId, approved_at: null }));
  for (const row of rows) {
    if (rewriteOutsideInstalls(transaction, [row], (existing) => [...existing, ...added]) > 0) return;
  }
}

/**
 * Every argv the Owner approved for this Work, whichever record a run selects: the approved entries of the Project's,
 * the Work's and its Tasks' records, and the installs of the Work's approved Decisions (a refused command may be in no record).
 */
export function approvedInstallArgvs(db: Pick<CoreWriteLaneTransaction, "get" | "all">, workId: string): string[][] {
  const argvs: string[][] = [];
  const add = (argv: unknown): void => {
    if (Array.isArray(argv) && argv.every((part) => typeof part === "string") && !argvs.some((known) => sameArgv(known, argv))) argvs.push([...argv]);
  };
  for (const { table, id } of recordRows(db, workId)) {
    const text = db.get<{ test_setup_json: string | null }>(`SELECT test_setup_json FROM ${table} WHERE id = ?`, id)?.test_setup_json;
    if (text == null) continue;
    try {
      const installs = (JSON.parse(text) as { outside_installs?: unknown }).outside_installs;
      for (const entry of Array.isArray(installs) ? (installs as OutsideInstall[]) : []) {
        if (typeof entry?.approved_at === "string" && entry.approved_at !== "") add(entry.argv);
      }
    } catch {
      // A broken record approves nothing; readStoredTestSetup warns about it where the record is read.
    }
  }
  const decisions = db.all<{ options_json: string }>(
    `SELECT d.options_json FROM events e JOIN decisions d ON d.id = json_extract(e.payload_json, '$.decision_id')
      WHERE e.type = 'test_setup.installs_approved' AND e.work_id = ?`,
    workId,
  );
  for (const { options_json } of decisions) {
    const options = JSON.parse(options_json) as readonly { key?: string; installs?: readonly { argv?: unknown }[] }[];
    for (const install of options.find((option) => option.key === TEST_SETUP_APPROVE_OPTION_KEY)?.installs ?? []) add(install.argv);
  }
  return argvs;
}

/** The Owner approved this Decision: the installs that name it get approved_at. Returns how many records changed. */
export function approveOutsideInstalls(transaction: CoreWriteLaneTransaction, workId: string, decisionId: string, at: string): number {
  const pending = (entry: OutsideInstall): boolean => entry.decision_id === decisionId && !entry.approved_at;
  return rewriteOutsideInstalls(transaction, recordRows(transaction, workId), (existing) => (existing.some(pending) ? existing.map((entry) => (pending(entry) ? { ...entry, approved_at: at } : entry)) : null));
}
