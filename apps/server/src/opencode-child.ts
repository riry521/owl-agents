import { resolve } from "node:path";
import {
  classifyProviderFailure,
  executeOpencode,
  opencodeFailureDetail,
  opencodeTokenUsage,
  parseOpencodeResult,
  providerFailureCause,
  turnFailureProviderError,
  unwrapOpencodeResult,
} from "../../../packages/agent-runtime/dist/index.js";
import {
  OPENCODE_EXECUTABLE_ENV,
  type ChildRunFailureKind,
  type OpencodeChildOutcome,
  type OpencodeChildRun,
} from "../../../packages/shared/dist/index.js";
import { opencodeErrorText } from "../../../packages/core/dist/executor.js";

const REASON_MAX_CHARS = 600;

/**
 * Core's opencodeErrorText (message, cause and redacted stderr tail) capped for the outcome. A provider failure
 * goes through providerFailureCause first: its cause falls back to the reason (e.g. the spawn failure code) when
 * the error carries none, and the error's own message is the same generic text for every provider failure.
 */
function failureText(error: unknown, cause: { readonly error?: unknown; readonly stderr?: string } | null): string {
  const message = error instanceof Error ? error.message : String(error);
  return opencodeErrorText(cause ? new Error(message, { cause }) : error).slice(0, REASON_MAX_CHARS);
}

/**
 * Runs one opencode child on its own `opencode serve` (executeOpencode starts it and stops it on every ending)
 * and maps the result to the failure kinds the child scheduler already knows.
 */
export async function runOpencodeChild(run: OpencodeChildRun, options: { executable?: string } = {}): Promise<OpencodeChildOutcome> {
  try {
    const response = await executeOpencode(
      {
        adapter: "opencode-serve/v1",
        role: "worker",
        model: run.model,
        ...(run.effort ? { effort: run.effort } : {}),
        prompt: run.prompt,
        invocation_id: run.agent_run_id,
        cwd: resolve(run.cwd),
        env: { ...run.env, ...(options.executable ? { [OPENCODE_EXECUTABLE_ENV]: options.executable } : {}) },
        ...(run.signal ? { signal: run.signal } : {}),
        ...(run.on_spawn ? { on_spawn: run.on_spawn } : {}),
        ...(run.on_output ? { on_output: run.on_output } : {}),
      },
      {
        env: {},
        ...(run.guard_token_file ? { guardTokenFile: run.guard_token_file } : {}),
        timeouts: { wallMs: run.timeout_ms, idleMs: run.idle_timeout_ms },
      },
    );
    const usage = opencodeTokenUsage(response.stdout);
    if (response.exit_code === 0) {
      const text = unwrapOpencodeResult(response.stdout)?.trim();
      if (text) return { success: true, output: text, exit_code: 0, usage };
      const output = "opencode finished without a final assistant message.";
      return {
        success: false,
        output,
        exit_code: 0,
        failure_kind: "no_final_report",
        usage,
        provider_error: turnFailureProviderError("opencode", { exit_code: 0, signal: response.signal, error: output, stderr: response.stderr }),
      };
    }
    const error = parseOpencodeResult(response.stdout)?.error;
    const classification = classifyProviderFailure("opencode", { exit_code: response.exit_code, signal: response.signal, kind: "exit", ...(error ? opencodeFailureDetail(error) : {}), stdout: response.stdout, stderr: response.stderr });
    const rate_limit = error ? classification.rate_limit : undefined;
    return {
      success: false,
      output: failureText(error?.message || `opencode exited with code ${String(response.exit_code)}`, { stderr: response.stderr }),
      exit_code: response.exit_code ?? -1,
      failure_kind: "exit_code",
      usage,
      provider_error: classification.provider_error,
      ...(rate_limit ? { rate_limit: { resets_at: rate_limit.resets_at } } : {}),
    };
  } catch (error) {
    const cause = providerFailureCause(error);
    const classification = cause === null ? null : classifyProviderFailure("opencode", cause);
    const rate_limit = cause?.kind === "harness_error" ? classification?.rate_limit : undefined;
    return {
      success: false,
      output: failureText(error, cause),
      exit_code: -1,
      failure_kind: failureKindOf(cause),
      usage: null,
      provider_error: classification?.provider_error ?? turnFailureProviderError("opencode", { error }),
      ...(rate_limit ? { rate_limit: { resets_at: rate_limit.resets_at } } : {}),
    };
  }
}

function failureKindOf(cause: ReturnType<typeof providerFailureCause>): ChildRunFailureKind {
  switch (cause?.kind) {
    case "timeout": return cause.timeout_kind === "idle" ? "idle_timeout" : "timeout";
    case "cancelled": return "cancelled";
    case "output_too_large": return "output_limit";
    case "exit": return "exit_code";
    case "harness_error": return "reported_error";
    default: return "spawn_error";
  }
}
