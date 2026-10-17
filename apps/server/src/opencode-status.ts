import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import {
  OPENCODE_EXECUTABLE_ENV,
  OPENCODE_MIN_SUPPORTED_VERSION,
  builtinProviderHarness,
  isSupportedOpencodeVersion,
  opencodeConfigContent,
  opencodeServeEnv,
  parseOpencodeVersion,
} from "../../../packages/shared/dist/index.js";
import { startOpencodeServer, type OpencodeServer } from "../../../packages/agent-runtime/dist/index.js";

import { isOwlSecretEnvName } from "./agent-env.js";
import { AppSettingsStore } from "./app-settings-store.js";
import { cliText } from "./cli-language.js";
import { resolveDataDir, serverPackageRoot } from "./contracts.js";

const VERSION_TIMEOUT_MS = 5_000;
const SERVE_STOP_GRACE_MS = 1_000;

/** OWL_OPENCODE_EXECUTABLE (absolute path), otherwise `opencode` on PATH. */
export function findOpencodeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env[OPENCODE_EXECUTABLE_ENV]?.trim();
  if (configured) {
    try {
      if (!isAbsolute(configured)) return undefined;
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      // Why not fall back to PATH: an explicit setting that does not work should show as missing, not be replaced silently.
      return undefined;
    }
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "opencode");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep checking the next PATH component.
    }
  }
  return undefined;
}

export type OpencodeCliStatus =
  | { readonly state: "missing" }
  | { readonly state: "unsupported"; readonly executable: string; readonly version: string | null }
  | { readonly state: "ok"; readonly executable: string; readonly version: string };

// Keyed by path, mtime and size so a replaced executable is read again.
const versionCache = new Map<string, string | null>();

function readVersionOutput(executable: string): Promise<string | null> {
  let key: string;
  try {
    const stat = statSync(executable);
    key = [executable, stat.mtimeMs, stat.size].join("|");
  } catch {
    return Promise.resolve(null);
  }
  if (versionCache.has(key)) return Promise.resolve(versionCache.get(key)!);
  return new Promise((resolve) => {
    execFile(executable, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
      const output = error ? null : stdout;
      versionCache.set(key, output);
      resolve(output);
    });
  });
}

export async function opencodeCliStatus(env: NodeJS.ProcessEnv = process.env): Promise<OpencodeCliStatus> {
  const executable = findOpencodeExecutable(env);
  if (!executable) return { state: "missing" };
  const output = await readVersionOutput(executable);
  const parsed = output === null ? null : parseOpencodeVersion(output);
  const version = parsed ? parsed.join(".") : null;
  return output !== null && version !== null && isSupportedOpencodeVersion(output)
    ? { state: "ok", executable, version }
    : { state: "unsupported", executable, version };
}

/** The warning shared by doctor and setup for an opencode that is too old (or whose version cannot be read). */
export function opencodeUnsupportedMessage(found: string | null): string {
  return cliText(
    `opencodeの版が対応外です（見つかった版: ${found ?? "不明"}、最低の版: ${OPENCODE_MIN_SUPPORTED_VERSION}）。更新してください。`,
    `The opencode version is not supported (found: ${found ?? "unknown"}, minimum: ${OPENCODE_MIN_SUPPORTED_VERSION}). Please update it.`,
  );
}

export interface OpencodeRole {
  readonly role: string;
  readonly model: string;
}

interface ReadonlySqliteDatabase {
  prepare(sql: string): { get(...parameters: unknown[]): unknown };
  close(): void;
}

/** Roles whose saved model setting uses opencode (the built-in provider or a custom one on the opencode harness); read without modifying the database. */
export function opencodeRoles(owlRoot: string): OpencodeRole[] {
  const dataDir = resolveDataDir(owlRoot);
  let database: ReadonlySqliteDatabase | null = null;
  try {
    const requireFromDb = createRequire(join(serverPackageRoot(), "../../packages/db/package.json"));
    const Database = requireFromDb("better-sqlite3") as new (file: string, options: { readonly: true; fileMustExist: true }) => ReadonlySqliteDatabase;
    database = new Database(join(dataDir, "owl.sqlite"), { readonly: true, fileMustExist: true });
    const row = database.prepare("SELECT value_json FROM settings WHERE key = 'model_settings'").get() as { value_json?: unknown } | undefined;
    if (typeof row?.value_json !== "string") return [];
    const roles = (JSON.parse(row.value_json) as { roles?: unknown }).roles;
    if (!Array.isArray(roles)) return [];
    const custom = new AppSettingsStore(owlRoot, dataDir).getCustomProviders();
    return roles.flatMap((entry: { role?: unknown; provider?: unknown; model?: unknown }) => {
      if (typeof entry?.role !== "string" || typeof entry.provider !== "string") return [];
      const provider = entry.provider.trim().toLowerCase();
      const harness = builtinProviderHarness(provider) ?? (custom[provider] ?? custom[entry.provider])?.harnessId;
      return harness === "opencode" ? [{ role: entry.role, model: typeof entry.model === "string" ? entry.model : "" }] : [];
    });
  } catch {
    // Why not log: a fresh install has no database yet, which simply means no role uses opencode.
    return [];
  } finally {
    database?.close();
  }
}

/**
 * Runs `fn` against a private `opencode serve` that reads no MCP servers or user config, then stops it.
 * The password lives only in the serve's env and in the client.
 */
export async function withPrivateOpencodeServe<T>(
  executable: string,
  env: NodeJS.ProcessEnv,
  fn: (server: OpencodeServer) => Promise<T>,
): Promise<T> {
  const runDir = await mkdtemp(join(tmpdir(), "owl-opencode-"));
  let server: OpencodeServer | undefined;
  try {
    const serveEnv = opencodeServeEnv({
      // Same environment a run gets (so provider credentials in it apply), minus Owl's own secrets.
      env: Object.fromEntries(Object.entries(env).filter(([name]) => !isOwlSecretEnvName(name))),
      password: randomBytes(24).toString("hex"),
      runDir,
      configContent: opencodeConfigContent({ cwd: runDir, model: "", env: {}, permissions: [], mcpServers: [] }),
    });
    server = await startOpencodeServer({ executable, cwd: runDir, env: serveEnv });
    return await fn(server);
  } finally {
    await server?.stop(SERVE_STOP_GRACE_MS).catch(() => server?.kill());
    await rm(runDir, { recursive: true, force: true });
  }
}
