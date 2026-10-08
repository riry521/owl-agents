import { readdir, readFile, writeFile, mkdir, stat, lstat, realpath, unlink, rename, link } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, isAbsolute, extname, basename, dirname } from "node:path";
import { isValidUlid } from "@owl/shared";

import {
  resolveKnowledgeFilename,
  slugifyKnowledgeNameOrContent,
} from "./knowledge-naming.js";
import { parseScalar, splitFlowArray } from "./knowledge-notes.js";

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
    if (parsed.unsupported) throw new Error(`unsupported_frontmatter: ${relPath}`);

    // Tags not being changed are written back as the lines on disk, not as the parsed values.
    const newTags = input.tags ?? parsed.tags;
    const writtenTags = input.tags ?? (parsed.rawTags === undefined ? parsed.tags : new RawValue(parsed.rawTags));
    // composeEntry puts a blank line before the body, so drop the one read back with it.
    const newBody = input.body ?? parsed.body.replace(/^\n/u, "");
    const created = parsed.created || new Date().toISOString().slice(0, 10);

    // Values already on disk are kept verbatim; only newly supplied values go through the quoting rule.
    const kept = Object.fromEntries(Object.entries(parsed.rawMetadata).map(([key, raw]) => [key, new RawValue(raw)]));
    const content = composeEntry({ tags: writtenTags, created, metadata: { ...kept, ...input.metadata }, body: newBody });
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
  /** Each metadata key's lines as written, including continuation lines such as block lists. */
  rawMetadata: Record<string, string>;
  /** The tags key line and the lines under it as written; undefined when the file has no tags key. */
  rawTags?: string;
  /** The file has frontmatter whose lines `update` could not write back. */
  unsupported: boolean;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {
    tags: [], created: "", title: "", body: content, metadata: {}, rawMetadata: {}, unsupported: /^---\r?\n/u.test(content),
  };
  if (!content.startsWith("---\n")) return result;

  const endIndex = content.indexOf("\n---\n", 4);
  if (endIndex < 0) return result;

  result.unsupported = false;
  const frontmatter = content.slice(4, endIndex);
  result.body = content.slice(endIndex + 5);

  // A line that does not start a key belongs to the key above it (block list items, block scalars).
  let owner: string | undefined;
  for (const line of frontmatter.split("\n")) {
    const keyMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (!keyMatch) {
      if (owner === "tags") result.rawTags += `\n${line}`;
      const tagItem = owner === "tags" ? line.match(/^\s*-\s+(.+)$/) : null;
      if (tagItem) {
        const strict = strictTagScalar(tagItem[1]);
        if (strict === undefined) result.unsupported = true;
        result.tags.push(strict ?? tagItem[1].trim());
      }
      else if (owner !== undefined && owner !== "tags" && owner !== "created") result.rawMetadata[owner] += `\n${line}`;
      else if (line.trim() !== "") result.unsupported = true;
      continue;
    }
    const [, key, value] = keyMatch;
    owner = key;
    // update rewrites tags and created from their parsed values, so YAML node syntax there would be lost.
    if (key === "created" && hasYamlNodeSyntax(value)) result.unsupported = true;
    if (key === "tags") {
      result.rawTags = line;
      const strict = strictTags(value);
      if (strict === undefined) result.unsupported = true;
      result.tags = strict ?? parseTags(value.trim());
    }
    else if (key === "created") result.created = value.trim();
    else {
      result.metadata[key] = value;
      result.rawMetadata[key] = line;
    }
  }

  const titleMatch = result.body.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    result.title = titleMatch[1].trim();
  }

  return result;
}

// Anchors (&), aliases (*), tags (!) and block scalars (|, >) at the start of a value.
function hasYamlNodeSyntax(value: string): boolean {
  return /^[&*!|>]/u.test(value.trim());
}

// `update` rewrites tags, so only plain or quoted string scalars are accepted; a mapping, nested array,
// node syntax or an unquoted bracket is undefined here and makes the file unsupported rather than guessed at.
// Not a YAML parser on purpose: widening it has kept turning up new ways to corrupt tags.
function strictTagScalar(raw: string): string | undefined {
  const item = raw.trim();
  try {
    if (item === "" || /^[&*!|>\[\]{}]/u.test(item) || /^[-?:](\s|$)/u.test(item)) return undefined;
    if (item.startsWith('"') || item.startsWith("'")) {
      const q = item[0];
      let end = -1;
      for (let i = 1; i < item.length && end < 0; i += 1) {
        if (q === '"' && item[i] === "\\") i += 1;
        else if (item[i] === q) {
          if (q === "'" && item[i + 1] === "'") i += 1;
          else end = i;
        }
      }
      // Anything after the closing quote other than a comment is more syntax than a single string.
      if (end < 0 || !/^(\s+#.*)?$/u.test(item.slice(end + 1))) return undefined;
      return parseScalar(item.slice(0, end + 1));
    }
    return /[\[\]{}]|:(\s|$)|\s#/u.test(item) ? undefined : item;
  } catch {
    return undefined;
  }
}

function strictTags(raw: string): string[] | undefined {
  const value = raw.trim();
  if (value === "") return [];
  if (!value.startsWith("[")) {
    const tag = strictTagScalar(value);
    return tag === undefined ? undefined : [tag];
  }
  // The closing bracket is the first one outside quotes; only blank or a comment may follow it.
  let quote = "";
  let end = -1;
  for (let i = 1; i < value.length && end < 0; i += 1) {
    const c = value[i];
    if (quote) {
      if (c === "\\" && quote === '"') i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && /\s/u.test(value[i - 1])) return undefined;
    else if (c === "]") end = i;
  }
  if (end < 0 || !/^(\s+#.*)?$/u.test(value.slice(end + 1))) return undefined;
  const inner = value.slice(1, end).trim();
  if (inner === "") return [];
  try {
    const tags = splitFlowArray(inner).map(strictTagScalar);
    return tags.every((tag) => tag !== undefined) ? tags : undefined;
  } catch {
    return undefined;
  }
}

// Files written before tags were quoted per item may not split cleanly; those fall back to a plain comma split.
function parseTags(value: string): string[] {
  // Text after the closing bracket is a trailing comment.
  const inner = value.startsWith("[") && value.includes("]") ? value.slice(1, value.lastIndexOf("]")).trim() : value;
  if (inner === "") return [];
  try {
    return splitFlowArray(inner).map(parseScalar);
  } catch {
    return inner.split(",").map((t) => t.trim().replace(/^['"]|['"]$/g, ""));
  }
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
export function composeEntry(input: { tags: string[] | RawValue; created: string; metadata?: Record<string, string | string[] | RawValue>; body: string }): string {
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
  // A leading &, *, !, | or > would make `update` reject the file as unsupported YAML node syntax.
  if (plain && value !== "" && value === value.trim() && !/^[&*!|>]/u.test(value) && !(inArray && (/[,"'\[\]]/u.test(value) || strictTagScalar(value) !== value))) return value;
  return JSON.stringify(value);
}

function buildFrontmatter(tags: string[] | RawValue, created: string, metadata: Record<string, string | string[] | RawValue> = {}): string {
  const tagsLine = tags instanceof RawValue ? tags.text : `tags: [${tags.map((t) => frontmatterScalar(t, true)).join(", ")}]`;
  const metadataLines = Object.entries(metadata).map(([key, value]) => {
    // Kept lines are copied from the file as they are, continuation lines included.
    if (value instanceof RawValue) return value.text;
    if (!/^[A-Za-z_][\w-]*$/u.test(key)) throw new Error("invalid_metadata_key");
    if (Array.isArray(value)) return `${key}: [${value.map((item) => frontmatterScalar(item, true)).join(", ")}]`;
    return `${key}: ${frontmatterScalar(value, false)}`;
  });
  return `---\n${tagsLine}\ncreated: ${created}\n${metadataLines.length > 0 ? `${metadataLines.join("\n")}\n` : ""}---\n`;
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
