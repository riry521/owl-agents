import type { LearningMetricsSettings } from "../../shared/dist/learning-metrics-settings.js";
import { createHash } from "node:crypto";
import { ruleKeyFingerprint } from "./learning-fingerprint.js";
import type { MetricsReader } from "./review-metrics.js";
import type { OwnerLanguage } from "./owner-language";
import type { RuleProposalCreateResult, RuleProposals } from "./rule-proposals.js";

export interface MetricsRuleCandidate {
  readonly task_type: string;
  readonly first_review_pass_rate: number;
  readonly tasks: number;
  readonly threshold: number;
  readonly min_tasks: number;
  /** The Tasks and Works behind the rate, sorted, and the span of the Tasks' created_at. */
  readonly task_ids: readonly string[];
  readonly work_ids: readonly string[];
  readonly first_at: string;
  readonly last_at: string;
}

/** The rule text proposed for a Task type, per Owner language. */
const RULE_TEXT: Record<OwnerLanguage, (taskType: string) => string> = {
  ja: (taskType) => `${taskType} Task の Worker は、報告前に受け入れ基準を 1 つずつ Reviewer の目で読み直し、証拠を基準ごとに書く`,
  en: (taskType) => `A Worker on a ${taskType} Task rereads each acceptance criterion as the Reviewer would before reporting, and writes evidence per criterion`,
};

/**
 * Task types whose first review pass rate is below the threshold, with at least min_tasks reviewed Tasks.
 * Reads reviews and tasks.type only, so failures that are not review verdicts never count.
 */
export function metricsRuleCandidates(db: MetricsReader, settings: LearningMetricsSettings): MetricsRuleCandidate[] {
  if (!settings.enabled) return [];
  const rows = db.all<{
    task_type: string; passed: number | null; total: number;
    task_ids: string; work_ids: string; first_at: string; last_at: string;
  }>(`
    WITH first AS (
      SELECT r.task_id, r.verdict FROM reviews r
      WHERE r.round = (SELECT MIN(round) FROM reviews WHERE task_id = r.task_id))
    SELECT t.type AS task_type, SUM(first.verdict = 'pass') AS passed, COUNT(*) AS total,
      group_concat(DISTINCT t.id) AS task_ids, group_concat(DISTINCT t.work_id) AS work_ids,
      MIN(t.created_at) AS first_at, MAX(t.created_at) AS last_at
    FROM first JOIN tasks t ON t.id = first.task_id
    GROUP BY t.type ORDER BY t.type`);
  return rows
    .filter((row) => row.total >= settings.min_tasks && (row.passed ?? 0) / row.total < settings.first_review_pass_rate_below)
    .map((row) => ({
      task_type: row.task_type,
      first_review_pass_rate: Math.round((10000 * (row.passed ?? 0)) / row.total) / 10000,
      tasks: row.total,
      threshold: settings.first_review_pass_rate_below,
      min_tasks: settings.min_tasks,
      task_ids: row.task_ids.split(",").sort(),
      work_ids: row.work_ids.split(",").sort(),
      first_at: row.first_at,
      last_at: row.last_at,
    }));
}

function listIds(label: string, ids: readonly string[], max: number): string {
  const shown = ids.slice(0, max).join(",");
  return `${label}(${ids.length}${ids.length > max ? `, first ${max}` : ""})=${shown}`;
}

/** Same aggregate, same ref; a changed aggregate is a new source that merges into the same proposal. */
function snapshotRef(candidate: MetricsRuleCandidate): string {
  const digest = createHash("sha256").update(JSON.stringify([candidate.task_type, candidate.first_review_pass_rate, candidate.task_ids])).digest("hex");
  return `metrics:${candidate.task_type}:${digest.slice(0, 16)}`;
}

/** Records each candidate as a rule proposal whose source is the metrics snapshot. Never approves: the Owner does that. */
export async function proposeFromMetrics(
  proposals: RuleProposals,
  candidates: readonly MetricsRuleCandidate[],
  options: { readonly project_id: string | null; readonly language: OwnerLanguage; readonly max_ids: number },
): Promise<RuleProposalCreateResult[]> {
  const results: RuleProposalCreateResult[] = [];
  for (const candidate of candidates) {
    const text = RULE_TEXT[options.language](candidate.task_type);
    results.push(await proposals.create({
      origin: "metrics",
      source: { kind: "metrics_snapshot", ref: snapshotRef(candidate) },
      input_fingerprint: ruleKeyFingerprint(text, "role", "worker"),
      level: "role",
      role: "worker",
      text,
      rationale: [
        `scope: Tasks of type=${candidate.task_type}, first review of each Task`,
        `first_review_pass_rate=${candidate.first_review_pass_rate} tasks=${candidate.tasks} threshold=${candidate.threshold} min_tasks=${candidate.min_tasks}`,
        `period: ${candidate.first_at} .. ${candidate.last_at}`,
        listIds("tasks", candidate.task_ids, options.max_ids),
        listIds("works", candidate.work_ids, options.max_ids),
      ].join("; "),
      applies_to: candidate.task_type,
      project_id: options.project_id,
    }));
  }
  return results;
}
