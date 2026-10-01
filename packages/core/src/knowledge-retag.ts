import { isAbsolute, join } from "node:path";
import { cp } from "node:fs/promises";

import type { KnowledgeBase } from "./knowledge-base.js";
import type { KnowledgeNotes } from "./knowledge-notes.js";
import { MAX_NOTE_TAGS, MIN_KEYWORDS, PRESERVED_ORIGIN_TAGS, sanitizeKeywords } from "./knowledge-tags.js";

export interface KeywordExtractionItem {
  id: string;
  title: string;
  /** First 1500 characters of the note body. */
  text: string;
  current_tags: string[];
}
export type KeywordExtractionResult =
  | { ok: true; items: Array<{ id: string; keywords: string[] }> }
  | { ok: false; error: string };

export interface RetagReport {
  dry_run: boolean;
  backup_path: string | null;
  scanned: number;
  targeted: number;
  changes: Array<{ path: string; before: string[]; after: string[]; }>;
  unchanged: string[];
  failed: Array<{ path: string; error: string }>;
}

interface Target {
  path: string;
  noteId: string;
  item: KeywordExtractionItem;
}

const PRESERVED = new Set<string>(PRESERVED_ORIGIN_TAGS);

function sortedKey(tags: readonly string[]): string {
  return [...tags].sort((a, b) => a.localeCompare(b)).join("\u0000");
}

/**
 * Rebuild the tags of every note under knowledge.knowledgeDir/notes from AI-extracted
 * keywords. Only notes without the `tags_source: keywords` record are
 * targeted (all of them with `force`), whatever their tags look like. A note is marked once its
 * extraction yielded at least MIN_KEYWORDS valid keywords, so a full successful run leaves nothing to
 * target; a failed or keywords_insufficient note is left untouched and unmarked.
 */
export async function retagKnowledge(input: {
  knowledge: KnowledgeBase;
  notes: KnowledgeNotes;
  backupRoot: string;
  extract: (items: KeywordExtractionItem[]) => Promise<KeywordExtractionResult>;
  dry_run: boolean;
  force?: boolean;
  batchSize?: number;
  now?: () => Date;
}): Promise<RetagReport> {
  const { knowledge, notes } = input;
  if (!isAbsolute(knowledge.knowledgeDir) || !isAbsolute(input.backupRoot)) throw new Error("retag_invalid_knowledge_dir");

  const all: Target[] = [];
  const marked = new Set<string>();
  for (const { note, file } of await notes.listWithFiles()) {
    if (note.tags_source === "keywords") marked.add(note.id);
    all.push({
      path: `notes/${file}`,
      noteId: note.id,
      item: {
        id: note.id,
        title: note.title,
        text: [note.summary, ...note.claims.map((claim) => claim.text)].join("\n").slice(0, 1500),
        current_tags: [...note.tags],
      },
    });
  }
  const targets = all.filter(({ noteId }) => input.force || !marked.has(noteId));
  const report: RetagReport = {
    dry_run: input.dry_run, backup_path: null, scanned: all.length, targeted: targets.length,
    changes: [], unchanged: [], failed: [],
  };
  if (targets.length === 0) return report;

  const size = Math.max(1, input.batchSize ?? 8);
  const extracted = new Map<string, string[]>();
  const failedTargets = new Set<Target>();
  let batches = 0;
  for (let i = 0; i < targets.length; i += size) {
    const batch = targets.slice(i, i + size);
    batches += 1;
    const result = await input.extract(batch.map(({ item }) => item)).catch((error: unknown): KeywordExtractionResult => ({
      ok: false, error: error instanceof Error ? error.message : String(error),
    }));
    if (!result.ok) {
      for (const target of batch) {
        failedTargets.add(target);
        report.failed.push({ path: target.path, error: result.error });
      }
      continue;
    }
    for (const item of result.items) extracted.set(item.id, item.keywords);
  }
  if (failedTargets.size === targets.length && batches > 0) throw new Error("retag_extraction_failed");

  const planned: Array<{ target: Target; after: string[] }> = [];
  for (const target of targets) {
    if (failedTargets.has(target)) continue;
    const before = target.item.current_tags;
    const preserved = before.filter((tag) => PRESERVED.has(tag));
    const room = MAX_NOTE_TAGS - preserved.length;
    const added = sanitizeKeywords(extracted.get(target.item.id) ?? [])
      .filter((tag) => !preserved.includes(tag))
      .slice(0, Math.max(MIN_KEYWORDS, room));
    if (added.length < MIN_KEYWORDS) {
      report.failed.push({ path: target.path, error: "keywords_insufficient" });
      continue;
    }
    const after = [...preserved.slice(0, MAX_NOTE_TAGS - added.length), ...added].sort((a, b) => a.localeCompare(b));
    if (sortedKey(after) === sortedKey(before)) {
      report.unchanged.push(target.path);
      planned.push({ target, after });
      continue;
    }
    report.changes.push({ path: target.path, before: [...before], after });
    planned.push({ target, after });
  }
  if (input.dry_run || planned.length === 0) return report;

  const stamp = (input.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backupPath = join(input.backupRoot, `knowledge-retag-${stamp}`);
  try {
    await cp(knowledge.knowledgeDir, backupPath, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    throw new Error(`retag_backup_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  report.backup_path = backupPath;

  for (const { target, after } of planned) {
    try {
      await notes.setTags(target.noteId, after, true);
    } catch (error) {
      report.failed.push({ path: target.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
