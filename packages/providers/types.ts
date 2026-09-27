export const PROVIDER_CONTRACT_VERSION = "1.0.0" as const;

export const SUPPORTED_ADAPTERS = [
  "claude-cli/v1",
  "codex-cli/v1",
] as const;

export type AdapterId = (typeof SUPPORTED_ADAPTERS)[number];
export type FailureClass = "success" | "transient" | "deterministic";
export type ReportResult = "success" | "failed" | "partial";

export interface ProviderLockRow {
  enabled: boolean;
  logical_provider: string;
  adapter: AdapterId;
  contract_version: string;
  executable_path: string;
  version: string;
  sha256: string;
  verified_at: string;
}

export interface ProviderLockDocument {
  schema_version: string;
  providers: ProviderLockRow[];
}

export interface ResolvedProvider {
  readonly adapter: AdapterId;
  readonly adapterVersion: string;
  readonly logicalProvider: string;
  readonly contractVersion: string;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly lockPath: string;
}

export interface CanonicalActivity {
  kind: "activity";
  text: string;
  at: string;
}

export interface CanonicalReport {
  kind: "report";
  invocation_id: string;
  schema_version: string;
  result: ReportResult;
  work_done: string;
  changes: unknown[];
  verification: Record<string, unknown>;
  remaining_issues: string[];
  next_action: string;
  needs_replanning: boolean;
  question_for_manager: string | null;
  [key: string]: unknown;
}

export interface CanonicalLog {
  kind: "log";
  level: string;
  text: string;
}

export type CanonicalLine = CanonicalActivity | CanonicalReport | CanonicalLog;

export interface CapturedStream {
  readonly bytes: number;
  readonly sha256: string;
  readonly text: string;
}

export interface ProviderProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
}

export interface AdapterOutcome {
  readonly outcome: ReportResult;
  readonly failureClass: FailureClass;
  readonly errorKey: string;
  readonly message: string;
  readonly retryAllowed: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reportValid: boolean;
  readonly adapterVersion: string;
  readonly counterDelta: 0;
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delaySeconds: 30 | 120 | 300 | null;
  readonly counterDelta: 0;
  readonly attempt: number;
  readonly maxRetries: 3;
}

export interface ProviderExecutionResult {
  readonly adapter: AdapterId;
  readonly argv: string[];
  readonly process: ProviderProcessResult;
  readonly canonicalLines: CanonicalLine[];
  readonly canonicalStdout: string;
  readonly report: CanonicalReport | null;
  readonly outcome: AdapterOutcome;
  readonly retry: RetryDecision;
}

export interface HealthExecutionResult {
  readonly adapter: AdapterId;
  readonly argv: string[];
  readonly process: ProviderProcessResult;
  readonly observedVersion: string;
}

export interface IdleAlert {
  readonly adapter: AdapterId;
  readonly executablePath: string;
  readonly idleSeconds: 1800;
}
