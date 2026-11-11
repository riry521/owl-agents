// @ts-check
/** @typedef {{ state: string, reason: string | null, network: boolean }} ViewerFailure */

/** @type {Record<string, string>} */
const STATE_BY_CODE = {
  markdown_path_denied: 'denied',
  markdown_not_found: 'not_found',
  markdown_not_integrated: 'not_integrated',
  markdown_too_large: 'too_large',
  markdown_unreadable: 'unreadable',
  knowledge_storage_unavailable: 'storage',
  validation_error: 'invalid_url',
  work_not_found: 'work_not_found',
};
const DENIED_REASONS = new Set(['secret', 'not_markdown']);

/**
 * Maps a thrown value from getWorkMarkdown to the screen state of the design's section 7.2.
 * Only code, kind and details are read, so it needs no ApiRequestError import.
 * @param {any} error
 * @returns {ViewerFailure}
 */
export function viewerStateForError(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code !== null && Object.hasOwn(STATE_BY_CODE, code)) {
    const state = STATE_BY_CODE[code];
    const reason = state === 'denied' ? (DENIED_REASONS.has(error.details?.reason) ? error.details.reason : 'outside') : null;
    return { state, reason, network: false };
  }
  return { state: 'load_failed', reason: null, network: code === null || error.kind === 'network_error' };
}

/** The back link of the screen: Work detail, or the Board when there is no Work to return to. @param {string | null | undefined} workId @param {string} state */
export function viewerBackTarget(workId, state) {
  if (!workId || state === 'work_not_found') return '/board';
  return `/work?${new URLSearchParams({ id: workId })}`;
}
