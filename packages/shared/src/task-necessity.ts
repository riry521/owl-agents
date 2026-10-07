export const CHECK_WEIGHTS = ["light", "medium", "heavy"] as const;
export type CheckWeight = typeof CHECK_WEIGHTS[number];

export interface TaskNecessity {
  readonly serves: string;
  readonly if_omitted: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Lenient read: null unless an object; non-strings become "". Per-criterion necessity lives in the acceptance criteria. */
export function parseTaskNecessity(value: unknown): TaskNecessity | null {
  if (!isRecord(value)) return null;
  return { serves: text(value.serves), if_omitted: text(value.if_omitted) };
}

/** Text appended to a Task's context so Worker, Designer and Reviewer see why the Task exists. */
export function renderTaskNecessity(necessity: TaskNecessity): string {
  return ["Necessity (Manager plan):", `Task serves: ${necessity.serves}`, `If omitted: ${necessity.if_omitted}`].join("\n");
}

/** The Manager's context, notes and necessity for one Task, kept as written in tasks.plan_context_json. */
export interface TaskPlanContext {
  readonly context: string | null;
  readonly notes: string | null;
  readonly necessity: TaskNecessity | null;
}

/** What roles read: legacy is set when the Task has no plan_context_json, so context holds the whole tasks.context text. */
export interface StoredTaskPlanContext {
  readonly context: string | null;
  readonly manager_notes: string | null;
  readonly necessity: TaskNecessity | null;
  readonly legacy?: true;
}

/** Reads the JSON column; a missing or damaged column reads tasks.context whole and never splits it. */
export function readStoredTaskPlanContext(json: string | null | undefined, contextText: string | null): StoredTaskPlanContext {
  if (typeof json === "string" && json !== "") {
    try {
      const parsed: unknown = JSON.parse(json);
      if (isRecord(parsed)) {
        const field = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
        return { context: field(parsed.context), manager_notes: field(parsed.notes), necessity: parseTaskNecessity(parsed.necessity) };
      }
    } catch {
      // A damaged column reads like a Task without one.
    }
  }
  return { context: contextText === null || contextText === "" ? null : contextText, manager_notes: null, necessity: null, legacy: true };
}
