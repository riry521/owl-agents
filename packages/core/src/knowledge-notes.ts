import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { generateUlid, isValidUlid } from "@owl/shared";

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
  readonly minTopicScore?: number;
  readonly minTopicScoreGap?: number;
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
  private readonly notesDir: string;
  private readonly minTopicScore: number;
  private readonly minTopicScoreGap: number;
  private readonly now: () => string;
  private readonly knownTitles = new Map<string, string>();

  public constructor(knowledge: KnowledgeBase, options: KnowledgeNotesOptions = {}) {
    this.notesDir = join(knowledge.knowledgeDir, "notes");
    this.minTopicScore = validThreshold(options.minTopicScore, DEFAULT_MIN_TOPIC_SCORE);
    this.minTopicScoreGap = validThreshold(options.minTopicScoreGap, DEFAULT_MIN_TOPIC_SCORE_GAP);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async list(): Promise<NoteDocument[]> {
    const entries = await this.readStoredNotes();
    return entries
      .map(({ note }) => note)
      .sort((left, right) => right.updated.localeCompare(left.updated) || left.id.localeCompare(right.id));
  }

  /** Notes with their actual file names under notes/ (which may carry a de-duplication suffix). */
  public async listWithFiles(): Promise<Array<{ note: NoteDocument; file: string }>> {
    return (await this.readStoredNotes()).map(({ note, path }) => ({ note, file: path }));
  }

  public async get(id: string): Promise<NoteDocument | null> {
    const entry = (await this.readStoredNotes()).find(({ note }) => note.id === id);
    return entry?.note ?? null;
  }

  public async findByTopic(topic: string, tags: readonly string[]): Promise<{ note: NoteDocument; score: number }[]> {
    return this.rankCandidates(`${topic} ${tags.join(" ")}`);
  }

  public async mergeClaim(input: {
    topic: string;
    kind: NoteClaim["kind"];
    text: string;
    work_id: string;
    project_id: string | null;
    tags: readonly string[];
    /** Mark a newly created note as tagged from keywords. */
    tags_source?: "keywords";
  }): Promise<{ note_id: string; created: boolean; added: boolean }> {
    const topic = input.topic.trim();
    const text = input.text.trim();
    if (!topic || !text) throw new Error("invalid_note_claim");
    if (!(input.kind === "fact" || input.kind === "decision" || input.kind === "pitfall")) {
      throw new Error("invalid_note_claim_kind");
    }

    const topicSlug = slugifyKnowledgeName(topic);
    const candidates = await this.readStoredNotes();
    const exact = candidates.find(({ note }) => note.slug === topicSlug);
    const ranked = exact
      ? [{ note: exact.note, score: Number.MAX_SAFE_INTEGER }]
      : await this.rankCandidates(`${topic} ${text} ${input.tags.join(" ")}`);
    const best = ranked[0];
    const second = ranked[1];
    const matched = best !== undefined
      && best.score >= this.minTopicScore
      && best.score - (second?.score ?? 0) >= this.minTopicScoreGap;

    if (matched && best) {
      const result = await this.mergeInto(best.note, { ...input, topic }, text);
      return { note_id: result.note.id, created: false, added: result.added };
    }

    const now = this.now();
    const id = generateUlid();
    if (!isValidUlid(id)) throw new Error("invalid_note_id");
    const claim: NoteClaim = {
      fingerprint: fingerprint(text),
      kind: input.kind,
      text,
      sources: [input.work_id],
    };
    const note: NoteDocument = {
      id,
      title: topic,
      slug: topicSlug,
      tags: sanitizeKeywords(input.tags).sort((a, b) => a.localeCompare(b)),
      ...(input.tags_source ? { tags_source: input.tags_source } : {}),
      sources: [input.work_id],
      links: [],
      project_ids: input.project_id ? [input.project_id] : [],
      created: now,
      updated: now,
      summary: text.slice(0, 200),
      claims: [claim],
      promotions: [],
    };
    await this.writeNewNote(note);

    const ambiguous = best !== undefined
      && best.score >= this.minTopicScore
      && (best.score - (second?.score ?? 0)) < this.minTopicScoreGap;
    if (ambiguous) {
      for (const candidate of ranked.slice(0, 2)) {
        await this.addLink(id, candidate.note.id);
      }
    }
    return { note_id: id, created: true, added: true };
  }

  public async addLink(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const stored = await this.readStoredNotes();
    const from = stored.find(({ note }) => note.id === fromId);
    const to = stored.find(({ note }) => note.id === toId);
    if (!from || !to) throw new Error("note_not_found");

    const now = this.now();
    const updatedFrom = { ...from.note, links: uniqueSorted([...from.note.links, toId]), updated: now };
    const updatedTo = { ...to.note, links: uniqueSorted([...to.note.links, fromId]), updated: now };
    const fromContent = this.render(updatedFrom);
    const toContent = this.render(updatedTo);
    this.assertRoundTrip(updatedFrom, fromContent);
    this.assertRoundTrip(updatedTo, toContent);
    await writeAtomic(join(this.notesDir, from.path), fromContent);
    await writeAtomic(join(this.notesDir, to.path), toContent);
  }

  public async mergeNotes(targetId: string, sourceId: string): Promise<boolean> {
    if (targetId === sourceId) return false;
    const stored = await this.readStoredNotes();
    const target = stored.find(({ note }) => note.id === targetId);
    const source = stored.find(({ note }) => note.id === sourceId);
    if (!target || !source) throw new Error("note_not_found");

    const claims = [...target.note.claims];
    for (const sourceClaim of source.note.claims) {
      const index = claims.findIndex((claim) => claim.fingerprint === sourceClaim.fingerprint);
      if (index < 0) claims.push(sourceClaim);
      else claims[index] = {
        ...claims[index],
        sources: uniqueSorted([...claims[index].sources, ...sourceClaim.sources]),
      };
    }
    const updatedTarget: NoteDocument = {
      ...target.note,
      tags: mergeTagSets(target.note.tags, source.note.tags),
      sources: uniqueSorted([...target.note.sources, ...source.note.sources, ...claims.flatMap((claim) => claim.sources)]),
      links: uniqueSorted([...target.note.links, sourceId]),
      project_ids: uniqueSorted([...target.note.project_ids, ...source.note.project_ids]),
      updated: this.now(),
      claims,
    };
    const updatedSource: NoteDocument = {
      ...source.note,
      links: uniqueSorted([...source.note.links, targetId]),
      updated: this.now(),
    };
    await this.writeNote(target.path, updatedTarget);
    await this.writeNote(source.path, updatedSource);
    return true;
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

  private async mergeInto(
    target: NoteDocument,
    input: { topic: string; kind: NoteClaim["kind"]; work_id: string; project_id: string | null; tags: readonly string[] },
    text: string,
  ): Promise<{ note: NoteDocument; added: boolean }> {
    const claimFingerprint = fingerprint(text);
    const existing = target.claims.find((claim) => claim.fingerprint === claimFingerprint);
    const claims = existing
      ? target.claims.map((claim) => claim.fingerprint === claimFingerprint
        ? { ...claim, sources: uniqueSorted([...claim.sources, input.work_id]) }
        : claim)
      : [...target.claims, {
        fingerprint: claimFingerprint,
        kind: input.kind,
        text,
        sources: [input.work_id],
      }];
    const note: NoteDocument = {
      ...target,
      tags: mergeTagSets(target.tags, input.tags),
      sources: uniqueSorted([...target.sources, ...claims.flatMap((claim) => claim.sources), input.work_id]),
      project_ids: uniqueSorted([...target.project_ids, ...(input.project_id ? [input.project_id] : [])]),
      updated: this.now(),
      claims,
    };
    const stored = (await this.readStoredNotes()).find(({ note: candidate }) => candidate.id === target.id);
    if (!stored) throw new Error("note_not_found");
    await this.writeNote(stored.path, note);
    return { note, added: existing === undefined };
  }

  private async rankCandidates(query: string): Promise<{ note: NoteDocument; score: number }[]> {
    const queryWords = words(query);
    if (queryWords.size === 0) return [];
    const entries = await this.readStoredNotes();
    return entries
      .map(({ note }) => {
        const noteWords = words([
          note.title,
          ...note.tags,
          note.summary,
          ...note.claims.map((claim) => claim.text),
        ].join(" "));
        let score = 0;
        for (const word of noteWords) score += Number(queryWords.has(word));
        return { note, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score
        || right.note.updated.localeCompare(left.note.updated)
        || left.note.id.localeCompare(right.note.id));
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
      const note = this.parse(content);
      this.knownTitles.set(note.id, note.title);
      stored.push({ note, path: entry.name });
    }
    return stored;
  }

  private async writeNewNote(note: NoteDocument): Promise<void> {
    await mkdir(this.notesDir, { recursive: true });
    const resolved = await resolveKnowledgeFilename(this.notesDir, note.slug);
    await this.writeNote(resolved.filename, note);
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

function splitFlowArray(value: string): string[] {
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
