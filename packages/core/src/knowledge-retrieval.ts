import type { KnowledgeNotes, NoteDocument, NoteClaim } from "./knowledge-notes.js";

export interface KnowledgeQuery {
  readonly work_title: string;
  readonly task_title?: string;
  readonly task_text?: string;
  readonly project_id: string | null;
}

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
export function estimateTokens(text: string): number {
  let total = 0;
  for (const character of text.normalize("NFKC")) total += character.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  return Math.ceil(total);
}

export class KnowledgeRetriever {
  public constructor(private readonly notes: KnowledgeNotes, _options: { now?: () => string } = {}) {}

  public async select(query: KnowledgeQuery, limits: KnowledgeLimits): Promise<{ note: NoteDocument; score: number }[]> {
    const bounded = normalizeKnowledgeLimits(limits);
    if (bounded.max_notes === 0) return [];
    const queryWords = words([query.work_title, query.task_title ?? "", query.task_text ?? ""].join(" "));
    const notes = await this.notes.list();
    return notes
      .map((note) => {
        const titleAndTags = words(`${note.title} ${note.tags.join(" ")}`);
        const content = words(`${note.summary} ${note.claims.map((claim) => claim.text).join(" ")}`);
        let score = intersectionSize(queryWords, titleAndTags) * 2 + intersectionSize(queryWords, content);
        if (query.project_id && note.project_ids.includes(query.project_id)) score += 2;
        return { note, score };
      })
      .filter(({ score }) => score >= bounded.min_score)
      .sort((left, right) => right.score - left.score
        || right.note.updated.localeCompare(left.note.updated)
        || left.note.id.localeCompare(right.note.id))
      .slice(0, bounded.max_notes);
  }

  public async render(
    query: KnowledgeQuery,
    limits: KnowledgeLimits,
  ): Promise<{ text: string; tokens: number; characters: number; notes: number } | null> {
    try {
      const bounded = normalizeKnowledgeLimits(limits);
      if (bounded.max_notes === 0 || bounded.max_tokens === 0 || bounded.max_characters === 0) return null;
      const selected = await this.select(query, bounded);
      const blocks: string[] = [];
      for (const { note } of selected) {
        const rendered = fitNote(note, bounded.per_note_tokens);
        if (!rendered) break;
        let block = rendered.text;
        let text = [...blocks, block].join("\n\n");
        while (!fits(text, bounded) && rendered.claims.length > 0) {
          rendered.claims.pop();
          block = formatNote(note, rendered.summary, rendered.claims);
          text = [...blocks, block].join("\n\n");
        }
        if (!fits(text, bounded)) break;
        blocks.push(block);
      }
      if (blocks.length === 0) return null;
      const text = blocks.join("\n\n");
      return { text, tokens: estimateTokens(text), characters: text.length, notes: blocks.length };
    } catch (error) {
      console.warn("[owl-core] Could not render knowledge notes", error);
      return null;
    }
  }
}

function fitNote(note: NoteDocument, tokenLimit: number): { text: string; summary: string; claims: NoteClaim[] } | null {
  const claims = [...note.claims].sort((left, right) => right.sources.length - left.sources.length
    || left.fingerprint.localeCompare(right.fingerprint));
  let summary = note.summary;
  let text = formatNote(note, summary, claims);
  while (estimateTokens(text) > tokenLimit && claims.length > 0) {
    claims.pop();
    text = formatNote(note, summary, claims);
  }
  if (estimateTokens(text) <= tokenLimit) return { text, summary, claims };

  const codePoints = [...note.summary];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidateSummary = `${codePoints.slice(0, middle).join("")}…`;
    if (estimateTokens(formatNote(note, candidateSummary, [])) <= tokenLimit) low = middle;
    else high = middle - 1;
  }
  summary = `${codePoints.slice(0, low).join("")}…`;
  text = formatNote(note, summary, []);
  return estimateTokens(text) <= tokenLimit ? { text, summary, claims: [] } : null;
}

function formatNote(note: NoteDocument, summary: string, claims: readonly NoteClaim[]): string {
  const heading = `- [${note.id}] ${note.title} (sources: ${note.sources.length} Works)\n  Summary: ${summary}`;
  return claims.length === 0 ? heading : `${heading}\n${claims.map((claim) => `  - [${claim.kind}] ${claim.text}`).join("\n")}`;
}

function fits(text: string, limits: KnowledgeLimits): boolean {
  return estimateTokens(text) <= limits.max_tokens && text.length <= limits.max_characters;
}

function words(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1));
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const word of left) if (right.has(word)) count += 1;
  return count;
}

function boundedInteger(value: unknown, fallback: number, ceiling: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(ceiling, Math.floor(value))
    : fallback;
}
