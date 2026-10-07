import type { PlanQualityCode, PlanQualitySettings } from "../../shared/dist/plan-quality-settings.js";
import { acceptanceCriteriaProblems } from "../../shared/dist/acceptance-criteria.js";
import type { TaskPlanItem } from "./types";

export type { PlanQualityCode };

export interface PlanQualityWarning {
  readonly task_ref: string;
  readonly title: string;
  readonly code: PlanQualityCode;
  /** English explanation handed to the Manager. */
  readonly detail: string;
  readonly measured: number | string[];
  readonly threshold: number | null;
}

const matchesAny = (sources: readonly string[], text: string): boolean => sources.some((source) => new RegExp(source, "iu").test(text));

/** Removes the spans that point at a copy or a guarded target, so only what is still named can count as external. */
const withoutExempt = (sources: readonly string[], text: string): string => sources.reduce((rest, source) => rest.replace(new RegExp(source, "giu"), " "), text);

export type PlanQualityOutcome = "repair_requested" | "accepted_with_warnings" | "rejected";

/** Decides what happens to a plan with warnings; call only when warnings is not empty. */
export function planQualityOutcome(warnings: readonly PlanQualityWarning[], repairsUsed: number, settings: PlanQualitySettings): PlanQualityOutcome {
  if (repairsUsed < settings.max_repair_requests) return "repair_requested";
  return warnings.some((warning) => settings.blocking_codes.includes(warning.code)) ? "rejected" : "accepted_with_warnings";
}

/** Pure quality check of the new and revised Tasks of a plan; reads the criteria fields only (content, check, weight), never splits text. */
export function evaluatePlanQuality(items: readonly TaskPlanItem[], settings: PlanQualitySettings): PlanQualityWarning[] {
  const warnings: PlanQualityWarning[] = [];
  items.forEach((item, index) => {
    const base = { task_ref: item.id ?? item.manager_task_id ?? `#${index}`, title: item.title };
    const criteria = item.acceptance_criteria ?? [];
    const missing = acceptanceCriteriaProblems(item.acceptance_criteria);
    const necessity = item.necessity ?? null;
    if (necessity === null) missing.push("necessity");
    else {
      if (necessity.serves.trim() === "") missing.push("necessity.serves");
      if (necessity.if_omitted.trim() === "") missing.push("necessity.if_omitted");
    }
    if (missing.length > 0) {
      warnings.push({ ...base, code: "criterion_field_missing", detail: `Fields are missing or out of range (${missing.join(", ")}). Give the Task a necessity (serves, if_omitted) and every acceptance criterion an id (AC1, AC2, ...), text, check, serves, if_omitted, check_weight and, for heavy, weight_reason.`, measured: missing, threshold: null });
      // Criteria with broken fields are not read any further; the Manager fixes the format first.
      return;
    }
    const fields = (criterion: { readonly text: string; readonly check: string }): string => `${criterion.text}\n${criterion.check}`;
    const heavy = criteria.filter((criterion) => (criterion.check_weight === "heavy" || matchesAny(settings.heavy_check_patterns, fields(criterion))) && (criterion.weight_reason ?? "").trim() === "");
    if (heavy.length > 0) {
      warnings.push({ ...base, code: "heavy_check_unjustified", detail: `A criterion needs a heavy check without a reason (${heavy[0].text.slice(0, 200)}). Make it lighter (a small sample, a stub provider, a temporary copy with a few items), or, only if the request cannot be met otherwise, set check_weight heavy and give weight_reason.`, measured: heavy.length, threshold: 0 });
    }
    if (item.type === "design") return;
    if (criteria.length > settings.max_acceptance_items) {
      warnings.push({ ...base, code: "acceptance_items_over", detail: `The acceptance has ${criteria.length} criteria (limit ${settings.max_acceptance_items}). Narrow the Task or split it into separate Tasks.`, measured: criteria.length, threshold: settings.max_acceptance_items });
    }
    const chars = criteria.reduce((sum, criterion) => sum + [...criterion.text].length + [...criterion.check].length, 0);
    if (chars > settings.max_acceptance_chars) {
      warnings.push({ ...base, code: "acceptance_chars_over", detail: `The acceptance is ${chars} characters (limit ${settings.max_acceptance_chars}). Shorten it or split the Task.`, measured: chars, threshold: settings.max_acceptance_chars });
    }
    const external = criteria.map(fields).filter((text) => {
      const remaining = withoutExempt(settings.external_state_exempt_patterns, text);
      return matchesAny(settings.external_state_patterns, remaining) && matchesAny(settings.state_comparison_patterns, remaining);
    });
    if (external.length > 0) {
      warnings.push({ ...base, code: "external_state_comparison", detail: `Criterion compares state outside the Task (${external[0].slice(0, 200)}). Replace it with a check the Task can run itself, e.g. on a copy made inside the Task, or with write access denied.`, measured: external.length, threshold: 0 });
    }
  });
  return warnings;
}

export function formatPlanQualityReason(warnings: readonly PlanQualityWarning[]): string {
  return warnings.map((warning) => `- ${warning.task_ref} "${warning.title}" [${warning.code}]: ${warning.detail}`).join("\n");
}

/** The previous Manager output handed back, one field per fact: validator errors (one sentence each) and quality warnings as they were measured. */
export interface PreviousOutputFeedback {
  readonly kind: "plan_rejected" | "fields_missing" | "quality_rejected" | "quality_repair";
  readonly errors: readonly string[];
  readonly warnings: readonly PlanQualityWarning[];
}
