import { PREREQUISITE_LIMITS } from "./prerequisite.js";

/** Most Works one Work may wait on; the same bound as the conditions of a Task prerequisite. */
export const WORK_PREREQUISITE_LIMIT = PREREQUISITE_LIMITS.conditions;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A prerequisite Work as shown to the Owner; `state` is null once the Work was deleted. */
export type WorkPrerequisiteView = {
  work_id: string;
  project_id: string | null;
  project_name: string | null;
  display_number: number | null;
  title: string;
  state: string | null;
  deleted: boolean;
  satisfied: boolean;
};

/** Throws an Error whose message is safe to show; callers wrap it in their own validation error. */
export function validatePrerequisiteWorkIds(value: unknown, field = "prerequisite_work_ids"): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !ULID_PATTERN.test(id))) {
    throw new Error(`${field} must be an array of Work IDs.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} must list each Work once.`);
  if (value.length > WORK_PREREQUISITE_LIMIT) throw new Error(`${field} can list at most ${WORK_PREREQUISITE_LIMIT} Works.`);
  return value as string[];
}
