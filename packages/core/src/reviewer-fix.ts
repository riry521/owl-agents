import {
  DEFAULT_REVIEWER_FIX_SETTINGS,
  readReviewerFixSettings,
  REVIEWER_FIX_SETTINGS_KEY,
  validateReviewerFixSettings,
  type ReviewerFixSettings,
} from "@owl/shared/reviewer-fix-settings";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingSpec } from "./settings-store";

export const REVIEWER_FIX_SETTING: SettingSpec<ReviewerFixSettings> = {
  key: REVIEWER_FIX_SETTINGS_KEY,
  defaults: DEFAULT_REVIEWER_FIX_SETTINGS,
  read: readReviewerFixSettings,
  warnPrefix: "reviewer_fix: ",
  readFailure: "Could not read reviewer_fix; using defaults",
  validate: validateReviewerFixSettings,
  event: { type: "settings.reviewer_fix_updated", idempotencyPrefix: "settings-reviewer-fix" },
};

/** The stored Reviewer fix limits; missing or invalid values fall back to the defaults. */
export function reviewerFixSettings(reader: SettingsReader): ReviewerFixSettings {
  return readSetting(reader, REVIEWER_FIX_SETTING);
}

export interface ReviewerFixFinding {
  readonly severity?: unknown;
  readonly scope?: unknown;
  readonly caused_by_change?: unknown;
  readonly target?: unknown;
  readonly subject?: unknown;
}

/** A finding that stops the Task: severity major (normalizeReviewFindings has already turned goal and beyond_acceptance majors into minor). */
export function isBlockingFinding(finding: ReviewerFixFinding): boolean {
  return finding.severity === "major";
}

/** A blocking finding a Reviewer may fix itself: not overbuilt (a removal), not about a test result (evidence of a criterion), and about the deliverable. */
export function isFixableFinding(finding: ReviewerFixFinding): boolean {
  return isBlockingFinding(finding) && (finding.scope === "in_scope" || (finding.caused_by_change === true && (finding.scope === "beyond_acceptance" || finding.scope === "goal"))) && finding.target === "deliverable" && finding.subject === "other";
}

export type ReviewerFixNotAllowedReason =
  | "fix_not_permitted" | "head_moved" | "verdict_not_fixable" | "file_not_editable" | "no_fix_report"
  | "finding_not_fixable" | "blocking_finding_left" | "report_mismatch";

export interface ReviewerFixJudgement {
  /** `ok` means every rule holds and Core may run the Task's tests. */
  readonly outcome: "ok" | "over_limit" | "not_allowed";
  readonly reason: ReviewerFixNotAllowedReason | null;
  readonly measured: { readonly changed_lines: number; readonly changed_files: number };
}

export interface ReviewerFixJudgementInput {
  readonly permit: { readonly limits: { readonly max_changed_lines: number; readonly max_changed_files: number }; readonly editable_files: readonly string[] } | null;
  readonly headMoved: boolean;
  /** The Reviewer's own verdict, before Core changes it. */
  readonly verdict: string;
  readonly findings: readonly ReviewerFixFinding[];
  readonly fixes: readonly { readonly finding_index: number; readonly file: string }[];
  readonly files: readonly { readonly path: string; readonly status: string; readonly added_lines: number; readonly deleted_lines: number; readonly binary: boolean }[];
}

/** The pure rules of the design (6.4 step 3, a to i): the first one that applies decides; the limits are inclusive. */
export function judgeReviewerFix(input: ReviewerFixJudgementInput): ReviewerFixJudgement {
  const measured = {
    changed_lines: input.files.reduce((sum, file) => sum + file.added_lines + file.deleted_lines, 0),
    changed_files: input.files.length,
  };
  const notAllowed = (reason: ReviewerFixNotAllowedReason): ReviewerFixJudgement => ({ outcome: "not_allowed", reason, measured });
  if (input.permit === null) return notAllowed("fix_not_permitted");
  if (input.headMoved) return notAllowed("head_moved");
  if (input.verdict !== "fix_required") return notAllowed("verdict_not_fixable");
  const editable = new Set(input.permit.editable_files);
  if (input.files.some((file) => !editable.has(file.path) || file.status !== "M" || file.binary)) return notAllowed("file_not_editable");
  if (input.fixes.length === 0) return notAllowed("no_fix_report");
  const pointed = new Set<number>();
  for (const fix of input.fixes) {
    const finding = Number.isInteger(fix.finding_index) ? input.findings[fix.finding_index] : undefined;
    if (finding === undefined || !isFixableFinding(finding)) return notAllowed("finding_not_fixable");
    pointed.add(fix.finding_index);
  }
  if (input.findings.some((finding, index) => isBlockingFinding(finding) && !pointed.has(index))) return notAllowed("blocking_finding_left");
  const reported = new Set(input.fixes.map((fix) => fix.file));
  const changed = new Set(input.files.map((file) => file.path));
  if (reported.size !== changed.size || [...reported].some((path) => !changed.has(path))) return notAllowed("report_mismatch");
  const { max_changed_lines, max_changed_files } = input.permit.limits;
  if (measured.changed_lines > max_changed_lines || measured.changed_files > max_changed_files) return { outcome: "over_limit", reason: null, measured };
  return { outcome: "ok", reason: null, measured };
}
