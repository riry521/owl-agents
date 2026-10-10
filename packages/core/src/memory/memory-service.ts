import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultEmbedder, DEFAULT_EMBEDDER_CONFIG, embeddingUnavailableWarning, type Embedder, type EmbedderHealth, type RetrievalProfile } from "./embedder.js";
import { MemoryIndex, type MemoryIndexOptions, type MemoryIndexStatus, type MemoryScanResult } from "./memory-index.js";
import type { MemoryMode } from "@owl/shared";
import { advisorKey, MemoryReadLedger } from "./memory-read-ledger.js";
import { estimatePageTokens, PAGE_LIMITS, SEARCHABLE_PAGE_KINDS, parsePage, setFrontmatter, type PageSection, type StoredKind } from "./page-format.js";
import { buildFilter, MemorySearch, type MemorySearchInput } from "./memory-search.js";
import { nextConversationName } from "./conversation-log-writer.js";
import { KIND_OF_SECTION, writeAtomic, type PageRouter, type RouteResult } from "./page-router.js";
import type { KnowledgeSearchResult } from "../knowledge-base.js";
import { MEMORY_TYPES, type MemoryLogger, type MemoryNoteRow, type MemoryNoteStatus, type MemoryNoteType, type MemoryRequestContext, type MemoryStoragePort } from "./memory-types.js";

export interface MemorySearchItem {
  readonly id: string; readonly path: string; readonly title: string; readonly type: MemoryNoteType;
  readonly summary: string; readonly status: MemoryNoteStatus; readonly importance: number;
  readonly updated: string | null; readonly score: number; readonly match: "fts" | "vec" | "both";
}

export interface MemorySearchOutput {
  readonly items: readonly MemorySearchItem[]; readonly stale: boolean; readonly index_at: string | null;
  readonly mode: "hybrid" | "fts"; readonly note?: string;
}

type Ref = { id: string; path: string; title: string };

export type MemoryExpandOutput =
  | { readonly found: true; readonly id: string; readonly path: string; readonly frontmatter: Record<string, string | readonly string[]>;
      readonly body: string | null; readonly truncated: boolean;
      readonly links_out: readonly { filename: string; title: string | null; status: MemoryNoteStatus | null; path: string | null; resolved: boolean }[];
      readonly linked_from: readonly Ref[];
      readonly superseded_chain: readonly (Ref & { status: MemoryNoteStatus })[];
      readonly stale: boolean }
  | { readonly found: false; readonly ambiguous: true; readonly candidates: readonly (Ref & { type: MemoryNoteType })[]; readonly stale: boolean }
  | { readonly found: false; readonly ambiguous: false; readonly did_you_mean: readonly Ref[]; readonly stale: boolean };

export interface MemoryRecallOutput {
  readonly items: readonly (MemorySearchItem & { readonly reason?: string })[];
  readonly superseded: readonly MemorySearchItem[];
  readonly explain?: readonly { id: string; reason: string }[];
  readonly stale: boolean; readonly index_at: string | null;
}

interface EvalMetrics { readonly recall_at_5: number; readonly recall_at_10: number; readonly mrr_at_10: number }

/** Latest `<dataDir>/memory-eval/*.json` written by scripts/memory-eval.mjs, with the design §5.3 pass lines. */
export interface MemoryEvalSummary {
  readonly measured_at: string; readonly model: string | null; readonly mode: string; readonly split: string;
  readonly page_types: readonly string[] | null; readonly lines: EvalLines;
  readonly overall: EvalMetrics; readonly keyword: EvalMetrics; readonly paraphrase: EvalMetrics;
  readonly checks: { readonly overall_recall5: boolean; readonly overall_mrr10: boolean; readonly paraphrase_recall5: boolean; readonly keyword_recall5: boolean; readonly vs_baseline: boolean; readonly no_regression: boolean };
  readonly passed: boolean;
}

/** Pass lines (design §5.3). A report may carry its own `lines` (passed to scripts/memory-eval.mjs with --lines, e.g. for a clipping-only eval set); otherwise the §5.3 defaults apply. */
export interface EvalLines { readonly recall5: number; readonly mrr10: number; readonly paraphrase5: number; readonly keyword5: number; readonly gain: number }
const DEFAULT_EVAL_LINES: EvalLines = { recall5: 0.7, mrr10: 0.55, paraphrase5: 0.6, keyword5: 0.6, gain: 0.4 };
const LINE_KEYS = ["recall5", "mrr10", "paraphrase5", "keyword5", "gain"] as const;
const linesFor = (raw: unknown): EvalLines =>
  typeof raw === "object" && raw !== null && LINE_KEYS.every((k) => Number.isFinite((raw as Record<string, unknown>)[k]))
    ? (Object.fromEntries(LINE_KEYS.map((k) => [k, (raw as Record<string, number>)[k]])) as unknown as EvalLines)
    : DEFAULT_EVAL_LINES;

const isMetrics = (m: unknown): m is EvalMetrics =>
  typeof m === "object" && m !== null && ["recall_at_5", "recall_at_10", "mrr_at_10"].every((k) => Number.isFinite((m as Record<string, unknown>)[k]));

const pick = (m: EvalMetrics): EvalMetrics => ({ recall_at_5: m.recall_at_5, recall_at_10: m.recall_at_10, mrr_at_10: m.mrr_at_10 });

function summarizeEval(raw: string): MemoryEvalSummary | null {
  const r = JSON.parse(raw) as { finished_at?: unknown; model?: unknown; mode?: unknown; split?: unknown; page_types?: unknown; lines?: unknown; metrics?: Record<string, unknown>; baseline_recall_at_5?: unknown; previous_recall_at_5?: unknown };
  const { all, "kind:keyword": keyword, "kind:paraphrase": paraphrase } = r.metrics ?? {};
  if (typeof r.finished_at !== "string" || !isMetrics(all) || !isMetrics(keyword) || !isMetrics(paraphrase)) return null;
  const lines = linesFor(r.lines);
  const checks = {
    overall_recall5: all.recall_at_5 >= lines.recall5, overall_mrr10: all.mrr_at_10 >= lines.mrr10,
    paraphrase_recall5: paraphrase.recall_at_5 >= lines.paraphrase5, keyword_recall5: keyword.recall_at_5 >= lines.keyword5,
    // 基準値が記録にないときは未確認として false (1e-9 は浮動小数の誤差の余裕)
    vs_baseline: typeof r.baseline_recall_at_5 === "number" && all.recall_at_5 - r.baseline_recall_at_5 >= lines.gain - 1e-9,
    no_regression: typeof r.previous_recall_at_5 === "number" && all.recall_at_5 - r.previous_recall_at_5 >= -0.03 - 1e-9,
  };
  return {
    measured_at: r.finished_at, model: typeof r.model === "string" ? r.model : null, mode: String(r.mode), split: String(r.split),
    page_types: Array.isArray(r.page_types) ? r.page_types.map(String) : null, lines,
    overall: pick(all), keyword: pick(keyword), paraphrase: pick(paraphrase), checks, passed: Object.values(checks).every(Boolean),
  };
}

/** Never throws: a missing directory or a broken JSON gives null. */
function latestEval(dataDir: string): MemoryEvalSummary | null {
  const dir = join(dataDir, "memory-eval");
  try {
    const latest = readdirSync(dir).filter((n) => n.endsWith(".json")).sort().pop();
    return latest ? summarizeEval(readFileSync(join(dir, latest), "utf8")) : null;
  } catch { return null; }
}

export interface MemoryHealth {
  readonly storage: { available: boolean; dir: string | null; since: string | null };
  readonly index: MemoryIndexStatus;
  readonly embedder: EmbedderHealth;
  readonly eval: MemoryEvalSummary | null;
  readonly queue: { pending_writes: null };
  readonly nightly: { last_run_at: null; status: null };
  readonly probe_ms: number | null;
  /** Theme-page state in pages mode (null when the index cannot be read); absent in legacy mode so its output stays unchanged. */
  readonly pages?: MemoryPagesHealth | null;
}

export interface MemoryPagesHealth {
  /** Pages the librarian failed to integrate several times in a row; only the nightly run retries them. */
  readonly integration_failed: readonly { path: string; failures: number; last_error: string; last_at: string }[];
  readonly index_over_budget: number;
  readonly pending_integration: number;
  readonly unresolved_links: number;
  readonly template_invalid: number;
  readonly theme_over_budget: number;
}

export interface PageBudget {
  readonly pages_used?: number; readonly pages_limit?: number; readonly tokens_used?: number; readonly tokens_limit?: number;
  readonly clippings_used?: number; readonly clippings_limit?: number;
}
export type PageReadOutput =
  | { readonly found: true; readonly path: string; readonly title: string; readonly kind: StoredKind; readonly text: string;
      readonly tokens: number; readonly truncated: boolean; readonly stale: boolean; readonly budget?: PageBudget }
  | { readonly found: false; readonly did_you_mean: readonly Ref[]; readonly stale: boolean }
  | { readonly error: "page_budget_exceeded"; readonly outline: readonly { section: string; lines: number }[]; readonly budget: PageBudget }
  | { readonly error: "clipping_budget_exceeded"; readonly budget: PageBudget }
  | { readonly error: "unknown_sections"; readonly outline: readonly { section: string; lines: number }[] }
  | { readonly error: "index_unavailable" };
export interface PageSearchItem { readonly path: string; readonly title: string; readonly summary: string; readonly score: number }
export interface PageSearchOutput { readonly items: readonly PageSearchItem[]; readonly stale: boolean; readonly note?: string; readonly error?: "index_unavailable" | "search_budget_exceeded" }

/** Cuts at a code point so the estimate stays within `limit`. */
function cutToTokens(text: string, limit: number): { text: string; truncated: boolean } {
  if (estimatePageTokens(text) <= limit) return { text, truncated: false };
  let total = 0;
  let out = "";
  for (const character of text) {
    total += (character.normalize("NFKC").codePointAt(0) ?? 0) <= 0x7f ? 0.25 : 1;
    if (Math.ceil(total) > limit) break;
    out += character;
  }
  return { text: out, truncated: true };
}

export type MemoryReindexOutput = MemoryScanResult & { readonly embedded?: number };

export interface MemoryServiceOptions {
  readonly dataDir: string;
  readonly storage: MemoryStoragePort;
  readonly embedder?: Embedder;
  /** Fusion weights, recorded in the index meta when embeddings are written. */
  readonly weights?: { readonly fts: number; readonly vec: number };
  readonly profile?: RetrievalProfile;
  readonly now?: () => Date;
  readonly logger?: MemoryLogger;
  readonly indexOptions?: Partial<MemoryIndexOptions>;
  /** Read-budget counter of the page tools; held in memory only. */
  readonly ledger?: MemoryReadLedger;
  /** Called with the Advisor session id and path when a theme page was handed to an Advisor (its "shown" version). */
  readonly onAdvisorPageShown?: (sessionId: string, path: string) => void;
  /** Days without being opened (and without a source Work update) before a theme page is a dormancy candidate; 90 when omitted. */
  readonly dormantDays?: () => number | undefined;
  /** Newest update day (`YYYY-MM-DD`) of the Works numbered `numbers` (the project's own; any project's when `projectId` is null), or null when none are known. */
  readonly sourceWorksUpdated?: (projectId: string | null, numbers: readonly number[]) => string | null;
  /** Pages the page librarian gave up on (health `pages.integration_failed`). */
  readonly integrationFailed?: () => MemoryPagesHealth["integration_failed"];
  /** Where `append` writes; without it the Advisor append tool is unavailable. */
  readonly router?: Pick<PageRouter, "route">;
  /** Rebuilds the Project's index after an append, so a new theme page is listed without waiting for the librarian. */
  readonly rebuildProjectIndex?: (projectId: string) => Promise<unknown>;
}

export type MemoryAppendError = "invalid_section" | "empty_text" | "project_required" | "append_unavailable";
export type MemoryAppendOutput = RouteResult | { readonly error: MemoryAppendError };

const UNAVAILABLE_NOTE = "索引を利用できません。health で確認";
const DAY_MS = 86_400_000;
const DEFAULT_DORMANT_DAYS = 90;

export class MemoryService {
  public readonly index: MemoryIndex;
  public readonly searcher: MemorySearch;
  private readonly embedder: Embedder;
  private readonly storage: MemoryStoragePort;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly logger?: MemoryLogger;
  private readonly weights: { fts: number; vec: number };
  private readonly profile: RetrievalProfile;
  private readonly options: MemoryServiceOptions;
  private readonly ledger: MemoryReadLedger;
  private failed: string | null = null;
  private embedding: Promise<number> | null = null;

  public constructor(options: MemoryServiceOptions) {
    this.options = options;
    this.ledger = options.ledger ?? new MemoryReadLedger();
    this.storage = options.storage;
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    this.embedder = options.embedder ?? createDefaultEmbedder();
    this.weights = { fts: options.weights?.fts ?? 1, vec: options.weights?.vec ?? 1 };
    this.profile = options.profile ?? DEFAULT_EMBEDDER_CONFIG.profile;
    this.index = new MemoryIndex({
      dataDir: options.dataDir, storage: options.storage, now: options.now, logger: options.logger,
      // Edits are embedded only while the child is already up; a stopped child waits for the next search.
      onScanned: () => { if (this.embedder.model && this.embedder.isReady()) void this.embedPending().catch((error: unknown) => this.logger?.warn("Background embedding failed", error)); },
      ...options.indexOptions,
    });
    this.searcher = new MemorySearch({ index: this.index, embedder: this.embedder, weights: this.weights, profile: this.profile, now: this.now, logger: this.logger });
  }

  /** Never throws: a failing index is reported through `health().index.last_error`. */
  public async start(): Promise<void> {
    try {
      await this.index.start();
    } catch (error) {
      this.failed = (error as Error).message;
      this.logger?.warn("memory index failed to start", error);
    }
  }

  /** Takes pages reads offline (search, table of contents, page reads answer "unavailable") after a failed start. */
  public markUnavailable(reason: string): void { this.failed = reason; }

  /** Waits for the first index scan, so rows of files that left the vault are gone before the index is used. */
  public whenScanned(): Promise<void> {
    return this.index.whenScanned();
  }

  public async stop(): Promise<void> {
    await this.index.stop().catch((error) => this.logger?.warn("memory index failed to stop", error));
    await this.embedder.stop();
  }

  private item(hit: { row: MemoryNoteRow; rel: number; match: "fts" | "vec" | "both" }): MemorySearchItem {
    const r = hit.row;
    return { id: r.id, path: r.path, title: r.title, type: r.type, summary: r.summary, status: r.status, importance: r.importance, updated: r.updated, score: Math.round(hit.rel * 1e4) / 1e4, match: hit.match };
  }

  /** Single-flight: embeds the notes that have no vectors yet. Rejects when the embedder or sqlite-vec is unavailable. */
  private embedPending(): Promise<number> {
    this.embedding ??= this.index.embedPending(this.embedder, this.profile, { rrf_w_fts: String(this.weights.fts), rrf_w_vec: String(this.weights.vec) })
      .finally(() => { this.embedding = null; });
    return this.embedding;
  }

  public async search(input: MemorySearchInput, _ctx?: MemoryRequestContext): Promise<MemorySearchOutput> {
    if (this.failed) return { items: [], stale: true, index_at: null, mode: "fts", note: UNAVAILABLE_NOTE };
    // The first search starts the child and embeds in the background; this search answers from what exists.
    if (this.embedder.model) this.embedPending().catch((error) => this.logger?.warn("memory embedding failed", error));
    try {
      const result = await this.searcher.search({ ...input, limit: Math.min(input.limit ?? 8, 30), ...this.templateOnly() });
      return {
        items: result.hits.map((hit) => this.item(hit)), stale: result.stale, index_at: result.index_at, mode: result.mode,
        ...(result.hits.length === 0 ? { note: "0 件。保管庫の状態は health で確認" } : {}),
      };
    } catch (error) {
      this.logger?.warn("memory search failed", error);
      return { items: [], stale: true, index_at: null, mode: "fts", note: UNAVAILABLE_NOTE };
    }
  }

  /** Records today as the page's last open; a dormant page goes back to `active` in its file and in the index. */
  private async touchPage(path: string): Promise<void> {
    try {
      this.index.markOpened(path, this.now().toISOString().slice(0, 10));
      if (this.index.pageStatus(path) !== "dormant") return;
      const withWrite = this.storage.withWrite;
      if (!withWrite) throw new Error("storage has no write lock");
      await withWrite.call(this.storage, async () => {
        const file = join(this.storage.activeDir(), path);
        const text = readFileSync(file, "utf8");
        // One line is edited, not a parse-and-render: that would drop what the parser does not keep (block lists, comments, CRLF).
        if (parsePage(text).frontmatter.status === "dormant") await writeAtomic(file, setFrontmatter(text, "status", "active"));
      });
      await this.index.refreshChanged();
    } catch (error) {
      this.logger?.warn("memory page open was not recorded", error);
    }
  }

  /** Pages to put to sleep: not opened for `dormantDays` (default 90) and whose cited source Works (`W<number>`) were not updated within that time either. */
  public async dormantCandidates(): Promise<readonly { path: string; title: string; updated: string | null; last_opened: string | null }[]> {
    const days = this.options.dormantDays?.() ?? DEFAULT_DORMANT_DAYS;
    const cutoff = new Date(this.now().getTime() - days * DAY_MS).toISOString().slice(0, 10);
    const out: { path: string; title: string; updated: string | null; last_opened: string | null }[] = [];
    for (const r of this.index.dormantCandidates(cutoff)) {
      // A page deleted since the last scan is no candidate; it must not end the list for the rest.
      const text = await this.storage.withRead(async () => readFileSync(join(this.storage.activeDir(), r.path), "utf8")).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (text === null) continue;
      const numbers = [...new Set([...text.matchAll(/\bW(\d+)\b/gu)].map((m) => Number(m[1])))];
      const sourceDay = this.options.sourceWorksUpdated?.(r.project_id, numbers) ?? r.updated ?? "";
      if (sourceDay < cutoff) out.push({ path: r.path, title: r.title, updated: r.updated, last_opened: this.index.lastOpened(r.path) });
    }
    return out;
  }

  public async expand(input: { note: string; include_body?: boolean; max_bytes?: number }, ctx?: MemoryRequestContext): Promise<MemoryExpandOutput> {
    const out = await this.expandNote(input, ctx);
    if (out.found) await this.touchPage(out.path);
    return out;
  }

  private async expandNote(input: { note: string; include_body?: boolean; max_bytes?: number }, _ctx?: MemoryRequestContext): Promise<MemoryExpandOutput> {
    const status = this.index.status();
    const { match, candidates } = this.index.resolveNoteRef(input.note);
    const ref = (r: MemoryNoteRow): Ref => ({ id: r.id, path: r.path, title: r.title });
    if (!match) {
      if (candidates.length > 0) return { found: false, ambiguous: true, candidates: candidates.slice(0, 10).map((r) => ({ ...ref(r), type: r.type })), stale: status.stale };
      const similar = await this.searcher.search({ query: input.note, limit: 5, include_raw: true, include_archived: true, include_superseded: true });
      return { found: false, ambiguous: false, did_you_mean: similar.hits.map((h) => ref(h.row)), stale: status.stale };
    }
    const db = this.index.db();
    const rowidOf = (db.prepare("SELECT rowid FROM notes WHERE path = ?").get(match.path) as { rowid: number }).rowid;
    const links = db.prepare("SELECT raw, dst_rowid FROM links WHERE src_rowid = ?").all(rowidOf) as { raw: string; dst_rowid: number | null }[];
    const linkedFrom = db.prepare("SELECT DISTINCT src_rowid FROM links WHERE dst_rowid = ?").all(rowidOf) as { src_rowid: number }[];
    const chain: (Ref & { status: MemoryNoteStatus })[] = [];
    const seen = new Set<string>([match.path]);
    for (let next = match.superseded_by, i = 0; next && i < 10; i += 1) {
      const found = this.index.resolveNoteRef(next).match;
      if (!found || seen.has(found.path)) break;
      seen.add(found.path);
      chain.push({ ...ref(found), status: found.status });
      next = found.superseded_by;
    }
    const body = input.include_body === false ? null : await this.index.readBody(match, input.max_bytes ?? 20_000);
    const stored = db.prepare("SELECT frontmatter_json FROM notes WHERE rowid = ?").get(rowidOf) as { frontmatter_json: string };
    return {
      found: true, id: match.id, path: match.path, frontmatter: JSON.parse(stored.frontmatter_json) as Record<string, string | string[]>,
      body: body?.body ?? null, truncated: body?.truncated ?? false,
      links_out: links.map((l) => {
        const target = l.dst_rowid === null ? null : this.index.getByRowid(l.dst_rowid);
        return { filename: l.raw, title: target?.title ?? null, status: target?.status ?? null, path: target?.path ?? null, resolved: target !== null };
      }),
      linked_from: linkedFrom.map((l) => this.index.getByRowid(l.src_rowid)).filter((r): r is MemoryNoteRow => r !== null).map(ref),
      superseded_chain: chain,
      stale: body?.stale ?? status.stale,
    };
  }

  public mode(): MemoryMode { return "pages"; }
  /** Only files of the 4 templates are knowledge. */
  private templateOnly(): { page_types?: readonly StoredKind[]; template_valid_only?: boolean } { return { page_types: SEARCHABLE_PAGE_KINDS, template_valid_only: true }; }

  private budgetKey(ctx: MemoryRequestContext): string {
    const run = ctx.agent_run_id ?? `anon:${ctx.caller}`;
    if (!ctx.agent_run_id) this.logger?.warn(`memory read without agent_run_id (${ctx.caller}); counted as ${run}`);
    return ctx.caller === "advisor" ? advisorKey(run) : run;
  }

  private async pageNear(query: string): Promise<Ref[]> {
    const similar = await this.searcher.search({ query, limit: 5, include_raw: true, include_archived: true, include_superseded: true, ...this.templateOnly() });
    return similar.hits.map((h) => ({ id: h.row.id, path: h.row.path, title: h.row.title }));
  }

  /**
   * Appends one line to a Project theme page through the PageRouter, the way a compacted conversation does (label 会話<日付>-<n>, n numbered as ConversationLogWriter does).
   * Only the template sections the router writes are accepted; nothing is deleted or rewritten.
   */
  public async append(input: { project_id?: string | null; section: string; text: string; theme?: string; procedure?: string }, ctx: MemoryRequestContext): Promise<MemoryAppendOutput> {
    if (!this.options.router) return { error: "append_unavailable" };
    const kind = Object.hasOwn(KIND_OF_SECTION, input.section) ? KIND_OF_SECTION[input.section] : undefined;
    if (!kind) return { error: "invalid_section" };
    if (input.text.trim() === "") return { error: "empty_text" };
    const projectId = input.project_id ?? ctx.project_id;
    if (!projectId) return { error: "project_required" };
    const day = this.now().toISOString().slice(0, 10);
    const label = `会話${(await nextConversationName(this.storage.activeDir(), day)).replace(/\.md$/u, "")}`;
    const routed = await this.options.router.route({
      kind, text: input.text, procedure: input.procedure, theme: input.theme ?? "", project_id: projectId, append_only: true,
      source: { work_number: null, work_id: null, actor: "advisor", label },
    });
    if (routed.status === "appended") await this.options.rebuildProjectIndex?.(projectId);
    return routed;
  }

  /** The Project's index page (the common one when `project_id` is null). Not counted against the read budget. */
  public async readIndex(input: { project_id?: string | null }, ctx: MemoryRequestContext): Promise<PageReadOutput> {
    if (this.failed) return { error: "index_unavailable" };
    const projectId = input.project_id === undefined ? ctx.project_id : input.project_id;
    const row = this.index.getProjectIndex(projectId);
    const note = row ? this.index.resolveNoteRef(row.path).match : null;
    if (!row || !note) return { found: false, did_you_mean: [], stale: this.index.status().stale };
    const { body, stale } = await this.index.readBody(note, 100_000);
    return { found: true, path: row.path, title: row.title, kind: row.page_type, text: body, tokens: estimatePageTokens(body), truncated: false, stale };
  }

  /** Themes cost a page and tokens; every other page costs a clipping and is cut at `clipping_open_tokens`. */
  public async page(input: { page: string; sections?: readonly string[] }, ctx: MemoryRequestContext): Promise<PageReadOutput> {
    const out = await this.readPage(input, ctx);
    if ("found" in out && out.found) await this.touchPage(out.path);
    return out;
  }

  private async readPage(input: { page: string; sections?: readonly string[] }, ctx: MemoryRequestContext): Promise<PageReadOutput> {
    if (this.failed) return { error: "index_unavailable" };
    const resolved = this.index.resolvePageRef(input.page);
    const row = resolved && resolved.template_valid === true ? resolved : null;
    const note = row ? this.index.resolveNoteRef(row.path).match : null;
    if (!row || !note) return { found: false, did_you_mean: await this.pageNear(input.page), stale: this.index.status().stale };
    const { body, stale } = await this.index.readBody(note, 200_000);
    const all = parsePage(body).sections;
    const outline = all.map((s) => ({ section: s.heading, lines: s.lines.length }));
    const picked = input.sections?.length ? all.filter((s) => input.sections!.includes(s.heading)) : null;
    if (picked?.length === 0) return { error: "unknown_sections", outline };
    const render = (list: readonly PageSection[]): string => list.map((s) => `## ${s.heading}\n${s.lines.join("\n")}`.trimEnd()).join("\n\n");
    const key = this.budgetKey(ctx);
    const done = (text: string, truncated: boolean, budget?: PageBudget): PageReadOutput => {
      if (ctx.caller === "advisor" && ctx.agent_run_id) this.options.onAdvisorPageShown?.(ctx.agent_run_id, row.path);
      return { found: true, path: row.path, title: row.title, kind: row.page_type, text, tokens: estimatePageTokens(text), truncated, stale, ...(budget ? { budget } : {}) };
    };
    const text = picked ? render(picked) : body;
    if (row.page_type === "project-index" || ctx.caller === "owner") return done(text, false);
    if (row.page_type !== "theme") {
      const charge = this.ledger.chargeClipping(key, ctx.caller, row.path);
      if (!charge.ok) return { error: "clipping_budget_exceeded", budget: { clippings_used: charge.used, clippings_limit: charge.limit } };
      const cut = cutToTokens(text, PAGE_LIMITS.clipping_open_tokens);
      return done(cut.text, cut.truncated, { clippings_used: charge.used, clippings_limit: charge.limit });
    }
    let charged = this.ledger.chargePage(key, ctx.caller, { path: row.path, tokens: estimatePageTokens(text) });
    let out = text;
    let truncated = false;
    if (!charged.ok) {
      // Only a narrowed read can shrink; without `sections` the caller gets the outline to choose from.
      // Shrink to the longest leading run whose rendered text (joins included) the ledger accepts.
      let fitted: PageSection[] | null = null;
      for (let n = (picked?.length ?? 0) - 1; n >= 1 && !fitted; n--) {
        const candidate = render(picked!.slice(0, n));
        const attempt = this.ledger.chargePage(key, ctx.caller, { path: row.path, tokens: estimatePageTokens(candidate) });
        if (attempt.ok) { fitted = picked!.slice(0, n); out = candidate; charged = attempt; }
      }
      if (!fitted) {
        return { error: "page_budget_exceeded", outline, budget: { pages_used: charged.pages_used, pages_limit: charged.pages_limit, tokens_used: charged.used, tokens_limit: charged.limit } };
      }
      truncated = true;
    }
    return done(out, truncated, { pages_used: charged.pages_used, pages_limit: charged.pages_limit, tokens_used: charged.used, tokens_limit: charged.limit });
  }

  /** Clippings (and work records when asked). At most `search_items` items within `search_tokens`. */
  public async searchPages(input: { query: string; include_work_log?: boolean }, ctx: MemoryRequestContext): Promise<PageSearchOutput> {
    if (this.failed) return { items: [], stale: true, error: "index_unavailable" };
    if (ctx.caller !== "owner") {
      const charge = this.ledger.chargeSearch(this.budgetKey(ctx), ctx.caller);
      if (!charge.ok) return { items: [], stale: false, error: "search_budget_exceeded" };
    }
    try {
      const result = await this.searcher.search({
        query: input.query, limit: PAGE_LIMITS.search_items, include_raw: true, ...this.templateOnly(),
        page_types: input.include_work_log ? ["clipping", "work-log"] : ["clipping"],
        ...(input.include_work_log && ctx.project_id ? { work_log_project_id: ctx.project_id } : {}),
      });
      const items = result.hits.slice(0, PAGE_LIMITS.search_items).map((h): PageSearchItem => ({
        path: h.row.path, title: h.row.title, summary: [...h.row.summary].slice(0, 100).join(""), score: Math.round(h.rel * 1e4) / 1e4,
      }));
      let out: PageSearchOutput = { items, stale: result.stale, ...(items.length === 0 ? { note: "0 件" } : {}) };
      while (out.items.length > 0 && estimatePageTokens(JSON.stringify(out)) > PAGE_LIMITS.search_tokens) {
        out = { ...out, items: out.items.slice(0, -1) };
      }
      return out;
    } catch (error) {
      this.logger?.warn("memory page search failed", error);
      return { items: [], stale: true, error: "index_unavailable" };
    }
  }

  /** Stage ①-1 ordering: relevance, recency and importance only (design §5.4 score1). */
  public async recall(input: { topic?: string; types?: MemoryNoteType[]; limit?: number; explain?: boolean }, ctx?: MemoryRequestContext): Promise<MemoryRecallOutput> {
    const limit = Math.min(input.limit ?? 20, 50);
    const types = input.types ?? [...MEMORY_TYPES];
    const filter = { query: input.topic ?? "", types, limit: 50, include_superseded: true, project_id: ctx?.project_id ?? null, ...this.templateOnly() };
    const result = await this.searcher.search(filter);
    let hits = result.hits;
    if (!input.topic) {
      const { sql, params } = buildFilter(filter);
      const rows = this.index.db().prepare(`SELECT n.rowid FROM notes n WHERE ${sql} ORDER BY n.updated DESC LIMIT 50`).all(...params) as { rowid: number }[];
      hits = rows.map((r, i) => ({ row: this.index.getByRowid(r.rowid) as MemoryNoteRow, rowid: r.rowid, rrf: 0, rel: 1 - i / 100, match: "fts" as const, fts_rank: i + 1, vec_rank: null, vec_similarity: null }));
    }
    const score1 = (h: (typeof hits)[number]): number => {
      const ageDays = Math.max(0, (this.now().getTime() - Date.parse(h.row.updated ?? "")) / DAY_MS);
      const rec = h.row.type === "preference" || h.row.type === "north-star" || Number.isNaN(ageDays) ? 1 : Math.exp(-Math.LN2 * ageDays / 90);
      return (0.6 * h.rel + 0.15 * rec + 0.15 * ((h.row.importance - 1) / 4)) / 0.9;
    };
    const ranked = hits.map((h) => ({ h, s: score1(h) })).sort((a, b) => b.s - a.s);
    const toItem = ({ h, s }: { h: (typeof hits)[number]; s: number }): MemorySearchItem & { reason: string } =>
      ({ ...this.item({ ...h, rel: s }), reason: `rel=${h.rel.toFixed(2)} importance=${h.row.importance}` });
    const active = ranked.filter(({ h }) => h.row.status === "active" || h.row.status === "dormant").slice(0, limit).map(toItem);
    return {
      items: input.explain ? active : active.map(({ reason: _reason, ...rest }) => rest),
      superseded: ranked.filter(({ h }) => h.row.status === "superseded").slice(0, 5).map(toItem),
      ...(input.explain ? { explain: active.map((i) => ({ id: i.id, reason: i.reason })) } : {}),
      stale: result.stale, index_at: result.index_at,
    };
  }

  public async health(): Promise<MemoryHealth> {
    let probe: number | null = null;
    try {
      const started = Date.now();
      await this.searcher.search({ query: "owl", limit: 1 });
      probe = Date.now() - started;
    } catch { /* index unavailable: probe stays null */ }
    const index = this.index.status();
    const embedder = this.embedder.health();
    const warning = index.vec_error
      ? [embedder.warning, embeddingUnavailableWarning(index.vec_error)].filter(Boolean).join(" ")
      : embedder.warning;
    let pages: MemoryPagesHealth | null = null;
    try {
      const { index_over_budget, pending_integration, unresolved_links, template_invalid, theme_over_budget } = this.index.pageStats();
      pages = { integration_failed: this.options.integrationFailed?.() ?? [], index_over_budget, pending_integration, unresolved_links, template_invalid, theme_over_budget };
    } catch { /* index unavailable: pages stays null */ }
    return {
      storage: this.storage.status(), index, embedder: { ...embedder, warning },
      eval: latestEval(this.dataDir), queue: { pending_writes: null }, nightly: { last_run_at: null, status: null }, probe_ms: probe,
      pages,
    };
  }

  public async reindex(input: { mode: "diff" | "full"; embed?: boolean }): Promise<MemoryReindexOutput> {
    const scan = await (input.mode === "full" ? this.index.rebuild("manual") : this.index.refreshChanged());
    return input.embed ? { ...scan, embedded: await this.embedPending() } : scan;
  }

  public searchKnowledgeCompat(query: string, tags: readonly string[]): Promise<KnowledgeSearchResult[] | null> {
    return this.failed ? Promise.resolve(null) : this.searcher.searchKnowledgeCompat(query, tags);
  }

  public notifyChanged(paths?: readonly string[]): void { this.index.notifyChanged(paths); }
  public onStorageAvailable(): Promise<void> { return this.index.onStorageAvailable(); }
  public onStorageUnavailable(): void { this.index.onStorageUnavailable(); }
  public onStorageSwitched(): Promise<void> { return this.index.onStorageSwitched(); }
}
