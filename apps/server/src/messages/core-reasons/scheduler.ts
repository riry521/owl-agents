import type { SchedulerReasonValues } from "@owl/core";
import type { ReasonTable } from "./types.js";

export const schedulerReasons: ReasonTable<keyof SchedulerReasonValues> = {
  "child_run.request_key_required": {
    ja: () => "request_key は空にできません。値を指定してください。",
    en: () => "request_key must not be empty.",
  },
  "child_run.dispatch_fields_invalid": {
    ja: (v) => `${v.fields} は必須で、サイズの上限（title ${v.title_max_chars} 文字、instruction ${v.instruction_max_chars} 文字、write_paths ${v.write_paths_max} 件）以内にしてください。`,
    en: (v) => `${v.fields} are required and must be within their limits (title ${v.title_max_chars} chars, instruction ${v.instruction_max_chars} chars, write_paths ${v.write_paths_max} items).`,
  },
  "child_run.child_ids_invalid": {
    ja: (v) => `${v.field} は 1 件以上 ${v.max} 件以下の子 ID にしてください。`,
    en: (v) => `${v.field} must contain between 1 and ${v.max} child IDs.`,
  },
  "child_run.return_when_invalid": {
    ja: (v) => `${v.field} は "all" か "any" にしてください。`,
    en: (v) => `${v.field} must be "all" or "any".`,
  },
  "child_run.timeout_seconds_invalid": {
    ja: (v) => `${v.field} は 0 以上の整数にしてください。`,
    en: (v) => `${v.field} must be a non-negative integer.`,
  },
};
