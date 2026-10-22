const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');
const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The GET /works/{id}/view auto_recovery section in a stable shape; anything unreadable is dropped.
 * @param {unknown} value
 */
export function normalizeAutoRecovery(value) {
  const source = isRecord(value) ? value : {};
  const detail = (item) => {
    const d = isRecord(item) ? item : {};
    return { text: text(d.text), check: text(d.check) };
  };
  return {
    active: (Array.isArray(source.active) ? source.active : []).filter(isRecord).map((item) => ({
      kind: text(item.kind),
      target_kind: item.target_kind === 'task' ? 'task' : 'work',
      target_id: text(item.target_id),
      task_title: typeof item.task_title === 'string' ? item.task_title : null,
      attempt_no: count(item.attempt_no),
      limit: count(item.limit),
      counted: item.counted !== false,
      resume_at: typeof item.resume_at === 'string' ? item.resume_at : null,
      started_at: text(item.started_at),
    })),
    relaxations: (Array.isArray(source.relaxations) ? source.relaxations : []).filter(isRecord).map((item) => ({
      task_id: text(item.task_id),
      task_title: typeof item.task_title === 'string' ? item.task_title : null,
      criterion_id: text(item.criterion_id),
      original: detail(item.original),
      relaxed: detail(item.relaxed),
      reason: text(item.reason),
      keeps: text(item.keeps),
      at: text(item.at),
    })),
  };
}

const clock = (iso, locale) => {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
};

/**
 * One line per active recovery: the wording for its kind, with the wait variants for a temporary provider error.
 * @param {ReturnType<typeof normalizeAutoRecovery>['active'][number]} item
 * @param {string} locale
 * @param {(key: string, values?: Record<string, string | number>) => string} t
 */
export function autoRecoveryLine(item, locale, t) {
  const values = { attempt: item.attempt_no, limit: item.limit, time: item.resume_at ? clock(item.resume_at, locale) : '' };
  if (item.kind === 'provider_transient') {
    return t(item.counted ? 'work.autoRecoveryTransient' : 'work.autoRecoveryRateLimited', values);
  }
  return t('work.autoRecovering', { ...values, kind: t(`work.autoRecoveryKind.${item.kind}`) });
}

/**
 * The text of the "recovering automatically" badge: the first recovery, "n more" for the rest, and every line for the title attribute.
 * @returns {{ label: string, title: string } | null}
 */
export function autoRecoveryBadge(active, locale, t) {
  if (active.length === 0) return null;
  const lines = active.map((item) => autoRecoveryLine(item, locale, t));
  const more = active.length - 1;
  return { label: more > 0 ? `${lines[0]} ${t('work.autoRecoveryMore', { count: more })}` : lines[0], title: lines.join('\n') };
}
