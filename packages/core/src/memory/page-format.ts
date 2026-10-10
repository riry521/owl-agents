import { createHash } from "node:crypto";

import { isValidUlid } from "@owl/shared";

/** Parser, renderer and validator for the four page templates (design §2, §6). Flat frontmatter only. */

export type PageKind = "theme" | "project-index" | "work-log" | "clipping" | "conversation-log";
export type StoredKind = PageKind | "legacy" | "archive";
export type FrontmatterValue = string | number | boolean | null | readonly string[];

export interface PageSection {
  /** Heading without the "## ". */
  readonly heading: string;
  /** Lines after the heading up to the next "## ", without trailing blank lines. */
  readonly lines: readonly string[];
}
export interface ParsedPage {
  readonly kind: PageKind | null;
  readonly frontmatter: Readonly<Record<string, FrontmatterValue>>;
  readonly frontmatter_order: readonly string[];
  readonly comment: string | null;
  readonly title: string | null;
  readonly preamble: readonly string[];
  readonly sections: readonly PageSection[];
}
export interface PageIssue {
  readonly code:
    | "missing_frontmatter" | "missing_key" | "invalid_value" | "unknown_kind"
    | "missing_section" | "unexpected_section" | "section_order" | "section_over_lines"
    | "unresolved_link" | "ulid_link" | "over_budget" | "secret_pattern" | "owl_new_left";
  readonly message: string;
  readonly key?: string;
  readonly section?: string;
}
export interface ValidateOptions {
  /** `owl`: rejects (errors). `owner`: hand edit, structural problems make the index row invalid. */
  readonly writer: "owl" | "owner";
  readonly resolveLink?: (target: string) => boolean;
  /** Librarian output: `owl:new` marks must be gone and the size limit is enforced. */
  readonly require_integrated?: boolean;
}
export interface ValidateResult {
  readonly ok: boolean;
  readonly errors: readonly PageIssue[];
  readonly warnings: readonly PageIssue[];
  readonly tokens: number;
}

export const PAGE_KINDS: readonly PageKind[] = ["theme", "project-index", "work-log", "clipping", "conversation-log"];
/** Kinds that search shows; conversation logs are opened by path only. */
export const SEARCHABLE_PAGE_KINDS: readonly PageKind[] = PAGE_KINDS.filter((k) => k !== "conversation-log");

export const PAGE_LIMITS = {
  index_tokens: 1200, advisor_first_tokens: 1600, advisor_diff_tokens: 300,
  theme_tokens: 3000, theme_soft_tokens: 2000, clipping_tokens: 6000,
  clipping_open_tokens: 1500, search_tokens: 800, search_items: 5,
  mcp_tool_tokens: 350, librarian_input_tokens: 5500, librarian_output_tokens: 3500,
  librarian_run_pages: 20, librarian_run_tokens: 100000,
} as const;

/** The heading of the theme section Core writes on its own (audit lines); the model never points at it. */
export const UPDATES_SECTION = "更新履歴";
export const THEME_SECTIONS = ["概要", "決まりごと", "落とし穴", "手順", "関連ページ", UPDATES_SECTION] as const;
export const INDEX_SECTIONS = ["概要", "必読（決まりごと・落とし穴）", "テーマ", "共通テーマ"] as const;
export const WORK_LOG_SECTIONS = ["何をしたか", "学んだこと", "反映先"] as const;
export const CLIPPING_SECTIONS = ["出典", "要点", "使いどころ", "関係する Project"] as const;
/** A source label in a line's trailing （…）: a Work (W123) or a conversation log (会話2026-10-04-1). */
export const SOURCE_LABEL = "(?:W\\d+|会話\\d{4}-\\d{2}-\\d{2}-\\d+)";
export const CONVERSATION_LOG_SECTIONS = ["話したこと", "決まったこと", "学んだこと", "反映先", "原文"] as const;

interface Template {
  readonly sections: readonly string[];
  readonly optional: readonly string[];
  /** Max list lines per section (`### ` count for 手順). */
  readonly lines: Readonly<Record<string, number>>;
  readonly tokens: number;
}
const TEMPLATES: Readonly<Record<PageKind, Template>> = {
  theme: { sections: THEME_SECTIONS, optional: [], tokens: PAGE_LIMITS.theme_tokens, lines: { 概要: 8, 決まりごと: 12, 落とし穴: 15, 手順: 3, 関連ページ: 8, 更新履歴: 8 } },
  "project-index": { sections: INDEX_SECTIONS, optional: [], tokens: PAGE_LIMITS.index_tokens, lines: { "必読（決まりごと・落とし穴）": 10, テーマ: 20, 共通テーマ: 6 } },
  "work-log": { sections: WORK_LOG_SECTIONS, optional: [], tokens: Infinity, lines: { 何をしたか: 6, 学んだこと: 12 } },
  clipping: { sections: CLIPPING_SECTIONS, optional: ["使いどころ"], tokens: PAGE_LIMITS.clipping_tokens, lines: { 出典: 3, 要点: 7, "関係する Project": 3 } },
  "conversation-log": { sections: CONVERSATION_LOG_SECTIONS, optional: ["原文"], tokens: Infinity, lines: {} },
};

/** ASCII code points count 1/4, everything else 1 (after NFKC). */
export function estimatePageTokens(text: string): number {
  let total = 0;
  for (const character of text.normalize("NFKC")) total += character.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  return Math.ceil(total);
}

const lf = (text: string): string => text.replace(/\r\n?/gu, "\n");
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/u;

function splitFrontmatter(text: string): { block: string; rest: string } | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const after = text.slice(end + 4);
  if (after !== "" && !after.startsWith("\n")) return null;
  return { block: text.slice(4, end + 1), rest: after.slice(1) };
}

/** Same quoting rules as knowledge-notes `parseScalar`, but a malformed quote stays literal instead of throwing. */
function parseScalar(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch { /* keep literal */ }
  } else if (value.startsWith("'") && value.length >= 2 && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

/** Splits on commas outside quotes. */
function splitFlowArray(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quote) {
      if (quote === '"' && c === "\\") i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ",") { items.push(value.slice(start, i).trim()); start = i + 1; }
  }
  items.push(value.slice(start).trim());
  return items.filter((item) => item !== "");
}

function parseValue(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : splitFlowArray(inner).map(parseScalar);
  }
  if (value.startsWith('"') || value.startsWith("'")) return parseScalar(value);
  if (/^-?\d+$/u.test(value) && String(Number(value)) === value) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/** Quotes only what would not parse back to the same value, or would break onto another line (a new key). */
function renderValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === "" || /[,"'\n]|^\s|\s$/u.test(item) ? JSON.stringify(item) : item)).join(", ")}]`;
  if (value === null) return "";
  if (typeof value === "string" && value !== "" && (/[\r\n]/u.test(value) || parseValue(value) !== value)) return JSON.stringify(value);
  return String(value);
}

/** Never throws. A doubled frontmatter uses the outer block; the inner one stays in the body. */
export function parsePage(text: string): ParsedPage {
  const source = lf(text);
  const split = splitFrontmatter(source);
  const frontmatter: Record<string, FrontmatterValue> = {};
  const order: string[] = [];
  if (split) {
    for (const line of split.block.split("\n")) {
      const kv = /^([\w-]+):[ \t]*(.*)$/u.exec(line);
      if (!kv) continue;
      if (!(kv[1] in frontmatter)) order.push(kv[1]);
      frontmatter[kv[1]] = parseValue(kv[2]);
    }
  }
  const type = frontmatter.type;
  const kind = typeof type === "string" && (PAGE_KINDS as readonly string[]).includes(type) ? (type as PageKind) : null;

  let comment: string | null = null;
  let title: string | null = null;
  const preamble: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  let fenced: string | null = null;
  let seenTitle = false;
  for (const line of (split ? split.rest : source).split("\n")) {
    const fence = FENCE.exec(line);
    if (fence) {
      if (fenced === null) fenced = fence[1];
      else if (fence[1][0] === fenced[0] && fence[1].length >= fenced.length && fence[2].trim() === "") fenced = null;
    }
    const heading = fenced !== null ? null : /^## (.*)$/u.exec(line);
    if (heading) { sections.push({ heading: heading[1].trim(), lines: [] }); continue; }
    if (sections.length > 0) { sections[sections.length - 1].lines.push(line); continue; }
    if (!seenTitle && fenced === null) {
      if (comment === null && title === null && /^<!--.*-->$/u.test(line.trim())) { comment = line.trim(); continue; }
      const h1 = /^# (.*)$/u.exec(line);
      if (h1) { title = h1[1].trim(); seenTitle = true; continue; }
    }
    preamble.push(line);
  }
  const trim = (lines: string[]): string[] => {
    let start = 0;
    let end = lines.length;
    while (end > start && lines[end - 1].trim() === "") end -= 1;
    while (start < end && lines[start].trim() === "") start += 1;
    return lines.slice(start, end);
  };
  return {
    kind, frontmatter, frontmatter_order: order, comment, title,
    preamble: trim(preamble),
    sections: sections.map((s) => {
      let end = s.lines.length;
      while (end > 0 && s.lines[end - 1].trim() === "") end -= 1;
      return { heading: s.heading, lines: s.lines.slice(0, end) };
    }),
  };
}

/** LF, one trailing newline. */
/** Sets `key: value` in the frontmatter by editing that one line (or adding it before the closing `---`). */
export function setFrontmatter(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const end = lines.findIndex((line, i) => i > 0 && line.replace(/\r$/u, "") === "---");
  if (lines[0]?.replace(/\r$/u, "") !== "---" || end < 0) return text;
  const cr = lines[end].endsWith("\r") ? "\r" : "";
  const at = lines.findIndex((line, i) => i > 0 && i < end && line.startsWith(`${key}:`));
  if (at >= 0) lines[at] = `${key}: ${value}${cr}`;
  else lines.splice(end, 0, `${key}: ${value}${cr}`);
  return lines.join("\n");
}

export function renderPage(page: ParsedPage): string {
  const out: string[] = [];
  if (page.frontmatter_order.length > 0) {
    out.push("---");
    for (const key of page.frontmatter_order) {
      const value = renderValue(page.frontmatter[key] ?? null);
      out.push(value === "" ? `${key}:` : `${key}: ${value}`);
    }
    out.push("---");
  }
  if (page.comment !== null) out.push(page.comment);
  if (page.title !== null) out.push(`# ${page.title.replace(/[\r\n]+/gu, " ")}`, "");
  if (page.preamble.length > 0) out.push(...page.preamble, "");
  page.sections.forEach((section, i) => {
    if (i > 0) out.push("");
    out.push(`## ${section.heading}`, ...section.lines);
  });
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
}

/** Text after the frontmatter (the outer one when doubled), LF. The input of body_sha256. */
export function bodyOf(text: string): string {
  const source = lf(text);
  return splitFrontmatter(source)?.rest ?? source;
}
export const bodySha256 = (text: string): string => createHash("sha256").update(bodyOf(text)).digest("hex");

/** Content hash of one item: sha256 of its raw UTF-8 bytes (one trailing CR dropped), first 12 hex digits. */
export const lineHash = (item: string): string => createHash("sha256").update(item.replace(/\r$/u, ""), "utf8").digest("hex").slice(0, 12);

/** `_history/<題名>.md` (design §5.1): retired items with reason and evidence, kept so they can be restored. */
export interface HistoryEntry {
  readonly id: string;
  readonly date: string;
  readonly reason: string;
  /** 元の欄. */
  readonly section: string;
  /** 根拠: W numbers, paths that are gone, the kept line. */
  readonly evidence: string;
  /** 置き換え先: the new line, or "なし". */
  readonly replaced_by: string;
  /** 直前の行: line hash, or "（欄の先頭）". */
  readonly before: string;
  /** 元の行, byte for byte. */
  readonly lines: readonly string[];
  /** 復元の日付, null when not restored. */
  readonly restored: string | null;
  /** The page's `updated` and the raw lines of its `## 更新履歴` section before the run that retired the item; restore puts them back. */
  readonly pre_updated?: string;
  readonly pre_updates?: readonly string[];
}
export interface ParsedHistory {
  readonly frontmatter: Readonly<Record<string, FrontmatterValue>>;
  readonly frontmatter_order: readonly string[];
  readonly title: string | null;
  readonly entries: readonly HistoryEntry[];
  /** Lines of `## 更新履歴`, as written. */
  readonly updates: readonly string[];
}

const ENTRY_HEAD = /^### (\S+) (.*) (\S+)$/u;
function preOf(f: Record<string, string>): { pre_updated?: string; pre_updates?: string[] } {
  const raw = f["更新前updated"];
  if (raw === undefined) return {};
  let updates: unknown;
  try { updates = JSON.parse(f["更新前の更新履歴"] ?? ""); } catch { return {}; }
  if (!Array.isArray(updates) || !updates.every((u) => typeof u === "string")) return {};
  // New shape: the whole `updated:` line as a JSON string. Old shape: the bare date value.
  let line = `updated: ${raw}`;
  if (raw.startsWith('"')) {
    try { const v: unknown = JSON.parse(raw); if (typeof v === "string") line = v; } catch { /* bare value */ }
  }
  return { pre_updated: line, pre_updates: updates };
}
const BULLET = /^- ([^:]+): ?(.*)$/u;

export function parseHistory(text: string): ParsedHistory {
  const page = parsePage(text);
  const retired = page.sections.find((s) => s.heading === "退役")?.lines ?? [];
  const entries: HistoryEntry[] = [];
  let current: { head: RegExpExecArray; fields: Record<string, string>; lines: string[]; fence: string | null } | null = null;
  const flush = (): void => {
    if (!current) return;
    const f = current.fields;
    const cr = new Set((f["行末CR"] ?? "").split(",").map((n) => Number(n.trim())));
    const lines = current.lines.map((l, i) => (cr.has(i + 1) ? `${l}\r` : l));
    entries.push({ id: current.head[3], date: current.head[1], reason: f["理由"] ?? current.head[2], section: f["元の欄"] ?? "", evidence: f["根拠"] ?? "", replaced_by: f["置き換え先"] ?? "", before: f["直前の行"] ?? "", lines, restored: f["復元"] ?? null, ...preOf(f) });
    current = null;
  };
  for (const line of retired) {
    if (current && current.fence !== null) {
      if (line === current.fence) current.fence = null;
      else current.lines.push(line);
      continue;
    }
    const head = ENTRY_HEAD.exec(line);
    if (head) { flush(); current = { head, fields: {}, lines: [], fence: null }; continue; }
    if (!current) continue;
    const open = /^(`{4,})text$/u.exec(line);
    if (open) { current.fence = open[1]; continue; }
    const bullet = BULLET.exec(line);
    if (bullet) current.fields[bullet[1]] = bullet[2];
  }
  flush();
  return {
    frontmatter: page.frontmatter, frontmatter_order: page.frontmatter_order, title: page.title, entries,
    updates: page.sections.find((s) => s.heading === "更新履歴")?.lines.filter((l) => l.trim() !== "") ?? [],
  };
}

export function renderHistory(history: ParsedHistory): string {
  const lines: string[] = [];
  history.entries.forEach((e, i) => {
    const longest = Math.max(0, ...[...e.lines.join("\n").matchAll(/`+/gu)].map((m) => m[0].length));
    const fence = "`".repeat(Math.max(4, longest + 1));
    const crAt = e.lines.flatMap((l, n) => (l.endsWith("\r") ? [n + 1] : []));
    if (i > 0) lines.push("");
    lines.push(
      `### ${e.date} ${e.reason} ${e.id}`, `- 元の欄: ${e.section}`, `- 理由: ${e.reason}`, `- 根拠: ${e.evidence}`,
      `- 置き換え先: ${e.replaced_by}`, `- 直前の行: ${e.before}`,
      ...(e.pre_updated !== undefined && e.pre_updates !== undefined ? [`- 更新前updated: ${JSON.stringify(e.pre_updated)}`, `- 更新前の更新履歴: ${JSON.stringify(e.pre_updates)}`] : []),
      ...(crAt.length > 0 ? [`- 行末CR: ${crAt.join(",")}`] : []), "- 元の行:", `${fence}text`, ...e.lines.map((l) => l.replace(/\r$/u, "")), fence,
      ...(e.restored !== null ? [`- 復元: ${e.restored}`] : []),
    );
  });
  const sections: PageSection[] = [{ heading: "退役", lines: ["", ...lines] }];
  if (history.updates.length > 0) sections.push({ heading: "更新履歴", lines: ["", ...history.updates] });
  return renderPage({ kind: null, frontmatter: history.frontmatter, frontmatter_order: history.frontmatter_order, comment: null, title: history.title, preamble: [], sections });
}

/** NFKC and whitespace removal: the match key for theme titles. */
export const themeTitleKey = (title: string): string => title.normalize("NFKC").replace(/\s+/gu, "");
/** themeTitleKey that also reads 「・」 as 「-」: slugifyKnowledgeName turns 「・」 into 「-」, so both spellings name one file. */
export const pagePathKey = (path: string): string => themeTitleKey(path).replace(/・/gu, "-");

const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["sk-", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/u],
  ["xox[bp]-", /xox[bp]-[A-Za-z0-9-]{10,}/u],
  ["ghp_", /ghp_[A-Za-z0-9]{20,}/u],
  ["AKIA", /AKIA[0-9A-Z]{16}/u],
];
/** Names of the secret shapes found in `text` (never the secret itself). */
export function findSecretPatterns(text: string): readonly string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
/** Copies a JSON value with every secret shape in its strings (object keys too) replaced by `[secret:<name>]`, using the patterns findSecretPatterns names. */
export function maskSecrets(value: unknown): unknown {
  const maskText = (text: string): string => SECRET_PATTERNS.reduce((t, [name, pattern]) => t.replace(new RegExp(pattern.source, `${pattern.flags}g`), `[secret:${name}]`), text);
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskText(k), maskSecrets(v)]));
  return value;
}

/** `name.md` → `name-2.md`, `name-3.md`, … until `exists` is false. */
export function uniqueFilename(filename: string, exists: (candidate: string) => boolean): string {
  if (!exists(filename)) return filename;
  const dot = filename.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
  for (let n = 2; ; n += 1) if (!exists(`${stem}-${n}${ext}`)) return `${stem}-${n}${ext}`;
}

export function emptyThemePage(input: { id: string; title: string; summary: string; scope: "project" | "common"; project_id: string | null; today: string }): ParsedPage {
  const frontmatter: Record<string, FrontmatterValue> = {
    id: input.id, type: "theme", title: input.title, summary: input.summary, scope: input.scope,
    ...(input.scope === "project" && input.project_id ? { project_id: input.project_id } : {}),
    status: "active", integrated_hash: "", integrated_at: "", created: input.today, updated: input.today,
  };
  return {
    kind: "theme", frontmatter, frontmatter_order: Object.keys(frontmatter), comment: null, title: input.title, preamble: [],
    sections: THEME_SECTIONS.map((heading) => ({ heading, lines: ["（なし）"] })),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

interface KeyRule {
  readonly key: string;
  readonly when?: (fm: Readonly<Record<string, FrontmatterValue>>) => boolean;
  /** Present with an empty value is allowed (a freshly created page). */
  readonly empty?: boolean;
  /** Absent is fine; present must pass. */
  readonly optional?: boolean | ((fm: Readonly<Record<string, FrontmatterValue>>) => boolean);
  /** A bare number (work_number: 12) is a valid value; otherwise only strings are. */
  readonly numeric?: boolean;
  readonly check: (value: string) => string | null;
}
interface ListRule {
  readonly key: string;
  readonly max?: number;
  readonly item: (v: string) => boolean;
  readonly expected: string;
}
const text = (max: number) => (v: string): string | null => (v.length <= max ? null : `${max} 文字以内`);
const oneOf = (...values: string[]) => (v: string): string | null => (values.includes(v) ? null : values.join(" / "));
const ulid = (v: string): string | null => (isValidUlid(v) ? null : "ULID");
/** The pattern matches and the calendar date exists (2026-02-30 and 2026-99-99 do not). */
const realDate = (v: string, pattern: RegExp): boolean => pattern.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v.slice(0, 10));
const date = (v: string): string | null => (realDate(v, DATE) ? null : "YYYY-MM-DD");
const datetime = (v: string): string | null => (realDate(v, DATETIME) ? null : "ISO 8601 (UTC)");
const hex64 = (v: string): string | null => (HEX64.test(v) ? null : "sha256 (64 桁)");
const nonEmpty = (v: string): string | null => (v !== "" ? null : "空にできない");
const url = (v: string): string | null => {
  try { return ["http:", "https:"].includes(new URL(v).protocol) ? null : "http(s) の URL"; } catch { return "http(s) の URL"; }
};
const notProject = (fm: Readonly<Record<string, FrontmatterValue>>): boolean => fm.scope !== "project";

const posInt = (v: string): string | null => (/^[1-9]\d*$/u.test(v) ? null : "1 以上の整数");

const KEY_RULES: Readonly<Record<PageKind, readonly KeyRule[]>> = {
  theme: [
    { key: "id", check: ulid }, { key: "type", check: oneOf("theme") }, { key: "title", check: (v) => (v !== "" && v.length <= 30 ? null : "1〜30 文字") },
    { key: "summary", check: (v) => (v !== "" && v.length <= 40 ? null : "1〜40 文字") }, { key: "scope", check: oneOf("project", "common") },
    { key: "project_id", optional: notProject, check: ulid }, { key: "status", check: oneOf("active", "dormant", "archived") },
    { key: "integrated_hash", empty: true, check: hex64 }, { key: "integrated_at", empty: true, check: datetime },
    { key: "created", check: date }, { key: "updated", check: date },
    { key: "merged_into", optional: true, check: (v) => (/^\[\[[^\]\n]+\]\]$/u.test(v) ? null : "[[ページ名]]") },
  ],
  "project-index": [
    { key: "id", check: ulid }, { key: "type", check: oneOf("project-index") }, { key: "scope", check: oneOf("project", "common") },
    { key: "project_id", optional: notProject, check: ulid }, { key: "title", check: nonEmpty }, { key: "generated_at", check: datetime },
    { key: "source_hash", check: hex64 }, { key: "token_estimate", numeric: true, check: (v) => (/^\d+$/u.test(v) ? null : "整数") },
  ],
  "work-log": [
    { key: "id", check: ulid }, { key: "type", check: oneOf("work-log") }, { key: "work_id", check: (v) => (v === "unknown" || isValidUlid(v) ? null : "ULID か unknown") },
    { key: "work_number", empty: true, numeric: true, check: (v) => (/^\d+$/u.test(v) ? null : "整数") }, { key: "title", check: nonEmpty },
    { key: "project_id", optional: true, check: ulid }, { key: "outcome", check: oneOf("completed", "incomplete", "cancelled") }, { key: "completed_at", check: datetime }, { key: "created", check: date },
  ],
  "conversation-log": [
    { key: "id", check: ulid }, { key: "type", check: oneOf("conversation-log") }, { key: "title", check: nonEmpty },
    { key: "conversation_id", check: nonEmpty }, { key: "session_id", check: nonEmpty },
    { key: "compaction_index", numeric: true, check: posInt }, { key: "cause", check: oneOf("owl", "auto", "manual") },
    { key: "summary_source", check: oneOf("provider", "owl-turns") }, { key: "extraction", check: oneOf("program", "pending", "librarian") },
    { key: "created", check: date },
  ],
  clipping: [
    { key: "id", check: ulid }, { key: "type", check: oneOf("clipping") }, { key: "title", check: (v) => (v !== "" && v.length <= 80 ? null : "1〜80 文字") },
    { key: "source_url", when: (fm) => !(typeof fm.source_ref === "string" && fm.source_ref.trim() !== "") || "source_url" in fm, check: url },
    { key: "source_ref", optional: true, check: nonEmpty }, { key: "retrieved_at", check: datetime },
    { key: "retrieved_by", check: oneOf("research-recorder", "external", "owner", "migration") },
    { key: "summary", check: (v) => (v !== "" && v.length <= 120 ? null : "1〜120 文字") }, { key: "created", check: date },
  ],
};

const LIST_RULES: Readonly<Record<PageKind, readonly ListRule[]>> = {
  theme: [
    { key: "related_projects", item: isValidUlid, expected: "ULID の配列" },
    { key: "tags", max: 3, item: (v) => v.trim() !== "", expected: "3 個までの文字列の配列" },
  ],
  "project-index": [],
  "work-log": [],
  "conversation-log": [],
  clipping: [
    { key: "project_ids", item: isValidUlid, expected: "ULID の配列" },
    { key: "tags", item: (v) => v.trim() !== "", expected: "文字列の配列" },
  ],
};

function countLines(kind: PageKind, section: PageSection): number {
  if (kind === "theme" && section.heading === "手順") return section.lines.filter((l) => l.startsWith("### ")).length;
  return section.lines.filter((l) => /^\s*- /u.test(l) && l.trim() !== "- （なし）").length;
}

export interface PageSize {
  readonly tokens: number;
  readonly token_limit: number;
  readonly sections: readonly { readonly section: string; readonly lines: number; readonly limit: number }[];
}
/** The page's tokens and per-section line counts with their template limits, measured as validatePage measures them; null for a page of unknown kind. */
export function pageSize(page: ParsedPage): PageSize | null {
  if (page.kind === null) return null;
  const kind = page.kind;
  const template = TEMPLATES[kind];
  const sections = page.sections.flatMap((s) => {
    const limit = template.lines[s.heading];
    return template.sections.includes(s.heading) && limit !== undefined ? [{ section: s.heading, lines: countLines(kind, s), limit }] : [];
  });
  return { tokens: estimatePageTokens(renderPage({ ...page, frontmatter_order: [] })), token_limit: template.tokens, sections };
}

export function validatePage(page: ParsedPage, options: ValidateOptions): ValidateResult {
  const errors: PageIssue[] = [];
  const warnings: PageIssue[] = [];
  const body = renderPage({ ...page, frontmatter_order: [] });
  const tokens = estimatePageTokens(body);
  const owl = options.writer === "owl";

  if (page.frontmatter_order.length === 0) errors.push({ code: "missing_frontmatter", message: "frontmatter がない" });
  else if (page.kind === null) errors.push({ code: "unknown_kind", key: "type", message: `type が 4 種のどれでもない: ${String(page.frontmatter.type ?? "")}` });
  if (page.kind !== null) {
    const fm = page.frontmatter;
    for (const rule of KEY_RULES[page.kind]) {
      if (rule.when && !rule.when(fm)) continue;
      if (!(rule.key in fm) && (typeof rule.optional === "function" ? rule.optional(fm) : rule.optional)) continue;
      if (!(rule.key in fm)) { errors.push({ code: "missing_key", key: rule.key, message: `必須キー ${rule.key} がない` }); continue; }
      const raw = fm[rule.key];
      if (typeof raw !== "string" && !(rule.numeric && typeof raw === "number")) {
        errors.push({ code: "invalid_value", key: rule.key, message: `${rule.key} の値が不正（文字列か数値）` });
        continue;
      }
      const value = String(raw);
      if (value === "" && rule.empty) continue;
      const expected = rule.check(value);
      if (expected) errors.push({ code: "invalid_value", key: rule.key, message: `${rule.key} の値が不正（${expected}）` });
    }
    for (const rule of LIST_RULES[page.kind]) {
      if (!(rule.key in fm)) continue;
      const list = fm[rule.key];
      const ok = Array.isArray(list) && (rule.max === undefined || list.length <= rule.max) && list.every((v) => typeof v === "string" && rule.item(v));
      if (!ok) errors.push({ code: "invalid_value", key: rule.key, message: `${rule.key} の値が不正（${rule.expected}）` });
    }
    const template = TEMPLATES[page.kind];
    const known = page.sections.filter((s) => template.sections.includes(s.heading));
    for (const section of page.sections) {
      if (!template.sections.includes(section.heading)) errors.push({ code: "unexpected_section", section: section.heading, message: `テンプレートにない欄: ${section.heading}` });
    }
    for (const heading of template.sections) {
      if (!template.optional.includes(heading) && !page.sections.some((s) => s.heading === heading)) errors.push({ code: "missing_section", section: heading, message: `欄 ${heading} がない` });
    }
    const wanted = template.sections.filter((h) => known.some((s) => s.heading === h));
    if (known.some((s, i) => s.heading !== wanted[i])) errors.push({ code: "section_order", message: "欄の順番がテンプレートと違う" });
    const size = pageSize(page)!;
    for (const s of size.sections) {
      if (s.lines > s.limit) warnings.push({ code: "section_over_lines", section: s.section, message: `${s.section} が ${s.limit} 行を超えている` });
    }
    if (page.kind === "work-log") {
      const learned = known.find((s) => s.heading === "学んだこと");
      const applied = known.find((s) => s.heading === "反映先");
      if (learned && applied && countLines(page.kind, applied) > countLines(page.kind, learned)) warnings.push({ code: "section_over_lines", section: "反映先", message: "反映先が学んだことより多い" });
    }
    if (size.tokens > size.token_limit) {
      // The token limit is a hint for splitting, never a rejection.
      warnings.push({ code: "over_budget", message: `${size.tokens} トークンで目安 ${size.token_limit} を超えている` });
    }
  }

  const secrets = findSecretPatterns(renderPage(page));
  for (const name of secrets) (owl ? errors : warnings).push({ code: "secret_pattern", message: `秘密情報の形（${name}）が含まれている` });
  if (options.require_integrated && /<!--\s*owl:new\b/u.test(body)) errors.push({ code: "owl_new_left", message: "owl:new の印が残っている" });

  const targets = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]\n]+)\]\]/gu)) targets.add(m[1].split("|")[0].split("#")[0].trim());
  for (const target of targets) {
    if (isValidUlid(target)) warnings.push({ code: "ulid_link", message: `ULID のリンク: [[${target}]]` });
    else if (options.resolveLink && !options.resolveLink(target)) warnings.push({ code: "unresolved_link", message: `解決できないリンク: [[${target}]]` });
  }
  return { ok: errors.length === 0, errors, warnings, tokens };
}

/** Thrown by the write paths when a page does not fit the four templates; nothing was written. */
export class PageRejectedError extends Error {
  public constructor(public readonly errors: readonly PageIssue[]) {
    super(`page_rejected: ${errors.map((e) => e.message).join("; ")}`);
    this.name = "PageRejectedError";
  }
}

/** The check every page write goes through (Owl writes: secrets are errors). Throws PageRejectedError. */
export function assertValidPage(text: string): void {
  const result = validatePage(parsePage(text), { writer: "owl" });
  if (!result.ok) throw new PageRejectedError(result.errors);
}
