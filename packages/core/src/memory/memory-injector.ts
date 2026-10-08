import type { MemoryRole } from "./memory-types.js";

const MAX_CONTEXT_CHARS = 1500;

export interface MemoryInjectionInput {
  readonly role: MemoryRole;
  /** Work title, Task title, Task text, … (design §6.3). */
  readonly query: readonly (string | null | undefined)[];
  readonly project_id: string | null;
  /** Advisor start only: appended after `query` (active Work titles and summaries). */
  readonly start_query?: readonly (string | null | undefined)[];
  /** Advisor only: injected ids are remembered per session; the first call of a session is the start catalog. */
  readonly session_id?: string;
  /** What to recall research clippings for (Owner's statement, or the Work request). Advisor, Manager and Designer only. */
  readonly recall_query?: string;
}

/** Materials of the search text; `searchQuery` orders them per role (design §6.2, §6.3). */
export interface QueryMaterials {
  readonly work_title?: string | null;
  readonly work_summary?: string | null;
  readonly project_name?: string | null;
  readonly task_title?: string | null;
  readonly task_acceptance?: string | null;
  readonly task_context?: string | null;
  readonly changed_files?: readonly string[] | null;
  readonly owner_text?: string | null;
}

export function searchQuery(role: MemoryRole, m: QueryMaterials): (string | null | undefined)[] {
  const task = [m.task_title, m.task_acceptance];
  switch (role) {
    case "manager": return [m.work_title, m.work_summary, m.project_name];
    case "designer": return [m.work_title, m.work_summary, ...task, m.task_context];
    case "worker": return [...task, m.task_context?.slice(0, MAX_CONTEXT_CHARS), m.work_title];
    case "reviewer": return [...task, ...(m.changed_files ?? [])];
    default: return [m.owner_text];
  }
}

export const kb = (n: number): string => `${(n / 1000).toFixed(1)}kB`;

/** Page and clipping text is placed inside `<owl-…>` blocks: a fullwidth ＜ keeps a tag in it from closing (or faking) one. */
export const defuseTags = (text: string): string => text.replace(/<(?=\s*\/?\s*owl-)/giu, "＜");
