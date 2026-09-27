import { WORK_SUMMARY_SECTIONS } from './work-summary.mjs';

/** @typedef {import('./types').BacklogItem} BacklogItem */

const TITLE_LIMIT = 500;
const SUMMARY_LIMIT = 20_000;
const PROBLEM_TITLE_LIMIT = 80;

/** @param {string} key */
function summaryLabel(key, locale) {
  const section = WORK_SUMMARY_SECTIONS.find((item) => item.key === key);
  return locale === 'ja' ? section.label : section.label_en;
}

/** @param {BacklogItem} item @param {(key: string, params?: Record<string, string>) => string} t */
export function backlogLocation(item, t) {
  if (!item.file || item.file.trim().length === 0) return t('backlog.item.general');
  return item.line > 0 ? `${item.file}:${item.line}` : item.file;
}

/**
 * Build the editable title and summary defaults for issuing backlog items as a Work.
 * @param {BacklogItem[]} items Selected items in display order.
 * @param {'ja' | 'en'} locale
 * @param {(key: string, params?: Record<string, string>) => string} t
 * @returns {{ title: string, summary: string }}
 */
export function backlogWorkDraft(items, locale, t) {
  const firstProblem = (items[0]?.problem ?? '').split(/\r\n?|\n/u)[0];
  const title = items.length === 1
    ? t('backlog.issue.defaultTitleOne', {
      problem: firstProblem.length > PROBLEM_TITLE_LIMIT
        ? `${firstProblem.slice(0, PROBLEM_TITLE_LIMIT - 1)}…`
        : firstProblem,
    })
    : t('backlog.issue.defaultTitleMany', { count: String(items.length) });

  const requestLabel = summaryLabel('request', locale);
  const backgroundLabel = summaryLabel('background', locale);
  const acceptanceLabel = summaryLabel('acceptance', locale);
  const request = t('backlog.issue.summaryRequest', { count: String(items.length) });
  const acceptance = [
    `- ${t('backlog.issue.summaryAcceptanceResolved')}`,
    `- ${t('backlog.issue.summaryAcceptanceTests')}`,
  ].join('\n');
  const entries = items.map((item, index) => {
    const lines = [`${index + 1}. ${backlogLocation(item, t)} — ${item.problem}`];
    if (item.reason.trim().length > 0) lines.push(`   ${t('backlog.item.reason')}: ${item.reason}`);
    if (item.suggestion.trim().length > 0) lines.push(`   ${t('backlog.item.suggestion')}: ${item.suggestion}`);
    lines.push(`   ${t('backlog.issue.summarySource', {
      number: String(item.work_display_number ?? item.work_id),
      work: item.work_title,
      task: item.task_title,
    })}`);
    return lines.join('\n');
  });

  const renderSummary = (backgroundEntries, addEllipsis) => {
    const background = [...backgroundEntries, ...(addEllipsis ? ['…'] : [])].join('\n');
    return [
      `${requestLabel}: ${request}`,
      '',
      `${backgroundLabel}:`,
      background,
      '',
      `${acceptanceLabel}:`,
      acceptance,
    ].join('\n');
  };

  let retained = [...entries];
  let omitted = false;
  let summary = renderSummary(retained, false);
  while (summary.length > SUMMARY_LIMIT && retained.length > 1) {
    retained.pop();
    omitted = true;
    summary = renderSummary(retained, true);
  }
  if (summary.length > SUMMARY_LIMIT && retained.length > 0) {
    omitted = true;
    const fixedLength = renderSummary([], true).length;
    const maxEntryLength = Math.max(0, SUMMARY_LIMIT - fixedLength);
    retained = [retained[0].slice(0, maxEntryLength)];
    summary = renderSummary(retained, omitted);
  }

  return { title: title.slice(0, TITLE_LIMIT), summary };
}
