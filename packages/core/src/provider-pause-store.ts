import { validationError } from "./errors";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

export type ProviderPauseState = "active" | "paused" | "probing";
export type ProviderPauseResumeSource = "reported" | "backoff";

export interface ProviderPauseRow {
  readonly provider: string;
  readonly state: ProviderPauseState;
  readonly paused_at: string | null;
  readonly resume_at: string | null;
  readonly resume_source: ProviderPauseResumeSource | null;
  readonly reported_resets_at: string | null;
  readonly backoff_step: number;
  readonly probe_started_at: string | null;
  readonly last_error_key: string | null;
  readonly last_error: string | null;
  readonly last_role: string | null;
  readonly last_work_id: string | null;
  readonly last_task_id: string | null;
  readonly resumed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProviderRateLimit {
  readonly provider: string;
  readonly resets_at?: string | null;
  readonly role?: string;
  readonly work_id?: string | null;
  readonly task_id?: string | null;
  readonly last_error_key?: string | null;
  readonly last_error?: string | null;
}

export interface ProviderPauseStore {
  recordRateLimit(report: ProviderRateLimit): Promise<ProviderPauseRow>;
  resume(provider: string): Promise<ProviderPauseRow | null>;
  noteProviderSucceeded(provider: string, runStartedAt: string): Promise<ProviderPauseRow | null>;
  get(provider: string): ProviderPauseRow | null;
  list(): ProviderPauseRow[];
}

const BACKOFF_MINUTES = [15, 30, 60] as const;
const RESUME_GRACE_MS = 30_000;

export function createProviderPauseStore(
  db: Pick<CoreDatabase, "get" | "all" | "createWriteLane">,
  now: () => string = () => new Date().toISOString(),
): ProviderPauseStore {
  const writeLane = db.createWriteLane();

  return {
    recordRateLimit(report) {
      const provider = validateProvider(report?.provider);
      const resetsAt = report.resets_at === undefined || report.resets_at === null
        ? null
        : normalizeDate(report.resets_at, "resets_at");
      return writeLane.transact((tx) => {
        const current = readProviderPause(tx, provider);
        const updatedAt = normalizeDate(now(), "now");
        const next = nextPauseRow(current, report, provider, resetsAt, updatedAt);
        writeProviderPause(tx, next);
        return next;
      });
    },

    resume(providerInput) {
      const provider = validateProvider(providerInput);
      return writeLane.transact((tx) => {
        const current = readProviderPause(tx, provider);
        if (!current || current.state === "active") return null;
        const timestamp = normalizeDate(now(), "now");
        const next: ProviderPauseRow = {
          ...current,
          state: "probing",
          resume_at: timestamp,
          probe_started_at: timestamp,
          updated_at: timestamp,
        };
        writeProviderPause(tx, next);
        return next;
      });
    },

    noteProviderSucceeded(providerInput, runStartedAtInput) {
      const provider = validateProvider(providerInput);
      const runStartedAt = normalizeDate(runStartedAtInput, "run_started_at");
      return writeLane.transact((tx) => {
        const current = readProviderPause(tx, provider);
        if (!current || current.state !== "probing" || runStartedAt < (current.probe_started_at ?? "")) return current ?? null;
        const timestamp = normalizeDate(now(), "now");
        const next: ProviderPauseRow = {
          ...current,
          state: "active",
          backoff_step: 0,
          probe_started_at: null,
          resumed_at: timestamp,
          updated_at: timestamp,
        };
        writeProviderPause(tx, next);
        return next;
      });
    },

    get(providerInput) {
      return readProviderPause(db, validateProvider(providerInput)) ?? null;
    },

    list() {
      return db.all<ProviderPauseRow>(
        "SELECT * FROM provider_pauses WHERE state <> 'active' ORDER BY resume_at, provider",
      );
    },
  };
}

function nextPauseRow(
  before: ProviderPauseRow | undefined,
  report: ProviderRateLimit,
  provider: string,
  resetsAt: string | null,
  now: string,
): ProviderPauseRow {
  if (before?.state === "paused") {
    const details = rateLimitDetails(before, report);
    if (resetsAt === null) return { ...before, ...details, updated_at: now };
    const reportedResumeAt = addMilliseconds(resetsAt, RESUME_GRACE_MS);
    const resumeAt = before.resume_source === "reported" && before.resume_at !== null
      ? maxDate(before.resume_at, reportedResumeAt)
      : reportedResumeAt;
    return {
      ...before,
      ...details,
      resume_at: resumeAt,
      resume_source: "reported",
      reported_resets_at: resetsAt,
      updated_at: now,
    };
  }

  const retrying = before?.state === "probing";
  const backoffStep = retrying ? before.backoff_step + 1 : 0;
  const resumeAt = resetsAt === null
    ? addMilliseconds(now, BACKOFF_MINUTES[Math.min(backoffStep, BACKOFF_MINUTES.length - 1)] * 60_000)
    : addMilliseconds(resetsAt, RESUME_GRACE_MS);

  return {
    provider,
    state: "paused",
    paused_at: before?.state === "probing" ? before.paused_at ?? now : now,
    resume_at: resumeAt,
    resume_source: resetsAt === null ? "backoff" : "reported",
    reported_resets_at: resetsAt,
    backoff_step: backoffStep,
    probe_started_at: null,
    last_error_key: report.last_error_key === undefined ? before?.last_error_key ?? null : report.last_error_key,
    last_error: report.last_error === undefined ? before?.last_error ?? null : report.last_error,
    last_role: report.role === undefined ? before?.last_role ?? null : report.role,
    last_work_id: report.work_id === undefined ? before?.last_work_id ?? null : report.work_id,
    last_task_id: report.task_id === undefined ? before?.last_task_id ?? null : report.task_id,
    resumed_at: before?.resumed_at ?? null,
    created_at: before?.created_at ?? now,
    updated_at: now,
  };
}

function rateLimitDetails(before: ProviderPauseRow, report: ProviderRateLimit): Pick<ProviderPauseRow, "last_error_key" | "last_error" | "last_role" | "last_work_id" | "last_task_id"> {
  return {
    last_error_key: report.last_error_key === undefined ? before.last_error_key : report.last_error_key,
    last_error: report.last_error === undefined ? before.last_error : report.last_error,
    last_role: report.role === undefined ? before.last_role : report.role,
    last_work_id: report.work_id === undefined ? before.last_work_id : report.work_id,
    last_task_id: report.task_id === undefined ? before.last_task_id : report.task_id,
  };
}

function readProviderPause(reader: Pick<CoreWriteLaneTransaction, "get">, provider: string): ProviderPauseRow | undefined {
  return reader.get<ProviderPauseRow>("SELECT * FROM provider_pauses WHERE provider = ?", provider);
}

function writeProviderPause(tx: CoreWriteLaneTransaction, row: ProviderPauseRow): void {
  tx.run(
    `INSERT INTO provider_pauses
       (provider, state, paused_at, resume_at, resume_source, reported_resets_at, backoff_step, probe_started_at,
        last_error_key, last_error, last_role, last_work_id, last_task_id, resumed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET
       state = excluded.state, paused_at = excluded.paused_at, resume_at = excluded.resume_at,
       resume_source = excluded.resume_source, reported_resets_at = excluded.reported_resets_at,
       backoff_step = excluded.backoff_step, probe_started_at = excluded.probe_started_at,
       last_error_key = excluded.last_error_key, last_error = excluded.last_error,
       last_role = excluded.last_role, last_work_id = excluded.last_work_id,
       last_task_id = excluded.last_task_id, resumed_at = excluded.resumed_at, updated_at = excluded.updated_at`,
    row.provider, row.state, row.paused_at, row.resume_at, row.resume_source, row.reported_resets_at,
    row.backoff_step, row.probe_started_at, row.last_error_key, row.last_error, row.last_role,
    row.last_work_id, row.last_task_id, row.resumed_at, row.created_at, row.updated_at,
  );
}

function validateProvider(provider: unknown): string {
  if (typeof provider !== "string" || provider.trim().length === 0) {
    throw validationError("Provider must be a non-empty string.", { field: "provider" });
  }
  return provider;
}

function normalizeDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw validationError("Provider pause timestamps must be valid date strings.", { field });
  }
  return new Date(value).toISOString();
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function maxDate(first: string, second: string): string {
  return Date.parse(first) >= Date.parse(second) ? first : second;
}
