import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

import {
  emptyThemePage, findSecretPatterns, lineHash, parseHistory, parsePage, renderHistory, renderPage, themeTitleKey, validatePage,
  type FrontmatterValue, type HistoryEntry,
} from "./page-format.js";

/**
 * Pure applier for the librarian's operations (design §3, §4, §5). No file or DB access, no model call.
 * Pages are edited line by line (never re-rendered), so every line an operation does not point at stays byte for byte.
 */

export interface PageOpsState {
  /** Vault-relative path → raw text. */
  pages: Map<string, string>;
  /** `_history/…` vault-relative path → raw text. */
  histories: Map<string, string>;
  /** page_id → path (restore finds the page by id). */
  pageIds: Map<string, string>;
}
export interface PageOpsContext {
  today: string;
  newId(): string;
  workExists(w: number): boolean;
  pathMissing(page: string, path: string): "missing" | "exists" | "unavailable";
  conversationExists(path: string): boolean;
  isDormant(page: string): boolean;
  isDormantCandidate(page: string): boolean;
  titleTaken(titleKey: string): boolean;
  /** Folder of the common theme pages. */
  commonDir?: string;
}
export interface PageOpsWarning { readonly page?: string; readonly code: string; readonly message: string }
export interface PageOpsResult {
  state: PageOpsState;
  applied: { index: number; op: unknown }[];
  rejected: { index: number; op: unknown; code: string }[];
  warnings: PageOpsWarning[];
  /** For the DB, not the files. */
  activity: { page: string; action: "dormant" | "reactivate" }[];
  /** Files (pages and `_history`) whose text changed or that were created. */
  touched: Set<string>;
}

export const PROMOTE_RELATION = "共通化";
const HISTORY_SECTION = "退役";
const UPDATES = "更新履歴";
const RELATED = "関連ページ";
const PROCEDURE = "手順";
const REASONS = { contradiction: "矛盾", missing_path: "参照先なし", duplicate: "重複" } as const;
const LABELS: Readonly<Record<string, string>> = { merge: "統合", move: "移動", retire: "退役", link: "リンク", split: "分割", promote_common: "共通化", restore: "復元" };

class Reject extends Error {
  public constructor(public readonly code: string) { super(code); }
}
const reject = (code: string): never => { throw new Reject(code); };

// ---------------------------------------------------------------- lines and items

interface Line { t: string; /** Index in the original text, -1 for a line written by us. */ o: number }
interface Doc { lines: Line[]; eol: boolean; crlf: boolean }
interface Item { start: number; end: number; text: string; /** Hash, with `~n` when the section holds the same content twice. */ h: string }
interface Sec { heading: string; head: number; end: number; items: Item[] }

function docOf(text: string): Doc {
  const eol = text.endsWith("\n");
  const parts = text.split("\n");
  if (eol) parts.pop();
  // CRLF only when every line break is CRLF; the CR is kept off the line text and put back on output.
  const breaks = eol ? parts : parts.slice(0, -1);
  const crlf = breaks.length > 0 && breaks.every((t) => t.endsWith("\r"));
  if (crlf) for (let i = 0; i < breaks.length; i += 1) parts[i] = parts[i].slice(0, -1);
  return { lines: parts.map((t, o) => ({ t, o })), eol, crlf };
}
const textOf = (doc: Doc): string => {
  const nl = doc.crlf ? "\r\n" : "\n";
  return doc.lines.map((l) => l.t).join(nl) + (doc.eol ? nl : "");
};
const cloneDoc = (doc: Doc): Doc => ({ eol: doc.eol, crlf: doc.crlf, lines: doc.lines.map((l) => ({ ...l })) });
const mk = (t: string): Line => ({ t, o: -1 });
const isPlaceholder = (t: string): boolean => ["（なし）", "- （なし）"].includes(t.trim());
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/u;

function frontmatterEnd(doc: Doc): number {
  const bar = (i: number): boolean => doc.lines[i].t.replace(/\r$/u, "") === "---";
  if (doc.lines.length === 0 || !bar(0)) return -1;
  for (let i = 1; i < doc.lines.length; i += 1) if (bar(i)) return i;
  return -1;
}

/** Sections and items by the same rules as parsePage (fenced `## ` is not a heading), design §4.1–§4.2. */
function scan(doc: Doc): Sec[] {
  const lines = doc.lines;
  const secs: Sec[] = [];
  const fenced: boolean[] = [];
  let fence: string | null = null;
  for (let i = Math.max(0, frontmatterEnd(doc) + 1); i < lines.length; i += 1) {
    const m = FENCE.exec(lines[i].t);
    if (m) {
      if (fence === null) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === "") fence = null;
    }
    fenced[i] = fence !== null;
    const h = fence !== null ? null : /^## (.*)$/u.exec(lines[i].t);
    if (h) {
      if (secs.length > 0) secs[secs.length - 1].end = i;
      secs.push({ heading: h[1].trim(), head: i, end: lines.length, items: [] });
    }
  }
  for (const sec of secs) {
    const starts: number[] = [];
    for (let i = sec.head + 1; i < sec.end; i += 1) {
      if (fenced[i]) continue;
      if (sec.heading === PROCEDURE ? lines[i].t.startsWith("### ") : /^\s*[-*] /u.test(lines[i].t) && !isPlaceholder(lines[i].t)) starts.push(i);
    }
    const counts = new Map<string, number>();
    const raw = starts.map((start, k) => {
      let end = sec.heading === PROCEDURE ? (starts[k + 1] ?? sec.end) : start + 1;
      while (end > start + 1 && lines[end - 1].t.trim() === "") end -= 1;
      const text = lines.slice(start, end).map((l) => l.t).join("\n");
      const h = lineHash(text);
      counts.set(h, (counts.get(h) ?? 0) + 1);
      return { start, end, text, h };
    });
    const seen = new Map<string, number>();
    sec.items = raw.map((r) => {
      if (counts.get(r.h) === 1) return r;
      const n = (seen.get(r.h) ?? 0) + 1;
      seen.set(r.h, n);
      return { ...r, h: `${r.h}~${n}` };
    });
  }
  return secs;
}
const section = (doc: Doc, heading: string): Sec | undefined => scan(doc).find((s) => s.heading === heading);

/** Puts `（なし）` back when a section has nothing left. */
function fixPlaceholder(doc: Doc, heading: string): void {
  const sec = section(doc, heading);
  if (!sec) return;
  const body = doc.lines.slice(sec.head + 1, sec.end);
  if (!body.some((l) => l.t.trim() !== "")) doc.lines.splice(sec.head + 1, 0, mk("（なし）"));
}
/** Adds lines at the end (after the last non-blank line) or the start of a section; drops the placeholder. */
function addToSection(doc: Doc, heading: string, texts: readonly string[], where: "end" | "start" = "end"): void {
  let sec = section(doc, heading);
  if (!sec) return;
  for (let i = sec.end - 1; i > sec.head; i -= 1) if (isPlaceholder(doc.lines[i].t)) doc.lines.splice(i, 1);
  sec = section(doc, heading)!;
  let pos = sec.head + 1;
  if (where === "end") {
    for (let i = sec.end - 1; i > sec.head; i -= 1) if (doc.lines[i].t.trim() !== "") { pos = i + 1; break; }
  } else {
    for (let i = sec.head + 1; i < sec.end; i += 1) if (doc.lines[i].t.trim() !== "") { pos = i; break; }
  }
  doc.lines.splice(pos, 0, ...texts.map(mk));
}
function setFm(doc: Doc, key: string, value: string): void {
  const end = frontmatterEnd(doc);
  if (end < 0) return;
  const line = mk(`${key}: ${value}${doc.lines[end].t.endsWith("\r") ? "\r" : ""}`);
  for (let i = 1; i < end; i += 1) if (doc.lines[i].t.startsWith(`${key}:`)) { doc.lines[i] = line; return; }
  doc.lines.splice(end, 0, line);
}
const fmOf = (doc: Doc): Readonly<Record<string, FrontmatterValue>> => parsePage(textOf(doc)).frontmatter;
const titleOf = (path: string, doc: Doc): string => { const t = fmOf(doc).title; return typeof t === "string" && t !== "" ? t : posix.basename(path, ".md"); };

const OWL_NEW = /\s*<!--\s*owl:new\b.*?-->\s*$/u;
const stripNew = (text: string): string => text.split("\n").map((l) => l.replace(OWL_NEW, "")).join("\n");
const SOURCES = /[（(]\s*(W\d+(?:\s*[,、]\s*W\d+)*)\s*[）)]\s*$/u;
const worksOf = (text: string): number[] => text.split("\n").flatMap((l) => [...(SOURCES.exec(l.replace(OWL_NEW, ""))?.[1] ?? "").matchAll(/W(\d+)/gu)].map((m) => Number(m[1])));
const sourcesText = (works: readonly number[]): string => (works.length > 0 ? `（${[...new Set(works)].sort((a, b) => a - b).map((n) => `W${n}`).join(", ")}）` : "");
const hasStar = (text: string): boolean => /^\s*[-*]\s*★/u.test(text);

/**
 * The lines of `before` that were not removed must appear in `after` in the same order and bytes,
 * and `after` holds nothing else but the inserted lines (design §4.4 step 6).
 */
export function verifyUntouched(before: string, after: string, removed: ReadonlySet<number>, inserted: number): boolean {
  const a = before.split("\n");
  const b = after.split("\n");
  const kept = a.filter((_, i) => !removed.has(i));
  if (b.length !== kept.length + inserted) return false;
  let j = 0;
  for (const line of b) if (j < kept.length && line === kept[j]) j += 1;
  return j === kept.length;
}

// ---------------------------------------------------------------- item identity and the operations output

export interface SectionItems { section: string; items: { h: string; text: string }[] }
/** Every item of a page that operations can point at (the model input, design §3.1). */
export function itemsOf(text: string): SectionItems[] {
  return scan(docOf(text)).map((s) => ({ section: s.heading, items: s.items.map((i) => ({ h: i.h, text: i.text })) }));
}
export { lineHash };

const FULL_TEXT_KEYS = ["pages", "body", "rewrite"];
/** Reads the model output: only `operations` (and `note`) may be present. A full-text key rejects everything. */
export function parseOperationsOutput(raw: unknown): { ops: unknown[] } | { error: string } {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { error: "invalid_json" }; }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "invalid_json" };
  const keys = Object.keys(value);
  if (keys.some((k) => FULL_TEXT_KEYS.includes(k))) return { error: "full_text_not_accepted" };
  if (keys.some((k) => k !== "operations" && k !== "note")) return { error: "unexpected_key" };
  const ops = (value as { operations?: unknown }).operations;
  return Array.isArray(ops) ? { ops } : { error: "invalid_json" };
}

interface Ref { page: string; section: string; h: string }
interface Spec { required: Record<string, "string" | "ref" | "refs" | "target" | "strings" | "evidence">; optional: Record<string, "string" | "boolean" | "ref" | "evidence"> }
const SPECS: Readonly<Record<string, Spec>> = {
  merge: { required: { items: "refs", into: "target", text: "string" }, optional: { star: "boolean" } },
  move: { required: { item: "ref", to: "target" }, optional: {} },
  retire: { required: { item: "ref", reason: "string", evidence: "evidence" }, optional: { replaced_by: "ref" } },
  dormant: { required: { page: "string" }, optional: {} },
  reactivate: { required: { page: "string" }, optional: {} },
  link: { required: { from: "string", to: "string", relation: "string" }, optional: {} },
  split: { required: { page: "string", new_title: "string", new_summary: "string", items: "refs", relation: "string" }, optional: {} },
  promote_common: { required: { items: "refs", to: "target" }, optional: { text: "string" } },
  restore: { required: { history: "string", entry: "string" }, optional: {} },
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const isRef = (v: unknown): v is Ref => isObj(v) && exactKeys(v, ["page", "section", "h"]) && nonEmpty(v.page) && nonEmpty(v.section) && nonEmpty(v.h);
const isTarget = (v: unknown): boolean => isObj(v) && (exactKeys(v, ["page", "section"]) ? nonEmpty(v.page) && nonEmpty(v.section) : exactKeys(v, ["title", "section"]) && nonEmpty(v.title) && nonEmpty(v.section));
const isEvidence = (v: unknown): boolean => isObj(v) && Object.keys(v).every((k) => ["works", "conversation", "paths", "kept"].includes(k))
  && (v.works === undefined || (Array.isArray(v.works) && v.works.every(nonEmpty))) && (v.paths === undefined || (Array.isArray(v.paths) && v.paths.every(nonEmpty)))
  && (v.conversation === undefined || nonEmpty(v.conversation)) && (v.kept === undefined || isRef(v.kept));
const CHECKS: Readonly<Record<string, (v: unknown) => boolean>> = {
  string: nonEmpty, boolean: (v) => typeof v === "boolean", ref: isRef, refs: (v) => Array.isArray(v) && v.every(isRef), target: isTarget, strings: (v) => Array.isArray(v) && v.every(nonEmpty), evidence: isEvidence,
};
const NEWLINE_FIELDS = ["text", "relation", "new_title", "new_summary"];

function validateShape(op: unknown, allowCoreOps: boolean): Record<string, unknown> {
  if (!isObj(op) || typeof op.op !== "string" || !Object.hasOwn(SPECS, op.op)) return reject("unknown_op");
  const spec = SPECS[op.op];
  if (op.op === "dormant" && !allowCoreOps) return reject("unknown_op");
  const allowed = new Set(["op", ...Object.keys(spec.required), ...Object.keys(spec.optional)]);
  if (Object.keys(op).some((k) => !allowed.has(k))) return reject("unknown_op");
  for (const [k, type] of Object.entries(spec.required)) if (!(k in op) || !CHECKS[type](op[k])) reject("missing_field");
  for (const [k, type] of Object.entries(spec.optional)) if (k in op && op[k] !== undefined && !CHECKS[type](op[k])) reject("missing_field");
  for (const k of NEWLINE_FIELDS) {
    const v = op[k];
    if (typeof v === "string" && /[\r\n]/u.test(v)) reject("text_has_newline");
    if (typeof v === "string" && findSecretPatterns(v).length > 0) reject("secret_detected");
  }
  if (isObj(op.to) && typeof op.to.title === "string" && /[\r\n]/u.test(op.to.title)) reject("text_has_newline");
  if (Array.isArray(op.items) && op.items.length < (op.op === "split" ? 1 : 2)) reject("missing_field");
  return op;
}

// ---------------------------------------------------------------- the run

interface Pending {
  docs: Map<string, Doc>;
  hists: Map<string, Doc>;
  ids: Map<string, string>;
  used: string[];
  protectedKeys: string[];
  tally: { page: string; label: string; ref?: string }[];
  activity: { page: string; action: "dormant" | "reactivate" }[];
  warnings: PageOpsWarning[];
}
const keyOf = (r: Ref): string => `${r.page}\0${r.section}\0${r.h}`;

class Run {
  public readonly docs = new Map<string, Doc>();
  public readonly hists = new Map<string, Doc>();
  public readonly ids: Map<string, string>;
  public readonly used = new Set<string>();
  public readonly protectedKeys = new Set<string>();
  public readonly tally = new Map<string, Map<string, { count: number; refs: Set<string> }>>();
  public readonly activity: { page: string; action: "dormant" | "reactivate" }[] = [];
  public readonly warnings: PageOpsWarning[] = [];
  public readonly reactivated = new Set<string>();
  public readonly dormanted = new Set<string>();
  private readonly writableCache = new Map<string, boolean>();
  public tx!: Pending;

  public constructor(public readonly state: PageOpsState, public readonly ctx: PageOpsContext) {
    for (const [p, text] of state.pages) this.docs.set(p, docOf(text));
    for (const [p, text] of state.histories) this.hists.set(p, docOf(text));
    this.ids = new Map(state.pageIds);
  }

  public begin(): void {
    this.tx = { docs: new Map(), hists: new Map(), ids: new Map(), used: [], protectedKeys: [], tally: [], activity: [], warnings: [] };
  }
  public commit(): void {
    for (const [p, d] of this.tx.docs) this.docs.set(p, d);
    for (const [p, d] of this.tx.hists) this.hists.set(p, d);
    for (const [k, v] of this.tx.ids) this.ids.set(k, v);
    this.tx.used.forEach((k) => this.used.add(k));
    this.tx.protectedKeys.forEach((k) => this.protectedKeys.add(k));
    for (const t of this.tx.tally) {
      const labels = this.tally.get(t.page) ?? new Map<string, { count: number; refs: Set<string> }>();
      const entry = labels.get(t.label) ?? { count: 0, refs: new Set<string>() };
      entry.count += 1;
      if (t.ref) entry.refs.add(t.ref);
      labels.set(t.label, entry);
      this.tally.set(t.page, labels);
    }
    for (const a of this.tx.activity) {
      this.activity.push(a);
      if (a.action === "reactivate") { this.reactivated.add(a.page); this.dormanted.delete(a.page); } else { this.dormanted.add(a.page); this.reactivated.delete(a.page); }
    }
    this.warnings.push(...this.tx.warnings);
  }

  /** The working copy of a page for the current operation. */
  public doc(path: string): Doc {
    const own = this.tx.docs.get(path);
    if (own) return own;
    const base = this.docs.get(path);
    if (!base) return reject("unknown_page");
    const copy = cloneDoc(base);
    this.tx.docs.set(path, copy);
    return copy;
  }
  public peek(path: string): Doc {
    const d = this.tx.docs.get(path) ?? this.docs.get(path);
    return d ?? reject("unknown_page");
  }
  public isDormant(page: string): boolean {
    return this.dormanted.has(page) || this.tx.activity.some((a) => a.page === page && a.action === "dormant")
      || (this.ctx.isDormant(page) && !this.reactivated.has(page) && !this.tx.activity.some((a) => a.page === page && a.action === "reactivate"));
  }
  /** Valid template and not archived (judged on the text before this run). */
  public writable(path: string): boolean {
    if (!this.docs.has(path)) return false;
    if (this.tx.docs.has(path) && !this.state.pages.has(path)) return true;
    let ok = this.writableCache.get(path);
    if (ok === undefined) {
      const page = parsePage(this.state.pages.get(path) ?? textOf(this.docs.get(path)!));
      ok = validatePage(page, { writer: "owl" }).ok && page.frontmatter.status !== "archived";
      this.writableCache.set(path, ok);
    }
    return ok;
  }
  public requireWritable(path: string, allowDormant = false): Doc {
    const d = this.peek(path);
    if (!this.writable(path) || (!allowDormant && this.isDormant(path))) reject("page_not_writable");
    return d;
  }
  public resolve(ref: Ref, opts: { check?: boolean; allowDormant?: boolean } = {}): Item {
    const check = opts.check ?? true;
    if (check && (this.used.has(keyOf(ref)) || this.protectedKeys.has(keyOf(ref)) || this.tx.used.includes(keyOf(ref)))) reject("item_already_used");
    const doc = this.requireWritable(ref.page, opts.allowDormant);
    const sec = section(doc, ref.section);
    if (!sec) reject("unknown_section");
    if (ref.section === UPDATES) reject("section_not_allowed");
    return sec!.items.find((i) => i.h === ref.h) ?? reject("line_hash_mismatch");
  }
  public tallyOf(page: string, label: string, ref?: string): void { this.tx.tally.push({ page, label, ref }); }
}

const isProcedure = (heading: string): boolean => heading === PROCEDURE;
const sameKind = (items: readonly { section: string }[], target: string): void => {
  if (items.some((i) => isProcedure(i.section) !== isProcedure(target))) reject("kind_mismatch");
};
const used = (run: Run, ...refs: Ref[]): void => { run.tx.used.push(...refs.map(keyOf)); };

function historyPath(page: string): string {
  const dir = posix.dirname(page);
  return `${dir === "." ? "" : `${dir}/`}_history/${posix.basename(page)}`;
}
function entryLines(entry: HistoryEntry): string[] {
  const out = renderHistory({ frontmatter: {}, frontmatter_order: [], title: null, entries: [entry], updates: [] }).split("\n");
  out.pop();
  return out.slice(2);
}
const updatesBody = (doc: Doc): { sec: Sec; lines: string[] } | null => {
  const sec = section(doc, UPDATES);
  return sec ? { sec, lines: doc.lines.slice(sec.head + 1, sec.end).map((l) => l.t) } : null;
};
const realLines = (lines: readonly string[]): string[] => lines.filter((l) => l.trim() !== "" && !isPlaceholder(l));
/** `updated` and the `## 更新履歴` lines of the page as the run found it, so restore can give the page back byte for byte. */
function preRun(run: Run, page: string): { pre_updated?: string; pre_updates?: string[] } {
  const text = run.state.pages.get(page);
  if (text === undefined) return {};
  const doc = docOf(text);
  const end = frontmatterEnd(doc);
  const raw = end < 0 ? undefined : doc.lines.slice(1, end).find((l) => l.t.startsWith("updated:"));
  const body = updatesBody(doc);
  return raw && body ? { pre_updated: raw.t, pre_updates: body.lines } : {};
}
/** Undoes the audit trail the retiring run added to the page (one 更新履歴 line and `updated`) when nothing else changed it since. */
function revertAudit(doc: Doc, entry: HistoryEntry): boolean {
  if (entry.pre_updated === undefined || entry.pre_updates === undefined) return false;
  const body = updatesBody(doc);
  if (!body || fmOf(doc).updated !== entry.date) return false;
  const now = realLines(body.lines);
  const pre = realLines(entry.pre_updates);
  if (now.length !== pre.length + 1 || !now[0].startsWith(`- ${entry.date} 司書: `) || now.slice(1).some((l, i) => l !== pre[i])) return false;
  doc.lines.splice(body.sec.head + 1, body.lines.length, ...entry.pre_updates.map(mk));
  const end = frontmatterEnd(doc);
  const at = doc.lines.findIndex((l, i) => i > 0 && i < end && l.t.startsWith("updated:"));
  if (at < 0) return false;
  doc.lines[at] = mk(entry.pre_updated);
  return true;
}
/** Adds a retired entry to `_history/<題名>.md` (created when missing). */
function appendHistory(run: Run, page: string, entry: Omit<HistoryEntry, "id" | "date" | "restored">): void {
  const path = historyPath(page);
  const full: HistoryEntry = { ...entry, id: run.ctx.newId(), date: run.ctx.today, restored: null, ...preRun(run, page) };
  const base = run.tx.hists.get(path) ?? run.hists.get(path);
  if (!base) {
    const pageDoc = run.peek(page);
    const title = titleOf(page, pageDoc);
    const frontmatter = { id: run.ctx.newId(), type: "history", title: `${title} の履歴`, page_id: String(fmOf(pageDoc).id ?? ""), created: run.ctx.today, updated: run.ctx.today };
    const text = renderHistory({ frontmatter, frontmatter_order: Object.keys(frontmatter), title: `${title} の履歴`, entries: [full], updates: [] });
    run.tx.hists.set(path, docOf(text));
    return;
  }
  const doc = run.tx.hists.get(path) ?? cloneDoc(base);
  run.tx.hists.set(path, doc);
  const lines = entryLines(full);
  const sec = section(doc, HISTORY_SECTION);
  if (!sec) {
    // Old shape (title and bullet lines only): add the new headings in front of the old lines, which stay as they are.
    let at = Math.max(0, frontmatterEnd(doc) + 1);
    while (at < doc.lines.length && (doc.lines[at].t.trim() === "" || doc.lines[at].t.startsWith("# "))) at += 1;
    doc.lines.splice(at, 0, ...[`## ${HISTORY_SECTION}`, "", ...lines, "", `## ${UPDATES}`, ""].map(mk));
  } else {
    let pos = sec.head + 1;
    for (let i = sec.end - 1; i > sec.head; i -= 1) if (doc.lines[i].t.trim() !== "") { pos = i + 1; break; }
    doc.lines.splice(pos, 0, ...["", ...lines].map(mk));
  }
  setFm(doc, "updated", run.ctx.today);
}

/** Removes items (highest first) and puts the placeholder back where a section became empty. */
function removeItems(doc: Doc, groups: { heading: string; items: Item[] }[]): void {
  const all = groups.flatMap((g) => g.items).sort((a, b) => b.start - a.start);
  for (const it of all) doc.lines.splice(it.start, it.end - it.start);
  for (const heading of new Set(groups.map((g) => g.heading))) fixPlaceholder(doc, heading);
}
/** The item right before `item` in its section that is not itself being removed, or the start marker. */
function beforeOf(doc: Doc, heading: string, item: Item, removing: readonly Item[]): string {
  const items = section(doc, heading)?.items ?? [];
  const prev = items.filter((i) => i.start < item.start && !removing.some((r) => r.start === i.start)).pop();
  return prev ? prev.h : "（欄の先頭）";
}
const firstLine = (text: string): string => text.split("\n")[0];
const hasLink = (doc: Doc, title: string): boolean => (section(doc, RELATED)?.items ?? []).some((i) => i.text.includes(`[[${title}]]`) || i.text.includes(`[[${title}|`));
const addLink = (doc: Doc, title: string, relation: string): void => addToSection(doc, RELATED, [`- [[${title}]] — ${relation}`]);

type Applier = (run: Run, op: Record<string, any>) => void;

const applyMerge: Applier = (run, op) => {
  const refs = op.items as Ref[];
  const into = op.into as { page: string; section: string };
  if (new Set(refs.map(keyOf)).size !== refs.length) reject("item_already_used");
  if (/[（(]\s*W\d+/u.test(op.text)) reject("sources_in_text");
  const items = refs.map((r) => ({ ref: r, item: run.resolve(r) }));
  const intoDoc = run.requireWritable(into.page);
  if (into.section === UPDATES) reject("section_not_allowed");
  if (!section(intoDoc, into.section)) reject("unknown_section");
  sameKind(refs, into.section);
  if (isProcedure(into.section) && !String(op.text).startsWith("### ")) reject("kind_mismatch");
  const works = items.flatMap((i) => worksOf(i.item.text));
  const star = typeof op.star === "boolean" ? op.star : items.some((i) => hasStar(i.item.text));
  const newLine = isProcedure(into.section) ? op.text : `- ${star ? "★ " : ""}${op.text}${sourcesText(works)}`;
  const byPage = new Map<string, typeof items>();
  for (const it of items) byPage.set(it.ref.page, [...(byPage.get(it.ref.page) ?? []), it]);
  // History first: "before" is read from the untouched pages.
  for (const it of items) {
    const doc = run.peek(it.ref.page);
    appendHistory(run, it.ref.page, {
      section: it.ref.section, reason: REASONS.duplicate, evidence: `merge（残した行 ${lineHash(newLine)}）`, replaced_by: firstLine(newLine),
      before: beforeOf(doc, it.ref.section, it.item, items.filter((x) => x.ref.page === it.ref.page && x.ref.section === it.ref.section).map((x) => x.item)), lines: it.item.text.split("\n"),
    });
  }
  let placed = false;
  for (const [page, list] of byPage) {
    const doc = run.doc(page);
    const sameSection = list.filter((i) => page === into.page && i.ref.section === into.section);
    const anchor = sameSection.length > 0 ? sameSection.reduce((a, b) => (b.item.start < a.item.start ? b : a)) : null;
    for (const it of [...list].sort((a, b) => b.item.start - a.item.start)) {
      const sec = it.item;
      if (it === anchor) { doc.lines.splice(sec.start, sec.end - sec.start, ...newLine.split("\n").map(mk)); placed = true; }
      else doc.lines.splice(sec.start, sec.end - sec.start);
    }
    for (const heading of new Set(list.map((i) => i.ref.section))) fixPlaceholder(doc, heading);
    run.tallyOf(page, "merge");
  }
  if (!placed) { addToSection(run.doc(into.page), into.section, newLine.split("\n")); run.tallyOf(into.page, "merge"); }
  used(run, ...refs);
};

const applyMove: Applier = (run, op) => {
  const ref = op.item as Ref;
  const to = op.to as { page: string; section: string };
  const item = run.resolve(ref);
  const toDoc = run.peek(to.page);
  if (!run.writable(to.page)) reject("page_not_writable");
  if (to.section === UPDATES) reject("section_not_allowed");
  if (!section(toDoc, to.section)) reject("unknown_section");
  sameKind([ref], to.section);
  const moved = stripNew(item.text).split("\n");
  if (to.page === ref.page && to.section === ref.section) {
    const doc = run.doc(ref.page);
    doc.lines.splice(item.start, item.end - item.start, ...moved.map(mk));
  } else {
    removeItems(run.doc(ref.page), [{ heading: ref.section, items: [item] }]);
    addToSection(run.doc(to.page), to.section, moved);
    if (run.isDormant(to.page)) run.tx.activity.push({ page: to.page, action: "reactivate" });
  }
  used(run, ref);
  run.tallyOf(ref.page, "move");
  if (to.page !== ref.page) run.tallyOf(to.page, "move");
};

const applyRetire: Applier = (run, op) => {
  const ref = op.item as Ref;
  const reason = op.reason as string;
  const evidence = op.evidence as { works?: string[]; conversation?: string; paths?: string[]; kept?: Ref };
  if (!Object.hasOwn(REASONS, reason)) reject("unknown_reason");
  const item = run.resolve(ref);
  const replacedBy = op.replaced_by as Ref | undefined;
  const resolveOther = (r: Ref | undefined): Item | undefined => {
    if (!r) return undefined;
    if (keyOf(r) === keyOf(ref)) reject("evidence_item_missing");
    try { return run.resolve(r, { check: false, allowDormant: true }); } catch (e) { if (e instanceof Reject && e.code !== "item_already_used") return reject("evidence_item_missing"); throw e; }
  };
  let evidenceText = "";
  let replacedText = "なし";
  let works: string[] = [];
  if (reason === "contradiction") {
    works = evidence.works ?? [];
    if (works.length === 0 && !evidence.conversation) reject("retire_without_evidence");
    if (!replacedBy) reject("retire_without_evidence");
    const newest = Math.max(0, ...worksOf(item.text));
    for (const w of works) {
      const m = /^W(\d+)$/u.exec(w);
      if (!m || !run.ctx.workExists(Number(m[1])) || Number(m[1]) <= newest) reject("evidence_work_invalid");
    }
    if (evidence.conversation && !run.ctx.conversationExists(evidence.conversation)) reject("evidence_conversation_missing");
    evidenceText = [...works, ...(evidence.conversation ? [evidence.conversation] : [])].join(", ");
    replacedText = firstLine(resolveOther(replacedBy)!.text);
  } else if (reason === "missing_path") {
    const paths = evidence.paths ?? [];
    if (paths.length === 0) reject("retire_without_evidence");
    const scope = fmOf(run.peek(ref.page)).scope;
    if (scope === "common" || ref.page.startsWith(`${run.ctx.commonDir ?? "common"}/`)) reject("scope_not_allowed");
    for (const p of paths) {
      const r = run.ctx.pathMissing(ref.page, p);
      if (r === "exists") reject("evidence_path_exists");
      if (r === "unavailable") reject("path_check_unavailable");
    }
    evidenceText = `${paths.join(", ")}（base に無い）`;
    if (replacedBy) replacedText = firstLine(resolveOther(replacedBy)!.text);
  } else {
    if (!evidence.kept) reject("retire_without_evidence");
    const kept = resolveOther(evidence.kept)!;
    evidenceText = `残した行 ${evidence.kept!.h}${sourcesText(worksOf(kept.text))}`;
    replacedText = firstLine(replacedBy ? resolveOther(replacedBy)!.text : kept.text);
  }
  const doc = run.peek(ref.page);
  appendHistory(run, ref.page, {
    section: ref.section, reason: REASONS[reason as keyof typeof REASONS], evidence: evidenceText, replaced_by: replacedText,
    before: beforeOf(doc, ref.section, item, []), lines: item.text.split("\n"),
  });
  removeItems(run.doc(ref.page), [{ heading: ref.section, items: [item] }]);
  used(run, ref);
  run.tx.protectedKeys.push(...[evidence.kept, replacedBy].filter((r): r is Ref => r !== undefined).map(keyOf));
  run.tallyOf(ref.page, "retire", works.join(", "));
};

const applyDormant: Applier = (run, op) => {
  const page = op.page as string;
  const doc = run.peek(page);
  if (!run.writable(page) || fmOf(doc).status === "archived") reject("page_not_writable");
  if (!run.ctx.isDormantCandidate(page)) reject("not_dormant_candidate");
  run.tx.activity.push({ page, action: "dormant" });
};

const applyReactivate: Applier = (run, op) => {
  const page = op.page as string;
  run.peek(page);
  if (!run.writable(page)) reject("page_not_writable");
  if (!run.isDormant(page)) { run.tx.warnings.push({ page, code: "not_dormant", message: "休眠でないページへの reactivate は何もしない" }); return; }
  run.tx.activity.push({ page, action: "reactivate" });
};

const applyLink: Applier = (run, op) => {
  const from = op.from as string;
  const to = op.to as string;
  if (from === to) reject("self_link");
  const fromDoc = run.requireWritable(from);
  const toTitle = titleOf(to, run.peek(to));
  if (hasLink(fromDoc, toTitle)) reject("link_exists");
  addLink(run.doc(from), toTitle, op.relation);
  run.tallyOf(from, "link");
};

const projectOf = (page: string, doc: Doc): string => {
  const fm = fmOf(doc);
  return typeof fm.project_id === "string" && fm.project_id !== "" ? fm.project_id : posix.dirname(page);
};
const titleKeyTaken = (run: Run, key: string, except?: string): boolean =>
  run.ctx.titleTaken(key) || [...run.docs, ...run.tx.docs].some(([p, d]) => p !== except && themeTitleKey(titleOf(p, d)) === key);
/** A title becomes a file name: no folders, and no leading `_` or `.`, which name Owl's own files (_index.md, _history/) and hidden files. */
const reservedTitle = (title: string): boolean => /[/\\]|^[._]/u.test(title);
const relatedProjects = (doc: Doc): string[] => { const v = fmOf(doc).related_projects; return Array.isArray(v) ? [...v] : []; };

const applySplit: Applier = (run, op) => {
  const page = op.page as string;
  const refs = op.items as Ref[];
  const title = op.new_title as string;
  if (reservedTitle(title)) reject("invalid_title");
  if (new Set(refs.map(keyOf)).size !== refs.length) reject("item_already_used");
  const doc = run.requireWritable(page);
  const key = themeTitleKey(title);
  const newPath = posix.join(posix.dirname(page), `${title}.md`);
  if (titleKeyTaken(run, key) || run.docs.has(newPath) || run.tx.docs.has(newPath)) reject("title_exists");
  if (refs.some((r) => r.page !== page)) reject("item_not_in_page");
  const items = refs.map((r) => ({ ref: r, item: run.resolve(r) }));
  const movable = scan(doc).filter((s) => s.heading !== UPDATES && s.heading !== RELATED).flatMap((s) => s.items);
  if (movable.length > 0 && movable.every((m) => items.some((i) => i.item.start === m.start))) reject("split_empties_page");
  const fm = fmOf(doc);
  const created = emptyThemePage({
    id: run.ctx.newId(), title, summary: op.new_summary, scope: fm.scope === "common" ? "common" : "project",
    project_id: typeof fm.project_id === "string" ? fm.project_id : null, today: run.ctx.today,
  });
  const newDoc = docOf(renderPage(created));
  run.tx.docs.set(newPath, newDoc);
  run.tx.ids.set(String(created.frontmatter.id), newPath);
  const src = run.doc(page);
  const bySection = new Map<string, Item[]>();
  for (const it of items) bySection.set(it.ref.section, [...(bySection.get(it.ref.section) ?? []), it.item]);
  removeItems(src, [...bySection].map(([heading, list]) => ({ heading, items: list })));
  for (const [heading, list] of bySection) for (const it of list.sort((a, b) => a.start - b.start)) addToSection(newDoc, heading, stripNew(it.text).split("\n"));
  addLink(src, title, op.relation);
  addLink(newDoc, titleOf(page, doc), op.relation);
  used(run, ...refs);
  run.tallyOf(page, "split");
  run.tallyOf(newPath, "split");
};

const applyPromote: Applier = (run, op) => {
  const refs = op.items as Ref[];
  const to = op.to as { title: string; section: string };
  if (to.section === UPDATES) reject("section_not_allowed");
  if (new Set(refs.map(keyOf)).size !== refs.length) reject("item_already_used");
  if (typeof op.text === "string" && /[（(]\s*W\d+/u.test(op.text)) reject("sources_in_text");
  const items = refs.map((r) => ({ ref: r, item: run.resolve(r) }));
  if (new Set(items.map((i) => projectOf(i.ref.page, run.peek(i.ref.page)))).size < 2 || items.some((i) => fmOf(run.peek(i.ref.page)).scope === "common")) reject("not_cross_project");
  sameKind(refs, to.section);
  if (typeof op.text === "string" && isProcedure(to.section) && !op.text.startsWith("### ")) reject("kind_mismatch");
  const key = themeTitleKey(to.title);
  const commonDir = run.ctx.commonDir ?? "common";
  if (reservedTitle(to.title)) reject("invalid_title");
  let commonPath = [...run.docs, ...run.tx.docs].find(([p, d]) => fmOf(d).scope === "common" && themeTitleKey(titleOf(p, d)) === key)?.[0];
  if (commonPath === undefined) {
    commonPath = `${commonDir}/${to.title}.md`;
    if (titleKeyTaken(run, key) || run.docs.has(commonPath)) reject("title_exists");
  } else if (!run.writable(commonPath)) reject("page_not_writable");
  const works = items.flatMap((i) => worksOf(i.item.text));
  const star = items.some((i) => hasStar(i.item.text));
  let newLine: string;
  if (typeof op.text === "string") newLine = isProcedure(to.section) ? op.text : `- ${star ? "★ " : ""}${op.text}${sourcesText(works)}`;
  else if (isProcedure(to.section)) newLine = stripNew(items[0].item.text);
  else newLine = `${stripNew(items[0].item.text).replace(SOURCES, "").trimEnd()}${sourcesText(works)}`;
  const projects = [...new Set(items.map((i) => projectOf(i.ref.page, run.peek(i.ref.page))))];
  for (const it of items) {
    appendHistory(run, it.ref.page, {
      section: it.ref.section, reason: REASONS.duplicate, evidence: `promote_common（残した行 ${lineHash(newLine)}）`, replaced_by: firstLine(newLine),
      before: beforeOf(run.peek(it.ref.page), it.ref.section, it.item, items.filter((x) => x.ref.page === it.ref.page && x.ref.section === it.ref.section).map((x) => x.item)), lines: it.item.text.split("\n"),
    });
  }
  let commonDoc: Doc;
  if (run.docs.has(commonPath) || run.tx.docs.has(commonPath)) commonDoc = run.doc(commonPath);
  else {
    const created = emptyThemePage({ id: run.ctx.newId(), title: to.title, summary: to.title, scope: "common", project_id: null, today: run.ctx.today });
    commonDoc = docOf(renderPage(created));
    run.tx.docs.set(commonPath, commonDoc);
    run.tx.ids.set(String(created.frontmatter.id), commonPath);
  }
  if (!section(commonDoc, to.section)) reject("unknown_section");
  addToSection(commonDoc, to.section, newLine.split("\n"));
  const related = [...new Set([...relatedProjects(commonDoc), ...projects])];
  setFm(commonDoc, "related_projects", `[${related.join(", ")}]`);
  const commonTitle = titleOf(commonPath, commonDoc);
  const byPage = new Map<string, { heading: string; items: Item[] }[]>();
  for (const it of items) {
    const groups = byPage.get(it.ref.page) ?? [];
    const g = groups.find((x) => x.heading === it.ref.section);
    if (g) g.items.push(it.item); else groups.push({ heading: it.ref.section, items: [it.item] });
    byPage.set(it.ref.page, groups);
  }
  for (const [page, groups] of byPage) {
    const doc = run.doc(page);
    removeItems(doc, groups);
    if (!hasLink(doc, commonTitle)) addLink(doc, commonTitle, PROMOTE_RELATION);
    run.tallyOf(page, "promote_common");
  }
  run.tallyOf(commonPath, "promote_common");
  used(run, ...refs);
};

/** Locates `### … <id>` in a history file (fences skipped): the lines of the entry. */
function entryRange(doc: Doc, id: string): { start: number; end: number } | null {
  const sec = section(doc, HISTORY_SECTION);
  if (!sec) return null;
  let fence: string | null = null;
  let start = -1;
  for (let i = sec.head + 1; i < sec.end; i += 1) {
    const t = doc.lines[i].t;
    if (fence !== null) { if (t === fence) fence = null; continue; }
    if (start >= 0 && t.startsWith("### ")) { sec.end = i; break; }
    if (start < 0 && t.startsWith("### ") && t.endsWith(` ${id}`)) start = i;
    const open = /^(`{4,})text$/u.exec(t);
    if (open) fence = open[1];
  }
  if (start < 0) return null;
  let end = sec.end;
  while (end > start + 1 && doc.lines[end - 1].t.trim() === "") end -= 1;
  return { start, end };
}

const applyRestore: Applier = (run, op) => {
  const path = op.history as string;
  const hdoc = run.hists.get(path);
  if (!hdoc) return reject("unknown_entry");
  const entry = parseHistory(textOf(hdoc)).entries.find((e) => e.id === op.entry);
  if (!entry) return reject("unknown_entry");
  if (entry.restored !== null) reject("already_restored");
  const pageId = parseHistory(textOf(hdoc)).frontmatter.page_id;
  const page = typeof pageId === "string" ? run.ids.get(pageId) : undefined;
  if (!page || !run.writable(page) || run.docs.get(page) === undefined) return reject("page_not_writable");
  const doc = run.doc(page);
  const sec = section(doc, entry.section);
  if (!sec || entry.section === UPDATES) return reject(sec ? "section_not_allowed" : "unknown_section");
  const after = sec.items.find((i) => i.h === entry.before);
  let pos: number;
  if (after) pos = after.end;
  else if (entry.before === "（欄の先頭）" && sec.items.length > 0) pos = sec.items[0].start;
  else { addToSection(doc, entry.section, entry.lines); pos = -1; }
  if (pos >= 0) {
    for (let i = sec.end - 1; i > sec.head; i -= 1) if (isPlaceholder(doc.lines[i].t)) { doc.lines.splice(i, 1); if (i < pos) pos -= 1; }
    doc.lines.splice(pos, 0, ...entry.lines.map(mk));
  }
  const copy = cloneDoc(hdoc);
  const range = entryRange(copy, entry.id)!;
  copy.lines.splice(range.end, 0, mk(`- 復元: ${run.ctx.today}`));
  setFm(copy, "updated", run.ctx.today);
  run.tx.hists.set(path, copy);
  if (run.isDormant(page)) run.tx.activity.push({ page, action: "reactivate" });
  if (!revertAudit(doc, entry)) run.tallyOf(page, "restore", entry.id);
};

const APPLIERS: Readonly<Record<string, Applier>> = {
  merge: applyMerge, move: applyMove, retire: applyRetire, dormant: applyDormant, reactivate: applyReactivate,
  link: applyLink, split: applySplit, promote_common: applyPromote, restore: applyRestore,
};

/** Applies the operations one by one. A rejected operation changes nothing; the rest go on. */
export function applyOperations(state: PageOpsState, ops: readonly unknown[], ctx: PageOpsContext, opts: { allowCoreOps?: boolean } = {}): PageOpsResult {
  const run = new Run(state, ctx);
  const applied: PageOpsResult["applied"] = [];
  const rejected: PageOpsResult["rejected"] = [];
  ops.forEach((raw, index) => {
    run.begin();
    try {
      const op = validateShape(raw, opts.allowCoreOps === true);
      APPLIERS[op.op as string](run, op);
      // Every page an operation changes was valid before (or is new), so a template error here is the operation's own.
      for (const doc of run.tx.docs.values()) if (!validatePage(parsePage(textOf(doc)), { writer: "owl" }).ok) reject("page_invalid");
      run.commit();
      applied.push({ index, op: raw });
    } catch (error) {
      if (!(error instanceof Reject)) throw error;
      rejected.push({ index, op: raw, code: error.code });
    }
  });

  // One line per run on the pages that changed, then the final check of the untouched lines.
  for (const [page, labels] of run.tally) {
    const doc = run.docs.get(page);
    if (!doc) continue;
    const parts = [...labels].map(([label, { count, refs }]) => `${LABELS[label]} ${count}${refs.size > 0 ? `（${[...refs].join(", ")}）` : ""}`);
    addToSection(doc, UPDATES, [`- ${ctx.today} 司書: ${parts.join("・")}`], "start");
    setFm(doc, "updated", ctx.today);
  }
  const out: PageOpsState = { pages: new Map(), histories: new Map(), pageIds: run.ids };
  const touched = new Set<string>();
  const warnings = [...run.warnings];
  for (const [kind, docs, source, target] of [["page", run.docs, state.pages, out.pages], ["history", run.hists, state.histories, out.histories]] as const) {
    for (const [path, doc] of docs) {
      const text = textOf(doc);
      target.set(path, text);
      const before = source.get(path);
      if (before === text) continue;
      touched.add(path);
      if (before !== undefined) {
        const keptOriginals = new Set(doc.lines.filter((l) => l.o >= 0).map((l) => l.o));
        const count = before.split("\n").length - (before.endsWith("\n") ? 1 : 0);
        const removed = new Set(Array.from({ length: count }, (_, i) => i).filter((i) => !keptOriginals.has(i)));
        if (!verifyUntouched(before, text, removed, doc.lines.filter((l) => l.o < 0).length)) throw new Error(`untouched_lines_changed: ${path}`);
      }
      if (kind === "page") for (const w of validatePage(parsePage(text), { writer: "owl" }).warnings) warnings.push({ page: path, code: w.code, message: w.message });
    }
  }
  return { state: out, applied, rejected, warnings, activity: run.activity, touched };
}

/** Reads the vault under `root`, applies the operations and writes back only the files that changed. Rejected operations write nothing. */
export function applyOperationsToRoot(root: string, ops: readonly unknown[], ctx: PageOpsContext, opts: { allowCoreOps?: boolean } = {}): PageOpsResult {
  const state: PageOpsState = { pages: new Map(), histories: new Map(), pageIds: new Map() };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const text = readFileSync(join(root, rel), "utf8");
        if (posix.basename(dir) === "_history") state.histories.set(rel, text);
        else {
          state.pages.set(rel, text);
          const id = parsePage(text).frontmatter.id;
          if (typeof id === "string") state.pageIds.set(id, rel);
        }
      }
    }
  };
  walk("");
  const result = applyOperations(state, ops, ctx, opts);
  for (const path of result.touched) {
    const text = result.state.pages.get(path) ?? result.state.histories.get(path)!;
    mkdirSync(join(root, posix.dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return result;
}
