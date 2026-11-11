import type { CoreReasonCode, CoreReasonValues } from "@owl/core";
import type { OwnerLanguage } from "@owl/shared/owner-language";
import { coreMainReasons } from "./core.js";
import { otherReasons } from "./other.js";
import { schedulerReasons } from "./scheduler.js";
import type { ReasonTable } from "./types.js";
import { workflowReasons } from "./workflow.js";

// The annotation is the completeness check: a CoreReasonCode with no sentence in any file fails the build.
const REASONS: ReasonTable<CoreReasonCode> = { ...schedulerReasons, ...coreMainReasons, ...workflowReasons, ...otherReasons };

/** Sentence for a reason code in one language, or undefined when the code is unknown (e.g. from a newer core). */
export function coreReasonMessage(language: OwnerLanguage, code: string, values: unknown): string | undefined {
  if (!Object.hasOwn(REASONS, code)) return undefined;
  const text = REASONS[code as CoreReasonCode] as { ja: (v: unknown) => string; en: (v: unknown) => string };
  return text[language](values as CoreReasonValues[CoreReasonCode]);
}
