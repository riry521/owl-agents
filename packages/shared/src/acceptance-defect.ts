/** Core から Manager へ「この Task の受け入れ条件は Task の中で証明できない」と伝えるイベント。 */
export const ACCEPTANCE_DEFECT_EVENT = "task.acceptance_defect_reported" as const;
/** failedTaskBrief の failure.kind。Manager の指示文はこの値で分岐する。 */
export const ACCEPTANCE_DEFECT_FAILURE_KIND = "acceptance_defect" as const;
/** Worker の verification.acceptance[].status に足す値。 */
export const UNVERIFIABLE_STATUS = "unverifiable" as const;
/** Reviewer の verdict に足す値。 */
export const ACCEPTANCE_DEFECT_VERDICT = "acceptance_defect" as const;
/** 入力の形の上限（運用設定ではなく契約上の上限）。 */
export const ACCEPTANCE_DEFECT_LIMITS = { defects: 20, text: 2000 } as const;

export type AcceptanceDefectSource = "worker" | "reviewer";

export interface AcceptanceDefect {
  /** Worker の criterion_id。Reviewer は分かれば同じ id、なければ "" */
  readonly criterion_id: string;
  /** 対象の条件文（引用） */
  readonly criterion: string;
  /** なぜ Task の中で証明できないか */
  readonly reason: string;
  /** 書き直しの提案（なければ ""） */
  readonly suggestion: string;
}

/** イベント payload の形（Worker も Reviewer も同じ） */
export interface AcceptanceDefectPayload {
  readonly task_id: string;
  readonly source: AcceptanceDefectSource;
  readonly agent_run_id: string;
  readonly defects: AcceptanceDefect[];
  /** Manager への依頼文（formatAcceptanceDefectReason）。no_progress の Decision の recent にも出る */
  readonly reason: string;
}

function clip(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, ACCEPTANCE_DEFECT_LIMITS.text) : "";
}

/** 不明な形にも寛容に正規化する。例外は投げない。criterion と reason が両方とも空の項目は捨てる。 */
export function normalizeAcceptanceDefects(value: unknown): AcceptanceDefect[] {
  if (!Array.isArray(value)) return [];
  const defects: AcceptanceDefect[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const defect = {
      criterion_id: clip(record.criterion_id),
      criterion: clip(record.criterion),
      reason: clip(record.reason),
      suggestion: clip(record.suggestion),
    };
    if (defect.criterion === "" && defect.reason === "") continue;
    defects.push(defect);
    if (defects.length >= ACCEPTANCE_DEFECT_LIMITS.defects) break;
  }
  return defects;
}

/**
 * Worker の報告（unknown）から status === UNVERIFIABLE_STATUS の acceptance 項目を取り出す。
 * reason には unverifiable_reason を使い、なければ evidence を使う。
 */
export function workerAcceptanceDefects(report: unknown): AcceptanceDefect[] {
  if (report === null || typeof report !== "object") return [];
  const verification = (report as Record<string, unknown>).verification;
  if (verification === null || typeof verification !== "object") return [];
  const acceptance = (verification as Record<string, unknown>).acceptance;
  if (!Array.isArray(acceptance)) return [];
  const items = acceptance.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (record.status !== UNVERIFIABLE_STATUS) return [];
    const reason = clip(record.unverifiable_reason) || clip(record.evidence);
    return [{ criterion_id: record.criterion_id, criterion: record.criterion, reason, suggestion: "" }];
  });
  return normalizeAcceptanceDefects(items);
}

/** Manager の replan request に入れる reason 文（Manager への指示は英語で統一されている）。 */
export function formatAcceptanceDefectReason(
  taskId: string,
  source: AcceptanceDefectSource,
  defects: readonly AcceptanceDefect[],
): string {
  const head =
    `Task ${taskId}: the ${source} reported acceptance criteria that cannot be proven inside the Task. ` +
    "Retry the same Task with its existing id and replaces: []. Rewrite only the listed criteria so each one " +
    "is decided by something the Task itself can run, with how to check it; do not compare state outside " +
    "the Task (a live server, live data, another Work). Do not set wait_for.";
  const lines = defects.map((defect) => {
    const id = defect.criterion_id === "" ? "" : `[${defect.criterion_id}] `;
    const suggestion = defect.suggestion === "" ? "" : ` (suggestion: ${defect.suggestion})`;
    return `- ${id}${defect.criterion}: ${defect.reason}${suggestion}`;
  });
  return [head, ...lines].join("\n");
}
