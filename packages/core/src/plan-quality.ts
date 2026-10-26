import type { PlanFeedbackKind } from "../../shared/dist/manager-trigger.js";
import type { PlanQualityCode, PlanQualitySettings } from "../../shared/dist/plan-quality-settings.js";
import { acceptanceCriteriaProblems, criterionRequirement, isManagerCriterion, type AcceptanceCriterion, type CriteriaRelaxation, type StoredAcceptanceCriterion } from "../../shared/dist/acceptance-criteria.js";
import { workSummaryListItems } from "../../shared/dist/work-summary.js";
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

/** The warnings worth asking the Manager to repair; record-only warnings are left out. */
export const repairableWarnings = (warnings: readonly PlanQualityWarning[], settings: PlanQualitySettings): PlanQualityWarning[] =>
  warnings.filter((warning) => !settings.record_only_codes.includes(warning.code));

/**
 * Decides what happens to a plan with warnings; call only when warnings is not empty.
 * finalAttempt is true on the last Manager call that progress_guard.plan_rejection_attempts_max allows.
 * Why not max_repair_requests: counting repairs apart from rejections applied a plan still over a limit
 * after one repair, and added Manager calls beyond plan_rejection_attempts_max before a Decision.
 */
export function planQualityOutcome(warnings: readonly PlanQualityWarning[], finalAttempt: boolean, settings: PlanQualitySettings): PlanQualityOutcome {
  if (!finalAttempt && repairableWarnings(warnings, settings).length > 0) return "repair_requested";
  return warnings.some((warning) => settings.blocking_codes.includes(warning.code)) ? "rejected" : "accepted_with_warnings";
}

const squeezed = (value: string): string => value.replace(/\s+/gu, "");

/**
 * Pure quality check of the new and revised Tasks of a plan; reads the criteria fields only (content, check, weight), never splits text.
 * ownerTexts are the Owner's own words (Work summary, instructions, Decision answers) a criterion with origin owner must quote.
 * summary is the Work summary: an owner criterion quoted from its Goals section must be goal, one quoted only from its Acceptance section must be required.
 */
export function evaluatePlanQuality(items: readonly TaskPlanItem[], settings: PlanQualitySettings, ownerTexts: readonly string[] = [], summary: string | null = null): PlanQualityWarning[] {
  const warnings: PlanQualityWarning[] = [];
  const goalLines = summary === null ? [] : workSummaryListItems(summary, "goals").map(squeezed);
  const acceptanceLines = summary === null ? [] : workSummaryListItems(summary, "acceptance").map(squeezed);
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
    // The Owner asking for a heavy or external check is itself the reason, so only the quote is checked for those criteria.
    const ownerSet = criteria.filter((criterion) => criterion.origin?.kind === "owner");
    const unquoted = ownerSet.filter((criterion) => {
      const quote = squeezed(criterion.origin?.quote ?? "");
      return quote === "" || !ownerTexts.some((text) => squeezed(text).includes(quote));
    });
    if (unquoted.length > 0) {
      warnings.push({ ...base, code: "criterion_origin_unquoted", detail: `A criterion marked origin owner does not quote the Owner (${unquoted.map((criterion) => criterion.id).join(", ")}). Copy the Owner's sentence from the Work summary, an instruction or a Decision answer into origin.quote, or mark the criterion origin manager.`, measured: unquoted.map((criterion) => criterion.id), threshold: null });
    }
    // Instruction and Decision answer quotes are not checked: the Owner may move a criterion between required and goal by saying so.
    const mismatched = ownerSet.filter((criterion) => {
      if (criterion.origin?.source !== "summary") return false;
      const quote = squeezed(criterion.origin.quote ?? "");
      if (quote === "") return false;
      const inGoals = goalLines.some((line) => line.includes(quote));
      const inAcceptance = acceptanceLines.some((line) => line.includes(quote));
      const requirement = criterionRequirement(criterion);
      return (inGoals && requirement !== "goal") || (inAcceptance && !inGoals && requirement !== "required");
    });
    if (mismatched.length > 0) {
      warnings.push({ ...base, code: "criterion_requirement_mismatch", detail: `A criterion marked origin owner has a requirement that differs from the Work summary section it quotes (${mismatched.map((criterion) => criterion.id).join(", ")}). A sentence from the Goals section is goal; a sentence from the Acceptance section is required.`, measured: mismatched.map((criterion) => criterion.id), threshold: null });
    }
    const forOwner = new Set<unknown>(ownerSet);
    const heavy = criteria.filter((criterion) => !forOwner.has(criterion) && (criterion.check_weight === "heavy" || matchesAny(settings.heavy_check_patterns, fields(criterion))) && (criterion.weight_reason ?? "").trim() === "");
    if (heavy.length > 0) {
      const ids = heavy.map((criterion) => criterion.id);
      warnings.push({ ...base, code: "heavy_check_unjustified", detail: `Task ${base.task_ref}: criteria ${ids.join(", ")} need a heavy check without a reason. Make each lighter (a small sample, a stub provider, a temporary copy with a few items), or, only if the request cannot be met otherwise, set check_weight heavy and give weight_reason.`, measured: ids, threshold: null });
    }
    if (item.type === "design") return;
    if (criteria.length > settings.max_acceptance_items) {
      warnings.push({ ...base, code: "acceptance_items_over", detail: `The acceptance has ${criteria.length} criteria (limit ${settings.max_acceptance_items}). Narrow the Task or split it into separate Tasks.`, measured: criteria.length, threshold: settings.max_acceptance_items });
    }
    const lengths = criteria.map((criterion) => ({ id: criterion.id, chars: [...criterion.text].length + [...criterion.check].length }));
    const chars = lengths.reduce((sum, entry) => sum + entry.chars, 0);
    if (chars > settings.max_acceptance_chars) {
      const longest = [...lengths].sort((a, b) => b.chars - a.chars).map((entry) => `${entry.id} ${entry.chars}`).join(", ");
      warnings.push({ ...base, code: "acceptance_chars_over", detail: `Task ${base.task_ref}: the acceptance is ${chars} characters in total (limit ${settings.max_acceptance_chars}); characters of text and check per criterion, longest first: ${longest}. Shorten the longest criteria or split the Task.`, measured: chars, threshold: settings.max_acceptance_chars });
    }
    const external = criteria.filter((criterion) => !forOwner.has(criterion)).map(fields).filter((text) => {
      const remaining = withoutExempt(settings.external_state_exempt_patterns, text);
      return matchesAny(settings.external_state_patterns, remaining) && matchesAny(settings.state_comparison_patterns, remaining);
    });
    if (external.length > 0) {
      warnings.push({ ...base, code: "external_state_comparison", detail: `Criterion compares state outside the Task (${external[0].slice(0, 200)}). Replace it with a check the Task can run itself, e.g. on a copy made inside the Task, or with write access denied.`, measured: external.length, threshold: 0 });
    }
  });
  return warnings;
}

/**
 * The problems of an automatic replan that loosens Manager-made criteria of a retried Task, one sentence each; [] when it is allowed.
 * Only the checking may get lighter: the criterion stays (id, kind), still says what is checked (text, check, keeps) and passes the blocking quality checks.
 */
export function evaluateCriteriaRelaxation(
  current: readonly StoredAcceptanceCriterion[],
  revised: readonly AcceptanceCriterion[],
  relaxations: readonly CriteriaRelaxation[],
  settings: PlanQualitySettings,
): string[] {
  const errors: string[] = [];
  for (const before of current.filter(isManagerCriterion)) {
    const after = revised.find((criterion) => criterion.id === before.id);
    if (after === undefined) {
      errors.push(`Criterion ${before.id} was removed; loosen it instead of deleting it, and keep the same criterion_id.`);
      continue;
    }
    const requirementChanged = criterionRequirement(after) !== criterionRequirement(before);
    if (after.text === before.text && after.check === before.check && !requirementChanged) continue;
    if (requirementChanged) errors.push(`Criterion ${before.id}: requirement must stay ${criterionRequirement(before)} when loosening.`);
    if (after.text.trim() === "" || after.check.trim() === "") errors.push(`Criterion ${before.id}: text and check must not be empty after loosening.`);
    if ((after.kind ?? "work_check") !== (before.kind ?? "work_check")) errors.push(`Criterion ${before.id}: kind must stay ${before.kind ?? "work_check"} when loosening.`);
    const record = relaxations.find((entry) => entry.criterion_id === before.id);
    if (record === undefined) errors.push(`Criterion ${before.id} was changed but has no entry in auto_recovery.criteria_relaxations (criterion_id, reason, keeps).`);
    else if (record.reason.trim() === "") errors.push(`Criterion ${before.id}: criteria_relaxations.reason must say why the criterion is loosened.`);
    else if (record.keeps.trim() === "") errors.push(`Criterion ${before.id}: criteria_relaxations.keeps must say what is still checked.`);
    const blocking = evaluatePlanQuality(
      [{ title: before.id, type: "code", acceptance: after.text, acceptance_criteria: [{ ...after, id: "AC1" }], necessity: { serves: "-", if_omitted: "-" } }],
      settings,
    ).filter((warning) => settings.blocking_codes.includes(warning.code));
    if (blocking.length > 0) errors.push(`Criterion ${before.id}: the loosened criterion still fails the plan quality check.\n${formatPlanQualityReason(blocking)}`);
  }
  return errors;
}

export function formatPlanQualityReason(warnings: readonly PlanQualityWarning[]): string {
  return warnings.map((warning) => `- ${warning.task_ref} "${warning.title}" [${warning.code}]: ${warning.detail}`).join("\n");
}

/** The previous Manager output handed back, one field per fact: validator errors (one sentence each) and quality warnings as they were measured. */
export interface PreviousOutputFeedback {
  readonly kind: PlanFeedbackKind;
  readonly errors: readonly string[];
  readonly warnings: readonly PlanQualityWarning[];
}
