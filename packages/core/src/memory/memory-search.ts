import { compareText } from "../context-canonical.js";
import type Database from "better-sqlite3";

import { extractSnippet, type KnowledgeSearchResult } from "../knowledge-base.js";
import { DEFAULT_EMBEDDER_CONFIG, type Embedder, type RetrievalProfile } from "./embedder.js";
import type { MemoryIndex } from "./memory-index.js";
import type { StoredKind } from "./page-format.js";
import type { MemoryLogger, MemoryNoteRow, MemoryNoteType } from "./memory-types.js";

export interface MemorySearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly types?: readonly MemoryNoteType[];
  readonly scope?: "global" | "project" | "all";
  readonly include_superseded?: boolean;
  readonly include_raw?: boolean;
  readonly include_archived?: boolean;
  readonly project_id?: string | null;
  /** Note ids left out at the query stage (e.g. already injected), so paging past the result cap works. */
  readonly exclude_ids?: readonly string[];
  /** Layout page kinds (`notes.page_type`) to search; every kind stays in when omitted. */
  readonly page_types?: readonly StoredKind[];
  /** Only files that pass their template check (`notes.template_valid = 1`). */
  readonly template_valid_only?: boolean;
  /** Work records of other Projects are left out; other kinds are unaffected. */
  readonly work_log_project_id?: string;
}

export interface MemorySearchHit {
  readonly row: MemoryNoteRow; readonly rowid: number;
  readonly rrf: number;
  /** rrf / max rrf (0–1). */
  readonly rel: number;
  readonly match: "fts" | "vec" | "both";
  readonly fts_rank: number | null; readonly vec_rank: number | null;
  /** Cosine similarity of the note's nearest chunk (body or title+summary); null when it was not among the vector candidates. */
  readonly vec_similarity: number | null;
}

export interface MemorySearchResult {
  readonly hits: readonly MemorySearchHit[];
  readonly mode: "hybrid" | "fts";
  readonly stale: boolean; readonly index_at: string | null;
}

export interface FtsQueryPlan {
  /** `"abc" OR "bcd" …` over trigrams, or null. */
  readonly trigramMatch: string | null;
  /** Segments matched as phrases (they earn a bonus). */
  readonly phrases: readonly string[];
  /** Segments of two characters or fewer, matched with LIKE on title, summary and tags. */
  readonly likeTerms: readonly string[];
  readonly normalized: string;
}

const MAX_QUERY_CHARS = 2000;
const MAX_TRIGRAMS = 128;
const CANDIDATE_LIMIT = 500;
const HIRAGANA_ONLY = /^[ぁ-ゟ]+$/u;
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const STRONG_JAPANESE = /[\p{Script=Han}\p{Script=Katakana}]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

const quote = (term: string): string => `"${term.replace(/"/gu, '""')}"`;
const likePattern = (term: string): string => `%${term.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

/** Splits on whitespace, punctuation and symbols, except `-`, `_` and `.` between alphanumerics. */
function segments(normalized: string): string[] {
  const chars = [...normalized];
  const out: string[] = [];
  let current = "";
  chars.forEach((ch, i) => {
    const inner = "-_.".includes(ch) && WORD_CHAR.test(chars[i - 1] ?? "") && WORD_CHAR.test(chars[i + 1] ?? "");
    if (inner || !/[\s\p{P}\p{S}]/u.test(ch)) current += ch;
    else { if (current) out.push(current); current = ""; }
  });
  if (current) out.push(current);
  return [...new Set(out)];
}

/** `content`: a Japanese segment is cut at hiragana runs, so particles and verb endings stop producing trigrams. */
const cutAtHiragana = (segment: string): string[] => (JAPANESE.test(segment) ? segment.split(/[ぁ-ゟ]+/u).filter(Boolean) : [segment]);

export function buildFtsQueryPlan(query: string, content = false): FtsQueryPlan {
  const normalized = query.normalize("NFKC").toLowerCase().trim().slice(0, MAX_QUERY_CHARS);
  const japaneseQuery = JAPANESE.test(normalized);
  const phrases: string[] = [];
  const likeTerms: string[] = [];
  const trigrams = new Set<string>();
  // A quoted multi-word phrase keeps its boundary: it earns one phrase bonus only as a contiguous string.
  const quoted = [...normalized.matchAll(/"([^"]+)"/gu)].map((m) => segments(m[1] ?? ""));
  for (const words of quoted) if (words.length > 1 && words.join(" ").length > 2) phrases.push(words.join(" "));
  const multi = new Set(quoted.filter((w) => w.length > 1).flat());
  const whole = segments(normalized.replace(/"([^"]+)"/gu, " $1 "));
  const planSegments = content ? [...new Set(whole.flatMap(cutAtHiragana))] : whole;
  for (const segment of planSegments) {
    const length = [...segment].length;
    if (length <= 2) {
      if (!HIRAGANA_ONLY.test(segment)) likeTerms.push(segment);
      continue;
    }
    if (!multi.has(segment)) phrases.push(segment);
    if (japaneseQuery && !JAPANESE.test(segment)) continue;
    // Preserve exact phrase matching for one English token or punctuation-joined terms.
    if (!japaneseQuery && (planSegments.length === 1 || /[-_.]/u.test(segment))) continue;
    const chars = [...segment];
    for (let i = 0; i + 3 <= chars.length; i += 1) {
      const gram = chars.slice(i, i + 3).join("");
      if (!HIRAGANA_ONLY.test(gram)) trigrams.add(gram);
    }
  }
  const ordered = [...trigrams].sort((a, b) => Number(STRONG_JAPANESE.test(b)) - Number(STRONG_JAPANESE.test(a))).slice(0, MAX_TRIGRAMS);
  return { trigramMatch: ordered.length > 0 ? ordered.map(quote).join(" OR ") : null, phrases, likeTerms, normalized };
}

interface Filter { readonly sql: string; readonly params: (string | number)[] }

export function buildFilter(input: MemorySearchInput): Filter {
  const clauses = ["n.status != 'draft'"];
  const params: (string | number)[] = [];
  if (input.types && input.types.length > 0) {
    clauses.push(`n.type IN (${input.types.map(() => "?").join(",")})`);
    params.push(...input.types);
  }
  if (input.page_types) {
    clauses.push(`n.page_type IN (${input.page_types.map(() => "?").join(",") || "NULL"})`);
    params.push(...input.page_types);
  }
  if (input.template_valid_only) clauses.push("n.template_valid = 1");
  if (input.work_log_project_id) {
    clauses.push("(n.page_type != 'work-log' OR n.page_project_id = ?)");
    params.push(input.work_log_project_id);
  }
  if (input.exclude_ids?.length) {
    clauses.push(`n.id NOT IN (${input.exclude_ids.map(() => "?").join(",")})`);
    params.push(...input.exclude_ids);
  }
  if (!input.include_raw) clauses.push("n.type NOT IN ('raw','log')");
  if (!input.include_superseded) clauses.push("n.status != 'superseded'");
  if (!input.include_archived) clauses.push("n.status != 'archived'");
  const scope = input.scope ?? "all";
  const projectClause = input.project_id ? "(n.scope = 'project' AND n.project_ids_json LIKE ?)" : "0";
  if (scope === "global") clauses.push("n.scope = 'global'");
  else {
    clauses.push(scope === "project" ? projectClause : `(n.scope = 'global' OR ${projectClause})`);
    if (input.project_id) params.push(`%"${input.project_id}"%`);
  }
  return { sql: clauses.join(" AND "), params };
}

/** Lexical score per matching row: 2·phrase hits + 1·LIKE hits + normalized bm25 (design §5.2). */
function lexScores(db: Database.Database, plan: FtsQueryPlan, filter: Filter): Map<number, number> {
  const scores = new Map<number, number>();
  const bump = (rowid: number, by: number): void => { scores.set(rowid, (scores.get(rowid) ?? 0) + by); };
  const where = filter.sql;
  if (plan.trigramMatch) {
    const rows = db.prepare(
      `SELECT n.rowid AS rowid, -bm25(notes_fts, 10.0, 5.0, 5.0, 0.1) AS s FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
       WHERE notes_fts MATCH ? AND ${where} ORDER BY s DESC, n.path ASC LIMIT ${CANDIDATE_LIMIT}`,
    ).all(plan.trigramMatch, ...filter.params) as { rowid: number; s: number }[];
    const max = Math.max(...rows.map((r) => r.s), 0);
    for (const r of rows) bump(r.rowid, max > 0 ? r.s / max : 0);
  }
  for (const phrase of plan.phrases) {
    const rows = db.prepare(
      `SELECT n.rowid AS rowid FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? AND ${where} ORDER BY n.path ASC LIMIT ${CANDIDATE_LIMIT}`,
    ).all(quote(phrase), ...filter.params) as { rowid: number }[];
    for (const r of rows) bump(r.rowid, 2);
  }
  for (const term of plan.likeTerms) {
    const pattern = likePattern(term);
    const rows = db.prepare(
      `SELECT n.rowid AS rowid FROM notes n WHERE (n.title LIKE ? ESCAPE '\\' OR n.summary LIKE ? ESCAPE '\\' OR n.tags_text LIKE ? ESCAPE '\\') AND ${where} ORDER BY n.path ASC LIMIT ${CANDIDATE_LIMIT}`,
    ).all(pattern, pattern, pattern, ...filter.params) as { rowid: number }[];
    for (const r of rows) bump(r.rowid, 1);
  }
  return scores;
}

/** Rowids matching any trigram in title, summary or tags only, best bm25 first. */
function headRank(db: Database.Database, plan: FtsQueryPlan, filter: Filter, top: number): number[] {
  if (!plan.trigramMatch) return [];
  return (db.prepare(
    `SELECT n.rowid AS rowid FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
     WHERE notes_fts MATCH ? AND ${filter.sql} ORDER BY bm25(notes_fts, 10.0, 5.0, 5.0, 0.0), n.path ASC LIMIT ${top}`,
  ).all(`{title summary tags} : (${plan.trigramMatch})`, ...filter.params) as { rowid: number }[]).map((r) => r.rowid);
}

export const RRF_K = 60;

/** Weighted reciprocal rank fusion: score(d) = Σ w_i / (60 + rank_i(d)), ranks starting at 1. */
export function fuseRrf(lists: readonly { readonly weight: number; readonly ids: readonly number[] }[]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const { weight, ids } of lists) ids.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + i + 1)));
  return scores;
}

export class MemorySearch {
  private readonly index: MemoryIndex;
  private readonly embedder?: Embedder;
  private readonly weights: { fts: number; vec: number };
  private readonly profile: RetrievalProfile;
  private readonly logger?: MemoryLogger;

  public constructor(deps: { index: MemoryIndex; embedder?: Embedder; weights?: { fts: number; vec: number }; profile?: RetrievalProfile; now?: () => Date; logger?: MemoryLogger }) {
    this.index = deps.index;
    this.embedder = deps.embedder;
    this.weights = deps.weights ?? { fts: 1, vec: 1 };
    this.profile = deps.profile ?? DEFAULT_EMBEDDER_CONFIG.profile;
    this.logger = deps.logger;
  }

  /** Nearest notes to the query (by body chunk, and by title+summary). Empty when there is no embedder, no vectors yet, or the embedder failed (health reports why). */
  private async vecRank(input: MemorySearchInput, filter: Filter): Promise<{ body: number[]; head: number[]; similarity: Map<number, number> }> {
    const none = { body: [], head: [], similarity: new Map<number, number>() };
    if (!this.embedder || this.weights.vec <= 0 || !this.index.hasVectors()) return none;
    try {
      const [query] = await this.embedder.embed("query", [input.query.slice(0, this.profile.queryChars)], { timeoutMs: 30_000, maxTokens: this.profile.maxTokens });
      if (!query) return none;
      const near = this.index.nearest(query);
      const all = [...near.body, ...near.head];
      const ok = new Set((this.index.db().prepare(`SELECT n.rowid AS rowid FROM notes n WHERE n.rowid IN (${all.map(() => "?").join(",") || "NULL"}) AND ${filter.sql}`).all(...all, ...filter.params) as { rowid: number }[]).map((r) => r.rowid));
      const keep = (ids: number[]): number[] => ids.filter((rowid) => ok.has(rowid)).slice(0, this.profile.ftsTop);
      return { body: keep(near.body), head: keep(near.head), similarity: near.similarity };
    } catch (error) {
      this.logger?.warn("vector search failed; answering from FTS only", error);
      return none;
    }
  }

  /** Rowids ordered by lex desc, then updated desc, then path asc. */
  private rank(plan: FtsQueryPlan, filter: Filter): number[] {
    const db = this.index.db();
    const scores = lexScores(db, plan, filter);
    if (scores.size === 0) return [];
    const meta = new Map<number, { updated: string; path: string }>();
    const ids = [...scores.keys()];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const r of db.prepare(`SELECT rowid, coalesce(updated, '') AS updated, path FROM notes WHERE rowid IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as { rowid: number; updated: string; path: string }[]) meta.set(r.rowid, r);
    }
    return ids.sort((a, b) => {
      const d = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
      if (d !== 0) return d;
      const ma = meta.get(a)!;
      const mb = meta.get(b)!;
      if (ma.updated !== mb.updated) return ma.updated < mb.updated ? 1 : -1;
      return ma.path < mb.path ? -1 : 1;
    });
  }

  public async search(input: MemorySearchInput): Promise<MemorySearchResult> {
    const status = this.index.status();
    const plan = buildFtsQueryPlan(input.query, this.profile.content);
    const limit = Math.max(1, Math.min(input.limit ?? 8, 100));
    const filter = buildFilter(input);
    const ftsIds = this.weights.fts > 0 ? this.rank(plan, filter).slice(0, this.profile.ftsTop) : [];
    const near = await this.vecRank(input, filter);
    const vecIds = near.body;
    const scores = fuseRrf([
      { weight: this.weights.fts, ids: ftsIds }, { weight: this.weights.vec, ids: vecIds },
      { weight: this.profile.headVec, ids: near.head },
      { weight: this.profile.ftsHead, ids: this.profile.ftsHead > 0 && this.weights.fts > 0 ? headRank(this.index.db(), plan, filter, this.profile.ftsTop) : [] },
    ]);
    const maxRrf = (Math.max(this.weights.fts, 0) + (vecIds.length > 0 ? this.weights.vec : 0)) / (RRF_K + 1) || 1;
    const hits: MemorySearchHit[] = [];
    for (const [rowid, rrf] of scores) {
      const row = this.index.getByRowid(rowid);
      if (!row || rrf <= 0) continue;
      const f = ftsIds.indexOf(rowid) + 1;
      const v = vecIds.indexOf(rowid) + 1;
      const penalty = row.status === "superseded" ? 0.3 : 1;
      hits.push({ row, rowid, rrf: rrf * penalty, rel: Math.min(1, rrf / maxRrf) * penalty, match: f && v ? "both" : v ? "vec" : "fts", fts_rank: f || null, vec_rank: v || null, vec_similarity: near.similarity.get(rowid) ?? null });
    }
    hits.sort((a, b) => (a.row.status === "superseded" ? 1 : 0) - (b.row.status === "superseded" ? 1 : 0) || b.rrf - a.rrf || compareText(a.row.path, b.row.path));
    return { stale: status.stale, index_at: status.last_scan_at, mode: vecIds.length > 0 ? "hybrid" : "fts", hits: hits.slice(0, limit) };
  }

  /**
   * Same result shape as the old `KnowledgeBase.search`: every old substring match first, then up to 20 FTS-only matches.
   * Returns null when the index has never been built, so the caller falls back to walking the vault.
   */
  public searchKnowledgeCompat(query: string, tags: readonly string[]): Promise<KnowledgeSearchResult[] | null> {
    try {
      const db = this.index.db();
      if (!this.index.status().built_at) return Promise.resolve(null);
      const all: Filter = { sql: "1 = 1", params: [] };
      const toResult = (row: MemoryNoteRow, body: string): KnowledgeSearchResult => ({
        path: row.path, title: row.title, mtime: new Date(row.mtime).toISOString(), tags: [...row.tags], snippet: extractSnippet(body, query),
      });
      const matchesTags = (row: MemoryNoteRow): boolean => tags.every((t) => row.tags.includes(t));
      const load = (rowids: number[]): { row: MemoryNoteRow; body: string }[] => {
        const out: { row: MemoryNoteRow; body: string }[] = [];
        for (const rowid of rowids) {
          const row = this.index.getByRowid(rowid);
          if (row && matchesTags(row)) out.push({ row, body: (db.prepare("SELECT body FROM notes WHERE rowid = ?").get(rowid) as { body: string }).body });
        }
        return out;
      };
      if (!query) {
        const rowids = (db.prepare("SELECT rowid FROM notes ORDER BY mtime DESC").all() as { rowid: number }[]).map((r) => r.rowid);
        return Promise.resolve(load(rowids).map(({ row, body }) => toResult(row, body)));
      }
      const lower = query.toLowerCase();
      const substring = (db.prepare(
        "SELECT rowid FROM notes WHERE instr(lower(filename), ?) > 0 OR instr(lower(body), ?) > 0 OR instr(lower(tags_text), ?) > 0 OR instr(lower(title), ?) > 0",
      ).all(lower, lower, lower, lower) as { rowid: number }[]).map((r) => r.rowid);
      const plan = buildFtsQueryPlan(query);
      const scores = lexScores(db, plan, all);
      const byLex = (a: number, b: number): number => (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
      const mtimeOf = new Map<number, number>();
      for (const rowid of [...substring, ...scores.keys()]) mtimeOf.set(rowid, (db.prepare("SELECT mtime FROM notes WHERE rowid = ?").get(rowid) as { mtime: number }).mtime);
      const first = [...substring].sort((a, b) => byLex(a, b) || (mtimeOf.get(b) ?? 0) - (mtimeOf.get(a) ?? 0));
      const seen = new Set(first);
      const second = [...scores.keys()].filter((id) => !seen.has(id)).sort(byLex);
      const extra = load(second).slice(0, 20);
      return Promise.resolve([...load(first), ...extra].map(({ row, body }) => toResult(row, body)));
    } catch (error) {
      this.logger?.warn("memory search failed; falling back to scanning the vault", error);
      return Promise.resolve(null);
    }
  }
}
