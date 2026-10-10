import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { KNOWLEDGE_EXTERNAL_COMMAND_RULE } from "@owl/shared";
import { createUlid } from "../../../db/dist/index.js";
import type { IndexScope } from "./index-builder.js";
import type { PageQuery, PageRow } from "./memory-types.js";
import { bodySha256, estimatePageTokens, findSecretPatterns, lineHash, maskSecrets, PAGE_LIMITS, pageSize, type PageSize, parsePage, setFrontmatter, UPDATES_SECTION, validatePage } from "./page-format.js";
import { newLinesOf, type MemoryLibrarianSetting } from "./page-integration.js";
import type { RouteInput, RouteResult } from "./page-router.js";
import { applyOperations, itemsOf, parseOperationsOutput, stripNew, type PageOpsContext, type PageOpsState } from "./page-operations.js";
import { OTHER_NOTES_TITLE, writeAtomic } from "./page-router.js";
import { normalizeOp, type OpDefinitions } from "../op-shape.js";

/** The page librarian (design §3, §4): the model names operations, the applier of page-operations.ts is the only writer of page text. */

export type PageRunMode = "nightly" | "manual";
export interface PageRunInput {
  readonly run_id: string;
  readonly mode: PageRunMode;
  /** Vault-relative paths; only these pages are sent with their items when given. */
  readonly paths?: readonly string[];
}
export interface PageActionReport {
  readonly path: string;
  readonly action: "updated" | "created";
}
/** What a rejected operation looked like: names and types only, never values (they may hold page text or secrets). */
export interface RejectedOp { readonly index: number; readonly code: string; readonly op?: string; readonly op_type?: string; readonly keys?: readonly string[]; readonly shape?: string; readonly detail?: Record<string, unknown> }
const SHAPE_NAME_MAX = 64;
const SHAPE_KEYS_MAX = 20;
const shapeType = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
export function describeRejectedOp(op: unknown): Pick<RejectedOp, "op" | "op_type" | "keys" | "shape"> {
  if (typeof op !== "object" || op === null || Array.isArray(op)) return { shape: shapeType(op) };
  const o = op as Record<string, unknown>;
  return {
    ...(typeof o.op === "string" ? { op: o.op.slice(0, SHAPE_NAME_MAX) } : { op_type: shapeType(o.op) }),
    keys: Object.keys(o).slice(0, SHAPE_KEYS_MAX).map((k) => k.slice(0, SHAPE_NAME_MAX)),
  };
}

export interface PageRunReport {
  readonly run_id: string;
  readonly mode: PageRunMode;
  readonly pages: PageActionReport[];
  readonly applied: number;
  readonly rejected: readonly RejectedOp[];
  readonly warnings: readonly { readonly page?: string; readonly code: string; readonly message: string }[];
  readonly remaining: number;
  readonly llm_calls: number;
  readonly input_tokens: number;
  readonly backup_dir: string | null;
  readonly skipped?: string;
  readonly error?: string;
  /** Why the run ended; absent on reports Core builds itself (busy, ...). */
  readonly stop_reason?: "done" | "no_progress" | "max_batches" | "skipped" | "error";
}
export interface PagePendingStats {
  readonly pending_conversations: number;
  readonly unused_clippings: number;
  /** Seconds since the oldest pending file was last modified; null when nothing is pending. */
  readonly oldest_pending_age_seconds: number | null;
}
export interface PageFailure { readonly path: string; readonly failures: number; readonly last_error: string; readonly last_at: string }

/** Where a line lives: copied whole by the model, so it never builds a ref from parts of different entries. */
export interface RequestLineRef { readonly page: string; readonly section: string; readonly h: string }
export interface RequestSectionItems {
  readonly section: string;
  readonly items: readonly { readonly ref: RequestLineRef; readonly text: string }[];
}
/** What the model receives: the theme pages with their items (the units operations point at) and the pages that may go dormant. */
export interface LibrarianOpsRequest {
  readonly run_id: string;
  readonly pages: readonly {
    readonly path: string; readonly title: string; readonly summary: string; readonly scope: "project" | "common"; readonly project_id: string | null;
    readonly status: string; readonly new_lines: number;
    /** Some `free` value is negative: its items are always sent, and it is to be split. */
    readonly over_limit: boolean;
    /** Pages of the same scope and project (not this page): the only destinations split `into` and move may use. */
    readonly move_to: readonly string[];
    /** Room left before each limit (negative = over): tokens, and lines per section except 更新履歴, which Core moves to _history itself before the operations. Null for a page that is not a theme. */
    readonly free: { readonly tokens: number; readonly lines: Readonly<Record<string, number>> } | null;
    /** Null when the page was left out of the token budget (or is dormant): it can still be linked or reactivated. */
    readonly items: readonly RequestSectionItems[] | null;
  }[];
  readonly dormant_candidates: readonly string[];
  /** Operations the previous run's last batch had rejected: do not propose them again. */
  readonly previous_rejections: readonly Record<string, unknown>[];
  /** Conversation logs marked `extraction: pending`: the decisions and learnings are yet to be taken out. */
  readonly conversations: readonly { readonly path: string; readonly h: string; readonly text: string }[];
  /** Clippings without a 使いどころ line. */
  readonly clippings: readonly { readonly path: string; readonly h: string; readonly title: string; readonly summary: string; readonly points: readonly string[] }[];
  readonly rules: string;
  readonly model: MemoryLibrarianSetting;
  readonly max_output_tokens: number;
}
export type LibrarianOpsResult =
  | { readonly ok: true; readonly output: unknown; readonly usage?: { input_tokens: number; output_tokens: number } }
  | { readonly ok: false; readonly error: string };
export type ProposeOperationsFn = (request: LibrarianOpsRequest) => Promise<LibrarianOpsResult>;

export const LIBRARIAN_RULES = [
  "Output only JSON {\"operations\":[...]} (optionally \"note\"). Never output page text; there is no way to rewrite a page.",
  "Point at a line by copying its `ref` object from `items` exactly as given; never combine the page or section of one entry with the h of another. Common and project pages can share a title and section names, and only `ref.page` tells them apart. A line marked `<!-- owl:new … -->` is new: take it in with move (to its own page and section, or the page it belongs to, which also drops the mark), merge it into an existing line, or retire it as a duplicate. When a new line already sits in the right page and section, confirm it with confirm{items} (refs copied from `items`, only lines marked owl:new), which drops the mark and changes nothing else. Do not leave new lines behind.",
  "Every operation is one flat object whose \"op\" field names it, like {\"op\":\"merge\",\"items\":[…],\"into\":{…},\"text\":\"…\"}. Never wrap it as {\"merge\":{…}}.",
  "Operations: merge{items,into,text,star?} · move{item,to} · retire{item,reason,evidence,replaced_by?} · link{from,to,relation} · split{page,items,relation,into} or split{page,items,relation,new_title,new_summary} · promote_common{items,to:{title,section},text?} · confirm{items} · dormant{page} · reactivate{page}.",
  "Field types: a line reference is the object {page,section,h} copied from `items` and nothing else; `item`, `replaced_by`, `evidence.kept` and every element of `items` are line references. `into` of merge and move and `to` of move and promote_common are {page,section} or {title,section}; split's `into` is not an object (see below). link `from`/`to` and the `page` of dormant/reactivate are page paths as plain strings, e.g. link{from:\"projects/a/x.md\",to:\"projects/b/y.md\",relation:\"…\"}. merge needs at least 2 items; to take a single line in, use move. split `into` is a page path string copied from `pages[].path`.",
  "retire reasons: contradiction (evidence {works:[\"W812\",…]} = newer Work numbers, and replaced_by = the line that wins), missing_path (evidence {paths:[…]} = repository paths that no longer exist; project pages only), duplicate (evidence {kept:{page,section,h}} = the line you keep).",
  "When lines contradict, prefer the newer Work's statement and retire the older one. Never retire a line the Owner wrote (no Work source and no owl:new mark) and never retire without evidence.",
  "Merge duplicate lines into one; keep one line per fact. Link pages that belong together. Move a rule that holds across Projects to a common page with promote_common.",
  "Conversations: for each entry of `conversations`, output {op:\"take_conversation\", conversation: its path, h: its h, items:[{kind:\"decision\"|\"pitfall\"|\"fact\", text}]} with the decisions the Owner agreed to and the pitfalls/facts learned (one line each, no Work sources). The program appends them to theme pages as new lines.",
  "Clippings: for each entry of `clippings`, output {op:\"set_usage\", clipping: its path, h: its h, text} where text is one line saying when to use the clipping.",
  "Pages with over_limit true are over a limit, and `free` shows the room left (tokens, and lines per section; a negative number is over). Every section with negative room must come down, 概要 and 決まりごと as well as 落とし穴. Move its lines out with split, grouped by theme; each line keeps its section. Give each destination one split that carries all the lines going there. To add lines to a listed page of the same scope and project_id, use split{page,items,relation,into:\"<that page's path>\"}. Create a page with split{page,items,relation,new_title,new_summary} only when no listed page fits. A page that receives lines must fit every limit afterwards, so never send lines to a page with over_limit true, and send no more than its `free` allows. A page that only gives lines may stay over a limit while it shrinks, but nothing over a limit may grow and nothing within a limit may cross it; such an operation is rejected. While any page is over a limit, bring it down first: taking new lines in does not count as progress until every page fits. When the page is the 「その他」 page (title " + OTHER_NOTES_TITLE + ") or a numbered continuation of it, never create or fill a numbered continuation page (a title or path ending in a number); move each line to a page named for its theme, new or listed. Also merge pages and lines of similar themes instead of leaving small near-duplicates.",
  "`move_to` of each page lists the only pages that may receive its lines (same scope and project); never send lines anywhere else, and never promote a project line to a common page with split. `previous_rejections` holds operations rejected last time: do not propose them again; choose another destination or fewer lines.",
  "dormant only for pages listed in `dormant_candidates`; never delete or shorten lines to fit a size limit.",
  "Every text field is one line without Work sources, ULIDs, API keys or tokens.",
  KNOWLEDGE_EXTERNAL_COMMAND_RULE,
].join("\n");

export interface PageLibrarianOptions {
  readonly vault: {
    isAvailable(): boolean;
    activeDir(): string;
    withWrite<T>(fn: () => Promise<T>): Promise<T>;
  };
  readonly dataDir: string;
  readonly index: {
    refresh(): Promise<unknown>;
    listPages(query: PageQuery): readonly PageRow[];
  };
  readonly propose: ProposeOperationsFn;
  /** Appends a taken-out line to a theme page with an owl:new mark (PageRouter). Without it conversation logs are left alone. */
  readonly router?: { route(input: RouteInput): Promise<RouteResult> };
  readonly model: () => MemoryLibrarianSetting;
  /** At most `max_items` conversation logs + clippings and `max_input_tokens` estimated tokens go into one request; the rest waits for the next run. */
  readonly batch?: () => { readonly max_items: number; readonly max_input_tokens: number; readonly max_batches?: number };
  /** Pages that have not been opened or cited for the dormant period (T4). */
  readonly dormantCandidates?: () => Promise<readonly { readonly path: string }[]>;
  readonly workExists?: (number: number) => boolean;
  readonly conversationExists?: (name: string) => boolean;
  /** Whether a repository path is missing in the Project's configured repository; "unavailable" when that cannot be told. */
  readonly pathMissing?: (projectId: string | null, path: string) => "missing" | "exists" | "unavailable";
  /**
   * Rebuilds the index pages of the scopes whose theme pages this run changed, and Home.md; runs inside the write lease.
   * `backup` must be called with each file's path before it is written, so a failed run can put it back.
   */
  readonly rebuildIndexes?: (scopes: readonly IndexScope[], backup: (rel: string) => Promise<void>) => Promise<unknown>;
  readonly onChanged?: (paths: readonly string[]) => void;
  readonly limits?: { readonly input_tokens?: number; readonly output_tokens?: number; readonly consecutive_failures?: number; readonly backup_days?: number };
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly logger?: { warn(message: string, error?: unknown): void };
}

const DAY_MS = 86_400_000;
const FAILURE_FILE = "memory-page-failures.json";
const FAILURE_KEY = "(librarian)";
const REJECTION_FILE = "memory-page-rejections.json";
const REJECTION_MAX = 10;
const BACKUP_FOLDER = join("backups", "memory-pages");
/** Each batch's raw model output and rejected operations, under `<backup_dir>/batch-N/`. */
export const LIBRARIAN_OUTPUT_FILE = "librarian-output.json";
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const normalizePath = (path: string): string => posix.normalize(path.replace(/\\/gu, "/")).replace(/^\.?\//u, "");

const USAGE = "使いどころ";
// Definitions of the two operations judged here instead of in page-operations; they feed the shared shape normalizer.
const EXTRA_SPECS: OpDefinitions = {
  take_conversation: { required: { conversation: "string", h: "string", items: "items" } },
  set_usage: { required: { clipping: "string", h: "string", text: "string" } },
};
const EXTRA_OPS = new Set(Object.keys(EXTRA_SPECS));
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[\r\n]/u.test(v) && findSecretPatterns(v).length === 0;

/** Puts `- line` under 使いどころ (in place of its placeholder, or as a new section before 関係する Project); every other line stays as it was. Null when there is no such place or it is already filled. */
function withUsage(text: string, line: string): string | null {
  const lines = text.split("\n");
  const cr = lines[0]?.endsWith("\r") ? "\r" : "";
  const head = lines.findIndex((l) => l.replace(/\r$/u, "") === `## ${USAGE}`);
  if (head >= 0) {
    let end = lines.findIndex((l, i) => i > head && l.startsWith("## "));
    if (end < 0) end = lines.length;
    const body = lines.slice(head + 1, end).map((l) => l.trim());
    if (body.some((l) => /^[-*] /u.test(l) && l !== "- （なし）")) return null;
    const placeholder = lines.findIndex((l, i) => i > head && i < end && /^(- )?（なし）$/u.test(l.trim()));
    if (placeholder >= 0) lines.splice(placeholder, 1, `- ${line}${cr}`);
    else lines.splice(head + 1, 0, `- ${line}${cr}`);
    return lines.join("\n");
  }
  const next = lines.findIndex((l) => l.replace(/\r$/u, "") === "## 関係する Project");
  if (next < 0) return null;
  lines.splice(next, 0, `## ${USAGE}${cr}`, `- ${line}${cr}`, cr);
  return lines.join("\n");
}

type Timed<T> = T & { readonly at: number };
interface PendingScan {
  readonly conversations: readonly Timed<LibrarianOpsRequest["conversations"][number]>[];
  readonly clippings: readonly Timed<LibrarianOpsRequest["clippings"][number]>[];
}
const modifiedAt = async (path: string): Promise<number> => (await stat(path).catch(() => null))?.mtimeMs ?? 0;

class WriteError extends Error {
  public constructor(public readonly path: string, cause: unknown) { super(messageOf(cause)); }
}

interface RunContext {
  readonly backupDir: string;
  readonly backedUp: Set<string>;
  readonly created: Set<string>;
  readonly touched: Set<string>;
  /** sha256 of what this run last wrote per file, so a restore never overwrites someone else's edit. */
  readonly written: Map<string, string>;
}

export class PageLibrarian {
  private readonly now: () => Date;
  private readonly limits: { input_tokens: number; output_tokens: number; consecutive_failures: number; backup_days: number };
  private failures: Map<string, PageFailure> | null = null;

  public constructor(private readonly options: PageLibrarianOptions) {
    this.now = options.now ?? (() => new Date());
    this.limits = {
      input_tokens: options.limits?.input_tokens ?? PAGE_LIMITS.librarian_run_tokens,
      output_tokens: options.limits?.output_tokens ?? PAGE_LIMITS.librarian_output_tokens,
      consecutive_failures: options.limits?.consecutive_failures ?? 3,
      backup_days: options.limits?.backup_days ?? 30,
    };
  }

  /** The librarian failed `consecutive_failures` times in a row. */
  public integrationFailed(): readonly PageFailure[] {
    return [...this.loadFailures().values()].filter((f) => f.failures >= this.limits.consecutive_failures);
  }

  /** Repeats batches while unread input, an over-limit excess or (with nothing over a limit) new lines shrink, up to `batch().max_batches` (1 without it, and for manual `paths`). */
  public async run(input: PageRunInput): Promise<PageRunReport> {
    const maxBatches = input.paths ? 1 : this.options.batch?.().max_batches ?? 1;
    const total: { -readonly [K in keyof PageRunReport]: PageRunReport[K] } = {
      run_id: input.run_id, mode: input.mode, pages: [], applied: 0, rejected: [], warnings: [], remaining: 0, llm_calls: 0, input_tokens: 0, backup_dir: null,
    };
    let before = this.options.vault.isAvailable() ? await this.measure() : null;
    for (let n = 1; ; n++) {
      const batch = await this.runBatch(input, n);
      for (const page of batch.pages) if (!total.pages.some((p) => p.path === page.path)) total.pages.push(page);
      total.applied += batch.applied;
      total.llm_calls += batch.llm_calls;
      total.input_tokens += batch.input_tokens;
      total.rejected = [...total.rejected, ...batch.rejected];
      total.warnings = [...total.warnings, ...batch.warnings];
      total.remaining = batch.remaining;
      if (batch.backup_dir !== null) total.backup_dir = join(this.options.dataDir, BACKUP_FOLDER, input.run_id);
      total.error = batch.error;
      total.skipped = batch.skipped;
      if (batch.skipped) { total.stop_reason = "skipped"; break; }
      if (batch.error) { total.stop_reason = "error"; break; }
      const after = await this.measure();
      if (done(after)) { total.stop_reason = "done"; break; }
      if (before === null || !progressed(before, after)) { total.stop_reason = "no_progress"; break; }
      if (n >= maxBatches) { total.stop_reason = "max_batches"; break; }
      before = after;
    }
    return total;
  }

  /** What is left to do, counted from the index and the active theme pages (owl:new marks left out of the sizes). */
  private async measure(): Promise<WorkLeft> {
    await this.options.index.refresh();
    const root = this.options.vault.activeDir();
    const pending = await this.scanPending();
    const left: { -readonly [K in keyof WorkLeft]: WorkLeft[K] } = { pending: pending.conversations.length + pending.clippings.length, new_lines: 0, over_sections: 0, excess_lines: 0, excess_tokens: 0 };
    for (const row of this.options.index.listPages({ types: ["theme"], status: ["active"] })) {
      left.new_lines += row.owl_new_count;
      const text = await readText(join(root, row.path));
      const size = text === null ? null : sizeOf(stripNew(text));
      if (size === null) continue;
      const excess = excessOf(size);
      left.over_sections += excess.over_sections;
      left.excess_lines += excess.excess_lines;
      left.excess_tokens += excess.excess_tokens;
    }
    return left;
  }

  private async runBatch(input: PageRunInput, batchNo: number): Promise<PageRunReport> {
    const report: { -readonly [K in keyof PageRunReport]: PageRunReport[K] } = {
      run_id: input.run_id, mode: input.mode, pages: [], applied: 0, rejected: [], warnings: [], remaining: 0, llm_calls: 0, input_tokens: 0, backup_dir: null,
    };
    if (!this.options.vault.isAvailable()) return { ...report, skipped: "storage_unavailable" };
    const runDir = join(this.options.dataDir, BACKUP_FOLDER, input.run_id);
    const ctx: RunContext = { backupDir: join(runDir, `batch-${batchNo}`), backedUp: new Set(), created: new Set(), touched: new Set(), written: new Map() };
    // Conversation/clipping results are settled per item in `ctx`; theme and index writes use `rest`, so their failure never undoes settled items.
    const rest: RunContext = { backupDir: join(ctx.backupDir, "after-items"), backedUp: new Set(), created: new Set(), touched: new Set(), written: new Map() };
    const calls: Record<string, unknown>[] = [];
    let appliedCall: number | null = null;
    let saved = false;
    let parsed: ReturnType<typeof parseOperationsOutput> | { error: string } | null = null;
    // Failing to keep the output only costs the investigation trail, so it never fails the run.
    const saveOutput = async (): Promise<void> => {
      if (calls.length === 0) return;
      const rejected = report.rejected.map((r) => ({ index: r.index, code: r.code, ...(r.detail ? { detail: r.detail } : {}), op: parsed !== null && "ops" in parsed ? parsed.ops[r.index] : undefined }));
      const record = maskSecrets({ run_id: input.run_id, batch: batchNo, at: this.now().toISOString(), calls, applied_call: appliedCall, rejected });
      try {
        await mkdir(ctx.backupDir, { recursive: true });
        await writeFile(join(ctx.backupDir, LIBRARIAN_OUTPUT_FILE), `${JSON.stringify(record, null, 2)}\n`);
        saved = true;
      } catch (error) {
        this.options.logger?.warn("Could not save the librarian output", error);
      }
    };
    let settled: { applied: number; pages: string[] } = { applied: 0, pages: [] };
    try {
      await this.pruneBackups();
      await this.options.index.refresh();
      const rows = this.options.index.listPages({ types: ["theme"], status: ["active", "dormant", "archived"] });
      const pending = await this.scanPending();
      if (rows.length === 0 && pending.conversations.length === 0 && pending.clippings.length === 0) return report;
      const candidates = new Set((await this.options.dormantCandidates?.() ?? []).map((c) => normalizePath(c.path)));
      const limit = this.options.batch?.().max_input_tokens ?? Number.POSITIVE_INFINITY;
      // An output over the limit is not thrown away: the same batch is asked again with half of the items it actually held (conversations, clippings and detailed pages together) until one is left.
      let built = await this.buildRequest(input, rows, candidates, pending);
      for (;;) {
        report.input_tokens = estimatePageTokens(JSON.stringify(built.request));
        if (report.input_tokens > limit) {
          await saveOutput();
          return { ...report, error: "input_over_limit", backup_dir: saved ? ctx.backupDir : null };
        }
        report.llm_calls += 1;
        const proposed = await this.call(built.request);
        parsed = !proposed.ok ? { error: proposed.error }
          : estimatePageTokens(JSON.stringify(proposed.output ?? null)) > this.limits.output_tokens ? { error: "output_over_limit" }
            : parseOperationsOutput(proposed.output);
        calls.push({ n: report.llm_calls, ok: proposed.ok, ...(proposed.ok ? { ...(proposed.usage ? { usage: proposed.usage } : {}), output: proposed.output } : { error: proposed.error }), ...("error" in parsed && proposed.ok ? { parse_error: parsed.error } : {}) });
        if (!("error" in parsed) || parsed.error !== "output_over_limit" || built.size <= 1) break;
        const smaller = await this.buildRequest(input, rows, candidates, pending, Math.floor(built.size / 2));
        if (smaller.size >= built.size) break; // over-limit pages stay in whatever the cap: the same input would only fail again
        built = smaller;
      }
      const { conversations, clippings } = built;
      if (parsed === null || "error" in parsed) {
        const error = parsed?.error ?? "no_output";
        this.recordFailure(error);
        await saveOutput();
        return { ...report, error, backup_dir: saved ? ctx.backupDir : null };
      }
      appliedCall = report.llm_calls;
      const themeOps: { op: unknown; index: number }[] = [];
      const extraOps: { op: unknown; index: number }[] = [];
      parsed.ops.forEach((raw, index) => {
        const flat = normalizeOp(raw, EXTRA_SPECS);
        // Only these two are taken here; every other shape goes on unchanged to applyOperations, which has its own table.
        if (flat !== null) extraOps.push({ op: flat, index });
        else themeOps.push({ op: raw, index });
      });
      // Lines taken out of conversations go first, so the theme pass below sees (and stamps around) them.
      const extra = await this.applyExtra(extraOps, rows, { conversations, clippings }, ctx);
      settled = extra;
      await this.options.vault.withWrite(async () => {
        await this.applyAll(themeOps.map((o) => o.op), rows, candidates, rest, report);
      });
      report.applied += extra.applied;
      // The rejected index is a position in themeOps; it is mapped back to parsed.ops before the operation is looked up and saved.
      report.rejected = [...report.rejected.map((r) => ({ ...r, index: themeOps[r.index]?.index ?? r.index })), ...extra.rejected].sort((a, b) => a.index - b.index);
      const allOps = parsed.ops;
      await this.saveRejections(report.rejected.map((r) => ({ ...r, raw: allOps[r.index] })));
      for (const path of extra.pages) if (!report.pages.some((p) => p.path === path)) report.pages.push({ path, action: "updated" });
      await this.rebuildIndexes(rest, ctx.touched);
      this.clearFailure();
      report.remaining = await this.countNewLines();
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      await this.restore(rest);
      this.recordFailure(`write_failed:${error.message}`);
      report.pages = settled.pages.map((path) => ({ path, action: "updated" as const }));
      report.applied = settled.applied;
      report.error = `write_failed:${error.message}`;
      rest.touched.clear();
    }
    await saveOutput();
    const written = [...ctx.touched, ...rest.touched];
    if (written.length > 0) this.options.onChanged?.(written);
    const kept = ctx.backedUp.size > 0 ? ctx : rest.backedUp.size > 0 ? rest : null;
    return { ...report, backup_dir: kept ? kept.backupDir : saved ? ctx.backupDir : null };
  }

  private async call(request: LibrarianOpsRequest): Promise<LibrarianOpsResult> {
    try {
      return await this.options.propose(request);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /**
   * One batch: the oldest pending conversations and clippings up to the item and token limits (the request's fixed part counts too;
   * an entry too long for what is left is skipped, never cut, so it is never marked done unread), then pages with new lines first, then those that may go
   * dormant, then the rest, with what budget remains.
   */
  private async buildRequest(input: PageRunInput, rows: readonly PageRow[], candidates: ReadonlySet<string>, pending: PendingScan, cap = Number.POSITIVE_INFINITY): Promise<{ request: LibrarianOpsRequest; conversations: LibrarianOpsRequest["conversations"]; clippings: LibrarianOpsRequest["clippings"]; size: number }> {
    const batch = this.options.batch?.() ?? { max_items: Number.POSITIVE_INFINITY, max_input_tokens: Number.POSITIVE_INFINITY };
    const root = this.options.vault.activeDir();
    const wanted = input.paths ? new Set(input.paths.map(normalizePath)) : null;
    const loaded = await Promise.all(rows.map(async (row) => ({ row, text: await readText(join(root, row.path)) })));
    const usable = loaded.filter((entry): entry is { row: PageRow; text: string } => entry.text !== null);
    // Over-limit pages are ranked first and their items always go in, so a big page without new lines is never left unsplit.
    const free = new Map(usable.map((entry) => [entry.row.path, freeOf(sizeOf(entry.text))]));
    const over = new Map([...free].map(([path, f]) => [path, f !== null && (f.tokens < 0 || Object.values(f.lines).some((v) => v < 0))]));
    const rank = (entry: { row: PageRow; text: string }): number => (over.get(entry.row.path) || newLinesOf(entry.text).length > 0 ? 0 : candidates.has(entry.row.path) ? 1 : 2);
    usable.sort((a, b) => rank(a) - rank(b) || a.row.path.localeCompare(b.row.path));
    const meta = (row: PageRow, text: string) => ({
      over_limit: over.get(row.path) === true,
      move_to: usable.filter((o) => o.row.path !== row.path && o.row.page_scope === row.page_scope && o.row.project_id === row.project_id).map((o) => o.row.path),
      free: free.get(row.path) ?? null,
      path: row.path, title: row.title, summary: row.summary, scope: row.page_scope === "common" ? "common" as const : "project" as const,
      project_id: row.project_id, status: row.status, new_lines: (text.match(/<!--\s*owl:new\b/gu) ?? []).length,
    });
    const fixed: LibrarianOpsRequest = {
      run_id: input.run_id, pages: usable.map(({ row, text }) => ({ ...meta(row, text), items: null })), dormant_candidates: [...candidates], previous_rejections: this.loadRejections(), conversations: [], clippings: [],
      rules: LIBRARIAN_RULES, model: this.options.model(), max_output_tokens: this.limits.output_tokens,
    };
    let room = batch.max_input_tokens - estimatePageTokens(JSON.stringify(fixed));
    const queue = [
      ...pending.conversations.map((item) => ({ kind: "conversation" as const, item })),
      ...pending.clippings.map((item) => ({ kind: "clipping" as const, item })),
    ].sort((a, b) => a.item.at - b.item.at);
    // `cap` is the shared item count (entries first, then detailed pages) of a retry after an output over the limit.
    queue.splice(Math.max(1, Math.min(batch.max_items, cap)));
    const conversations: LibrarianOpsRequest["conversations"][number][] = [];
    const clippings: LibrarianOpsRequest["clippings"][number][] = [];
    for (const { kind, item: { at: _at, ...item } } of queue) {
      const cost = estimatePageTokens(JSON.stringify(item));
      if (cost > room) continue; // never cut an entry: it stays pending for a larger limit, and smaller ones behind it still go
      room -= cost;
      if (kind === "conversation") conversations.push(item as LibrarianOpsRequest["conversations"][number]);
      else clippings.push(item as LibrarianOpsRequest["clippings"][number]);
    }
    let budget = Math.min(this.limits.input_tokens, Math.max(0, room));
    let size = conversations.length + clippings.length;
    const pages = usable.map(({ row, text }) => {
      const base = meta(row, text);
      const detailed = row.status === "active" && (wanted === null || wanted.has(row.path)) && (size < cap || base.over_limit); // over-limit pages ignore a retry's cap too
      const items = itemsOf(text).map((s) => ({ section: s.section, items: s.items.map((i) => ({ ref: { page: row.path, section: s.section, h: i.h }, text: i.text })) }));
      const cost = estimatePageTokens(JSON.stringify(items));
      if (!detailed || (cost > budget && !base.over_limit)) return { ...base, items: null };
      budget = Math.max(0, budget - cost);
      size += 1;
      return { ...base, items };
    });
    return { request: { ...fixed, pages, conversations, clippings }, conversations, clippings, size };
  }

  /** What the librarian still has to read, with each file's modified time (`at`). */
  private async scanPending(): Promise<PendingScan> {
    const root = this.options.vault.activeDir();
    const conversations: Timed<LibrarianOpsRequest["conversations"][number]>[] = [];
    if (this.options.router) {
      for (const row of this.options.index.listPages({ types: ["conversation-log"], status: ["active"] })) {
        const text = await readText(join(root, row.path));
        if (text !== null && parsePage(text).frontmatter.extraction === "pending") conversations.push({ path: row.path, h: bodySha256(text).slice(0, lineHash("").length), text: text.slice(text.indexOf("\n---", 3) + 4).trim(), at: await modifiedAt(join(root, row.path)) });
      }
    }
    const clippings: Timed<LibrarianOpsRequest["clippings"][number]>[] = [];
    for (const row of this.options.index.listPages({ types: ["clipping"], status: ["active"] })) {
      const text = await readText(join(root, row.path));
      if (text === null) continue;
      const sections = itemsOf(text);
      if ((sections.find((s) => s.section === USAGE)?.items.length ?? 0) > 0) continue;
      clippings.push({ path: row.path, h: bodySha256(text).slice(0, lineHash("").length), title: row.title, summary: row.summary, points: sections.find((s) => s.section === "要点")?.items.map((i) => i.text) ?? [], at: await modifiedAt(join(root, row.path)) });
    }
    return { conversations, clippings };
  }

  public async pendingStats(): Promise<PagePendingStats> {
    if (!this.options.vault.isAvailable()) return { pending_conversations: 0, unused_clippings: 0, oldest_pending_age_seconds: null };
    await this.options.index.refresh();
    const { conversations, clippings } = await this.scanPending();
    const oldest = Math.min(...conversations.map((c) => c.at), ...clippings.map((k) => k.at));
    return {
      pending_conversations: conversations.length,
      unused_clippings: clippings.length,
      oldest_pending_age_seconds: Number.isFinite(oldest) ? Math.max(0, Math.floor((this.now().getTime() - oldest) / 1000)) : null,
    };
  }

  /**
   * take_conversation and set_usage: the model names the lines, this code writes them. An operation whose target is missing,
   * not pending / already filled, or whose hash differs from what the model was shown is rejected and nothing changes.
   */
  private async applyExtra(ops: readonly { op: unknown; index: number }[], rows: readonly PageRow[], inputs: { conversations: readonly { path: string }[]; clippings: readonly { path: string }[] }, ctx: RunContext): Promise<{ applied: number; rejected: RejectedOp[]; pages: string[] }> {
    const result = { applied: 0, rejected: [] as RejectedOp[], pages: [] as string[] };
    const root = this.options.vault.activeDir();
    for (const { op, index } of ops) {
      const o = op as Record<string, unknown>;
      const conversation = o.op === "take_conversation";
      const targetKey = conversation ? "conversation" : "clipping";
      const valueKey = conversation ? "items" : "text";
      const path = o[targetKey];
      const reject = (code: string, detail?: Record<string, unknown>): void => { result.rejected.push({ index, code, ...describeRejectedOp(op), ...(detail ? { detail } : {}) }); };
      const valueOk = conversation
        ? Array.isArray(o.items) && o.items.length > 0 && o.items.every((i) => isPlainObject(i) && ["decision", "pitfall", "fact"].includes(i.kind as string) && isLine(i.text) && Object.keys(i).length === 2)
        : isLine(o.text);
      if (typeof path !== "string" || typeof o.h !== "string" || !valueOk || Object.keys(o).some((k) => !["op", targetKey, "h", valueKey].includes(k))) {
        const allowed = ["op", targetKey, "h", valueKey];
        const missing = [targetKey, "h", valueKey].filter((k) => !(k in o) || (k === "h" ? typeof o.h !== "string" : k === targetKey ? typeof path !== "string" : !valueOk));
        reject("missing_field", { missing, unknown: Object.keys(o).filter((k) => !allowed.includes(k)).slice(0, SHAPE_KEYS_MAX).map((k) => k.slice(0, SHAPE_NAME_MAX)) });
        continue;
      }
      const rel = normalizePath(path);
      // Only the pages this run showed to the model can be targets, so a path outside the vault is never touched.
      if (!(conversation ? inputs.conversations : inputs.clippings).some((c) => c.path === rel)) { reject("unknown_page"); continue; }
      let actualHash = "";
      // Names and hash prefixes only: the page text must not reach the report.
      const mismatch = (): Record<string, unknown> => ({ page: rel, section: conversation ? "extraction" : USAGE, h_given: (o.h as string).slice(0, 8), h_given_length: (o.h as string).length, h_checked: actualHash.slice(0, 8), changed_earlier: ctx.touched.has(rel) });
      const check = async (): Promise<{ text: string; frontmatter: Record<string, unknown> } | "unknown_page" | "hash_mismatch"> => {
        // The real file must stay inside the vault: a symlink swapped in after the request is refused.
        const real = await realpath(join(root, rel)).catch(this.nullUnlessMissing(`resolve ${rel}`));
        const realRoot = await realpath(root).catch(this.nullUnlessMissing("resolve the vault root"));
        if (real === null || realRoot === null || !real.startsWith(realRoot + sep)) return "unknown_page";
        const text = await readText(join(root, rel)).catch(this.nullUnlessMissing(`read ${rel}`));
        const parsed = text === null ? null : parsePage(text);
        if (text === null || parsed === null || parsed.kind !== (conversation ? "conversation-log" : "clipping")) return "unknown_page";
        actualHash = bodySha256(text);
        // The model copies a short head of the hash, as for theme lines; a different head is still a mismatch.
        return (o.h as string).length >= lineHash("").length && actualHash.startsWith(o.h as string) ? { text, frontmatter: parsed.frontmatter } : "hash_mismatch";
      };
      const first = await check();
      if (typeof first === "string") { reject(first, first === "hash_mismatch" ? mismatch() : undefined); continue; }
      // Theme lines routed for this conversation are undone when the operation ends up rejected.
      const originals = new Map<string, string | null>();
      const touchedBefore = new Set(ctx.touched);
      const pagesBefore = new Set(result.pages);
      // The hash this operation's last route left on each page; a page that differs from it before the next route was changed by another writer.
      const ownHash = new Map<string, string>();
      const foreign = new Set<string>();
      const rollback = (): Promise<void> => this.options.vault.withWrite(async () => {
        for (const [page, original] of originals) {
          if (foreign.has(page)) continue; // another writer's lines landed between two routes; the snapshot would drop them
          // A page another writer changed after the router keeps its text: restoring the snapshot would drop that writer's lines.
          const current = await readText(join(root, page)).catch(this.nullUnlessMissing(`hash ${page} before rollback`));
          if (current !== null && bodySha256(current) !== ctx.written.get(page)) continue;
          if (original === null) {
            await rm(join(root, page), { force: true });
            ctx.created.delete(page);
          } else await writeAtomic(join(root, page), original);
          // What an earlier operation of this run wrote stays registered; only this operation's own traces are removed.
          if (original !== null && touchedBefore.has(page)) ctx.written.set(page, bodySha256(original));
          else { ctx.touched.delete(page); ctx.written.delete(page); }
          if (!pagesBefore.has(page)) {
            const at = result.pages.indexOf(page);
            if (at >= 0) result.pages.splice(at, 1);
          }
        }
      });
      if (conversation) {
        const router = this.options.router;
        if (first.frontmatter.extraction !== "pending" || !router) { reject("not_applicable"); continue; }
        const project = typeof first.frontmatter.project_id === "string" ? first.frontmatter.project_id : null;
        const label = `会話${rel.replace(/^.*\//u, "").replace(/\.md$/u, "")}`;
        let failed: string | null = null;
        for (const item of o.items as { kind: RouteInput["kind"]; text: string }[]) {
          try {
            for (const [page, hash] of ownHash) {
              const now = await readText(join(root, page)).catch(this.nullUnlessMissing(`hash ${page} between routes`));
              if (now === null || bodySha256(now) !== hash) foreign.add(page);
            }
            const before = await this.snapshotThemes(rows, ctx);
            const routed = await router.route({ kind: item.kind, text: item.text, theme: "", project_id: project, source: { work_number: null, work_id: null, actor: "librarian", label }, own_hashes: Object.fromEntries(ownHash) });
            // Judged by the router inside its write lease, so a writer that came after the check above and before this write is caught too.
            for (const page of routed.foreign_pages ?? []) foreign.add(page);
            if (routed.page) {
              if (!originals.has(routed.page)) originals.set(routed.page, before.get(routed.page) ?? null);
              await this.adopt(ctx, routed.page, before.get(routed.page) ?? null, result.pages, routed.written_hash);
              if (routed.written_hash !== undefined) ownHash.set(routed.page, routed.written_hash);
            }
            if (routed.status !== "appended" && routed.status !== "duplicate") { failed = routed.reason ?? routed.status; break; }
          } catch (error) {
            // A throw is a failed route too: left to the run's catch, the lines already routed stayed and the next run added them again.
            failed = `thrown:${messageOf(error)}`;
            break;
          }
        }
        if (failed !== null) { await rollback(); reject(`route_failed:${failed}`); continue; }
      }
      const outcome = await this.options.vault.withWrite(async (): Promise<string> => {
        const fresh = await check(); // the page may have been edited while the lines were routed
        if (typeof fresh === "string") return fresh;
        const next = conversation ? setFrontmatter(fresh.text, "extraction", "librarian") : withUsage(fresh.text, o.text as string);
        if (next === null) return "not_applicable";
        try {
          await this.backup(ctx, rel);
          await writeAtomic(join(root, rel), next);
        } catch {
          return "write_failed"; // only this entry stays pending; entries already settled keep their result
        }
        ctx.written.set(rel, bodySha256(next));
        ctx.touched.add(rel);
        return "applied";
      });
      if (outcome !== "applied") { await rollback(); reject(outcome, outcome === "hash_mismatch" ? mismatch() : undefined); continue; }
      result.pages.push(rel);
      result.applied += 1;
    }
    return result;
  }

  /** The text of every theme page as it is now, to back up whatever the router changes. */
  private async snapshotThemes(rows: readonly PageRow[], ctx: RunContext): Promise<Map<string, string>> {
    const root = this.options.vault.activeDir();
    const out = new Map<string, string>();
    for (const path of new Set([...rows.map((r) => r.path), ...ctx.created])) { // pages created earlier in this run count too
      const text = await readText(join(root, path)).catch(this.nullUnlessMissing(`snapshot ${path} for the backup`));
      if (text !== null) out.set(path, text);
    }
    return out;
  }

  /** A `.catch` handler: a missing file is expected and gives null; any other failure is logged, then gives null. */
  private nullUnlessMissing(action: string): (error: unknown) => null {
    return (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.logger?.warn(`Could not ${action}`, error);
      return null;
    };
  }

  /** Registers a page the router wrote: its original is backed up (or it is remembered as created) and it counts as touched. */
  private async adopt(ctx: RunContext, rel: string, original: string | null, pages: string[], writtenHash?: string): Promise<void> {
    // Registered before the backup is attempted: if the backup throws, the caller's rollback still sees this write as the run's own and undoes it.
    // The router's own hash is preferred; reading the page here would also pick up a writer that came after the router.
    let hash = writtenHash;
    if (hash === undefined) {
      const current = await readText(join(this.options.vault.activeDir(), rel)).catch(this.nullUnlessMissing(`hash ${rel} after writing`));
      if (current !== null) hash = bodySha256(current);
    }
    if (hash !== undefined) ctx.written.set(rel, hash);
    ctx.touched.add(rel);
    if (!pages.includes(rel)) pages.push(rel);
    if (!ctx.backedUp.has(rel) && !ctx.created.has(rel)) {
      if (original === null) ctx.created.add(rel);
      else {
        await mkdir(dirname(join(ctx.backupDir, rel)), { recursive: true });
        await writeFile(join(ctx.backupDir, rel), original);
        ctx.backedUp.add(rel);
      }
    }
  }

  /** Applies the operations to the vault as it is now (inside the write lease), then writes what changed. */
  private async applyAll(ops: readonly unknown[], rows: readonly PageRow[], candidates: ReadonlySet<string>, ctx: RunContext, report: { pages: PageActionReport[]; applied: number; rejected: readonly RejectedOp[]; warnings: PageRunReport["warnings"] }): Promise<void> {
    const root = this.options.vault.activeDir();
    const state: PageOpsState = { pages: new Map(), histories: new Map(), pageIds: new Map() };
    const dirs = new Set<string>();
    for (const row of rows) {
      const text = await readText(join(root, row.path));
      if (text === null) continue;
      state.pages.set(row.path, text);
      const id = parsePage(text).frontmatter.id;
      if (typeof id === "string") state.pageIds.set(id, row.path);
      dirs.add(posix.dirname(row.path));
    }
    for (const dir of dirs) {
      const historyDir = posix.join(dir === "." ? "" : dir, "_history");
      for (const name of await readdir(join(root, historyDir)).catch(() => [] as string[])) {
        if (!name.endsWith(".md")) continue;
        const rel = posix.join(historyDir, name);
        const text = await readText(join(root, rel));
        if (text !== null) state.histories.set(rel, text);
      }
    }
    const projectOf = (page: string): string | null => {
      const id = parsePage(state.pages.get(page) ?? "").frontmatter.project_id;
      return typeof id === "string" ? id : null;
    };
    const opsCtx: PageOpsContext = {
      today: this.today(),
      newId: this.options.newId ?? createUlid,
      workExists: (number) => this.options.workExists?.(number) ?? false,
      conversationExists: (name) => this.options.conversationExists?.(name) ?? false,
      pathMissing: (page, path) => this.options.pathMissing?.(projectOf(page), path) ?? "unavailable",
      isDormant: (page) => parsePage(state.pages.get(page) ?? "").frontmatter.status === "dormant",
      isDormantCandidate: (page) => candidates.has(page),
      titleTaken: () => false,
    };
    const fit = fitOps(state, ops, opsCtx);
    const result = applyOperations(state, fit.ops, opsCtx, { allowCoreOps: true });
    report.applied = result.applied.length;
    report.rejected = [
      ...fit.dropped.map((d) => ({ index: d.index, code: "target_over_limit", ...describeRejectedOp(d.op) })),
      ...result.rejected.map((r) => ({ index: fit.origin[r.index], code: r.code, ...describeRejectedOp(r.op), ...(r.detail ? { detail: r.detail } : {}) })),
    ].sort((a, b) => a.index - b.index);
    report.warnings = result.warnings;

    const files = new Map<string, string>();
    for (const path of result.touched) files.set(path, result.state.pages.get(path) ?? result.state.histories.get(path)!);
    const current = (path: string): string | undefined => files.get(path) ?? result.state.pages.get(path);
    for (const { page, action } of result.activity) {
      const text = current(page);
      if (text !== undefined) files.set(page, setFrontmatter(text, "status", action === "dormant" ? "dormant" : "active"));
    }
    // A page without new lines is integrated: its hash says so (a page over a size limit is stamped too, nothing is cut).
    const stamp = this.now().toISOString().replace(/\.\d+Z$/u, "Z");
    const rejectedOps = [...result.rejected.map((r) => r.op), ...fit.dropped.map((d) => d.op)].map((op) => JSON.stringify(op));
    for (const path of result.state.pages.keys()) {
      const text = current(path);
      if (text === undefined || newLinesOf(text).length > 0) continue;
      if (text === state.pages.get(path) && rejectedOps.some((op) => op.includes(JSON.stringify(path)))) continue; // a rejected operation leaves its page as it was
      const parsed = parsePage(text);
      const hash = bodySha256(text);
      if (parsed.kind !== "theme" || parsed.frontmatter.integrated_hash === hash || !validatePage(parsed, { writer: "owl" }).ok) continue;
      files.set(path, setFrontmatter(setFrontmatter(text, "integrated_hash", hash), "integrated_at", stamp));
    }
    for (const [path, text] of files) {
      if (text === state.pages.get(path) || text === state.histories.get(path)) continue;
      try {
        await this.backup(ctx, path);
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeAtomic(join(root, path), text);
      } catch (error) {
        throw new WriteError(path, error);
      }
      ctx.written.set(path, bodySha256(text));
      ctx.touched.add(path);
      if (!path.includes("_history/")) report.pages.push({ path, action: state.pages.has(path) ? "updated" : "created" });
    }
  }

  /** Active pages that still carry a new line after the run. */
  private async countNewLines(): Promise<number> {
    await this.options.index.refresh();
    return this.options.index.listPages({ types: ["theme"], status: ["active"] }).filter((row) => row.owl_new_count > 0).length;
  }

  /** Index pages and Home.md are derived: only the scopes whose theme pages changed are rebuilt, and they are backed up like the pages. */
  private async rebuildIndexes(ctx: RunContext, settledPages: ReadonlySet<string>): Promise<void> {
    if (!this.options.rebuildIndexes) return;
    const changed = [...settledPages, ...ctx.touched].filter((rel) => !rel.includes("_history/"));
    if (changed.length === 0) return;
    await this.options.index.refresh();
    const rows = new Map(this.options.index.listPages({ types: ["theme"], status: ["active", "archived", "dormant"] }).map((row) => [row.path, row]));
    const scopes = new Map<string, IndexScope>();
    for (const rel of changed) {
      const row = rows.get(rel);
      if (row?.page_scope === "common") scopes.set("common", { kind: "common" });
      else if (row?.project_id) scopes.set(row.project_id, { kind: "project", project_id: row.project_id });
    }
    if (scopes.size === 0) return;
    try {
      await this.options.vault.withWrite(async () => {
        await this.options.rebuildIndexes!([...scopes.values()], async (rel) => { await this.backup(ctx, rel); ctx.touched.add(rel); });
      });
    } catch (error) {
      throw new WriteError("Home.md", error);
    }
  }

  /** Copies the original to `data/backups/memory-pages/<run_id>/<path>` once; a file that does not exist yet is remembered as created. */
  private async backup(ctx: RunContext, rel: string): Promise<void> {
    if (ctx.backedUp.has(rel) || ctx.created.has(rel)) return;
    const original = await readFile(join(this.options.vault.activeDir(), rel)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (original === null) { ctx.created.add(rel); return; }
    await mkdir(dirname(join(ctx.backupDir, rel)), { recursive: true });
    await writeFile(join(ctx.backupDir, rel), original);
    ctx.backedUp.add(rel);
  }

  /** Puts back what this run wrote: backed-up originals return, newly created files go. A file edited since this run wrote it is left alone. */
  private async restore(ctx: RunContext): Promise<void> {
    const root = this.options.vault.activeDir();
    const untouched = async (rel: string): Promise<boolean> => {
      const current = await readText(join(root, rel));
      const wrote = ctx.written.get(rel);
      return wrote === undefined || (current !== null && bodySha256(current) === wrote);
    };
    try {
      await this.options.vault.withWrite(async () => {
        for (const rel of ctx.backedUp) {
          try {
            if (!(await untouched(rel))) {
              this.options.logger?.warn(`Kept ${rel}: it changed after the librarian wrote it; the original is in ${ctx.backupDir}`);
              continue;
            }
            await mkdir(dirname(join(root, rel)), { recursive: true });
            await writeAtomic(join(root, rel), await readFile(join(ctx.backupDir, rel), "utf8"));
          } catch (error) {
            this.options.logger?.warn(`Could not restore ${rel} from the librarian backup`, error);
          }
        }
        for (const rel of ctx.created) {
          try {
            if (await untouched(rel)) await rm(join(root, rel), { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // already gone
            this.options.logger?.warn(`Could not remove ${rel}, which the librarian created`, error);
          }
        }
      });
    } catch (error) {
      this.options.logger?.warn("Could not restore the librarian backup", error);
    }
    this.options.onChanged?.([...ctx.backedUp, ...ctx.created]);
  }

  /** Backups older than `backup_days` go. */
  private async pruneBackups(): Promise<void> {
    const dir = join(this.options.dataDir, BACKUP_FOLDER);
    const names = await readdir(dir).catch(() => [] as string[]);
    const limit = this.now().getTime() - this.limits.backup_days * DAY_MS;
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (info && info.mtimeMs < limit) await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private loadFailures(): Map<string, PageFailure> {
    if (this.failures) return this.failures;
    this.failures = new Map();
    try {
      const raw = JSON.parse(readTextSync(join(this.options.dataDir, FAILURE_FILE)) ?? "[]") as PageFailure[];
      for (const entry of raw) if (entry && typeof entry.path === "string" && Number.isInteger(entry.failures)) this.failures.set(entry.path, entry);
    } catch (error) {
      this.options.logger?.warn("Could not read the librarian failure log; starting empty", error);
    }
    return this.failures;
  }

  private saveFailures(): void {
    const entries = [...this.loadFailures().values()];
    mkdir(this.options.dataDir, { recursive: true })
      .then(() => writeFile(join(this.options.dataDir, FAILURE_FILE), `${JSON.stringify(entries, null, 2)}\n`))
      .catch((error: unknown) => this.options.logger?.warn("Could not save the librarian failure log", error));
  }

  private loadRejections(): Record<string, unknown>[] {
    try {
      const raw = JSON.parse(readTextSync(join(this.options.dataDir, REJECTION_FILE)) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter(isPlainObject).slice(0, REJECTION_MAX) : [];
    } catch {
      return [];
    }
  }

  /** Kept in a file, not in memory: the next run is a new librarian, and the same plan would be rejected again. */
  private async saveRejections(rejected: readonly (RejectedOp & { raw?: unknown })[]): Promise<void> {
    const refs = (v: unknown): unknown => (Array.isArray(v) ? v.slice(0, 20).filter(isPlainObject).map((x) => ({ page: x.page, section: x.section, h: x.h })) : undefined);
    const entries = rejected.slice(0, REJECTION_MAX).map((r) => {
      const o = isPlainObject(r.raw) ? r.raw : {};
      return maskSecrets({ code: r.code, ...(r.detail ? { detail: r.detail } : {}), op: o.op, page: o.page, into: o.into, new_title: o.new_title, to: o.to, items: refs(o.items), item: isPlainObject(o.item) ? refs([o.item]) : undefined });
    });
    const file = join(this.options.dataDir, REJECTION_FILE);
    // Written beside the file and renamed over it, so a reader never sees half a JSON.
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(this.options.dataDir, { recursive: true });
      await writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`);
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      this.options.logger?.warn("Could not save the librarian rejections", error);
    }
  }

  private recordFailure(error: string): void {
    const previous = this.loadFailures().get(FAILURE_KEY);
    this.loadFailures().set(FAILURE_KEY, { path: FAILURE_KEY, failures: (previous?.failures ?? 0) + 1, last_error: error.slice(0, 500), last_at: this.now().toISOString() });
    this.saveFailures();
  }

  private clearFailure(): void {
    if (this.loadFailures().delete(FAILURE_KEY)) this.saveFailures();
  }

  private today(): string { return this.now().toISOString().slice(0, 10); }
}

/** What a run has left to do, measured at the end of every batch. */
interface WorkLeft {
  readonly pending: number;
  readonly new_lines: number;
  readonly over_sections: number;
  readonly excess_lines: number;
  readonly excess_tokens: number;
}
const sizeOf = (text: string): PageSize | null => (parsePage(text).kind === "theme" ? pageSize(parsePage(text)) : null);
/** Null for a page that is not a theme; 更新履歴 is left out because Core moves its overflow itself. */
function freeOf(size: PageSize | null): LibrarianOpsRequest["pages"][number]["free"] {
  if (size === null) return null;
  return { tokens: size.token_limit - size.tokens, lines: Object.fromEntries(size.sections.filter((s) => s.section !== UPDATES_SECTION).map((s) => [s.section, s.limit - s.lines])) };
}
/**
 * Keeps the batch's splits and moves within their destinations' room before anything is applied. Each operation is tried on a
 * copy of the vault with the operations kept before it, through the same applier the real run uses, so the destination is
 * resolved as the applier resolves it and room freed or used by earlier operations counts. A split is cut to the items that
 * fit; an operation of which nothing fits is dropped and reported at its own index (`origin` maps the kept operations back
 * to their index in `ops`). An operation refused for any other reason is left to the real run, which records the real code.
 */
function fitOps(state: PageOpsState, ops: readonly unknown[], ctx: PageOpsContext): { ops: unknown[]; origin: number[]; dropped: { index: number; op: unknown }[] } {
  const trialCtx: PageOpsContext = { ...ctx, newId: createUlid };
  const accepted: unknown[] = [];
  /** Null when the operation is applied, otherwise the code it is refused with. */
  const trial = (op: unknown): string | null => {
    try {
      const result = applyOperations(state, [...accepted, op], trialCtx, { allowCoreOps: true });
      const refused = result.rejected.find((r) => r.index === accepted.length);
      if (refused) return refused.code;
      for (const path of result.touched) {
        const after = sizeOf(result.state.pages.get(path) ?? "");
        const before = sizeOf(state.pages.get(path) ?? "");
        if (after !== null && after.tokens > after.token_limit && after.tokens > (before?.tokens ?? 0)) return "target_over_limit"; // the audit and link lines come with the applier's last step
      }
      return null;
    } catch {
      return "error";
    }
  };
  const out: { ops: unknown[]; origin: number[]; dropped: { index: number; op: unknown }[] } = { ops: [], origin: [], dropped: [] };
  ops.forEach((op, index) => {
    const keep = (kept: unknown, applied: boolean): void => {
      out.ops.push(kept);
      out.origin.push(index);
      if (applied) accepted.push(kept);
    };
    const code = trial(op);
    if (code !== "target_over_limit" || !isPlainObject(op)) return keep(op, code === null);
    if (op.op !== "split" || !Array.isArray(op.items)) return void out.dropped.push({ index, op });
    const items: unknown[] = [];
    for (const item of op.items) if (trial({ ...op, items: [...items, item] }) === null) items.push(item);
    if (items.length === 0) out.dropped.push({ index, op });
    else keep({ ...op, items }, true);
  });
  return out;
}
/** Every section counts, 更新履歴 and 関連ページ too. */
function excessOf(size: PageSize): Pick<WorkLeft, "over_sections" | "excess_lines" | "excess_tokens"> {
  const lines = size.sections.map((s) => Math.max(0, s.lines - s.limit));
  const tokens = Math.max(0, size.tokens - size.token_limit);
  return { over_sections: lines.filter((n) => n > 0).length + (tokens > 0 ? 1 : 0), excess_lines: lines.reduce((a, b) => a + b, 0), excess_tokens: tokens };
}
// Why not count a drop in new_lines while a page is over a limit: taking new lines in is work the model can always find,
// so a run could go on to max_batches without bringing a single section under its limit.
/** A run goes on only for an actual gain: input read, an excess that fell, or (when nothing is over a limit) new lines taken in. */
export function progressed(b: WorkLeft, a: WorkLeft): boolean {
  const inputDigested = a.pending < b.pending;
  const excessReduced = a.over_sections <= b.over_sections && a.excess_lines <= b.excess_lines && a.excess_tokens <= b.excess_tokens
    && (a.over_sections < b.over_sections || a.excess_lines < b.excess_lines || a.excess_tokens < b.excess_tokens);
  const newLinesSettled = b.over_sections === 0 && a.over_sections === 0 && a.new_lines < b.new_lines;
  return inputDigested || excessReduced || newLinesSettled;
}
export const done = (a: WorkLeft): boolean => a.pending === 0 && a.new_lines === 0 && a.over_sections === 0;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readTextSync(path: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (process.getBuiltinModule("node:fs") as typeof import("node:fs")).readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
