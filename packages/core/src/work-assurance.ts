import { notFound } from "./errors";
import type { CoreDatabase, JsonObject } from "./types";

export interface WorkAssuranceReview {
  readonly task_id: string;
  readonly required: boolean;
  readonly base: string;
  /** Why the Reviewer was skipped; null when the review is required. */
  readonly skip_reason: string | null;
  /** Why Core raised the review to required, as recorded by the routing. */
  readonly forced_reasons: readonly { readonly code: string; readonly detail: string }[];
}

export interface WorkAssurance {
  readonly work_id: string;
  readonly reviews: readonly WorkAssuranceReview[];
  /** The latest integration verification of the Work branch; null before one ran. */
  readonly integration_verification: JsonObject | null;
  readonly plan_quality_warnings: readonly JsonObject[];
}

const isRecord = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function parseObject(json: string): JsonObject | null {
  try {
    const value = JSON.parse(json) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Reads the recorded review routing, integration verification and plan quality warnings of one Work. */
export function getWorkAssurance(db: CoreDatabase, workId: string): WorkAssurance {
  if (!db.get("SELECT id FROM works WHERE id = ?", workId)) throw notFound("work", workId);
  const reviews: WorkAssuranceReview[] = [];
  for (const row of db.all<{ id: string; review_decision_json: string }>(
    "SELECT id, review_decision_json FROM tasks WHERE work_id = ? AND review_decision_json IS NOT NULL ORDER BY id",
    workId,
  )) {
    const decision = parseObject(row.review_decision_json);
    if (!decision || typeof decision.required !== "boolean") continue;
    const forced = Array.isArray(decision.forced_reasons) ? decision.forced_reasons.filter(isRecord) : [];
    reviews.push({
      task_id: row.id,
      required: decision.required,
      base: typeof decision.base === "string" ? decision.base : "",
      skip_reason: typeof decision.skip_reason === "string" ? decision.skip_reason : null,
      forced_reasons: forced.map((reason) => ({ code: String(reason.code ?? ""), detail: String(reason.detail ?? "") })),
    });
  }
  const events = (type: string): JsonObject[] =>
    db.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE work_id = ? AND type = ? ORDER BY sequence", workId, type)
      .map((row) => parseObject(row.payload_json))
      .filter((payload): payload is JsonObject => payload !== null);
  const verifications = events("work.integration_verification_completed");
  return {
    work_id: workId,
    reviews,
    integration_verification: verifications.at(-1) ?? null,
    plan_quality_warnings: events("work.plan_quality_warned"),
  };
}
