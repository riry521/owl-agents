/**
 * Display lines for the stored reason / current_state / tried texts of a
 * Decision: repeats and bare ids are removed, the stored texts stay as they are.
 *
 * packages/plugin-sdk/src/shared/decision-sections.ts holds the same rules,
 * because the web app does not import plugin-sdk; keep the two in step.
 */

/** Longest heading ("待っていた内容:") that is ignored when comparing lines. */
export const DECISION_LINE_LABEL_MAX_CHARS = 12;

const LINE_SEPARATOR = /\r?\n| \/ /u;
const BRACKETED_ID = /[（(][0-9A-Z]{26}[）)]/gu;
const BULLET = /^(?:- |・|• |\* )/u;

/** @param {string} line */
function compareKey(line) {
  const unbulleted = line.trim().replace(BULLET, '');
  const colon = unbulleted.search(/[:：]/u);
  const body = colon >= 0 && colon <= DECISION_LINE_LABEL_MAX_CHARS ? unbulleted.slice(colon + 1) : unbulleted;
  return body.trim().replace(/\s+/gu, ' ').replace(/[。.]$/u, '');
}

/**
 * @param {{ reason: string, current_state: string, tried: string }} input
 * @returns {{ reason: string[], current_state: string[], tried: string[] }}
 */
export function decisionContextLines(input) {
  const seen = new Set();
  const pick = (value) =>
    String(value ?? '').split(LINE_SEPARATOR).flatMap((raw) => {
      const line = raw.replace(BRACKETED_ID, '').trim();
      const key = compareKey(line);
      if (key === '' || seen.has(key)) return [];
      seen.add(key);
      return [line];
    });
  return { reason: pick(input.reason), current_state: pick(input.current_state), tried: pick(input.tried) };
}

/**
 * What the Decision screen shows: a ready explanation's summary and next_steps lead, the question follows,
 * and the stored texts keep only the lines not already shown.
 * @param {{ explanation: { status: string, summary: string | null, next_steps?: string | null } | null, questionText: string, decision: { reason: string, current_state: string, tried: string } }} input
 */
export function decisionDisplay({ explanation, questionText, decision }) {
  const ready = explanation?.status === 'ready' && explanation.summary !== null;
  const nextSteps = ready ? explanation?.next_steps || null : null;
  const countLines = (...texts) => decisionContextLines({ reason: texts.join('\n'), current_state: '', tried: '' }).reason.length;
  // Only the lines of text not already in before, so a text that partly repeats an earlier one shows just its new lines.
  const newLines = (before, text) =>
    decisionContextLines({ reason: [...before, text].join('\n'), current_state: '', tried: '' }).reason.slice(countLines(...before));
  const summary = ready ? [explanation?.summary ?? ''] : [];
  // A ready "how" holds only next_steps, never the question.
  const howCandidate = ready ? nextSteps : questionText;
  const howLines = howCandidate === null ? [] : newLines(summary, howCandidate);
  const lead = [...summary, ...howLines];
  const questionLines = ready ? newLines(lead, questionText) : [];
  const shown = [...lead, ...questionLines];
  const merged = decisionContextLines({ ...decision, reason: `${shown.join('\n')}\n${decision.reason}` });
  return { ready, howLines, questionLines, lines: { ...merged, reason: merged.reason.slice(countLines(...shown)) } };
}
