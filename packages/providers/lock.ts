import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, sep } from "node:path";
import { providerVersionMismatch } from "./errors.js";
import {
  PROVIDER_CONTRACT_VERSION,
  SUPPORTED_ADAPTERS,
  type AdapterId,
  type ProviderLockDocument,
  type ProviderLockRow,
  type ResolvedProvider,
} from "./types.js";

export interface ProviderLockValidationOptions {
  readonly allowedExecutableRoot: string;
  readonly expectedVersion?: string;
  readonly observedVersion?: string;
}
const ROW_KEYS = [
  "enabled",
  "logical_provider",
  "adapter",
  "contract_version",
  "executable_path",
  "version",
  "sha256",
  "verified_at",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

function readJsonText(path: string, adapter: AdapterId | null): unknown {
  try {
    const bytes = readFileSync(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw providerVersionMismatch("lock_unreadable_or_invalid_json", adapter);
  }
}

function validateRow(value: unknown, adapterHint: AdapterId | null): ProviderLockRow {
  if (!isRecord(value) || !hasOnlyKeys(value, ROW_KEYS)) {
    throw providerVersionMismatch("lock_row_schema", adapterHint);
  }

  if (typeof value.enabled !== "boolean") {
    throw providerVersionMismatch("lock_enabled_type", adapterHint);
  }
  if (typeof value.logical_provider !== "string" || value.logical_provider.length === 0) {
    throw providerVersionMismatch("lock_logical_provider", adapterHint);
  }
  if (
    value.adapter !== SUPPORTED_ADAPTERS[0] &&
    value.adapter !== SUPPORTED_ADAPTERS[1]
  ) {
    throw providerVersionMismatch("adapter_not_in_mvp_allowlist", null);
  }
  const adapter = value.adapter as AdapterId;
  if (typeof value.contract_version !== "string") {
    throw providerVersionMismatch("lock_contract_version_type", adapter);
  }
  if (typeof value.executable_path !== "string") {
    throw providerVersionMismatch("lock_executable_path_type", adapter);
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw providerVersionMismatch("lock_provider_version", adapter);
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw providerVersionMismatch("lock_sha256", adapter);
  }
  if (
    typeof value.verified_at !== "string" ||
    !value.verified_at.endsWith("Z") ||
    Number.isNaN(Date.parse(value.verified_at))
  ) {
    throw providerVersionMismatch("lock_verification_date", adapter);
  }

  return {
    enabled: value.enabled,
    logical_provider: value.logical_provider,
    adapter,
    contract_version: value.contract_version,
    executable_path: value.executable_path,
    version: value.version,
    sha256: value.sha256,
    verified_at: value.verified_at,
  };
}

export function readProviderLock(lockPath: string): ProviderLockDocument {
  const parsed = readJsonText(lockPath, null);
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["schema_version", "providers"])) {
    throw providerVersionMismatch("lock_document_schema");
  }
  if (parsed.schema_version !== PROVIDER_CONTRACT_VERSION) {
    throw providerVersionMismatch("lock_schema_version");
  }
  if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
    throw providerVersionMismatch("lock_providers_missing");
  }

  const providers = parsed.providers.map((row) => validateRow(row, null));
  const seen = new Set<string>();
  for (const row of providers) {
    if (seen.has(row.adapter)) {
      throw providerVersionMismatch("duplicate_adapter_row", row.adapter);
    }
    seen.add(row.adapter);
  }
  const enabled = new Set(
    providers.filter((row) => row.enabled).map((row) => row.adapter),
  );
  if (
    enabled.size !== SUPPORTED_ADAPTERS.length ||
    SUPPORTED_ADAPTERS.some((adapter) => !enabled.has(adapter))
  ) {
    throw providerVersionMismatch("enabled_adapter_set_mismatch");
  }

  return {
    schema_version: parsed.schema_version,
    providers,
  };
}

function assertVersionString(version: string, adapter: AdapterId): void {
  if (/^(latest|current|pending|uncomputed)$/i.test(version) || /^\d+$/.test(version)) {
    throw providerVersionMismatch("provider_version_is_not_exact", adapter);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function digestFile(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveExecutable(
  row: ProviderLockRow,
  options: ProviderLockValidationOptions,
): string {
  if (!isAbsolute(row.executable_path)) {
    throw providerVersionMismatch("executable_path_not_absolute", row.adapter);
  }

  let root: string;
  let resolved: string;
  try {
    root = realpathSync(options.allowedExecutableRoot);
    resolved = realpathSync(row.executable_path);
  } catch (cause) {
    throw providerVersionMismatch("executable_missing_or_unresolvable", row.adapter);
  }
  if (!isAbsolute(resolved) || !isWithinRoot(resolved, root)) {
    throw providerVersionMismatch("executable_realpath_outside_allowed_root", row.adapter);
  }

  let stat: { isFile(): boolean; mode: number };
  try {
    stat = statSync(resolved);
  } catch (cause) {
    throw providerVersionMismatch("executable_stat_failed", row.adapter);
  }
  if (!stat.isFile()) {
    throw providerVersionMismatch("executable_not_regular_file", row.adapter);
  }
  if ((stat.mode & 0o111) === 0) {
    throw providerVersionMismatch("executable_not_executable", row.adapter);
  }
  if (digestFile(resolved) !== row.sha256) {
    throw providerVersionMismatch("executable_digest_mismatch", row.adapter);
  }
  return resolved;
}

export function validateProviderLock(
  lockPath: string,
  adapter: AdapterId,
  options: ProviderLockValidationOptions,
): ResolvedProvider {
  const document = readProviderLock(lockPath);
  const row = document.providers.find(
    (candidate) => candidate.adapter === adapter && candidate.enabled,
  );
  if (row === undefined) {
    throw providerVersionMismatch("enabled_adapter_row_missing", adapter);
  }
  if (row.contract_version !== PROVIDER_CONTRACT_VERSION) {
    throw providerVersionMismatch("adapter_contract_version_mismatch", adapter);
  }
  assertVersionString(row.version, adapter);
  if (options.expectedVersion !== undefined && row.version !== options.expectedVersion) {
    throw providerVersionMismatch("locked_provider_version_mismatch", adapter);
  }
  if (
    options.observedVersion !== undefined &&
    !options.observedVersion.includes(row.version)
  ) {
    throw providerVersionMismatch("observed_provider_version_mismatch", adapter);
  }

  const executablePath = resolveExecutable(row, options);
  return Object.freeze({
    adapter,
    adapterVersion: row.version,
    logicalProvider: row.logical_provider,
    contractVersion: row.contract_version,
    executablePath,
    executableSha256: row.sha256,
    lockPath,
  });
}
