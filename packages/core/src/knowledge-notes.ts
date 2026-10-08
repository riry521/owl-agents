import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { generateUlid, isValidUlid } from "@owl/shared";

import { projectOverviewFilename } from "./project-overview.js";

import type { KnowledgeBase } from "./knowledge-base.js";
import { fingerprint } from "./learning-fingerprint.js";
import { mergeTagSets, sanitizeKeywords } from "./knowledge-tags.js";
import { resolveKnowledgeFilename, slugifyKnowledgeName } from "./knowledge-naming.js";

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

const DEFAULT_MIN_TOPIC_SCORE = 3;
const DEFAULT_MIN_TOPIC_SCORE_GAP = 2;

/** Atomically replace a file using a sibling temporary file and rename. */
export async function writeAtomic(absolutePath: string, content: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

interface StoredNote {
  readonly note: NoteDocument;
  readonly path: string;
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

  /** Files under notes/ do not match the page templates, so they are not knowledge: none is listed. */
  public async list(): Promise<NoteDocument[]> {
    return [];
  }

  /** Notes with their actual file names under notes/ (which may carry a de-duplication suffix). */
  public async listWithFiles(): Promise<Array<{ note: NoteDocument; file: string }>> {
    return (await this.readStoredNotes()).map(({ note, path }) => ({ note, file: path }));
  }

  /** The fixed-name overview note of one project; null if missing or unparsable. */
  public async getProjectOverview(projectId: string): Promise<NoteDocument | null> {
    try {
      return this.parse(await readFile(join(this.notesDir, projectOverviewFilename(projectId)), "utf8"));
    } catch {
      return null;
    }
  }

  public async get(id: string): Promise<NoteDocument | null> {
    const entry = (await this.readStoredNotes()).find(({ note }) => note.id === id);
    return entry?.note ?? null;
  }





  /** Move a merged source note out of knowledge/ and point other notes' links at the target. */
  public async retireMergedNote(
    sourceId: string,
    targetId: string,
    archiveDir: string,
  ): Promise<{ archived_path: string; relinked: string[] }> {
    const stored = await this.readStoredNotes();
    const source = stored.find(({ note }) => note.id === sourceId);
    if (!source || !stored.some(({ note }) => note.id === targetId)) throw new Error("note_not_found");

    const relinked: string[] = [];
    for (const { note, path } of stored) {
      if (note.id === sourceId || !note.links.includes(sourceId)) continue;
      const links = uniqueSorted(note.links.filter((id) => id !== sourceId).concat(note.id === targetId ? [] : [targetId]));
      await this.writeNote(path, { ...note, links, updated: this.now() });
      relinked.push(path);
    }

    const archiveNotes = join(archiveDir, "notes");
    await mkdir(archiveNotes, { recursive: true });
    const dot = source.path.lastIndexOf(".");
    const stem = dot > 0 ? source.path.slice(0, dot) : source.path;
    const ext = dot > 0 ? source.path.slice(dot) : "";
    let archived = join(archiveNotes, source.path);
    for (let n = 1; await readFile(archived).then(() => true, () => false); n += 1) {
      archived = join(archiveNotes, `${stem}-${n}${ext}`);
    }
    const from = join(this.notesDir, source.path);
    try {
      await rename(from, archived);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(from, archived);
      await unlink(from);
    }
    return { archived_path: archived, relinked };
  }

  public async normalizeTags(noteId: string, from: string, to: string): Promise<boolean> {
    const stored = (await this.readStoredNotes()).find(({ note }) => note.id === noteId);
    if (!stored) throw new Error("note_not_found");
    const tags = uniqueSorted(stored.note.tags.map((tag) => tag === from ? to : tag));
    if (tags.join("\u0000") === [...stored.note.tags].sort((a, b) => a.localeCompare(b)).join("\u0000")) return false;
    await this.writeNote(stored.path, { ...stored.note, tags, updated: this.now() });
    return true;
  }

  /** Replace only the tags of a note; body and `updated` stay untouched. `keywords` marks the tags as keyword-built. */
  public async setTags(noteId: string, tags: readonly string[], keywords = false): Promise<void> {
    const stored = (await this.readStoredNotes()).find(({ note }) => note.id === noteId);
    if (!stored) throw new Error("note_not_found");
    await this.writeNote(stored.path, { ...stored.note, tags: uniqueSorted(tags), ...(keywords ? { tags_source: "keywords" as const } : {}) });
  }

  public async recordPromotion(noteId: string, entry: NotePromotion): Promise<void> {
    const stored = (await this.readStoredNotes()).find(({ note }) => note.id === noteId);
    if (!stored) throw new Error("note_not_found");
    if (!(entry.status === "applied" || entry.status === "rejected") || !entry.date || !entry.proposal_id) {
      throw new Error("invalid_note_promotion");
    }
    const note = {
      ...stored.note,
      updated: this.now(),
      promotions: [...stored.note.promotions, { ...entry }],
    };
    await this.writeNote(stored.path, note);
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



  private async readStoredNotes(): Promise<StoredNote[]> {
    let entries;
    try {
      entries = await readdir(this.notesDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const stored: StoredNote[] = [];
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
      const content = await readFile(join(this.notesDir, entry.name), "utf8");
      let note: NoteDocument;
      try {
        note = this.parse(content);
      } catch (error) {
        console.warn(`[owl-core] Skipping unparsable knowledge note ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      this.knownTitles.set(note.id, note.title);
      stored.push({ note, path: entry.name });
    }
    return stored;
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

function words(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validThreshold(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
