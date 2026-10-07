import { estimatePageTokens } from "./memory/page-format.js";
import type { NoteDocument, NoteClaim } from "./knowledge-notes.js";

/** Extra budget for the project overview note; never exceeds the owner's max_tokens / max_characters. */
export const PROJECT_OVERVIEW_BUDGET = { tokens: 600, characters: 2400 } as const;

export interface KnowledgeLimits {
  readonly max_notes: number;
  readonly max_tokens: number;
  readonly per_note_tokens: number;
  readonly max_characters: number;
  readonly min_score: number;
}

export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeLimits = {
  max_notes: 3,
  max_tokens: 1500,
  per_note_tokens: 600,
  max_characters: 4000,
  min_score: 3,
};

const KNOWLEDGE_LIMIT_CEILINGS = {
  max_notes: 10,
  max_tokens: 4000,
  per_note_tokens: 1500,
  max_characters: 12000,
} as const;

export function normalizeKnowledgeLimits(value: unknown): KnowledgeLimits {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    max_notes: boundedInteger(input.max_notes, DEFAULT_KNOWLEDGE_LIMITS.max_notes, KNOWLEDGE_LIMIT_CEILINGS.max_notes),
    max_tokens: boundedInteger(input.max_tokens, DEFAULT_KNOWLEDGE_LIMITS.max_tokens, KNOWLEDGE_LIMIT_CEILINGS.max_tokens),
    per_note_tokens: boundedInteger(input.per_note_tokens, DEFAULT_KNOWLEDGE_LIMITS.per_note_tokens, KNOWLEDGE_LIMIT_CEILINGS.per_note_tokens),
    max_characters: boundedInteger(input.max_characters, DEFAULT_KNOWLEDGE_LIMITS.max_characters, KNOWLEDGE_LIMIT_CEILINGS.max_characters),
    min_score: typeof input.min_score === "number" && Number.isFinite(input.min_score) && input.min_score >= 0
      ? input.min_score
      : DEFAULT_KNOWLEDGE_LIMITS.min_score,
  };
}

/** Estimate tokens deterministically: ASCII code points are 1/4, others are 1. */
export const estimateTokens = estimatePageTokens;

/** The project overview note fitted to its own PROJECT_OVERVIEW_BUDGET (separate from the memory catalog budget). */
export function renderProjectOverview(note: NoteDocument): string | null {
  return fitNote(note, PROJECT_OVERVIEW_BUDGET.tokens, PROJECT_OVERVIEW_BUDGET.characters, true)?.text ?? null;
}

function fitNote(note: NoteDocument, tokenLimit: number, characterLimit: number, preserveOrder: boolean): { text: string; summary: string; claims: NoteClaim[] } | null {
  const claims = preserveOrder ? [...note.claims] : [...note.claims].sort((left, right) => right.sources.length - left.sources.length
    || left.fingerprint.localeCompare(right.fingerprint));
  const within = (value: string) => estimateTokens(value) <= tokenLimit && value.length <= characterLimit;
  let summary = note.summary;
  let text = formatNote(note, summary, claims);
  while (!within(text) && claims.length > 0) {
    claims.pop();
    text = formatNote(note, summary, claims);
  }
  if (within(text)) return { text, summary, claims };

  const codePoints = [...note.summary];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidateSummary = `${codePoints.slice(0, middle).join("")}…`;
    if (within(formatNote(note, candidateSummary, []))) low = middle;
    else high = middle - 1;
  }
  summary = `${codePoints.slice(0, low).join("")}…`;
  text = formatNote(note, summary, []);
  return within(text) ? { text, summary, claims: [] } : null;
}

function formatNote(note: NoteDocument, summary: string, claims: readonly NoteClaim[]): string {
  const heading = `- [${note.id}] ${note.title} (sources: ${note.sources.length} Works)\n  Summary: ${summary}`;
  return claims.length === 0 ? heading : `${heading}\n${claims.map((claim) => `  - [${claim.kind}] ${claim.text}`).join("\n")}`;
}

function boundedInteger(value: unknown, fallback: number, ceiling: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(ceiling, Math.floor(value))
    : fallback;
}
