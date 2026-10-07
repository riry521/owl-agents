import { isValidUlid } from "@owl/shared";

import { PROJECT_OVERVIEW_FILE_PATTERN } from "../project-overview.js";
import { PAGE_KINDS } from "./page-format.js";
import { MEMORY_TYPES, NON_MEMORY_TYPES, rawPathPrefixes, type MemoryNoteRow, type MemoryNoteStatus, type MemoryNoteType } from "./memory-types.js";

export interface ParsedLink {
  /** Content of `[[…]]` without the alias and the #heading. */
  readonly raw: string;
  readonly kind: "ulid" | "path" | "filename";
  /** ULID, normalized path (with .md) or filename (without .md). */
  readonly target: string;
}

export interface ParsedMemoryNote {
  readonly row: Omit<MemoryNoteRow, "mtime" | "sha256" | "size_bytes">;
  /** Body without the real (inner, when doubled) frontmatter. */
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, string | readonly string[]>>;
  readonly links: readonly ParsedLink[];
}

type Frontmatter = Record<string, string | string[]>;

const ALL_TYPES: readonly string[] = [...MEMORY_TYPES, ...NON_MEMORY_TYPES];
const STATUSES: readonly string[] = ["active", "dormant", "superseded", "archived", "draft"];
const SUMMARY_LENGTH = 200;

export function normalizeVaultPath(relativePath: string): string {
  return relativePath.normalize("NFC").replace(/\\/gu, "/").replace(/^(\.\/)+/u, "");
}

export function memoryIdForPath(relativePath: string): string {
  return `path:${normalizeVaultPath(relativePath)}`;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try { const parsed: unknown = JSON.parse(v); if (typeof parsed === "string") return parsed; } catch { /* fall through */ }
    return v.slice(1, -1);
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/gu, "'");
  return v;
}

function splitInline(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote = "";
  for (const ch of value) {
    if (quote) { current += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ",") { items.push(current); current = ""; continue; }
    current += ch;
  }
  items.push(current);
  return items.map(unquote).filter((item) => item.length > 0);
}

/** Splits a leading `---\n…\n---` block off `text`. Returns null when there is none. */
function splitBlock(text: string): { block: string; rest: string } | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const after = text.slice(end + 4);
  if (after !== "" && !after.startsWith("\n")) return null;
  return { block: text.slice(4, end + 1), rest: after.slice(1) };
}

function parseBlock(block: string): Frontmatter {
  const result: Frontmatter = {};
  let listKey: string | null = null;
  for (const line of block.split("\n")) {
    const item = /^\s+-\s+(.*)$/u.exec(line);
    if (item && listKey) { (result[listKey] as string[]).push(unquote(item[1])); continue; }
    const kv = /^([\w-]+):\s*(.*)$/u.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    if (value === "") { result[kv[1]] = []; listKey = kv[1]; continue; }
    listKey = null;
    result[kv[1]] = value.startsWith("[") && value.endsWith("]") ? splitInline(value.slice(1, -1)) : unquote(value);
  }
  for (const [key, value] of Object.entries(result)) if (Array.isArray(value) && value.length === 0) result[key] = "";
  return result;
}

const scalar = (fm: Frontmatter, key: string): string => {
  const value = fm[key];
  return (Array.isArray(value) ? value.join(", ") : value ?? "").trim();
};
const list = (fm: Frontmatter, key: string): string[] => {
  const value = fm[key];
  return Array.isArray(value) ? value : value ? splitInline(value) : [];
};

function stripLinkTarget(inner: string): string {
  return inner.split("|")[0].split("#")[0].trim().normalize("NFC");
}

function extractLinks(body: string, fm: Frontmatter): ParsedLink[] {
  const seen = new Map<string, ParsedLink>();
  const add = (raw: string): void => {
    if (!raw || seen.has(raw)) return;
    if (isValidUlid(raw)) seen.set(raw, { raw, kind: "ulid", target: raw });
    else if (raw.includes("/")) seen.set(raw, { raw, kind: "path", target: normalizeVaultPath(/\.md$/u.test(raw) ? raw : `${raw}.md`) });
    else seen.set(raw, { raw, kind: "filename", target: raw.replace(/\.md$/u, "") });
  };
  const texts = [body, ...Object.values(fm).map((v) => (Array.isArray(v) ? v.join("\n") : v))];
  for (const text of texts) for (const m of text.matchAll(/\[\[([^\]\n]+)\]\]/gu)) add(stripLinkTarget(m[1]));
  for (const item of list(fm, "links")) {
    const bare = item.replace(/^\[\[|\]\]$/gu, "");
    if (isValidUlid(bare)) add(bare);
  }
  return [...seen.values()];
}

export function inferMemoryType(relativePath: string, _fm: Record<string, unknown>, body: string): { type: MemoryNoteType; status?: MemoryNoteStatus } {
  const path = normalizeVaultPath(relativePath);
  const name = path.split("/").pop() ?? path;
  if (path === "north-star.md") return { type: "north-star" };
  if (PROJECT_OVERVIEW_FILE_PATTERN.test(name)) return { type: "overview" };
  if (path === "Home.md" || path === "hot.md" || path.startsWith("advisor/")) return { type: "log" };
  if (rawPathPrefixes().some((prefix) => path.startsWith(prefix))) return { type: "raw" };
  if (path.startsWith("archive/") || path.startsWith("policies/")) return { type: "reference", status: "archived" };
  if (path.startsWith("works/")) return { type: "lesson" };
  if (path.startsWith("reflections/")) return { type: "reflection" };
  const folder = /^memory\/([a-z]+)s\//u.exec(path)?.[1];
  if (folder && (MEMORY_TYPES as readonly string[]).includes(folder)) return { type: folder as MemoryNoteType };
  if (path.startsWith("reference/")) return { type: "reference" };
  const count = (tag: string): number => body.split(`[${tag}]`).length - 1;
  const [d, l, f] = [count("decision"), count("pitfall"), count("fact")];
  if (d + l + f === 0) return { type: "lesson" };
  return { type: d >= l && d >= f ? "decision" : "lesson" };
}

function deriveSummary(body: string): string {
  const section = /^##\s+(?:Summary|要点)\s*$/mu.exec(body);
  let text: string;
  if (section) {
    text = body.slice(section.index + section[0].length).split(/\n##?\s/u)[0].trim().split(/\n\s*\n/u)[0] ?? "";
  } else {
    text = body.split(/\n\s*\n/u).map((p) => p.trim()).find((p) => p !== "" && !p.startsWith("#")) ?? "";
  }
  return text.replace(/\s+/gu, " ").trim().slice(0, SUMMARY_LENGTH);
}

export function parseMemoryNote(relativePath: string, content: string, stat: { mtimeMs: number }): ParsedMemoryNote {
  const path = normalizeVaultPath(relativePath);
  const filename = (path.split("/").pop() ?? path).replace(/\.md$/u, "");
  const reasons: string[] = [];
  const text = content.replace(/\r\n/gu, "\n");
  const outer = splitBlock(text);
  let fm: Frontmatter = {};
  let body = text;
  if (outer) {
    fm = parseBlock(outer.block);
    body = outer.rest;
    const trimmed = body.replace(/^\s*\n/u, "");
    const inner = splitBlock(trimmed);
    if (inner) { fm = { ...fm, ...parseBlock(inner.block) }; body = inner.rest; }
    else if (trimmed.startsWith("---\n")) reasons.push("inner_frontmatter_parse_error");
  } else reasons.push("no_frontmatter");

  const inferred = inferMemoryType(path, fm, body);
  const fmType = scalar(fm, "type");
  const typeFromFm = ALL_TYPES.includes(fmType);
  const type = (typeFromFm ? fmType : inferred.type) as MemoryNoteType;
  const fmStatus = scalar(fm, "status");
  const status = (STATUSES.includes(fmStatus) ? fmStatus : inferred.status ?? "active") as MemoryNoteStatus;
  const fmSummary = scalar(fm, "summary");
  const title = scalar(fm, "title") || /^#\s+(.+)$/mu.exec(body)?.[1].trim() || filename;
  // The four page kinds are checked by validatePage (page-format.ts), not by the legacy keys.
  if (outer && !(PAGE_KINDS as readonly string[]).includes(fmType)) {
    if (!typeFromFm) reasons.push("missing:type");
    if (!fmSummary) reasons.push("missing:summary");
    if (!STATUSES.includes(fmStatus)) reasons.push("missing:status");
  }
  const overviewId = PROJECT_OVERVIEW_FILE_PATTERN.exec(`${filename}.md`)?.[1];
  const pageProjectId = scalar(fm, "project_id");
  const projectIds = list(fm, "project_ids").concat(overviewId ? [overviewId] : [], pageProjectId ? [pageProjectId] : []);
  const importanceRaw = Number.parseInt(scalar(fm, "importance"), 10);
  const importance = type === "north-star" ? 5 : importanceRaw >= 1 && importanceRaw <= 5 ? importanceRaw : 3;
  const supersededBy = scalar(fm, "superseded_by");
  return {
    row: {
      id: scalar(fm, "id") || memoryIdForPath(path), path, filename: filename.normalize("NFC"), title,
      type, type_source: typeFromFm ? "frontmatter" : "inferred",
      status, summary: fmSummary || deriveSummary(body), summary_source: fmSummary ? "frontmatter" : "derived",
      importance, confidence: scalar(fm, "confidence") || null, scope: scalar(fm, "scope") === "project" ? "project" : "global",
      project_ids: projectIds, tags: list(fm, "tags"),
      origin_by: scalar(fm, "origin_by") || null, origin_at: scalar(fm, "origin_at") || null, origin_ref: scalar(fm, "origin_ref") || null,
      created: scalar(fm, "created") || null,
      updated: scalar(fm, "updated") || scalar(fm, "created") || new Date(stat.mtimeMs).toISOString().slice(0, 10),
      valid: reasons.length === 0, invalid_reasons: reasons,
      superseded_by: supersededBy ? stripLinkTarget(supersededBy.replace(/^\[\[|\]\]$/gu, "")) : null,
    },
    body,
    frontmatter: fm,
    links: extractLinks(body, fm),
  };
}
