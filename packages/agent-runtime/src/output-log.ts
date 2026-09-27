import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentRunnerOptions, ProviderResponse } from "./types";

/** How much of each stream is kept: the tail, where the final answer is. */
export const OUTPUT_LOG_TAIL_CHARS = 20_000;

/**
 * Where raw provider output of a failed protocol parse is kept.
 * `options.outputLogDir` wins (null disables). Otherwise the server's data
 * directory is used, resolved the same way as the server does:
 * `$OWL_DATA_DIR` (absolute, or relative to OWL_ROOT) or `OWL_ROOT/data`,
 * then `logs/agent-output`. Without an OWL_ROOT there is no data directory
 * and nothing is written.
 */
export function resolveOutputLogDir(options: AgentRunnerOptions): string | null {
  if (options.outputLogDir !== undefined) return options.outputLogDir;
  const owlRoot = options.env?.OWL_ROOT;
  if (!owlRoot || !isAbsolute(owlRoot)) return null;
  const configured = options.env?.OWL_DATA_DIR ?? process.env.OWL_DATA_DIR;
  const dataDir = !configured
    ? join(owlRoot, "data")
    : isAbsolute(configured) ? resolve(configured) : resolve(owlRoot, configured);
  return join(dataDir, "logs", "agent-output");
}

/** Mask credentials the same way Core masks user-visible error text. */
export function redactProviderOutput(text: string): string {
  return text
    .replace(/(bearer\s+|authorization\s*[:=]\s*|api[-_ ]?key\s*[:=]\s*|access[_ -]?token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;"]+/giu, "$1[redacted]")
    .replace(/\b(?:sk|xoxb|xoxp|xapp|ghp|gho|github_pat)[-_][A-Za-z0-9_-]+\b/gu, "[redacted]");
}

function tail(text: string): string {
  const redacted = redactProviderOutput(text);
  return redacted.length > OUTPUT_LOG_TAIL_CHARS
    ? `[... ${redacted.length - OUTPUT_LOG_TAIL_CHARS} earlier characters omitted ...]\n${redacted.slice(-OUTPUT_LOG_TAIL_CHARS)}`
    : redacted;
}

/**
 * Write the redacted tail of stdout/stderr for one invocation whose output
 * did not match the role contract, so the operator can see what the model
 * actually returned. Returns the file path, or null when logging is disabled
 * or the write failed (a logging problem never masks the real failure).
 */
export function writeInvalidOutputLog(
  directory: string | null,
  entry: {
    readonly invocationId: string;
    readonly role: string;
    readonly reason: string;
    readonly response: Pick<ProviderResponse, "adapter" | "stdout" | "stderr" | "exit_code" | "format">;
  },
): string | null {
  if (!directory) return null;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const safeId = entry.invocationId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80) || "invocation";
    const path = join(directory, `${safeId}-${Date.now()}.log`);
    const body = [
      `invocation_id: ${entry.invocationId}`,
      `role: ${entry.role}`,
      `adapter: ${entry.response.adapter}`,
      `format: ${entry.response.format ?? "provider-json"}`,
      `exit_code: ${entry.response.exit_code}`,
      `reason: ${entry.reason}`,
      `written_at: ${new Date().toISOString()}`,
      `--- stdout (redacted, last ${OUTPUT_LOG_TAIL_CHARS} characters) ---`,
      tail(entry.response.stdout),
      `--- stderr (redacted, last ${OUTPUT_LOG_TAIL_CHARS} characters) ---`,
      tail(entry.response.stderr),
      "",
    ].join("\n");
    writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
    return path;
  } catch (error) {
    console.warn(`[agent-runtime] Could not write the invalid-output log for ${entry.invocationId}`, error);
    return null;
  }
}
