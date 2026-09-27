/** Longest wall-clock or no-output limit an agent process can be given. */
export const MAX_AGENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Wall-clock limit for one agent or Executor process unless configured otherwise. */
export const DEFAULT_AGENT_WALL_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** No-output limit for agent processes that stream progress, unless configured otherwise. */
export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** A running agent with no output for this long raises an `agent.idle` alert. */
export const AGENT_STALE_THRESHOLD_MS = 30 * 60 * 1000;

export const AGENT_WALL_TIMEOUT_ENV = "OWL_PROVIDER_TIMEOUT_MS";
export const AGENT_IDLE_TIMEOUT_ENV = "OWL_PROVIDER_IDLE_TIMEOUT_MS";

export type AgentTimeoutKind = "wall" | "idle";

/** Raised for a timeout setting that is not a usable duration. */
export class AgentTimeoutSettingError extends Error {
  public constructor(public readonly setting: string, message: string) {
    super(message);
    this.name = "AgentTimeoutSettingError";
  }
}

function durationSetting(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new AgentTimeoutSettingError(key, `${key} must be a whole number of milliseconds (0 disables the limit).`);
  }
  return Math.min(Number(raw), MAX_AGENT_TIMEOUT_MS);
}

/** Wall-clock limit in milliseconds from OWL_PROVIDER_TIMEOUT_MS; 0 means no limit. */
export function agentWallTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  return durationSetting(env, AGENT_WALL_TIMEOUT_ENV, DEFAULT_AGENT_WALL_TIMEOUT_MS);
}

/**
 * No-output limit in milliseconds from OWL_PROVIDER_IDLE_TIMEOUT_MS; 0 means
 * no limit. A limit shorter than the `agent.idle` alert threshold is rejected
 * so the Owner is always alerted before a silent process is stopped.
 */
export function agentIdleTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const value = durationSetting(env, AGENT_IDLE_TIMEOUT_ENV, DEFAULT_AGENT_IDLE_TIMEOUT_MS);
  if (value !== 0 && value < AGENT_STALE_THRESHOLD_MS) {
    throw new AgentTimeoutSettingError(
      AGENT_IDLE_TIMEOUT_ENV,
      `${AGENT_IDLE_TIMEOUT_ENV} must be 0 or at least ${AGENT_STALE_THRESHOLD_MS} (the agent.idle alert threshold).`,
    );
  }
  return value;
}

/**
 * Tracks progress in a Codex `--json` event stream. Every complete event line
 * counts as progress except `error` events, which Codex also emits while it
 * retries a lost connection, so a run stuck reconnecting still goes idle.
 */
export class CodexProgressTracker {
  private pending = "";

  public constructor(private readonly onProgress: () => void) {}

  public push(chunk: string): void {
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      if (line.length > 0 && !isCodexErrorEvent(line)) this.onProgress();
      newline = this.pending.indexOf("\n");
    }
  }
}

function isCodexErrorEvent(line: string): boolean {
  try {
    const event = JSON.parse(line) as unknown;
    return Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "error");
  } catch {
    return false;
  }
}
