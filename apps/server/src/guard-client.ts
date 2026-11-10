import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { GUARD_TOKEN_FILE_ENV } from "../../../packages/shared/dist/guard-token.js";

/** The run's Guard API settings, resolved from the environment. */
export interface GuardConfig {
  readonly role: string | undefined;
  readonly base: string;
  /** Absent only when `fallback` supplied a base without a token file. */
  readonly tokenFile: string | undefined;
  /** Env var holding a token to use when there is no token file. */
  readonly tokenFallbackVar: string | undefined;
}

export interface GuardConfigOptions {
  /** Env var holding the role: MCP servers get OWL_ROLE, hooks get OWL_AGENT_ROLE. */
  readonly roleVar: "OWL_ROLE" | "OWL_AGENT_ROLE";
  /** The role must equal this. */
  readonly role?: string;
  /** Any non-empty role is accepted (and none is not). */
  readonly requireRole?: boolean;
  readonly requireRunId?: boolean;
  /** The token file path must be absolute. */
  readonly absoluteTokenFile?: boolean;
  /** Env vars read when OWL_GUARD_API_BASE is absent; the token file is then optional and `tokenVar` supplies the token. */
  readonly fallback?: { readonly baseVar: string; readonly tokenVar: string };
}

/** Drops one trailing slash (what the hooks always did). */
export const trimOneSlash = (base: string): string => base.replace(/\/$/u, "");
/** Drops every trailing slash (what the MCP servers did). */
export const trimAllSlashes = (base: string): string => base.replace(/\/+$/u, "");

/** The Guard API settings, or null when the environment does not satisfy the options. */
export function guardConfig(options: GuardConfigOptions): GuardConfig | null {
  const role = process.env[options.roleVar];
  const base = process.env.OWL_GUARD_API_BASE ?? (options.fallback ? process.env[options.fallback.baseVar] : undefined);
  const tokenFile = process.env[GUARD_TOKEN_FILE_ENV];
  if (options.role !== undefined && role !== options.role) return null;
  if (options.requireRole && !role) return null;
  if (options.requireRunId && !process.env.OWL_AGENT_RUN_ID) return null;
  if (!base) return null;
  if (!options.fallback && !tokenFile) return null;
  if (options.absoluteTokenFile && (!tokenFile || !isAbsolute(tokenFile))) return null;
  return { role, base, tokenFile, tokenFallbackVar: options.fallback?.tokenVar };
}

/** The token in `tokenFile`; throws when the file cannot be read. Read per request: the token is leased per run. */
const readToken = async (tokenFile: string): Promise<string> => (await readFile(tokenFile, "utf8")).trim();

/** Whether the token file can be read and is not empty. */
export async function guardHasToken(config: GuardConfig): Promise<boolean> {
  if (!config.tokenFile) return false;
  try {
    return (await readToken(config.tokenFile)).length > 0;
  } catch {
    return false;
  }
}

export interface GuardRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly redirect?: "error" | "follow" | "manual";
  readonly timeoutMs: number;
  /** Turns `base` into the URL root; defaults to dropping every trailing slash. */
  readonly normalizeBase?: (base: string) => string;
  /** Send `authorization: Bearer ` even when the token is empty (what the MCP servers always did); otherwise an empty token sends none. */
  readonly authorizeEmptyToken?: boolean;
}

/**
 * fetch with the bearer token and a timeout; the method is POST unless given. `target` is a path under the
 * Guard API base, or a complete URL. Throws when the token file cannot be read. Returns the token too so
 * callers can scrub it from responses.
 */
export async function guardRequest(config: GuardConfig, target: string | URL, init: GuardRequestInit): Promise<{ response: Response; token: string | undefined }> {
  const token = config.tokenFile ? await readToken(config.tokenFile) : config.tokenFallbackVar ? process.env[config.tokenFallbackVar] : undefined;
  const url = typeof target === "string" ? `${(init.normalizeBase ?? trimAllSlashes)(config.base)}${target}` : target;
  const response = await fetch(url, {
    method: init.method ?? "POST",
    headers: { ...init.headers, ...(token || (init.authorizeEmptyToken && token !== undefined) ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body,
    redirect: init.redirect,
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  return { response, token };
}
