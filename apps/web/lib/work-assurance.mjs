const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');

/**
 * The review decision to show on each Task row: why the Reviewer was skipped,
 * or why Core forced it to required. Tasks that were required by plan have no note.
 * @param {unknown} assurance GET /works/{id}/assurance data
 * @returns {Map<string, { kind: 'skipped' | 'forced', reasons: string[] }>}
 */
export function reviewNotesByTask(assurance) {
  const notes = new Map();
  const reviews = isRecord(assurance) && Array.isArray(assurance.reviews) ? assurance.reviews : [];
  for (const review of reviews) {
    if (!isRecord(review) || typeof review.task_id !== 'string') continue;
    if (review.required === false) {
      const reason = text(review.skip_reason);
      if (reason) notes.set(review.task_id, { kind: 'skipped', reasons: [reason] });
      continue;
    }
    const reasons = (Array.isArray(review.forced_reasons) ? review.forced_reasons : [])
      .filter(isRecord)
      .map((reason) => text(reason.detail) || text(reason.code))
      .filter(Boolean);
    if (reasons.length > 0) notes.set(review.task_id, { kind: 'forced', reasons });
  }
  return notes;
}

/**
 * The latest integration verification of the Work branch, reduced to what the screen shows.
 * @param {unknown} assurance
 * @returns {{ status: string, reason: string, message: string, failedCommand: string, commands: number } | null}
 */
export function integrationVerificationView(assurance) {
  const verification = isRecord(assurance) ? assurance.integration_verification : null;
  if (!isRecord(verification)) return null;
  const commands = Array.isArray(verification.commands) ? verification.commands.filter(isRecord) : [];
  const failed = commands.find((command) => command.command_id === verification.failed_command_id);
  return {
    status: text(verification.status) || 'unknown',
    reason: text(verification.reason),
    message: text(verification.message),
    failedCommand: failed && Array.isArray(failed.argv) ? failed.argv.map(String).join(' ') : '',
    commands: commands.length,
  };
}

/**
 * Plan quality warnings flattened for display, oldest first.
 * @param {unknown} assurance
 * @returns {{ phase: string, outcome: string, title: string, detail: string }[]}
 */
export function planWarningLines(assurance) {
  const events = isRecord(assurance) && Array.isArray(assurance.plan_quality_warnings) ? assurance.plan_quality_warnings : [];
  return events.filter(isRecord).flatMap((event) =>
    (Array.isArray(event.warnings) ? event.warnings : []).filter(isRecord).map((warning) => ({
      phase: text(event.phase),
      outcome: text(event.outcome),
      title: text(warning.title),
      detail: text(warning.detail) || text(warning.code),
    })));
}
