import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDotEnv } from "../../../packages/shared/dist/env.js";

/**
 * Credentials that belong to Owl itself (connectors, the local API, the guard
 * endpoint, the legacy vault and Owl-managed provider keys). Agent processes
 * never need them, so they are removed from every agent environment. Anything
 * else the operator's environment carries (MCP server credentials, CLI
 * configuration, proxies) passes through unchanged.
 */
const OWL_SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  "OWL_API_TOKEN",
  "OWL_GUARD_TOKEN",
  "OWL_SECRET_PASSPHRASE",
  "OWL_TYPESAFE_API_KEY",
  "TYPESAFE_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "DISCORD_BOT_TOKEN",
]);

/** Role-scoped timeout and context-limit settings (see agent-timeouts.ts). */
const ROLE_RUNTIME_SETTING_ENV = /^(?:OWL_PROVIDER_(?:IDLE_)?TIMEOUT_MS_[A-Z0-9_]+|OWL_ROLE_SESSION_CONTEXT_LIMIT(?:_[A-Z0-9_]+)?)$/u;

const OWL_PROVIDER_API_KEY_ENV = /^OWL_PROVIDER_[A-Z0-9_]+_API_KEY$/u;

/**
 * Owl's project .env holds Owl's own configuration and credentials. Its keys
 * are withheld from agents, except for standard process, CLI and network
 * settings and the non-secret Owl runtime settings the agent processes read.
 */
const SHARED_CONFIGURATION_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "LANG",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "OWL_ROOT",
  "OWL_DATA_DIR",
  "OWL_INSTANCE_ID",
  "OWL_CLAUDE_EXECUTABLE",
  "OWL_CODEX_EXECUTABLE",
  "OWL_PROVIDER_TIMEOUT_MS",
  "OWL_PROVIDER_IDLE_TIMEOUT_MS",
]);

export function isOwlSecretEnvName(name: string): boolean {
  return OWL_SECRET_ENV_NAMES.has(name) || OWL_PROVIDER_API_KEY_ENV.test(name);
}

function projectEnvKeys(owlRoot: string): ReadonlySet<string> {
  const envPath = join(owlRoot, ".env");
  if (!existsSync(envPath)) return new Set();
  try {
    return new Set(Object.keys(parseDotEnv(readFileSync(envPath, "utf8"))));
  } catch (error) {
    console.error(`[agent-env] Could not read project .env keys from ${envPath}`, error);
    return new Set();
  }
}

export interface AgentEnvOptions {
  readonly owlRoot: string;
  /** Additional Owl-managed names to withhold, such as custom provider key variables. */
  readonly deny?: Iterable<string>;
  /** Owl-provided values applied after filtering. */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * Build the environment for an agent process from the server environment.
 * Owl's own secrets are removed; everything else passes through so agents keep
 * every MCP server, tool and CLI configuration the operator set up.
 */
export function buildAgentEnv(source: NodeJS.ProcessEnv, options: AgentEnvOptions): Record<string, string> {
  const withheld = new Set(options.deny ?? []);
  for (const key of projectEnvKeys(options.owlRoot)) {
    if (!SHARED_CONFIGURATION_ENV_NAMES.has(key) && !ROLE_RUNTIME_SETTING_ENV.test(key) && !key.startsWith("LC_")) withheld.add(key);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (withheld.has(key) || isOwlSecretEnvName(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_NONPROJECT_CLAUDE_MD = "1";
  env.OWL_ROOT = options.owlRoot;
  for (const [key, value] of Object.entries(options.extra ?? {})) env[key] = value;
  return env;
}
