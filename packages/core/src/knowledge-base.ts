import { readdir, readFile, writeFile, mkdir, stat, lstat, realpath, unlink, rename, link } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, isAbsolute, extname, basename, dirname } from "node:path";
import { isValidUlid } from "@owl/shared";

import {
  resolveKnowledgeFilename,
  slugifyKnowledgeNameOrContent,
} from "./knowledge-naming.js";
import { parseScalar } from "./knowledge-notes.js";

export interface KnowledgeEntry {
  path: string;
  note_id?: string;
  title: string;
  tags: string[];
  created: string;
  mtime: string;
  body: string;
}

export interface KnowledgeSearchResult {
  path: string;
  title: string;
  mtime: string;
  tags: string[];
  snippet: string;
}

export interface KnowledgeCreateInput {
  folder: string;
  filename: string;
  tags: string[];
  body: string;
  metadata?: KnowledgeMetadata;
  /** YYYY-MM-DD; defaults to today. Lets a caller compose the exact text `create` will write. */
  created?: string;
}

/** A string, or an array of strings written as an inline array. */
export type KnowledgeMetadata = Record<string, string | string[]>;

export interface KnowledgeUpdateInput {
  tags?: string[];
  body?: string;
  metadata?: KnowledgeMetadata;
}

const KNOWLEDGE_SUBDIRS = ["global", "projects", "works", "policies", "notes", "research"] as const;
const SNIPPET_LENGTH = 200;

export class KnowledgeBase {
  private readonly rootProvider: () => string;
  private readonly requireRoot: () => boolean;
  private readonly searcher?: (query: string, tags: readonly string[]) => Promise<KnowledgeSearchResult[] | null>;
  private readonly pageGuard?: (content: string) => void;

  /**
   * `requireRoot`: when true, a missing root directory is an error instead of an empty knowledge base (custom locations that went away).
   * `searcher`: answers `search` from the memory index; null means "not ready" and `search` then walks the vault.
   */
  public constructor(owlRoot: string, options: {
    rootDir?: () => string;
    requireRoot?: () => boolean;
    searcher?: (query: string, tags: readonly string[]) => Promise<KnowledgeSearchResult[] | null>;
    /** Called with the full text before create/update writes it; throwing refuses the write (memory_mode pages: validatePage). */
    pageGuard?: (content: string) => void;
  } = {}) {
    this.pageGuard = options.pageGuard;
    this.rootProvider = options.rootDir ?? (() => join(owlRoot, "knowledge"));
    this.requireRoot = options.requireRoot ?? (() => false);
    this.searcher = options.searcher;
  }

  private get rootDir(): string {
    return this.rootProvider();
  }

  public get knowledgeDir(): string {
    return this.rootDir;
  }

  public async resolveFilename(
    subdir: (typeof KNOWLEDGE_SUBDIRS)[number],
    title: string,
    source: { key: string; value: string; kind?: string },
  ): Promise<string>;
  public async resolveFilename(
    subdir: "advisor/conversations",
    title: string,
    source: { key: string; value: string; kind?: string },
  ): Promise<string>;
  public async resolveFilename(
    subdir: (typeof KNOWLEDGE_SUBDIRS)[number] | "advisor/conversations",
    title: string,
    source: { key: string; value: string; kind?: string },
  ): Promise<string> {
    return (await this.resolveFilenameResult(subdir, title, source)).filename;
  }

  public async ensureDirectories(): Promise<void> {
    for (const sub of KNOWLEDGE_SUBDIRS) {
      await mkdir(join(this.rootDir, sub), { recursive: true });
    }
  }

  public async search(query: string, tags: string[] = []): Promise<KnowledgeSearchResult[]> {
    // Resolving the root first keeps the "storage unavailable" rejection; the index must not mask a disconnected vault here.
    const root = this.rootDir;
    if (this.requireRoot()) await stat(root);
    const indexed = await this.searcher?.(query, tags);
    if (indexed) return indexed;
    const files = await this.walkMarkdown(root);
    const results: KnowledgeSearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const absPath of files) {
      const relPath = relative(this.rootDir, absPath);
      const content = await readFile(absPath, "utf8");
      const parsed = parseFrontmatter(content);
      const frontmatterTitle = getNotesFrontmatterTitle(relPath, parsed);
      const fileStat = await stat(absPath);

      if (tags.length > 0) {
        const entryTags = parsed.tags;
        const allMatch = tags.every((t) => entryTags.includes(t));
        if (!allMatch) continue;
      }

      if (query) {
        const nameMatch = basename(relPath, ".md").toLowerCase().includes(queryLower);
        const bodyMatch = parsed.body.toLowerCase().includes(queryLower);
        const tagMatch = parsed.tags.some((t) => t.toLowerCase().includes(queryLower));
        const titleMatch = frontmatterTitle?.toLowerCase().includes(queryLower) ?? false;
        if (!nameMatch && !bodyMatch && !tagMatch && !titleMatch) continue;
      }

      const snippet = extractSnippet(parsed.body, query);
      results.push({
        path: relPath,
        title: getKnowledgeTitle(relPath, parsed),
        mtime: fileStat.mtime.toISOString(),
        tags: parsed.tags,
        snippet,
      });
    }

    results.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return results;
  }

  public async list(folder?: string): Promise<KnowledgeSearchResult[]> {
    const rootDir = this.rootDir;
    const rootRequired = this.requireRoot();
    if (folder && !this.isValidFolder(folder)) throw new Error(`invalid_folder: ${folder}`);
    if (folder && rootRequired) await stat(rootDir);
    const baseDir = folder ? this.safePath(folder) : rootDir;
    try {
      await stat(baseDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && !folder && !rootRequired) return [];
      if (code === "ENOENT" && folder) {
        if (rootRequired) await stat(rootDir);
        return [];
      }
      throw error;
    }
    const files = await this.walkMarkdown(baseDir);
    const results: KnowledgeSearchResult[] = [];

    for (const absPath of files) {
      const relPath = relative(rootDir, absPath);
      const content = await readFile(absPath, "utf8");
      const parsed = parseFrontmatter(content);
      const fileStat = await stat(absPath);
      results.push({
        path: relPath,
        title: getKnowledgeTitle(relPath, parsed),
        mtime: fileStat.mtime.toISOString(),
        tags: parsed.tags,
        snippet: extractSnippet(parsed.body, ""),
      });
    }

    results.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return results;
  }

  /** The valid ULID in the note's `id` frontmatter key, whatever its folder; undefined when absent or malformed. */
  public async frontmatterId(relPath: string): Promise<string | undefined> {
    const parsed = parseFrontmatter(await readFile(await this.safeExistingPath(relPath), "utf8"));
    if (parsed.metadata.id === undefined) return undefined;
    const id = parseScalar(parsed.metadata.id);
    return isValidUlid(id) ? id : undefined;
  }

  public async get(relPath: string): Promise<KnowledgeEntry> {
    const absPath = await this.safeExistingPath(relPath);
    const content = await readFile(absPath, "utf8");
    const parsed = parseFrontmatter(content);
    const fileStat = await stat(absPath);
    const noteId = knowledgeNoteId(relPath, parsed);
    return {
      path: relPath,
      ...(noteId === undefined ? {} : { note_id: noteId }),
      title: getKnowledgeTitle(relPath, parsed),
      tags: parsed.tags,
      created: parsed.created || fileStat.birthtime.toISOString(),
      mtime: fileStat.mtime.toISOString(),
      body: parsed.body,
    };
  }

  public async create(input: KnowledgeCreateInput): Promise<KnowledgeEntry> {
    const folder = input.folder || "global";
    if (!this.isValidFolder(folder)) {
      throw new Error(`invalid_folder: ${folder}`);
    }
    const dir = this.safePath(folder);
    await mkdir(dir, { recursive: true });
    await this.assertContained(await realpath(dir));

    const filename = input.filename.endsWith(".md") ? input.filename : `${input.filename}.md`;
    if (filename !== basename(filename) || filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
      throw new Error("invalid_filename");
    }
    const absPath = this.safePath(folder, filename);
    const relPath = relative(this.rootDir, absPath);

    try {
      const existing = await lstat(absPath);
      if (existing.isSymbolicLink()) throw new Error("path_traversal");
      throw new Error(`already_exists: ${relPath}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("already_exists")) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    const created = input.created ?? new Date().toISOString().slice(0, 10);
    const content = composeEntry({ tags: input.tags, created, metadata: input.metadata, body: input.body });
    this.pageGuard?.(content);

    const tmpPath = `${absPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await link(tmpPath, absPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`already_exists: ${relPath}`);
        }
        throw error;
      }
    } finally {
      try {
        await unlink(tmpPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const fileStat = await stat(absPath);
    return {
      path: relPath,
      title: basename(filename, ".md"),
      tags: input.tags,
      created,
      mtime: fileStat.mtime.toISOString(),
      body: input.body,
    };
  }

  /** Creates the entry, or overwrites its tags/body in place if a file with that folder and filename already exists. */
  public async upsert(input: KnowledgeCreateInput): Promise<KnowledgeEntry> {
    this.assertNotNotesManaged(input.folder || "global");
    try {
      return await this.create(input);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("already_exists")) throw error;
      const folder = input.folder || "global";
      const filename = input.filename.endsWith(".md") ? input.filename : `${input.filename}.md`;
      const relPath = relative(this.rootDir, this.safePath(folder, filename));
      return this.update(relPath, { tags: input.tags, body: input.body });
    }
  }

  public async update(relPath: string, input: KnowledgeUpdateInput): Promise<KnowledgeEntry> {
    this.assertNotNotesManaged(relPath);
    const absPath = await this.safeExistingPath(relPath);
    const existing = await readFile(absPath, "utf8");
    const parsed = parseFrontmatter(existing);

    const newTags = input.tags ?? parsed.tags;
    const newBody = input.body ?? parsed.body;
    const created = parsed.created || new Date().toISOString().slice(0, 10);

    // Values already on disk are kept verbatim; only newly supplied values go through the quoting rule.
    const kept = Object.fromEntries(Object.entries(parsed.metadata).map(([key, raw]) => [key, new RawValue(raw)]));
    const content = composeEntry({ tags: newTags, created, metadata: { ...kept, ...input.metadata }, body: newBody });
    this.pageGuard?.(content);

    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(tmpPath, absPath);

    const fileStat = await stat(absPath);
    return {
      path: relPath,
      title: parsed.title || basename(relPath, ".md"),
      tags: newTags,
      created,
      mtime: fileStat.mtime.toISOString(),
      body: newBody,
    };
  }

  public async remove(relPath: string): Promise<void> {
    this.assertNotNotesManaged(relPath);
    const absPath = await this.safeExistingPath(relPath);
    await unlink(absPath);
  }

  public async upsertBySource(input: {
    folder: string;
    title: string;
    source: { key: string; value: string; kind?: string };
    body: string;
    nameFallback?: string;
    tags: string[];
    metadata?: KnowledgeMetadata;
  }): Promise<KnowledgeEntry> {
    this.assertNotNotesManaged(input.folder);
    const metadata: KnowledgeMetadata = { ...input.metadata, [input.source.key]: input.source.value };
    if (input.source.kind === undefined) delete metadata.kind;
    else metadata.kind = input.source.kind;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const resolved = await this.resolveFilenameResult(input.folder, input.title, input.source, input.nameFallback);
      const relPath = `${input.folder}/${resolved.filename}`;
      if (resolved.existing) {
        return this.update(relPath, { body: input.body, tags: input.tags, metadata });
      }
      try {
        return await this.create({
          folder: input.folder,
          filename: resolved.filename,
          body: input.body,
          tags: input.tags,
          metadata,
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("already_exists")) throw error;
      }
    }

    throw new Error("filename_conflict_limit_exceeded");
  }

  private safePath(...segments: string[]): string {
    if (segments.some((segment) => isAbsolute(segment) || segment.includes("\\"))) {
      throw new Error("path_traversal");
    }
    const root = resolve(this.rootDir);
    const resolved = resolve(root, ...segments);
    const rel = relative(root, resolved);
    if (rel === ".." || rel.startsWith(`..${requirePathSeparator()}`) || isAbsolute(rel)) {
      throw new Error("path_traversal");
    }
    return resolved;
  }

  private isValidFolder(folder: string): boolean {
    const parts = folder.split("/");
    return parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== "..")
      && ((KNOWLEDGE_SUBDIRS as readonly string[]).includes(parts[0]) || parts[0] === "advisor");
  }

  private assertNotNotesManaged(path: string): void {
    const absolutePath = this.safePath(path);
    const normalizedPath = relative(resolve(this.rootDir), absolutePath);
    if (normalizedPath === "notes" || normalizedPath.startsWith(`notes${requirePathSeparator()}`)) {
      throw new Error(`notes_managed: ${normalizedPath}`);
    }
  }

  private async resolveFilenameResult(
    subdir: string,
    title: string,
    source: { key: string; value: string; kind?: string },
    nameFallback?: string,
  ): Promise<{ filename: string; existing: boolean }> {
    if (!this.isValidFolder(subdir)) throw new Error(`invalid_folder: ${subdir}`);
    const slug = slugifyKnowledgeNameOrContent(title, nameFallback);
    return resolveKnowledgeFilename(this.safePath(subdir), slug, source);
  }

  private async walkMarkdown(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          const sub = await this.walkMarkdown(full);
          results.push(...sub);
        } else if (entry.isFile() && extname(entry.name) === ".md") {
          results.push(full);
        }
      }
    } catch (error) {
      // A missing sub-directory just has no notes yet; an unreadable root means the storage is gone.
      if (resolve(dir) === resolve(this.rootDir)) throw error;
    }
    return results;
  }

  private async safeExistingPath(relPath: string): Promise<string> {
    const candidate = this.safePath(relPath);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error("path_traversal");
    const resolved = await realpath(candidate);
    await this.assertContained(resolved);
    return resolved;
  }

  private async assertContained(candidate: string): Promise<void> {
    const root = await realpath(this.rootDir);
    const rel = relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${requirePathSeparator()}`) || isAbsolute(rel)) throw new Error("path_traversal");
  }
}

function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

interface ParsedFrontmatter {
  tags: string[];
  created: string;
  title: string;
  body: string;
  metadata: Record<string, string>;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = { tags: [], created: "", title: "", body: content, metadata: {} };
  if (!content.startsWith("---\n")) return result;

  const endIndex = content.indexOf("\n---\n", 4);
  if (endIndex < 0) return result;

  const frontmatter = content.slice(4, endIndex);
  result.body = content.slice(endIndex + 5);

  for (const line of frontmatter.split("\n")) {
    const tagsMatch = line.match(/^tags:\s*\[(.+)\]$/);
    if (tagsMatch) {
      result.tags = tagsMatch[1].split(",").map((t) => t.trim().replace(/^['"]|['"]$/g, ""));
    }
    const createdMatch = line.match(/^created:\s*(.+)$/);
    if (createdMatch) {
      result.created = createdMatch[1].trim();
    }
    const metadataMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (metadataMatch && metadataMatch[1] !== "tags" && metadataMatch[1] !== "created") {
      result.metadata[metadataMatch[1]] = metadataMatch[2];
    }
  }

  const titleMatch = result.body.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    result.title = titleMatch[1].trim();
  }

  return result;
}

function getNotesFrontmatterTitle(relPath: string, parsed: ParsedFrontmatter): string | undefined {
  if (relPath.split(/[\\/]/u, 1)[0] !== "notes") return undefined;
  const title = parsed.metadata.title?.trim();
  if (!title) return undefined;
  return parseScalar(title);
}

function knowledgeNoteId(relPath: string, parsed: ParsedFrontmatter): string | undefined {
  if (relPath.split(/[\\/]/u, 1)[0] !== "notes" || parsed.metadata.id === undefined) return undefined;
  const id = parseScalar(parsed.metadata.id);
  return isValidUlid(id) ? id : undefined;
}

function getKnowledgeTitle(relPath: string, parsed: ParsedFrontmatter): string {
  const filenameTitle = basename(relPath, ".md");
  if (relPath.split(/[\\/]/u, 1)[0] === "notes") {
    return getNotesFrontmatterTitle(relPath, parsed) || filenameTitle;
  }
  return parsed.title || filenameTitle;
}

class RawValue {
  public constructor(public readonly text: string) {}
}

/** The exact text `create` writes for an entry. */
export function composeEntry(input: { tags: string[]; created: string; metadata?: Record<string, string | string[] | RawValue>; body: string }): string {
  return `${buildFrontmatter(input.tags, input.created, input.metadata)}\n${input.body}`;
}

// Quote when reading the value back would not return it unchanged: parseScalar differs, the value is
// empty or padded with whitespace (the reader trims), or (array items only) it holds a flow-array
// delimiter or quote that splitFlowArray would split on.
function frontmatterScalar(raw: string, inArray: boolean): string {
  const value = raw.replace(/[\r\n]+/gu, " ");
  let plain: boolean;
  try {
    plain = parseScalar(value) === value;
  } catch {
    plain = false;
  }
  if (plain && value !== "" && value === value.trim() && !(inArray && /[,"'\[\]]/u.test(value))) return value;
  return JSON.stringify(value);
}

function buildFrontmatter(tags: string[], created: string, metadata: Record<string, string | string[] | RawValue> = {}): string {
  const tagStr = tags.map((t) => (t.includes(",") || t.includes(" ") ? `"${t}"` : t)).join(", ");
  const metadataLines = Object.entries(metadata).map(([key, value]) => {
    if (!/^[A-Za-z_][\w-]*$/u.test(key)) throw new Error("invalid_metadata_key");
    if (value instanceof RawValue) return `${key}: ${value.text.replace(/[\r\n]+/gu, " ")}`;
    if (Array.isArray(value)) return `${key}: [${value.map((item) => frontmatterScalar(item, true)).join(", ")}]`;
    return `${key}: ${frontmatterScalar(value, false)}`;
  });
  return `---\ntags: [${tagStr}]\ncreated: ${created}\n${metadataLines.length > 0 ? `${metadataLines.join("\n")}\n` : ""}---\n`;
}

export function extractSnippet(body: string, query: string): string {
  const clean = body.replace(/^#+\s+.+$/gm, "").trim();
  if (!query) return clean.slice(0, SNIPPET_LENGTH);

  const lower = clean.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return clean.slice(0, SNIPPET_LENGTH);

  const start = Math.max(0, idx - 40);
  return (start > 0 ? "…" : "") + clean.slice(start, start + SNIPPET_LENGTH);
}
