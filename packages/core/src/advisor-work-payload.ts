import type { AdvisorWorkOperationType } from "../../shared/dist/advisor-response.js";

export interface AdvisorWorkOperationPayload {
  readonly workId: string;
  readonly body?: string;
  readonly reopen: boolean;
  readonly title?: string;
  readonly summary?: string;
  readonly pauseReason: string;
  readonly cancelReason?: string;
  readonly resumeBody?: string;
  readonly projectId: string;
}

/** The trimmed work_id execution uses; null when it is missing or out of range. */
export function advisorWorkId(payload: Readonly<Record<string, unknown>> | undefined): string | null {
  const raw = payload?.work_id;
  return typeof raw === "string" && raw.trim().length >= 1 && raw.trim().length <= 128 ? raw.trim() : null;
}

/** Reads a Work-operation payload exactly as execution does (trimming included); the fingerprint shares it so both agree. */
export function parseAdvisorWorkOperationPayload(
  type: AdvisorWorkOperationType,
  payload: Readonly<Record<string, unknown>> | undefined,
): { ok: true; value: AdvisorWorkOperationPayload } | { ok: false } {
  const workId = advisorWorkId(payload);
  if (workId === null) return { ok: false };
  const value: { -readonly [K in keyof AdvisorWorkOperationPayload]: AdvisorWorkOperationPayload[K] } = {
    workId,
    reopen: false,
    pauseReason: "Advisor requested pause.",
    projectId: "",
  };

  if (type === "send_work_instruction") {
    const rawBody = payload?.body;
    const requestedReopen = payload?.reopen;
    if (typeof rawBody !== "string" || rawBody.trim().length < 1 || rawBody.length > 100_000 || (requestedReopen !== undefined && typeof requestedReopen !== "boolean")) {
      return { ok: false };
    }
    value.body = rawBody.trim();
    value.reopen = requestedReopen === true;
  } else if (type === "update_work") {
    const rawTitle = payload?.title;
    const rawSummary = payload?.summary;
    if (
      (rawTitle === undefined && rawSummary === undefined) ||
      (rawTitle !== undefined && (typeof rawTitle !== "string" || rawTitle.trim().length < 1 || rawTitle.length > 500)) ||
      (rawSummary !== undefined && (typeof rawSummary !== "string" || rawSummary.trim().length < 1 || rawSummary.length > 20_000))
    ) {
      return { ok: false };
    }
    if (typeof rawTitle === "string") value.title = rawTitle.trim();
    if (typeof rawSummary === "string") value.summary = rawSummary.trim();
  } else if (type === "pause_work") {
    const reason = payload?.reason;
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 1_000)) return { ok: false };
    if (typeof reason === "string") value.pauseReason = reason.trim();
  } else if (type === "resume_work") {
    const rawBody = payload?.body;
    if (rawBody !== undefined && (typeof rawBody !== "string" || rawBody.trim().length < 1 || rawBody.length > 10_000)) return { ok: false };
    if (typeof rawBody === "string") value.resumeBody = rawBody.trim();
  } else if (type === "cancel_work") {
    const reason = payload?.reason;
    if (typeof reason !== "string" || reason.trim().length < 1 || reason.trim().length > 1_000) return { ok: false };
    value.cancelReason = reason.trim();
  } else if (type === "move_work_to_project") {
    const rawProjectId = payload?.project_id;
    if (typeof rawProjectId !== "string" || rawProjectId.trim().length < 1 || rawProjectId.trim().length > 128) return { ok: false };
    value.projectId = rawProjectId.trim();
  }
  return { ok: true, value };
}
