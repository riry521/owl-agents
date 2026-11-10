import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isValidUlid } from "@owl/shared";

import { writeAtomic } from "./atomic-write.js";
import { projectOverviewFilename } from "./project-overview.js";

import type { KnowledgeBase } from "./knowledge-base.js";
import { fingerprint } from "./learning-fingerprint.js";
import { slugifyKnowledgeName } from "./knowledge-naming.js";

export interface NoteClaim {
  readonly fingerprint: string;
  readonly kind: "fact" | "decision" | "pitfall";
  readonly text: string;
  readonly sources: readonly string[];
}

export interface NotePromotion {
  readonly date: string;
  readonly proposal_id: string;
  readonly status: "applied" | "rejected";
  readonly path: string | null;
}

export interface NoteDocument {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly tags: readonly string[];
  /** Set to "keywords" once the tags were built from AI-extracted keywords (frontmatter `tags_source`). */
  readonly tags_source?: "keywords";
  readonly sources: readonly string[];
  readonly links: readonly string[];
  readonly project_ids: readonly string[];
  readonly created: string;
  readonly updated: string;
  readonly summary: string;
  readonly claims: readonly NoteClaim[];
  readonly promotions: readonly NotePromotion[];
}

export interface KnowledgeNotesOptions {
  readonly now?: () => string;
}


export class NoteParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NoteParseError";
  }
}

export class KnowledgeNotes {
  private readonly now: () => string;
  private readonly knownTitles = new Map<string, string>();

  private get notesDir(): string {
    return join(this.knowledge.knowledgeDir, "notes");
  }

  /** Drop cached titles after the knowledge location changed. */
  public resetCache(): void {
    this.knownTitles.clear();
  }

  public constructor(private readonly knowledge: KnowledgeBase, options: KnowledgeNotesOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** The fixed-name overview note of one project; null if missing or unparsable. */
  public async getProjectOverview(projectId: string): Promise<NoteDocument | null> {
    try {
      return this.parse(await readFile(join(this.notesDir, projectOverviewFilename(projectId)), "utf8"));
    } catch {
      return null;
    }
  }

  /** Read notes/<filename> (null if missing or unparsable), build the next note, and write it in place. */
  public async upsertFixedFile(
    filename: string,
    build: (existing: NoteDocument | null) => NoteDocument | null,
  ): Promise<{ note: NoteDocument; created: boolean; written: boolean } | null> {
    if (!/^project-overview-[0-9A-HJKMNP-TV-Z]{26}\.md$/u.test(filename)) throw new Error("invalid_fixed_note_filename");
    let existing: NoteDocument | null = null;
    try {
      existing = this.parse(await readFile(join(this.notesDir, filename), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof NoteParseError)) throw error;
    }
    const next = build(existing);
    if (next === null) return existing ? { note: existing, created: false, written: false } : null;
    await this.writeNote(filename, next);
    this.knownTitles.set(next.id, next.title);
    return { note: next, created: existing === null, written: true };
  }

  public parse(markdown: string): NoteDocument {
    const normalized = markdown.replace(/\r\n?/gu, "\n");
    if (!normalized.startsWith("---\n")) throw new NoteParseError("missing_frontmatter");
    const end = normalized.indexOf("\n---\n", 4);
    if (end < 0) throw new NoteParseError("unterminated_frontmatter");

    const fields = new Map<string, string>();
    for (const line of normalized.slice(4, end).split("\n")) {
      const match = line.match(/^([a-z_]+):\s*(.*)$/u);
      if (!match) throw new NoteParseError("invalid_frontmatter");
      if (fields.has(match[1])) throw new NoteParseError(`duplicate_frontmatter_field:${match[1]}`);
      fields.set(match[1], match[2]);
    }

    const id = readScalar(fields, "id");
    const title = readScalar(fields, "title");
    const tags = readArray(fields, "tags");
    const sources = readArray(fields, "sources");
    const links = readArray(fields, "links");
    const projectIds = readArray(fields, "project_ids");
    const tagsSource = fields.has("tags_source") ? readScalar(fields, "tags_source") : null;
    if (tagsSource !== null && tagsSource !== "keywords") throw new NoteParseError("invalid_tags_source");
    const created = readScalar(fields, "created");
    const updated = readScalar(fields, "updated");
    if (!isValidUlid(id)) throw new NoteParseError("invalid_note_id");
    for (const value of [...sources, ...links, ...projectIds]) {
      if (!isValidUlid(value)) throw new NoteParseError("invalid_note_reference");
    }
    if (!title.trim() || !created || !updated) throw new NoteParseError("invalid_note_metadata");

    const sections = parseSections(normalized.slice(end + 5));
    const summary = sectionText(sections.get("Summary") ?? []);
    const claims = parseClaims(sections.get("Claims") ?? []);
    const related = parseRelatedNotes(sections.get("Related notes") ?? []);
    const promotions = parsePromotions(sections.get("Rule promotion") ?? []);
    if (related.length !== links.length || related.some((link, index) => link.id !== links[index])) {
      throw new NoteParseError("related_links_mismatch");
    }

    return {
      id,
      title,
      slug: slugifyKnowledgeName(title),
      tags,
      ...(tagsSource ? { tags_source: "keywords" as const } : {}),
      sources,
      links,
      project_ids: projectIds,
      created,
      updated,
      summary,
      claims,
      promotions,
    };
  }

  public render(note: NoteDocument): string {
    validateNote(note);
    const frontmatter = [
      "---",
      `id: ${note.id}`,
      `title: ${renderScalar(note.title)}`,
      `tags: ${renderArray(note.tags)}`,
      ...(note.tags_source ? [`tags_source: ${note.tags_source}`] : []),
      `sources: ${renderArray(note.sources)}`,
      `links: ${renderArray(note.links)}`,
      `project_ids: ${renderArray(note.project_ids)}`,
      `created: ${renderScalar(note.created)}`,
      `updated: ${renderScalar(note.updated)}`,
      "---",
      "",
      "## Summary",
      note.summary,
      "",
      "## Claims",
      ...note.claims.map(renderClaim),
      "",
      "## Related notes",
      ...note.links.map((id) => `- [[${id}|${this.knownTitles.get(id) ?? id}]]`),
      "",
      "## Rule promotion",
      ...note.promotions.map(renderPromotion),
      "",
    ];
    return `${frontmatter.join("\n")}\n`;
  }



  private async writeNote(filename: string, note: NoteDocument): Promise<void> {
    const content = this.render(note);
    this.assertRoundTrip(note, content);
    await writeAtomic(join(this.notesDir, filename), content);
  }

  private assertRoundTrip(note: NoteDocument, content: string): void {
    const parsed = this.parse(content);
    if (!sameNote(note, parsed)) throw new NoteParseError("round_trip_mismatch");
  }
}

function parseSections(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of body.split("\n")) {
    const heading = line.match(/^## (.+)$/u);
    if (heading) {
      current = heading[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }
  return sections;
}

function sectionText(lines: readonly string[]): string {
  const result = [...lines];
  while (result.length > 0 && result[0] === "") result.shift();
  while (result.length > 0 && result[result.length - 1] === "") result.pop();
  return result.join("\n");
}

function parseClaims(lines: readonly string[]): NoteClaim[] {
  const claims: NoteClaim[] = [];
  for (const line of lines) {
    if (!line) continue;
    const match = line.match(/^- \[(fact|decision|pitfall)\] (.*)$/u);
    if (!match) throw new NoteParseError("invalid_claim");
    let rawText = match[2];
    const marker = rawText.match(/\s+<!-- claim:([a-f0-9]{16}) sources:([^>]*) -->$/u);
    let claimSources: string[] = [];
    let claimFingerprint: string;
    if (marker) {
      claimFingerprint = marker[1];
      claimSources = marker[2].trim() ? marker[2].split(",").map((value) => value.trim()) : [];
      rawText = rawText.slice(0, marker.index).trimEnd();
    } else {
      claimFingerprint = "";
    }
    const text = parseClaimText(rawText);
    const actualFingerprint = fingerprint(text);
    if (claimFingerprint && claimFingerprint !== actualFingerprint) throw new NoteParseError("claim_fingerprint_mismatch");
    if (claimSources.some((source) => !isValidUlid(source))) throw new NoteParseError("invalid_claim_source");
    claims.push({
      fingerprint: actualFingerprint,
      kind: match[1] as NoteClaim["kind"],
      text,
      sources: claimSources,
    });
  }
  return claims;
}

function parseClaimText(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      throw new NoteParseError("invalid_claim_text");
    }
  }
  return value;
}

function parseRelatedNotes(lines: readonly string[]): { id: string }[] {
  return lines.filter(Boolean).map((line) => {
    const match = line.match(/^- \[\[([^\]|]+)\|.*\]\]$/u);
    if (!match || !isValidUlid(match[1])) throw new NoteParseError("invalid_related_note");
    return { id: match[1] };
  });
}

function parsePromotions(lines: readonly string[]): NotePromotion[] {
  return lines.filter(Boolean).map((line) => {
    const match = line.match(/^- (\S+) proposal (\S+) (applied|rejected) →(.*)$/u);
    if (!match || !isValidUlid(match[2])) throw new NoteParseError("invalid_rule_promotion");
    return {
      date: match[1],
      proposal_id: match[2],
      status: match[3] as NotePromotion["status"],
      path: match[4].trim() || null,
    };
  });
}

function readScalar(fields: Map<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined) throw new NoteParseError(`missing_frontmatter_field:${key}`);
  return parseScalar(value);
}

function readArray(fields: Map<string, string>, key: string): string[] {
  const value = fields.get(key);
  if (value === undefined || !value.startsWith("[") || !value.endsWith("]")) {
    throw new NoteParseError(`invalid_frontmatter_array:${key}`);
  }
  const contents = value.slice(1, -1).trim();
  return contents ? splitFlowArray(contents).map(parseScalar) : [];
}

export function splitFlowArray(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ",") {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote) throw new NoteParseError("invalid_frontmatter_array");
  items.push(value.slice(start).trim());
  if (items.some((item) => item.length === 0)) throw new NoteParseError("invalid_frontmatter_array");
  return items;
}

export function parseScalar(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      throw new NoteParseError("invalid_frontmatter_scalar");
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new NoteParseError("invalid_frontmatter_scalar");
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

function renderClaim(claim: NoteClaim): string {
  const text = claim.text.startsWith('"') || claim.text.includes("\n") || claim.text.includes("<!-- claim:") || claim.text !== claim.text.trim()
    ? JSON.stringify(claim.text)
    : claim.text;
  return `- [${claim.kind}] ${text} <!-- claim:${claim.fingerprint} sources:${claim.sources.join(",")} -->`;
}

function renderPromotion(promotion: NotePromotion): string {
  return `- ${promotion.date} proposal ${promotion.proposal_id} ${promotion.status} → ${promotion.path ?? ""}`;
}

function renderArray(values: readonly string[]): string {
  return `[${values.map(renderScalar).join(", ")}]`;
}

function renderScalar(value: string): string {
  return /^[^\s\[\]{},#&*!|>'"%@`][^\r\n]*$/u.test(value)
    && !value.includes(": ")
    && !value.includes(" #")
    ? value
    : JSON.stringify(value);
}

function validateNote(note: NoteDocument): void {
  if (!isValidUlid(note.id) || !note.title.trim() || !note.created || !note.updated) {
    throw new NoteParseError("invalid_note_metadata");
  }
  if (note.slug !== slugifyKnowledgeName(note.title)) throw new NoteParseError("invalid_note_slug");
  for (const values of [note.tags, note.sources, note.links, note.project_ids]) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.includes("\n"))) {
      throw new NoteParseError("invalid_note_array");
    }
  }
  for (const value of [...note.sources, ...note.links, ...note.project_ids]) {
    if (!isValidUlid(value)) throw new NoteParseError("invalid_note_reference");
  }
  if (note.claims.some((claim) => !/^[a-f0-9]{16}$/u.test(claim.fingerprint)
    || claim.fingerprint !== fingerprint(claim.text)
    || !(claim.kind === "fact" || claim.kind === "decision" || claim.kind === "pitfall")
    || claim.sources.some((source) => !isValidUlid(source)))) {
    throw new NoteParseError("invalid_note_claim");
  }
  if (note.promotions.some((promotion) => !promotion.date || !isValidUlid(promotion.proposal_id)
    || !(promotion.status === "applied" || promotion.status === "rejected")
    || (promotion.path !== null && typeof promotion.path !== "string"))) {
    throw new NoteParseError("invalid_note_promotion");
  }
  if (/\r|\n/u.test(note.title) || /\r|\n/u.test(note.created) || /\r|\n/u.test(note.updated)
    || note.summary !== note.summary.trim()) throw new NoteParseError("invalid_note_text");
}

function sameNote(left: NoteDocument, right: NoteDocument): boolean {
  // tags_source is optional and may sit at a different key position, so compare it separately.
  return left.tags_source === right.tags_source
    && JSON.stringify({ ...left, tags_source: undefined }) === JSON.stringify({ ...right, tags_source: undefined });
}
