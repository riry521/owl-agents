import { cliText } from "./cli-language.js";
import { isIP } from "node:net";

import { loadOwlEnv } from "../../../packages/shared/dist/env.js";
import { AgentTimeoutSettingError, agentIdleTimeoutMs, agentWallTimeoutMs } from "../../../packages/shared/dist/index.js";

// Every server entry point imports this module before reading process.env.
// Existing process values are intentionally kept authoritative by loadOwlEnv.
loadOwlEnv();

export const DEFAULT_BIND = "127.0.0.1" as const;
export const DEFAULT_PORT = 3787 as const;

export function configuredBind(): string {
  return process.env.OWL_BIND?.trim() || DEFAULT_BIND;
}

export function configuredPort(): string | undefined {
  return process.env.OWL_PORT;
}

export function configuredApiToken(): string | undefined {
  const token = process.env.OWL_API_TOKEN?.trim();
  return token && token.length > 0 ? token : undefined;
}

export function getPluginsFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.OWL_PLUGINS_FILE?.trim();
  return path && path.length > 0 ? path : null;
}

export function isLoopbackBind(bind: string): boolean {
  const normalized = bind.trim().replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost") return true;
  const addressType = isIP(normalized);
  return addressType === 4
    ? normalized.startsWith("127.")
    : addressType === 6 && (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1");
}

export function isExternalBind(bind: string): boolean {
  return !isLoopbackBind(bind);
}

export function tailscaleServeEnabled(): boolean {
  return process.env.OWL_TAILSCALE_SERVE?.trim() === "1";
}

/**
 * Returns a user-safe configuration error without including any secret value.
 * Tailscale Serve needs no token: only devices in the owner's tailnet can reach it.
 */
export function serverExposureError(bind: string): string | null {
  if (isExternalBind(bind) && !configuredApiToken()) {
    return cliText('非loopback bindではOWL_API_TOKENが必須です。OWL_API_TOKENを設定してから起動してください。例: OWL_BIND=127.0.0.1（ローカル限定）またはOWL_API_TOKEN=<long-random-token>', 'OWL_API_TOKEN is required for non-loopback binding. Set it before startup, or use OWL_BIND=127.0.0.1 for local access.');
  }
  return null;
}

/** Returns why the agent process time limits cannot be used, or null when they are valid. */
export function agentTimeoutConfigurationError(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    agentWallTimeoutMs(env);
    agentIdleTimeoutMs(env);
    return null;
  } catch (error) {
    if (error instanceof AgentTimeoutSettingError) return error.message;
    throw error;
  }
}

export function deprecatedConfigurationWarnings(): string[] {
  if (!Object.prototype.hasOwnProperty.call(process.env, "OWL_HOST")) return [];
  return [
    cliText('OWL_HOSTはv1では使用しません。OWL_BINDへ置き換えてください（OWL_HOSTは無視されます）。', 'OWL_HOST is not used in v1. Use OWL_BIND instead; OWL_HOST is ignored.'),
  ];
}

export function providerMode(): "stub" | "real" | "invalid" {
  const value = process.env.OWL_PROVIDER?.trim().toLowerCase();
  if (!value || value === "real") return "real";
  if (value === "stub") return "stub";
  return "invalid";
}
