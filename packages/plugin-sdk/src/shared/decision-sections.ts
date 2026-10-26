/**
 * Display lines for the stored reason / current_state / tried texts of a
 * Decision. The texts repeat each other and carry bare ids, so each is split
 * into lines, ids are removed, and a line that an earlier text already said is
 * dropped. The stored texts stay as they are.
 *
 * apps/web/lib/decision-sections.mjs holds the same rules, because the web app
 * does not import plugin-sdk; keep the two in step.
 */

/** Longest heading ("待っていた内容:") that is ignored when comparing lines. */
export const DECISION_LINE_LABEL_MAX_CHARS = 12;

const LINE_SEPARATOR = /\r?\n| \/ /u;
const BRACKETED_ID = /[（(][0-9A-Z]{26}[）)]/gu;
const BULLET = /^(?:- |・|• |\* )/u;

export interface DecisionContextInput {
  readonly reason: string;
  readonly current_state: string;
  readonly tried: string;
}

export interface DecisionContextLines {
  readonly reason: string[];
  readonly current_state: string[];
  readonly tried: string[];
}

function compareKey(line: string): string {
  const unbulleted = line.trim().replace(BULLET, "");
  const colon = unbulleted.search(/[:：]/u);
  const body = colon >= 0 && colon <= DECISION_LINE_LABEL_MAX_CHARS ? unbulleted.slice(colon + 1) : unbulleted;
  return body.trim().replace(/\s+/gu, " ").replace(/[。.]$/u, "");
}

export function decisionContextLines(input: DecisionContextInput): DecisionContextLines {
  const seen = new Set<string>();
  const pick = (value: string): string[] =>
    value.split(LINE_SEPARATOR).flatMap((raw) => {
      const line = raw.replace(BRACKETED_ID, "").trim();
      const key = compareKey(line);
      if (key === "" || seen.has(key)) return [];
      seen.add(key);
      return [line];
    });
  return { reason: pick(input.reason), current_state: pick(input.current_state), tried: pick(input.tried) };
}
