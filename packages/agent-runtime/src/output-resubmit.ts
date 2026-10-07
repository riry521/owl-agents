import { addTokenUsage, type TokenUsage } from "@owl/shared";
import { extractProviderUsage } from "./protocol";
import type { ProviderResponse } from "./types";

/** A role answer that broke its output format (schema violation, missing field); the work behind it is fine. */
export class OutputFormatError extends Error {
  constructor(readonly problem: string, readonly original?: unknown) {
    super(problem);
    this.name = "OutputFormatError";
  }
}

export type OutputResubmitOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly response: ProviderResponse; readonly resubmits: number; readonly usage: TokenUsage | null }
  | { readonly ok: false; readonly error: unknown; readonly response: ProviderResponse; readonly resubmits: number; readonly usage: TokenUsage | null };

/** The prompt that asks a resumed session to give its previous answer again in the required format. */
export function outputResubmitPrompt(problem: string): string {
  return [
    "Your work is already done. Do not edit files, run commands, or redo any investigation, planning or review.",
    `Your last answer was rejected because it did not match the required output format: ${problem}`,
    "Return that same answer again now, with the same content, as exactly one output in the required format",
    "(one structured output call if the format is enforced; no tool-call markup inside values).",
  ].join(" ");
}

/**
 * Runs `parse` over a provider answer. When it throws OutputFormatError and the session id is known,
 * resumes the same session (up to `limit` times) and asks for the answer only. Any other error, a
 * missing session id or an exhausted limit end the loop with `ok: false`; the caller decides what
 * that means (Owner decision, failure record).
 */
export async function runWithOutputResubmit<T>(options: {
  readonly first: ProviderResponse;
  readonly parse: (response: ProviderResponse) => T;
  readonly resubmit: (sessionId: string, prompt: string) => Promise<ProviderResponse>;
  readonly limit: number;
  /** False once resubmitting is no longer safe (the run already had an external side effect). */
  readonly canResubmit?: () => boolean;
}): Promise<OutputResubmitOutcome<T>> {
  let response = options.first;
  let usage = extractProviderUsage(response);
  let resubmits = 0;
  for (;;) {
    let problem: string;
    try {
      return { ok: true, value: options.parse(response), response, resubmits, usage };
    } catch (error) {
      if (!(error instanceof OutputFormatError) || !response.provider_session_id || resubmits >= options.limit || options.canResubmit?.() === false) {
        return { ok: false, error, response, resubmits, usage };
      }
      problem = error.problem;
    }
    response = await options.resubmit(response.provider_session_id, outputResubmitPrompt(problem));
    usage = addTokenUsage(usage, extractProviderUsage(response));
    resubmits++;
  }
}
