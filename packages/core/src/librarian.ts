import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

import { KnowledgeBase, type KnowledgeEntry } from "./knowledge-base.js";
import { KnowledgeNotes, writeAtomic } from "./knowledge-notes.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_MD_PATH = "hot.md";
const DEFAULT_MOC_PATH = "Home.md";

export const CURATION_ACTION_KINDS = [
  "merge",
  "flag_stale",
  "flag_contradiction",
  "update_moc",
  "fix_orphan",
  "normalize_tag",
  "refresh_hot_md",
] as const;

export type CurationActionKind = (typeof CURATION_ACTION_KINDS)[number];

/** Common metadata accepted on every curation action. */
export interface CurationActionBase {
  readonly kind: CurationActionKind;
  readonly reason?: string;
  readonly requiresApproval?: boolean;
  readonly [key: string]: unknown;
}

export interface MergeCurationAction extends CurationActionBase {
  readonly kind: "merge";
  readonly targetPath?: string;
  readonly target?: string;
  readonly sourcePath?: string;
  readonly sourcePaths?: string[];
  readonly mergedContent?: string;
  readonly content?: string;
}

export interface FlagStaleCurationAction extends CurationActionBase {
  readonly kind: "flag_stale";
  readonly path?: string;
  readonly thresholdDays?: number;
  readonly ageDays?: number;
  readonly updatedAt?: string;
}

export interface FlagContradictionCurationAction extends CurationActionBase {
  readonly kind: "flag_contradiction";
  readonly paths?: string[];
  readonly leftPath?: string;
  readonly rightPath?: string;
  readonly details?: string;
}

export interface UpdateMocCurationAction extends CurationActionBase {
  readonly kind: "update_moc";
  readonly mocPath?: string;
  readonly entryPath?: string;
  readonly path?: string;
  readonly link?: string;
}

export interface FixOrphanCurationAction extends CurationActionBase {
  readonly kind: "fix_orphan";
  readonly path?: string;
  readonly entryPath?: string;
  readonly mocPath?: string;
  readonly link?: string;
}

export interface NormalizeTagCurationAction extends CurationActionBase {
  readonly kind: "normalize_tag";
  readonly path?: string;
  readonly paths?: string[];
  readonly from?: string;
  readonly to?: string;
  readonly oldTag?: string;
  readonly newTag?: string;
  readonly tags?: string[];
}

export interface RefreshHotMdCurationAction extends CurationActionBase {
  readonly kind: "refresh_hot_md";
  readonly path?: string;
  readonly content?: string;
  readonly maxLines?: number;
}

/** A provider-neutral action produced by the Librarian. */
export type CurationAction =
  | MergeCurationAction
  | FlagStaleCurationAction
  | FlagContradictionCurationAction
  | UpdateMocCurationAction
  | FixOrphanCurationAction
  | NormalizeTagCurationAction
  | RefreshHotMdCurationAction;

export interface DuplicateScores {
  readonly title: number;
  readonly body: number;
  readonly shared_tags: number;
  readonly total: number;
}

export interface MergedNoteRecord {
  readonly target: string;
  readonly source: string;
  readonly archived_path: string;
  readonly reason: "near_duplicate";
  readonly scores: DuplicateScores;
}

export interface MergeSkippedRecord {
  readonly paths: [string, string];
  readonly titles: [string, string];
  readonly reason:
    | "below_merge_threshold"
    | "no_content_overlap"
    | "possible_contradiction"
    | "merged_elsewhere"
    | "cross_folder"
    | "non_note_near_duplicate"
    | "entry_limit"
    | "merge_failed";
  readonly detail: string;
  readonly scores: DuplicateScores;
}

export interface CurationReport {
  readonly run_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly files_scanned: number;
  readonly actions_taken: CurationAction[];
  readonly actions_needing_approval: CurationAction[];
  /** Near-duplicate notes merged in this run (source moved out of knowledge/). */
  readonly merged: MergedNoteRecord[];
  /** Duplicate candidates that were not merged, with the reason (highest score first, all of them). */
  readonly merge_skipped: MergeSkippedRecord[];
  readonly warnings: string[];
}

export const NEAR_DUPLICATE_TITLE_MIN = 0.6;
export const NEAR_DUPLICATE_SCORE_MIN = 0.45;
export const MERGE_CANDIDATE_REPORT_MIN = 0.3;
export const NEAR_DUPLICATE_BODY_MIN = 0.1;
const PROVENANCE_TAGS = new Set(["auto-saved", "work-lessons", "legacy-unknown"]);

export interface LibrarianConfig {
  readonly mergedArchiveDir?: string;
  readonly idleTriggerMinutes: number;
  readonly maxEntriesPerRun: number;
  readonly stalenessThresholdDays: number;
  readonly hotMdMaxLines: number;
  readonly getModelConfig?: () => LibrarianModelConfig | undefined;
}

export interface LibrarianModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export interface LibrarianCurationRequest {
  readonly role: "librarian";
  readonly prompt: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

export const DEFAULT_LIBRARIAN_CONFIG: LibrarianConfig = {
  idleTriggerMinutes: 30,
  maxEntriesPerRun: 100,
  stalenessThresholdDays: 90,
  hotMdMaxLines: 50,
};

interface FrontmatterDocument {
  fields: string[];
  body: string;
}

interface LinkTarget {
  path: string;
  pathWithoutExtension: string;
  basenameWithoutExtension: string;
  title: string;
}

interface HotKnowledgeEntry extends KnowledgeEntry {
  readonly sourceCount?: number;
}

/**
 * Maintains the file-based knowledge base without performing destructive
 * operations. AI/provider integration can use the prompt and response
 * methods, while the local detectors provide a useful deterministic baseline.
 */
export class Librarian {
  private activeRun: Promise<CurationReport> | null = null;

  private readonly knowledge: KnowledgeBase;
  private readonly notes: KnowledgeNotes;
  private readonly config: LibrarianConfig;
  private readonly modelConfigReader: () => LibrarianModelConfig | undefined;
  private readonly mergedArchiveDir: string;

  public constructor(knowledge: KnowledgeBase, config: Partial<LibrarianConfig> = {}) {
    this.knowledge = knowledge;
    this.mergedArchiveDir =
      config.mergedArchiveDir ?? join(dirname(knowledge.knowledgeDir), "data", "backups", "knowledge-merged");
    this.notes = new KnowledgeNotes(knowledge);
    this.modelConfigReader = config.getModelConfig ?? (() => undefined);
    this.config = {
      idleTriggerMinutes: config.idleTriggerMinutes ?? DEFAULT_LIBRARIAN_CONFIG.idleTriggerMinutes,
      maxEntriesPerRun: config.maxEntriesPerRun ?? DEFAULT_LIBRARIAN_CONFIG.maxEntriesPerRun,
      stalenessThresholdDays: config.stalenessThresholdDays ?? DEFAULT_LIBRARIAN_CONFIG.stalenessThresholdDays,
      hotMdMaxLines: config.hotMdMaxLines ?? DEFAULT_LIBRARIAN_CONFIG.hotMdMaxLines,
    };
  }

  /**
   * Resolve the configured Librarian model at call time. Provider calls are
   * intentionally owned by the caller, so model-setting changes do not
   * require rebuilding this knowledge-base service.
   */
  public getModelConfig(): LibrarianModelConfig | undefined {
    return this.modelConfigReader();
  }

  public buildCurationRequest(changedFiles: string[]): LibrarianCurationRequest {
    const model = this.getModelConfig();
    return {
      role: "librarian",
      prompt: this.buildCurationPrompt(changedFiles),
      ...(model ?? {}),
    };
  }

  public async scanForChanges(since?: Date): Promise<string[]> {
    const results = await this.knowledge.list();
    const sinceTime = since?.getTime();
    const hasSince = sinceTime !== undefined && Number.isFinite(sinceTime);

    return results
      .filter((result) => {
        if (!hasSince) return true;
        const mtime = new Date(result.mtime).getTime();
        return Number.isFinite(mtime) && mtime > (sinceTime as number);
      })
      .sort((left, right) => {
        const byMtime = right.mtime.localeCompare(left.mtime);
        return byMtime !== 0 ? byMtime : left.path.localeCompare(right.path);
      })
      .map((result) => result.path);
  }

  public detectDuplicates(entries: KnowledgeEntry[]): CurationAction[] {
    const groups = new Map<string, KnowledgeEntry[]>();

    for (const entry of entries) {
      const bodyKey = normalizeComparableText(entry.body);
      const titleKey = normalizeComparableText(entry.title || basename(entry.path, extname(entry.path)));
      const key = bodyKey.length >= 8 ? `body:${bodyKey}` : titleKey.length >= 3 ? `title:${titleKey}` : "";
      if (!key) continue;

      const group = groups.get(key);
      if (group) {
        group.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }

    const actions: CurationAction[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;

      const [canonical, ...duplicates] = group;
      const sourcePaths = duplicates.map((entry) => entry.path);
      actions.push({
        kind: "merge",
        targetPath: canonical.path,
        sourcePaths,
        ...(sourcePaths.length === 1 ? { sourcePath: sourcePaths[0] } : {}),
        reason: "Entries have the same normalized title or body.",
      });
    }

    return actions;
  }

  public detectStale(entries: KnowledgeEntry[], thresholdDays: number): CurationAction[] {
    const cutoff = Date.now() - Math.max(0, thresholdDays) * MILLISECONDS_PER_DAY;
    const referenced = this.findReferencedPaths(entries);
    const actions: CurationAction[] = [];

    for (const entry of entries) {
      if (isIndexLike(entry.path) || referenced.has(entry.path)) continue;

      const timestamp = entryTimestamp(entry);
      if (timestamp === undefined || timestamp >= cutoff) continue;

      const ageDays = Math.floor((Date.now() - timestamp) / MILLISECONDS_PER_DAY);
      actions.push({
        kind: "flag_stale",
        path: entry.path,
        thresholdDays,
        ageDays,
        updatedAt: new Date(timestamp).toISOString(),
        reason: "Entry is older than the staleness threshold and has no backlinks.",
      });
    }

    return actions;
  }

  public detectOrphans(entries: KnowledgeEntry[]): CurationAction[] {
    const referenced = this.findReferencedPaths(entries);
    const actions: CurationAction[] = [];

    for (const entry of entries) {
      if (isIndexLike(entry.path) || referenced.has(entry.path)) continue;

      actions.push({
        kind: "fix_orphan",
        path: entry.path,
        entryPath: entry.path,
        mocPath: DEFAULT_MOC_PATH,
        link: wikiLink(entry.path),
        reason: "Entry has no incoming wiki-links.",
      });
    }

    return actions;
  }

  public normalizeTagsAction(entries: KnowledgeEntry[]): CurationAction[] {
    const actions: CurationAction[] = [];

    for (const entry of entries) {
      for (const tag of entry.tags) {
        const normalized = normalizeTag(tag);
        if (!normalized || normalized === tag) continue;

        actions.push({
          kind: "normalize_tag",
          path: entry.path,
          from: tag,
          to: normalized,
          oldTag: tag,
          newTag: normalized,
          reason: "Normalize tag spelling and casing.",
        });
      }
    }

    return actions;
  }

  public generateHotMd(entries: HotKnowledgeEntry[], maxLines: number): string {
    const limit = Math.max(0, Math.floor(maxLines));
    if (limit === 0) return "";

    const selected = uniqueEntries(entries)
      .sort((left, right) => {
        const sourceCountDifference = (right.sourceCount ?? 0) - (left.sourceCount ?? 0);
        if (sourceCountDifference !== 0) return sourceCountDifference;
        const leftTime = entryTimestamp(left) ?? 0;
        const rightTime = entryTimestamp(right) ?? 0;
        if (rightTime !== leftTime) return rightTime - leftTime;
        return left.path.localeCompare(right.path);
      });

    const lines = ["# Hot Knowledge"];
    for (const entry of selected) {
      if (lines.length >= limit) break;

      const title = entry.title.trim() || basename(entry.path, extname(entry.path));
      const summary = firstMeaningfulLine(entry.body);
      const suffix = summary && normalizeComparableText(summary) !== normalizeComparableText(title) ? ` — ${summary}` : "";
      lines.push(`- ${wikiLink(entry.path)} — ${title}${suffix}`);
    }

    return lines.slice(0, limit).join("\n");
  }

  public buildCurationPrompt(changedFiles: string[]): string {
    const files = [...new Set(changedFiles.map((file) => file.trim()).filter(Boolean))];
    const fileList = files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- (none)";

    return [
      "You are the Owl Librarian. Analyze the changed knowledge files and propose only safe, auditable curation actions.",
      "Do not delete files. Do not execute commands. Return a JSON array and no other text.",
      "Allowed action kinds: merge, flag_stale, flag_contradiction, update_moc, fix_orphan, normalize_tag, refresh_hot_md.",
      "Actions that resolve contradictions or request deletion require owner approval; all other actions must remain non-destructive.",
      "Changed files:",
      fileList,
      "Each action must be an object with a string `kind` and the paths/tags/content needed to apply it.",
    ].join("\n");
  }

  public parseCurationResponse(stdout: string): CurationAction[] {
    for (const candidate of jsonCandidates(stdout)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate) as unknown;
      } catch {
        continue;
      }

      const rawActions = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.actions)
          ? parsed.actions
          : [];

      const actions = rawActions.filter(isCurationAction).map((action) => ({ ...action }));
      if (actions.length > 0 || rawActions.length === 0) return actions;
    }

    return [];
  }

  /**
   * Score every pair of entries by title, claim text and shared tags. Notes in
   * the same folder that clear the thresholds, share claim content and do not
   * contradict each other are merged (best pair first); every other pair above
   * the report floor is recorded as skipped with a reason.
   */
  public async mergeNearDuplicates(
    entries: KnowledgeEntry[],
    deferred: KnowledgeEntry[],
    exactPaths: ReadonlySet<string>,
    archiveDir: string,
    warnings: string[],
  ): Promise<{ merged: MergedNoteRecord[]; skipped: MergeSkippedRecord[] }> {
    const deferredPaths = new Set(deferred.map((entry) => entry.path));
    const candidates = [...entries, ...deferred].filter((entry) => !isIndexLike(entry.path) && !exactPaths.has(entry.path));
    const texts = new Map<string, string>();
    for (const entry of candidates) texts.set(entry.path, await this.claimText(entry));

    const pairs: { a: KnowledgeEntry; b: KnowledgeEntry; scores: DuplicateScores }[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const scores = scoreDuplicate(candidates[i], candidates[j], texts.get(candidates[i].path)!, texts.get(candidates[j].path)!);
        if (scores.total >= MERGE_CANDIDATE_REPORT_MIN) pairs.push({ a: candidates[i], b: candidates[j], scores });
      }
    }
    pairs.sort((x, y) => y.scores.total - x.scores.total || x.a.path.localeCompare(y.a.path));

    const merged: MergedNoteRecord[] = [];
    const skipped: MergeSkippedRecord[] = [];
    const retired = new Map<string, string>();
    const skip = (a: KnowledgeEntry, b: KnowledgeEntry, scores: DuplicateScores, reason: MergeSkippedRecord["reason"], detail: string) =>
      skipped.push({ paths: [a.path, b.path], titles: [a.title, b.title], reason, detail, scores });

    for (const { a, b, scores } of pairs) {
      const blocked = this.mergeBlocker(a, b, scores, texts, deferredPaths, retired);
      if (blocked) {
        skip(a, b, scores, blocked[0], blocked[1]);
        continue;
      }
      try {
        const noteA = this.notes.parse(await readFile(this.safeAbsolutePath(a.path), "utf8"));
        const noteB = this.notes.parse(await readFile(this.safeAbsolutePath(b.path), "utf8"));
        const aWins = noteA.claims.length !== noteB.claims.length
          ? noteA.claims.length > noteB.claims.length
          : noteA.created !== noteB.created ? noteA.created < noteB.created : a.path < b.path;
        const [target, source, targetNote, sourceNote] = aWins ? [a, b, noteA, noteB] : [b, a, noteB, noteA];
        await this.notes.mergeNotes(targetNote.id, sourceNote.id);
        const { archived_path } = await this.notes.retireMergedNote(sourceNote.id, targetNote.id, archiveDir);
        await this.relinkWiki(source.path, target.path);
        retired.set(source.path, target.path);
        merged.push({ target: target.path, source: source.path, archived_path, reason: "near_duplicate", scores });
      } catch (error) {
        warnings.push(`merge_failed: ${b.path}: ${errorMessage(error)}`);
        skip(a, b, scores, "merge_failed", errorMessage(error));
      }
    }

    return { merged, skipped };
  }

  /** Why a scored pair must not be merged automatically, or undefined when it may be. */
  private mergeBlocker(
    a: KnowledgeEntry,
    b: KnowledgeEntry,
    scores: DuplicateScores,
    texts: ReadonlyMap<string, string>,
    deferredPaths: ReadonlySet<string>,
    retired: ReadonlyMap<string, string>,
  ): [MergeSkippedRecord["reason"], string] | undefined {
    const textA = texts.get(a.path)!;
    const textB = texts.get(b.path)!;
    const gone = [a, b].find((entry) => retired.has(entry.path));
    if (deferredPaths.has(a.path) || deferredPaths.has(b.path)) return ["entry_limit", "not compared in this run because of the entry limit"];
    if (gone) return ["merged_elsewhere", `${gone.path} was already merged into ${retired.get(gone.path)} in this run`];
    if (dirname(a.path) !== dirname(b.path)) return ["cross_folder", `different folders: ${dirname(a.path)} / ${dirname(b.path)}`];
    if (!a.path.startsWith("notes/")) return ["non_note_near_duplicate", "only notes/ entries are merged automatically"];
    if (normalizeComparableText(textA) === normalizeComparableText(textB)) return undefined;
    if (scores.title < NEAR_DUPLICATE_TITLE_MIN) return ["below_merge_threshold", `title ${scores.title} < ${NEAR_DUPLICATE_TITLE_MIN}`];
    // Same title but no shared claim text is a more specific reason than a total pulled down by tags, so it is checked first.
    if (scores.body < NEAR_DUPLICATE_BODY_MIN) return ["no_content_overlap", `claim text overlap ${scores.body} < ${NEAR_DUPLICATE_BODY_MIN}`];
    if (scores.total < NEAR_DUPLICATE_SCORE_MIN) return ["below_merge_threshold", `total ${scores.total} < ${NEAR_DUPLICATE_SCORE_MIN}`];
    const conflict = findContradiction(textA, textB);
    if (conflict) return ["possible_contradiction", `similar statements differ in negation: "${conflict[0]}" / "${conflict[1]}"`];
    return undefined;
  }

  /** Claim text of a note (summary and related-note sections excluded); the whole body for other entries. */
  private async claimText(entry: KnowledgeEntry): Promise<string> {
    if (!entry.path.startsWith("notes/")) return entry.body;
    try {
      const note = this.notes.parse(await readFile(this.safeAbsolutePath(entry.path), "utf8"));
      return note.claims.map((claim) => claim.text).join("\n");
    } catch {
      return entry.body;
    }
  }

  /** Point path-style wiki links to a retired note at its merge target. */
  private async relinkWiki(sourcePath: string, targetPath: string): Promise<void> {
    const stem = (path: string) => path.replace(/\.md$/i, "");
    const from = new RegExp(`\\[\\[${stem(sourcePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\]|#])`, "g");
    const to = `[[${stem(targetPath)}`;
    for (const { path } of await this.knowledge.list()) {
      if (!path.toLowerCase().endsWith(".md")) continue;
      const absolute = this.safeAbsolutePath(path);
      const content = await readFile(absolute, "utf8");
      if (!from.test(content)) continue;
      from.lastIndex = 0;
      const seen = new Set<string>();
      const lines = content.replace(from, to).split("\n").filter((line) => {
        if (!line.includes(`${to}]]`) || seen.has(line)) return !seen.has(line);
        seen.add(line);
        return true;
      });
      await writeAtomic(absolute, lines.join("\n"));
    }
  }

  public async applyNonDestructive(actions: CurationAction[], warnings?: string[]): Promise<CurationAction[]> {
    const applied: CurationAction[] = [];

    for (const action of actions) {
      if (action.requiresApproval === true || action.kind === "flag_contradiction") continue;

      try {
        const didApply = await this.applyAction(action);
        if (didApply) applied.push(action);
      } catch (error) {
        // A malformed or concurrently removed file must not make the whole run destructive.
        warnings?.push(`apply_failed: ${action.kind}: ${errorMessage(error)}`);
      }
    }

    return applied;
  }

  public run(options: { runId?: string } = {}): Promise<CurationReport> {
    if (this.activeRun) return this.activeRun;
    const task = this.runOnce(options.runId).finally(() => {
      if (this.activeRun === task) this.activeRun = null;
    });
    this.activeRun = task;
    return task;
  }

  private async runOnce(givenRunId?: string): Promise<CurationReport> {
    const startedAt = new Date();
    const warnings: string[] = [];
    const runId = givenRunId ?? `librarian-${startedAt.getTime()}-${randomUUID()}`;
    let changedFiles: string[] = [];

    try {
      changedFiles = await this.scanForChanges();
    } catch (error) {
      warnings.push(`Unable to scan the knowledge base: ${errorMessage(error)}`);
    }

    const maxEntries = Math.max(0, Math.floor(this.config.maxEntriesPerRun));
    const curationFiles = changedFiles.filter((file) => file !== DEFAULT_HOT_MD_PATH);
    const candidateFiles = curationFiles.slice(0, maxEntries);
    if (curationFiles.length > candidateFiles.length) {
      warnings.push(`Entry limit reached; deferred ${curationFiles.length - candidateFiles.length} file(s) to a later run.`);
    }

    const entries: KnowledgeEntry[] = [];
    for (const path of candidateFiles) {
      try {
        entries.push(await this.knowledge.get(path));
      } catch (error) {
        warnings.push(`Unable to read ${path}: ${errorMessage(error)}`);
      }
    }

    const deferred: KnowledgeEntry[] = [];
    for (const path of curationFiles.slice(candidateFiles.length)) {
      try {
        deferred.push(await this.knowledge.get(path));
      } catch (error) {
        warnings.push(`Unable to read ${path}: ${errorMessage(error)}`);
      }
    }

    // Merge first so that the hot page and the other actions see the merged state.
    const exactPaths = new Set<string>(
      this.detectDuplicates(entries).flatMap((action) => [
        ...firstActionStrings(action, "sourcePaths", "sourcePath"),
        firstActionString(action, "targetPath", "target") ?? "",
      ]).filter((path) => !path.startsWith("notes/")),
    );
    const { merged, skipped } = await this.mergeNearDuplicates(
      entries, deferred, exactPaths, join(this.mergedArchiveDir, runId), warnings,
    );
    const retiredPaths = new Set(merged.map((record) => record.source));
    const mergedTargets = new Set(merged.map((record) => record.target));
    for (const [index, entry] of entries.entries()) {
      if (mergedTargets.has(entry.path) && !retiredPaths.has(entry.path)) entries[index] = await this.knowledge.get(entry.path);
    }
    const liveEntries = entries.filter((entry) => !retiredPaths.has(entry.path));

    let hotEntries: KnowledgeEntry[] = [];
    try {
      hotEntries = await this.readHotEntries();
    } catch (error) {
      warnings.push(`Unable to read hot knowledge sources: ${errorMessage(error)}`);
    }

    const actions: CurationAction[] = [
      ...this.detectDuplicates(liveEntries).filter((action) => !firstActionString(action, "targetPath", "target")?.startsWith("notes/")),
      ...this.detectStale(liveEntries, this.config.stalenessThresholdDays),
      ...this.detectOrphans(liveEntries),
      ...this.normalizeTagsAction(liveEntries),
      {
        kind: "refresh_hot_md",
        path: DEFAULT_HOT_MD_PATH,
        content: this.generateHotMd(hotEntries, this.config.hotMdMaxLines),
        maxLines: this.config.hotMdMaxLines,
        reason: "Refresh the generated hot knowledge page.",
      },
    ];

    const uniqueActions = deduplicateActions(actions);
    const needingApproval = uniqueActions.filter(
      (action) => action.requiresApproval === true || action.kind === "flag_contradiction",
    );
    const actionsTaken = await this.applyNonDestructive(uniqueActions, warnings);
    const endedAt = new Date();

    return {
      run_id: runId,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      files_scanned: changedFiles.length,
      actions_taken: actionsTaken,
      actions_needing_approval: needingApproval,
      merged,
      merge_skipped: skipped,
      warnings,
    };
  }

  private async readHotEntries(): Promise<HotKnowledgeEntry[]> {
    const sourcePaths = new Set<string>();
    const sourceEntries: HotKnowledgeEntry[] = [];

    const notesDir = join(this.knowledge.knowledgeDir, "notes");
    try {
      const files = await readdir(notesDir, { withFileTypes: true });
      for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))) {
        const path = `notes/${file.name}`;
        const content = await readFile(this.safeAbsolutePath(path), "utf8");
        const note = this.notes.parse(content);
        sourceEntries.push({
          path,
          title: note.title,
          tags: [...note.tags],
          created: note.created,
          mtime: note.updated,
          body: note.summary,
          sourceCount: note.sources.length,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    for (const folder of ["advisor/notes", "advisor/sessions"]) {
      const results = await this.knowledge.list(folder);
      for (const result of results) sourcePaths.add(result.path);
    }

    for (const path of sourcePaths) {
      try {
        sourceEntries.push(await this.knowledge.get(path));
      } catch {
        // The file may have disappeared between list() and get().
      }
    }

    return sourceEntries;
  }

  private async applyAction(action: CurationAction): Promise<boolean> {
    switch (action.kind) {
      case "merge":
        return this.applyMerge(action);
      case "flag_stale":
        return this.applyFlagStale(action);
      case "update_moc":
        return this.applyMocLink(action);
      case "fix_orphan":
        return this.applyMocLink(action);
      case "normalize_tag":
        return this.applyNormalizeTag(action);
      case "refresh_hot_md":
        return this.applyHotMd(action);
      case "flag_contradiction":
        return false;
    }
  }

  private async applyMerge(action: MergeCurationAction): Promise<boolean> {
    const targetPath = firstActionString(action, "targetPath", "target");
    const sourcePaths = firstActionStrings(action, "sourcePaths", "sourcePath");
    if (!targetPath || sourcePaths.length === 0) return false;

    if (targetPath.startsWith("notes/")) {
      if (sourcePaths.some((path) => !path.startsWith("notes/"))) return false;
      const targetNote = this.notes.parse(await readFile(this.safeAbsolutePath(targetPath), "utf8"));
      let changed = false;
      for (const sourcePath of sourcePaths) {
        if (sourcePath === targetPath) continue;
        const sourceNote = this.notes.parse(await readFile(this.safeAbsolutePath(sourcePath), "utf8"));
        changed = await this.notes.mergeNotes(targetNote.id, sourceNote.id) || changed;
      }
      return changed;
    }

    const targetAbsolute = this.safeAbsolutePath(targetPath);
    let targetContent = await readFile(targetAbsolute, "utf8");
    let changed = false;

    for (const sourcePath of sourcePaths) {
      if (sourcePath === targetPath) continue;

      const sourceContent = await readFile(this.safeAbsolutePath(sourcePath), "utf8");
      const sourceBody = parseFrontmatterDocument(sourceContent).body.trim();
      const marker = `Merged from ${wikiLink(sourcePath)}`;
      if (!targetContent.includes(marker)) {
        const suppliedContent = action.mergedContent ?? action.content;
        const bodyToAppend = suppliedContent?.trim() || sourceBody;
        const section = bodyToAppend ? `## ${marker}\n\n${bodyToAppend}` : `## ${marker}`;
        targetContent = `${targetContent.trimEnd()}\n\n${section}\n`;
        changed = true;
      }

      const sourceWithStatus = updateFrontmatter(sourceContent, new Map([["status", "merged"]]));
      if (sourceWithStatus !== sourceContent) {
        if (!sourcePath.startsWith("notes/")) await this.writeAtomic(sourcePath, sourceWithStatus);
        changed = true;
      }
    }

    if (!changed) return false;
    await this.writeAtomic(targetPath, targetContent);
    return true;
  }

  private async applyFlagStale(action: FlagStaleCurationAction): Promise<boolean> {
    const path = firstActionString(action, "path");
    if (!path || path.startsWith("notes/")) return false;

    const content = await readFile(this.safeAbsolutePath(path), "utf8");
    const updated = updateFrontmatter(content, new Map([["status", "stale_flagged"]]));
    if (updated === content) return false;
    await this.writeAtomic(path, updated);
    return true;
  }

  private async applyMocLink(action: UpdateMocCurationAction | FixOrphanCurationAction): Promise<boolean> {
    const entryPath = firstActionString(action, "entryPath", "path");
    const mocPath = firstActionString(action, "mocPath") ?? DEFAULT_MOC_PATH;
    const link = firstActionString(action, "link") ?? (entryPath ? wikiLink(entryPath) : undefined);
    if (!link) return false;

    if (mocPath.startsWith("notes/")) {
      if (!entryPath?.startsWith("notes/")) return false;
      const [entryContent, mocContent] = await Promise.all([
        readFile(this.safeAbsolutePath(entryPath), "utf8"),
        readFile(this.safeAbsolutePath(mocPath), "utf8"),
      ]);
      const entryNote = this.notes.parse(entryContent);
      const mocNote = this.notes.parse(mocContent);
      if (entryNote.links.includes(mocNote.id) && mocNote.links.includes(entryNote.id)) return false;
      await this.notes.addLink(entryNote.id, mocNote.id);
      return true;
    }

    const normalizedLink = normalizeWikiLink(link);
    const absolutePath = this.safeAbsolutePath(mocPath);
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      content = "# Home\n";
    }

    if (content.includes(normalizedLink)) return false;
    const updated = `${content.trimEnd()}\n\n- ${normalizedLink}\n`;
    await this.writeAtomic(mocPath, updated);
    return true;
  }

  private async applyNormalizeTag(action: NormalizeTagCurationAction): Promise<boolean> {
    const paths = firstActionStrings(action, "paths", "path");
    const from = firstActionString(action, "from", "oldTag");
    const to = firstActionString(action, "to", "newTag");
    if (paths.length === 0 || !from || !to) return false;

    let changed = false;
    for (const path of paths) {
      if (path.startsWith("notes/")) {
        const note = this.notes.parse(await readFile(this.safeAbsolutePath(path), "utf8"));
        changed = await this.notes.normalizeTags(note.id, from, to) || changed;
        continue;
      }
      const content = await readFile(this.safeAbsolutePath(path), "utf8");
      const document = parseFrontmatterDocument(content);
      const tagsIndex = document.fields.findIndex((field) => /^tags\s*:/i.test(field));
      if (tagsIndex < 0) continue;

      const tags = parseTagList(document.fields[tagsIndex]);
      const normalizedTags = tags.map((tag) => (tag === from || normalizeTag(tag) === normalizeTag(from) ? to : tag));
      const uniqueTags = [...new Set(normalizedTags)];
      if (uniqueTags.join("\u0000") === tags.join("\u0000")) continue;

      const updated = updateFrontmatter(content, new Map([["tags", uniqueTags]]));
      await this.writeAtomic(path, updated);
      changed = true;
    }

    return changed;
  }

  private async applyHotMd(action: RefreshHotMdCurationAction): Promise<boolean> {
    if (typeof action.content !== "string") return false;
    const path = firstActionString(action, "path") ?? DEFAULT_HOT_MD_PATH;
    const absolutePath = this.safeAbsolutePath(path);
    let existing = "";
    try {
      existing = await readFile(absolutePath, "utf8");
    } catch {
      // The generated page may not exist on the first run.
    }

    const content = action.content.endsWith("\n") ? action.content : `${action.content}\n`;
    if (existing === content) return false;
    await this.writeAtomic(path, content);
    return true;
  }

  private findReferencedPaths(entries: KnowledgeEntry[]): Set<string> {
    const targets: LinkTarget[] = entries.map((entry) => ({
      path: entry.path,
      pathWithoutExtension: normalizeLinkTarget(entry.path),
      basenameWithoutExtension: normalizeLinkTarget(basename(entry.path, extname(entry.path))),
      title: normalizeComparableText(entry.title),
    }));
    const referenced = new Set<string>();

    for (const entry of entries) {
      for (const link of extractWikiLinks(entry.body)) {
        const normalized = normalizeLinkTarget(link);
        const matches = targets.filter(
          (target) =>
            target.path !== entry.path &&
            (target.pathWithoutExtension === normalized ||
              target.basenameWithoutExtension === normalized ||
              (target.title.length > 0 && target.title === normalizeComparableText(link))),
        );
        for (const match of matches) referenced.add(match.path);
      }
    }

    return referenced;
  }

  private safeAbsolutePath(relativePath: string): string {
    const root = resolve(this.knowledge.knowledgeDir);
    const absolute = resolve(root, relativePath);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new Error("path_traversal");
    }
    return absolute;
  }

  private async writeAtomic(relativePath: string, content: string): Promise<void> {
    await writeAtomic(this.safeAbsolutePath(relativePath), content);
  }
}

function isCurationAction(value: unknown): value is CurationAction {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  return (CURATION_ACTION_KINDS as readonly string[]).includes(value.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstActionString(action: CurationActionBase, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = action[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstActionStrings(action: CurationActionBase, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = action[key];
    if (Array.isArray(value)) {
      const strings = value
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => item.trim());
      if (strings.length > 0) return [...new Set(strings)];
    }
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return [];
}

function similarityTokens(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9]+/g) ?? []);
  for (const run of normalized.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1) tokens.add(run);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.add(chars[i] + chars[i + 1]);
  }
  return tokens;
}

function sentences(text: string): string[] {
  return text.split(/[。.!?！？\n]+/).map((part) => part.trim()).filter((part) => part.length >= 6);
}

const NEGATION = /ない|ず(?:に)?|禁止|不要|\bnot\b|\bnever\b|n't|\bno\b|\bdon't\b/i;

/** A pair of near-identical sentences of which only one is negated. */
function findContradiction(textA: string, textB: string): [string, string] | undefined {
  for (const x of sentences(textA)) {
    const tokensX = similarityTokens(x);
    for (const y of sentences(textB)) {
      const tokensY = similarityTokens(y);
      const dice = (2 * overlap(tokensX, tokensY)) / (tokensX.size + tokensY.size || 1);
      if (dice >= 0.5 && NEGATION.test(x) !== NEGATION.test(y)) return [x, y];
    }
  }
  return undefined;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

function scoreDuplicate(a: KnowledgeEntry, b: KnowledgeEntry, textA: string, textB: string): DuplicateScores {
  const titleA = similarityTokens(a.title);
  const titleB = similarityTokens(b.title);
  const bodyA = similarityTokens(textA);
  const bodyB = similarityTokens(textB);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const titleSize = titleA.size + titleB.size;
  const title = titleSize === 0 ? 0 : (2 * overlap(titleA, titleB)) / titleSize;
  const bodyShared = overlap(bodyA, bodyB);
  const bodyUnion = bodyA.size + bodyB.size - bodyShared;
  const body = bodyUnion === 0 ? 0 : bodyShared / bodyUnion;
  const tagsB = new Set(b.tags.filter((tag) => !PROVENANCE_TAGS.has(tag)));
  const sharedTags = new Set(a.tags.filter((tag) => tagsB.has(tag))).size;
  const total = 0.5 * title + 0.3 * body + 0.2 * (Math.min(sharedTags, 2) / 2);
  return { title: round(title), body: round(body), shared_tags: sharedTags, total: round(total) };
}

function normalizeComparableText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .toLocaleLowerCase();
}

function entryTimestamp(entry: KnowledgeEntry): number | undefined {
  for (const value of [entry.mtime, entry.created]) {
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

function isIndexLike(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLocaleLowerCase();
  const name = basename(normalized, extname(normalized));
  return name === "hot" || name === "home" || name === "index" || name === "moc" || normalized.endsWith("/moc.md");
}

function firstMeaningfulLine(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((candidate) => candidate.replace(/^\s*[-*]\s+/, "").replace(/^\s*#+\s+/, "").trim())
    .find((candidate) => candidate.length > 0);
  return line ? line.replace(/\s+/g, " ").slice(0, 180) : "";
}

function wikiLink(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "");
  return `[[${normalized}]]`;
}

function normalizeWikiLink(link: string): string {
  const trimmed = link.trim();
  if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) return trimmed;
  return wikiLink(trimmed);
}

function normalizeLinkTarget(value: string): string {
  return value
    .split("|")[0]
    .split("#")[0]
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\.md$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLocaleLowerCase();
}

function extractWikiLinks(body: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  for (const match of body.matchAll(pattern)) {
    if (match[1]) links.push(match[1]);
  }
  return links;
}

function uniqueEntries<T extends KnowledgeEntry>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

function parseFrontmatterDocument(content: string): FrontmatterDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { fields: [], body: content };
  return { fields: match[1].split(/\r?\n/), body: content.slice(match[0].length) };
}

function parseTagList(field: string): string[] {
  const match = /^tags\s*:\s*\[([^\]]*)\]\s*$/i.exec(field);
  if (!match || !match[1].trim()) return [];
  return match[1]
    .split(",")
    .map((tag) => tag.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function updateFrontmatter(content: string, updates: Map<string, string | string[]>): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const fields = match ? match[1].split(/\r?\n/) : [];
  const body = match ? content.slice(match[0].length) : content;

  for (const [key, value] of updates) {
    const rendered = `${key}: ${renderFrontmatterValue(value)}`;
    const index = fields.findIndex((field) => new RegExp(`^${escapeRegExp(key)}\\s*:`, "i").test(field));
    if (index >= 0) {
      fields[index] = rendered;
    } else {
      fields.push(rendered);
    }
  }

  return `---\n${fields.join("\n")}\n---\n${body}`;
}

function renderFrontmatterValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    const rendered = value.map((item) => {
      const escaped = item.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return /[,\s]/.test(item) ? `"${escaped}"` : escaped;
    });
    return `[${rendered.join(", ")}]`;
  }
  return value;
}

function jsonCandidates(stdout: string): string[] {
  const candidates: string[] = [];
  const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of stdout.matchAll(fencedPattern)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  if (stdout.trim()) candidates.push(stdout.trim());

  for (let index = 0; index < stdout.length; index += 1) {
    if (stdout[index] !== "[" && stdout[index] !== "{") continue;
    const end = findJsonEnd(stdout, index);
    if (end >= 0) candidates.push(stdout.slice(index, end + 1));
  }

  return [...new Set(candidates)];
}

function findJsonEnd(value: string, start: number): number {
  const opening = value[start];
  const closing = opening === "[" ? "]" : "}";
  const stack: string[] = [closing];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") {
      stack.push(character === "[" ? "]" : "}");
      continue;
    }
    if (character === "]" || character === "}") {
      if (stack[stack.length - 1] !== character) return -1;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }

  return -1;
}

function deduplicateActions(actions: CurationAction[]): CurationAction[] {
  const seen = new Set<string>();
  const result: CurationAction[] = [];

  for (const action of actions) {
    const key = JSON.stringify(action, (_key, value: unknown) => (Array.isArray(value) ? [...value].sort() : value));
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }

  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
