/**
 * Work summary template: read a summary written as
 *
 *   依頼: <what to do>
 *
 *   受け入れ条件:
 *   - <condition>
 *
 * into its sections so the UI can show each one on its own.
 *
 * WORK_SUMMARY_SECTIONS is a copy of packages/shared/src/work-summary.ts
 * (the definition the Advisor prompt is built from); tests keep them equal.
 * Plain JS imported by relative path, like agent-run-tree.mjs.
 *
 * @typedef {'request' | 'background' | 'approach' | 'acceptance' | 'notes'} WorkSummaryKey
 *
 * @typedef {object} WorkSummarySection
 * @property {WorkSummaryKey} key
 * @property {string} label Label written in the summary text.
 * @property {string} label_en English label, also accepted.
 * @property {'text' | 'list'} kind
 * @property {boolean} required
 * @property {string} guide
 *
 * @typedef {object} ParsedWorkSummarySection
 * @property {WorkSummaryKey} key
 * @property {string} label
 * @property {string} label_en
 * @property {'text' | 'list'} kind
 * @property {string} text Section body ('' for list sections).
 * @property {string[]} items List items ([] for text sections).
 *
 * @typedef {object} ParsedWorkSummary
 * @property {boolean} templated True when at least one template label was found.
 * @property {string} preamble Text before the first label (or the whole text when not templated).
 * @property {ParsedWorkSummarySection[]} sections Found sections, in template order.
 */

/** @type {readonly WorkSummarySection[]} */
export const WORK_SUMMARY_SECTIONS = [
  { key: 'request', label: '依頼', label_en: 'Request', kind: 'text', required: true, guide: 'what should be done, in one to three sentences' },
  { key: 'background', label: '背景', label_en: 'Background', kind: 'text', required: false, guide: 'why it is needed and what the conversation established' },
  { key: 'approach', label: '方針', label_en: 'Approach', kind: 'text', required: false, guide: 'the agreed way to do it and its constraints' },
  { key: 'acceptance', label: '受け入れ条件', label_en: 'Acceptance', kind: 'list', required: true, guide: 'conditions that make the Work done, one per line' },
  { key: 'notes', label: '注意', label_en: 'Notes', kind: 'text', required: false, guide: 'what must not be done and known pitfalls' },
];

const LIST_MARKER = /^(?:[-*•・]|\d+[.)])\s+/u;

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const LABEL_LINE = new RegExp(
  `^\\s*(${WORK_SUMMARY_SECTIONS.flatMap((section) => [section.label, section.label_en]).map(escapeRegExp).join('|')})\\s*[:：][ \\t]*(.*)$`,
  'iu',
);

/** @param {string} label */
function sectionOfLabel(label) {
  const lower = label.toLowerCase();
  return WORK_SUMMARY_SECTIONS.find((section) => section.label === label || section.label_en.toLowerCase() === lower);
}

/** @param {string[]} lines */
function listItems(lines) {
  /** @type {string[]} */
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (LIST_MARKER.test(line) || items.length === 0) items.push(line.replace(LIST_MARKER, ''));
    else items[items.length - 1] = `${items[items.length - 1]} ${line}`;
  }
  return items.filter((item) => item.length > 0);
}

/**
 * @param {string | null | undefined} summary
 * @returns {ParsedWorkSummary}
 */
export function parseWorkSummary(summary) {
  const text = (summary ?? '').replace(/\r\n?/gu, '\n').trim();
  /** @type {string[]} */
  const preamble = [];
  /** @type {Map<WorkSummaryKey, string[]>} */
  const bodies = new Map();
  /** @type {string[] | null} */
  let current = null;
  for (const line of text.split('\n')) {
    const match = LABEL_LINE.exec(line);
    const section = match ? sectionOfLabel(match[1]) : undefined;
    if (match && section) {
      current = bodies.get(section.key) ?? [];
      bodies.set(section.key, current);
      if (match[2].trim().length > 0) current.push(match[2]);
      continue;
    }
    (current ?? preamble).push(line);
  }
  if (bodies.size === 0) return { templated: false, preamble: text, sections: [] };
  const sections = WORK_SUMMARY_SECTIONS.flatMap((section) => {
    const lines = bodies.get(section.key);
    if (!lines) return [];
    const items = section.kind === 'list' ? listItems(lines) : [];
    const body = section.kind === 'list' ? '' : lines.join('\n').trim();
    if (items.length === 0 && body.length === 0) return [];
    return [{ key: section.key, label: section.label, label_en: section.label_en, kind: section.kind, text: body, items }];
  });
  return { templated: true, preamble: preamble.join('\n').trim(), sections };
}

/**
 * The empty template for the create form, with labels in the UI language.
 * @param {'ja' | 'en'} locale
 */
export function workSummarySkeleton(locale) {
  return WORK_SUMMARY_SECTIONS
    .map((section) => {
      const label = locale === 'ja' ? section.label : section.label_en;
      return section.kind === 'list' ? `${label}:\n- ` : `${label}: `;
    })
    .join('\n\n');
}
