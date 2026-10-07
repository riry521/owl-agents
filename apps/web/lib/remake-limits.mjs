/**
 * @typedef {object} RemakeLimits
 * @property {number} lineage_review_attempts
 * @property {number} lineage_worker_runs
 * @property {number} non_functional_remakes
 * @property {number} base_sync_lineage_review_attempts
 * @property {number} base_sync_lineage_worker_runs
 * @property {number} lead_review_rejections
 * @property {string[]} verification_paths
 * @property {string[]} checked_task_types
 */

/** Task types the remake gate can check (mirrors TASK_TYPES_FOR_REMAKE in packages/shared). */
export const REMAKE_TASK_TYPES = ['research', 'design', 'code', 'config', 'doc', 'test'];

/**
 * Form state: numbers stay as typed text and globs are one per line, so the API
 * (not the form) decides what is valid.
 * @param {RemakeLimits} settings
 */
export function remakeLimitsToDraft(settings) {
  return {
    lineage_review_attempts: String(settings.lineage_review_attempts),
    lineage_worker_runs: String(settings.lineage_worker_runs),
    non_functional_remakes: String(settings.non_functional_remakes),
    base_sync_lineage_review_attempts: String(settings.base_sync_lineage_review_attempts),
    base_sync_lineage_worker_runs: String(settings.base_sync_lineage_worker_runs),
    lead_review_rejections: String(settings.lead_review_rejections),
    verification_paths: settings.verification_paths.join('\n'),
    checked_task_types: [...settings.checked_task_types],
  };
}

/** @param {ReturnType<typeof remakeLimitsToDraft>} draft */
export function draftToRemakeLimits(draft) {
  const number = (text) => (text.trim() === '' ? Number.NaN : Number(text));
  return {
    lineage_review_attempts: number(draft.lineage_review_attempts),
    lineage_worker_runs: number(draft.lineage_worker_runs),
    non_functional_remakes: number(draft.non_functional_remakes),
    base_sync_lineage_review_attempts: number(draft.base_sync_lineage_review_attempts),
    base_sync_lineage_worker_runs: number(draft.base_sync_lineage_worker_runs),
    lead_review_rejections: number(draft.lead_review_rejections),
    verification_paths: draft.verification_paths.split('\n').map((line) => line.trim()).filter(Boolean),
    checked_task_types: draft.checked_task_types,
  };
}
