import {
  DEFAULT_REVIEW_FOCUS_SETTINGS,
  REVIEW_FOCUS_SETTINGS_KEY,
  readReviewFocusSettings,
  type ReviewFocusSettings,
} from "../../shared/dist/review-focus-settings.js";
import type { SettingsReader } from "./owner-language";
import type { LineageReader } from "./task-lineage";

/** One finding reduced to where it points. line is null when the Reviewer gave none. */
export interface ReviewSpot {
  readonly file: string;
  readonly line: number | null;
  readonly problem: string;
}

/** The stored review focus settings; missing or invalid values fall back to the defaults. A failed read never blocks a transition. */
export function reviewFocusSettings(reader: SettingsReader): ReviewFocusSettings {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", REVIEW_FOCUS_SETTINGS_KEY);
    if (!row) return DEFAULT_REVIEW_FOCUS_SETTINGS;
    return readReviewFocusSettings(JSON.parse(row.value_json) as unknown, (message) => {
      console.warn(`[owl-core] ${message}`);
    });
  } catch (error) {
    console.warn("[owl-core] Could not read review focus settings; using defaults.", error);
    return DEFAULT_REVIEW_FOCUS_SETTINGS;
  }
}

/** The major findings that name a file (minor ones and findings without a file point nowhere). */
export function reviewSpots(findings: unknown): ReviewSpot[] {
  if (!Array.isArray(findings)) return [];
  return findings.flatMap((finding: unknown) => {
    if (typeof finding !== "object" || finding === null) return [];
    const { file, line, problem, severity } = finding as Record<string, unknown>;
    if (typeof file !== "string" || file === "" || severity === "minor") return [];
    return [{ file, line: typeof line === "number" ? line : null, problem: typeof problem === "string" ? problem : "" }];
  });
}

/**
 * The spots of the fix_required reviews that came right before now (newest first, at most `count`), counted only from the last
 * replan: a replan changes the approach, so findings from before it do not count against the new one.
 */
export function previousFixSpots(reader: LineageReader, taskId: string, count: number): ReviewSpot[][] {
  const rows = reader.all<{ verdict: string; findings_json: string }>(
    `SELECT verdict, findings_json FROM reviews
      WHERE task_id = ? AND created_at >= COALESCE((
        SELECT MAX(created_at) FROM events
         WHERE task_id = ? AND type = 'task.attempt_decided'
           AND json_extract(payload_json, '$.reason') IN ('replanned', 'dependency_incomplete', 'process_wait')), '')
      ORDER BY round DESC LIMIT ?`,
    taskId, taskId, count,
  );
  const history: ReviewSpot[][] = [];
  for (const row of rows) {
    if (row.verdict !== "fix_required") break;
    try {
      history.push(reviewSpots(JSON.parse(row.findings_json)));
    } catch {
      break;
    }
  }
  return history;
}

/** The current spots that every earlier review in `history` also pointed at (same file, lines within `distance`), preceded by those earlier findings (oldest first) so the Manager sees how the case kept coming back. */
export function repeatedSpots(current: readonly ReviewSpot[], history: readonly (readonly ReviewSpot[])[], distance: number): ReviewSpot[] {
  const near = (a: ReviewSpot, b: ReviewSpot) => a.file === b.file && (a.line === null || b.line === null || Math.abs(a.line - b.line) <= distance);
  const repeated = current.filter((spot) => history.every((earlier) => earlier.some((other) => near(spot, other))));
  const past = [...history].reverse().flatMap((earlier) => earlier.filter((other) => repeated.some((spot) => near(spot, other))));
  return [...past, ...repeated];
}
