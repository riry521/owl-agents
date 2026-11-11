/** Reason codes for child-run-scheduler.ts (T41). Value shapes are what the server table interpolates. */
export interface SchedulerReasonValues {
  "child_run.request_key_required": { field: "request_key" };
  "child_run.dispatch_fields_invalid": { fields: string; title_max_chars: number; instruction_max_chars: number; write_paths_max: number };
  "child_run.child_ids_invalid": { field: "child_ids"; max: number };
  "child_run.return_when_invalid": { field: "return_when" };
  "child_run.timeout_seconds_invalid": { field: "timeout_seconds" };
}
