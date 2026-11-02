// 自動 Work 作成の画面が使う純粋な関数と定数。React にも fetch にも触れない。

export const AUTO_WORK_SETTINGS_VIEW_KEY = 'auto-work-settings';
export const AUTO_WORK_EVENTS_REFRESH_MS = 30_000;
export const AUTO_WORK_EVENTS_PAGE_SIZE = 50;

const ALL = '*';
export const AUTO_WORK_SOURCES = ['failure_notice', 'scheduled_check', 'github'];
export const AUTO_WORK_VERDICTS = [
  'created', 'duplicate', 'below_threshold', 'daily_cap', 'unauthorized', 'no_rule', 'disabled', 'not_worth', 'judge_failed', 'judging',
];
const FROM_KEYS = new Set(['db', 'project_file', 'local_file', 'defaults']);
const SOURCE_KEYS = new Set(AUTO_WORK_SOURCES);
const ORIGIN_KEYS = new Set(['defaults', 'local', 'project']);
const SKIPPED_VERDICTS = new Set(['duplicate', 'below_threshold', 'daily_cap', 'unauthorized', 'no_rule', 'disabled', 'not_worth', 'judge_failed']);
const VERDICT_TONES = {
  created: 'green',
  judging: 'accent',
  duplicate: 'amber',
  below_threshold: 'muted',
  daily_cap: 'amber',
  unauthorized: 'red',
  no_rule: 'muted',
  disabled: 'muted',
  not_worth: 'amber',
  judge_failed: 'red',
};
const CREATED_LABELS = { draft: 'created_draft', started: 'created_started', deleted: 'created_deleted' };

/** URL の値を、この画面が知っている値だけに絞る（知らない値は絞り込みなしとして扱う）。 */
export function knownValue(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

export function eventsViewKey({ projectId, source, verdict, offset } = {}) {
  return `auto-work-events:${projectId || ALL}:${source || ALL}:${verdict || ALL}:${offset ?? 0}`;
}

export function eventsQuery({ projectId, source, verdict, offset, limit } = {}) {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', projectId);
  if (source) params.set('source', source);
  if (verdict) params.set('verdict', verdict);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return params.toString();
}

/** 作った Work の今の状態で決める。action と action_error は見ない（コメント投稿だけ失敗した行を下書きと誤らないため）。 */
export function createdState(event) {
  if (event.verdict !== 'created') return null;
  if (event.work_id === null || event.work_id === undefined) return 'deleted';
  return event.work_state === 'memo' ? 'draft' : 'started';
}

export function verdictLabelKey(event) {
  const state = createdState(event);
  if (state !== null) return `autoWork.verdict.${CREATED_LABELS[state]}`;
  return `autoWork.verdict.${Object.hasOwn(VERDICT_TONES, event.verdict) ? event.verdict : 'judge_failed'}`;
}

export function verdictTone(event) {
  return Object.hasOwn(VERDICT_TONES, event.verdict) ? VERDICT_TONES[event.verdict] : 'muted';
}

/** 見送りと判定失敗の行は薄くして、作成した行を目で拾いやすくする。 */
export function isMutedEvent(event) {
  return SKIPPED_VERDICTS.has(event.verdict);
}

export function hasActionError(event) {
  return typeof event.action_error === 'string' && event.action_error.length > 0;
}

export const fromLabelKey = (from) => `autoWork.from.${FROM_KEYS.has(from) ? from : 'defaults'}`;
export const sourceLabelKey = (source) => (SOURCE_KEYS.has(source) ? `autoWork.source.${source}` : null);
export const originLabelKey = (origin) => `autoWork.origin.${ORIGIN_KEYS.has(origin) ? origin : 'defaults'}`;

/** ルール表から数えた要約。config_file_present は見ない（local.json だけの独自ルールもあるため）。 */
export function rulesSummary(rules) {
  let local = 0;
  let project = 0;
  let overridden = 0;
  for (const rule of rules ?? []) {
    if (rule.origin === 'local') local += 1;
    if (rule.origin === 'project') project += 1;
    if ((rule.overridden_fields?.length ?? 0) > 0) overridden += 1;
  }
  return { defaultsOnly: local + project + overridden === 0, local, project, overridden };
}

function externalHref(url) {
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}

export function eventLinks(event) {
  const issueNumber = event.github_issue_number ?? null;
  return {
    work: event.work_id
      ? { href: `/work?id=${encodeURIComponent(event.work_id)}`, number: event.work_display_number ?? null, title: event.work_title ?? '', state: event.work_state ?? null }
      : null,
    duplicateWork: event.duplicate_of_work_id
      ? { href: `/work?id=${encodeURIComponent(event.duplicate_of_work_id)}`, number: event.duplicate_of_work_display_number ?? null }
      : null,
    // 相手がまだ判定中で Work が無いときは、相手の記録を開く。
    duplicateEvent: !event.duplicate_of_work_id && event.duplicate_of_event_id
      ? { id: event.duplicate_of_event_id, short: event.duplicate_of_event_id.slice(0, 8) }
      : null,
    issue: externalHref(event.github_url) ? { href: event.github_url, number: issueNumber } : null,
    pr: externalHref(event.github_pr_url) ? { href: event.github_pr_url, number: issueNumber } : null,
    comment: externalHref(event.github_comment_url) ? { href: event.github_comment_url } : null,
  };
}

export function summarizeRun(events) {
  const list = Array.isArray(events) ? events : [];
  const created = list.filter((event) => event.verdict === 'created').length;
  return { created, skipped: list.length - created };
}

/** id で重複を除いて結合する。先に出た方（既存）の位置を保つ。 */
export function mergeEvents(existing, incoming) {
  const seen = new Set();
  const merged = [];
  for (const event of [...existing, ...incoming]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}
