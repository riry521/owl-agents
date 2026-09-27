import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { isRuleRole, isValidUlid } from "@owl/shared";

import { parseLessonBlocks } from "./final-verdict.js";
import { fingerprint } from "./learning-fingerprint.js";
import type { KnowledgeBase } from "./knowledge-base.js";
import type { KnowledgeNotes } from "./knowledge-notes.js";
import { writeAtomic } from "./knowledge-notes.js";
import { slugifyKnowledgeName } from "./knowledge-naming.js";
import type { OwnerLanguage } from "./owner-language.js";
import type { RuleProposalCreateInput, RuleProposals } from "./rule-proposals.js";

const ULID_PREFIX = /^([0-9A-HJKMNP-TV-Z]{26})/u;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface LegacyDocument {
  readonly body: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

interface MigrationRecord {
  readonly note_id: string;
  readonly claim_fingerprints: readonly string[];
  readonly rule_proposal_id?: string;
  readonly migrated_at: string;
  readonly work_id: string;
}

interface SimulatedNote {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  tags: string[];
  readonly summary: string;
  readonly updated: string;
  claims: { fingerprint: string; kind: "fact" | "decision" | "pitfall"; text: string }[];
}

export interface LegacyKnowledgeMigrationResult {
  readonly works_files: number;
  readonly policies_files: number;
  readonly notes_created: number;
  readonly notes_updated: number;
  readonly claims_added: number;
  readonly rule_proposals_created: number;
  readonly skipped: readonly { path: string; reason: string }[];
  readonly link_check: {
    readonly notes: number;
    readonly links: number;
    readonly dangling: readonly { note_id: string; target: string }[];
    readonly one_way: readonly { from: string; to: string }[];
  };
}

export async function migrateLegacyKnowledge(input: {
  readonly knowledge: KnowledgeBase;
  readonly notes: KnowledgeNotes;
  readonly ruleProposals: Pick<RuleProposals, "create" | "previewCreate">;
  readonly dry_run: boolean;
  readonly language?: OwnerLanguage;
  readonly now?: () => string;
}): Promise<LegacyKnowledgeMigrationResult> {
  if (typeof input.dry_run !== "boolean") throw new Error("invalid_dry_run");
  const root = input.knowledge.knowledgeDir;
  const manifestPath = join(root, "notes", ".migration.json");
  const manifest = await readManifest(manifestPath);
  const works = await legacyFiles(root, "works");
  const policies = await legacyFiles(root, "policies");
  const result = {
    works_files: works.length,
    policies_files: policies.length,
    notes_created: 0,
    notes_updated: 0,
    claims_added: 0,
    rule_proposals_created: 0,
    skipped: [] as { path: string; reason: string }[],
    link_check: { notes: 0, links: 0, dangling: [], one_way: [] } as LegacyKnowledgeMigrationResult["link_check"],
  };
  const existingNotes = await input.notes.list();
  const createdNoteIds = new Set<string>();
  const updatedNoteIds = new Set<string>();
  const simulatedNotes: SimulatedNote[] = existingNotes.map((note) => ({
    id: note.id,
    slug: note.slug,
    title: note.title,
    tags: [...note.tags],
    summary: note.summary,
    updated: note.updated,
    claims: note.claims.map(({ fingerprint: claimFingerprint, kind, text }) => ({ fingerprint: claimFingerprint, kind, text })),
  }));
  let simulatedNoteSequence = 0;
  const simulatedRuleProposalKeys = new Set<string>();

  for (const file of [...works, ...policies]) {
    if (manifest[file.path]) {
      result.skipped.push({ path: file.path, reason: "already_migrated" });
      continue;
    }
    try {
      const document = parseLegacyDocument(await readFile(file.absolutePath, "utf8"));
      const blocks = file.folder === "works" ? parseWorkLessonBlocks(document.body) : parseLessonBlocks(document.body);
      if (blocks.length === 0) {
        result.skipped.push({ path: file.path, reason: "no_lesson_blocks" });
        continue;
      }
      const mergeOrder = blocksForNoteMerge(blocks);
      const workId = resolveWorkId(document, file.path);
      // Note sources require ULIDs; keep the legacy sentinel in the manifest/tag and use a stable surrogate in the note.
      const noteSource = workId === "legacy-unknown" ? stableLegacyUlid(file.path) : workId;
      const topic = legacyTopic(document, file.path);

      if (input.dry_run) {
        for (const block of mergeOrder) {
          const claimText = formatClaimText(block.text, block.rationale, block.applies_to, input.language);
          const merged = simulateMergeClaim(simulatedNotes, {
            topic,
            kind: block.rationale || block.applies_to ? "pitfall" : "fact",
            text: claimText,
            tags: [...document.tags, ...(workId === "legacy-unknown" ? ["legacy-unknown"] : [])],
          }, ++simulatedNoteSequence);
          if (merged.created) createdNoteIds.add(merged.note_id);
          else updatedNoteIds.add(merged.note_id);
          if (merged.added) result.claims_added += 1;
        }
        if (file.folder === "policies") {
          for (const block of blocks) {
            if (input.ruleProposals.previewCreate(legacyPolicyProposalInput(file.path, block, topic), simulatedRuleProposalKeys)) {
              result.rule_proposals_created += 1;
            }
          }
        }
        continue;
      }

      const claimFingerprints = new Set<string>();
      let noteId = "";
      let firstProposalId: string | undefined;
      for (const block of mergeOrder) {
        const claimText = formatClaimText(block.text, block.rationale, block.applies_to, input.language);
        const claimFingerprint = fingerprint(claimText);
        claimFingerprints.add(claimFingerprint);
        const merged = await input.notes.mergeClaim({
          topic,
          kind: block.rationale || block.applies_to ? "pitfall" : "fact",
          text: claimText,
          work_id: noteSource,
          project_id: null,
          tags: [...document.tags, ...(workId === "legacy-unknown" ? ["legacy-unknown"] : [])],
        });
        noteId = merged.note_id;
        if (merged.created) createdNoteIds.add(merged.note_id);
        else updatedNoteIds.add(merged.note_id);
        if (merged.added) result.claims_added += 1;

        if (file.folder === "policies") {
          const proposal = await input.ruleProposals.create(legacyPolicyProposalInput(file.path, block, topic));
          firstProposalId ??= proposal.proposal_id;
          if (!proposal.already_recorded && !proposal.merged_into) result.rule_proposals_created += 1;
        }
      }
      const record: MigrationRecord = {
        note_id: noteId,
        claim_fingerprints: [...claimFingerprints].sort(),
        ...(firstProposalId ? { rule_proposal_id: firstProposalId } : {}),
        migrated_at: (input.now ?? (() => new Date().toISOString()))(),
        work_id: workId,
      };
      manifest[file.path] = record;
      await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      result.skipped.push({
        path: file.path,
        reason: error instanceof Error ? error.message : "migration_failed",
      });
    }
  }

  result.notes_created = createdNoteIds.size;
  result.notes_updated = [...updatedNoteIds].filter((id) => !createdNoteIds.has(id)).length;
  result.link_check = await checkLinks(input.notes);
  return result;
}

function legacyPolicyProposalInput(
  path: string,
  block: ReturnType<typeof parseLessonBlocks>[number],
  topic: string,
): RuleProposalCreateInput {
  const role = block.scope && block.scope !== "all" && isRuleRole(block.scope) ? block.scope : null;
  return {
    origin: "legacy_policy",
    source: { kind: "legacy_policy", ref: `${path}#${block.index}` },
    level: role === null ? "system" : "role",
    ...(role === null ? {} : { role }),
    text: block.text,
    rationale: block.rationale || `Imported from ${path}`,
    applies_to: block.applies_to || topic,
    project_id: null,
  };
}

async function legacyFiles(root: string, folder: "works" | "policies"): Promise<{ folder: "works" | "policies"; path: string; absolutePath: string }[]> {
  let entries;
  try {
    entries = await readdir(join(root, folder), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({ folder, path: `${folder}/${entry.name}`, absolutePath: join(root, folder, entry.name) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function readManifest(path: string): Promise<Record<string, MigrationRecord>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_migration_manifest");
    return value as Record<string, MigrationRecord>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function parseLegacyDocument(content: string): LegacyDocument {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const fields: Record<string, string> = {};
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---\n", 4);
    if (end >= 0) {
      body = normalized.slice(end + 5);
      for (const line of normalized.slice(4, end).split("\n")) {
        const match = /^([a-z_-]+):\s*(.*)$/iu.exec(line);
        if (match) fields[match[1]!.toLowerCase()] = unquote(match[2]!.trim());
      }
    }
  }
  const rawTags = fields.tags ?? "";
  const tags = rawTags.startsWith("[") && rawTags.endsWith("]")
    ? rawTags.slice(1, -1).split(",").map((tag) => unquote(tag.trim())).filter(Boolean)
    : rawTags ? [rawTags] : [];
  return { body, fields, tags };
}

function unquote(value: string): string {
  return value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function resolveWorkId(document: LegacyDocument, path: string): string {
  const fromFrontmatter = document.fields.work_id?.trim();
  if (fromFrontmatter && isValidUlid(fromFrontmatter)) return fromFrontmatter;
  const filenameId = ULID_PREFIX.exec(basename(path, ".md"))?.[1];
  return filenameId ?? "legacy-unknown";
}

function legacyTopic(document: LegacyDocument, path: string): string {
  const title = document.fields.title?.trim();
  if (title) return title;
  return basename(path, ".md").replace(ULID_PREFIX, "").replace(/[-_]+/gu, " ").trim() || "Legacy knowledge";
}

function formatClaimText(text: string, rationale: string, appliesTo: string, language: OwnerLanguage = "ja"): string {
  return [text, rationale ? `${language === "ja" ? "根拠" : "Basis"}: ${rationale}` : "", appliesTo ? `${language === "ja" ? "当てはまる場面" : "Applies to"}: ${appliesTo}` : ""]
    .filter(Boolean)
    .join("\n");
}

function parseWorkLessonBlocks(body: string) {
  const bullets = parseLessonBlocks(body);
  if (bullets.length > 0) return bullets;
  return parseLessonBlocks(body.replace(/^[\t ]*\d+\.[\t ]+/gmu, "- "));
}

function blocksForNoteMerge<T extends { text: string; rationale: string; applies_to: string }>(blocks: readonly T[]): readonly T[] {
  // KnowledgeNotes trims summaries at 200 characters, so create a note from a block with a safe boundary.
  const safeIndex = blocks.findIndex((block) => {
    const text = formatClaimText(block.text, block.rationale, block.applies_to);
    return text.length <= 200 || !/\s/u.test(text.slice(0, 200).slice(-1));
  });
  return safeIndex > 0 ? [blocks[safeIndex]!, ...blocks.slice(0, safeIndex), ...blocks.slice(safeIndex + 1)] : blocks;
}

function simulateMergeClaim(
  notes: SimulatedNote[],
  input: { topic: string; kind: "fact" | "decision" | "pitfall"; text: string; tags: readonly string[] },
  sequence: number,
): { note_id: string; created: boolean; added: boolean } {
  const topicSlug = slugifyKnowledgeName(input.topic);
  const exact = notes.find((note) => note.slug === topicSlug);
  const queryWords = words(`${input.topic} ${input.text} ${input.tags.join(" ")}`);
  const ranked = exact ? [{ note: exact, score: Number.MAX_SAFE_INTEGER }] : notes
    .map((note) => {
      const noteWords = words([note.title, ...note.tags, note.summary, ...note.claims.map((claim) => claim.text)].join(" "));
      let score = 0;
      for (const word of noteWords) score += Number(queryWords.has(word));
      return { note, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || right.note.updated.localeCompare(left.note.updated)
      || left.note.id.localeCompare(right.note.id));
  const best = ranked[0];
  const second = ranked[1];
  if (best && best.score >= 3 && best.score - (second?.score ?? 0) >= 2) {
    const existing = best.note.claims.find((claim) => claim.fingerprint === fingerprint(input.text));
    if (!existing) {
      best.note.claims = [...best.note.claims, {
        fingerprint: fingerprint(input.text), kind: input.kind, text: input.text,
      }];
    }
    best.note.tags = [...new Set([...best.note.tags, ...input.tags, ...words(input.topic)])].sort((a, b) => a.localeCompare(b));
    return { note_id: best.note.id, created: false, added: existing === undefined };
  }
  const id = `virtual-note-${sequence}`;
  notes.push({
    id,
    slug: topicSlug,
    title: input.topic,
    tags: [...new Set([...input.tags, ...words(input.topic)])].sort((a, b) => a.localeCompare(b)),
    summary: input.text.slice(0, 200),
    updated: "9999-12-31T23:59:59.999Z",
    claims: [{ fingerprint: fingerprint(input.text), kind: input.kind, text: input.text }],
  });
  return { note_id: id, created: true, added: true };
}

function words(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1));
}

function stableLegacyUlid(value: string): string {
  let number = BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 32)}`);
  let encoded = "";
  while (number > 0n) {
    encoded = ULID_ALPHABET[Number(number & 31n)] + encoded;
    number >>= 5n;
  }
  return encoded.padStart(26, "0");
}

async function checkLinks(notes: KnowledgeNotes): Promise<LegacyKnowledgeMigrationResult["link_check"]> {
  const documents = await notes.list();
  const ids = new Set(documents.map((note) => note.id));
  const dangling: { note_id: string; target: string }[] = [];
  const oneWay: { from: string; to: string }[] = [];
  let links = 0;
  for (const note of documents) {
    links += note.links.length;
    for (const target of note.links) {
      if (!ids.has(target)) dangling.push({ note_id: note.id, target });
      else if (!documents.find((candidate) => candidate.id === target)?.links.includes(note.id)) {
        oneWay.push({ from: note.id, to: target });
      }
    }
  }
  return {
    notes: documents.length,
    links,
    dangling: dangling.sort((left, right) => left.note_id.localeCompare(right.note_id) || left.target.localeCompare(right.target)),
    one_way: oneWay.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
  };
}
