/** error_key Core receives when a Claude report kept failing the enforced schema. */
export const REPORT_FORMAT_INVALID_ERROR_KEY = "report_format_invalid";

/** Prefix the runner puts on an error_key once the run had an external side effect. */
const SIDE_EFFECT_FAILURE_PREFIX = "side_effect_failure:";

/** True for report_format_invalid, also when the runner wrapped it as side_effect_failure:report_format_invalid. */
export function isReportFormatInvalidErrorKey(errorKey: unknown): errorKey is string {
  if (typeof errorKey !== "string") return false;
  return (errorKey.startsWith(SIDE_EFFECT_FAILURE_PREFIX) ? errorKey.slice(SIDE_EFFECT_FAILURE_PREFIX.length) : errorKey) === REPORT_FORMAT_INVALID_ERROR_KEY;
}

/** AgentRunRequest.context key Core uses to cap report-only resubmissions. */
export const REPORT_RESUBMIT_LIMIT_CONTEXT_KEY = "report_resubmit_limit";

/** AgentRunRequest.context key Core sets to resume this Claude session and ask for the report only. */
export const REPORT_RESUBMIT_SESSION_CONTEXT_KEY = "report_resubmit_session";

/** Decision option key for "resubmit only the report". */
export const REPORT_RESUBMIT_OPTION_KEY = "resubmit_report";

/** Report-only resubmissions allowed when Core passes no limit (settings default). */
export const DEFAULT_REPORT_RESUBMIT_LIMIT = 2;

/** error_key Core receives when a Manager or Reviewer answer kept breaking its output format after the resubmissions. */
export const OUTPUT_FORMAT_INVALID_ERROR_KEY = "output_format_invalid";

/** Decision option key for "run only the Reviewer again" after its output kept breaking the format. */
export const REVIEW_RERUN_OPTION_KEY = "rerun_review";

/** Settings key for output-only resubmissions per run (all roles); report_resubmit_limit is read when this one is unset. */
export const OUTPUT_RESUBMIT_LIMIT_SETTINGS_KEY = "output_resubmit_limit";
