import type { MemoryRole } from "./memory-types.js";

export interface RoleReadLimit { readonly pages: number; readonly page_tokens: number; readonly searches: number; readonly clippings: number }
export type MemoryReadLimits = Readonly<Record<"manager" | "designer" | "worker" | "reviewer" | "advisor", RoleReadLimit>>;

/** Design §3.10. An Advisor's numbers are per turn (the injector calls `reset` at the start of each turn). */
export const DEFAULT_MEMORY_READ_LIMITS: MemoryReadLimits = {
  manager: { pages: 2, page_tokens: 4000, searches: 1, clippings: 1 },
  designer: { pages: 4, page_tokens: 8000, searches: 3, clippings: 2 },
  worker: { pages: 3, page_tokens: 6000, searches: 2, clippings: 1 },
  reviewer: { pages: 2, page_tokens: 4000, searches: 1, clippings: 1 },
  advisor: { pages: 2, page_tokens: 4000, searches: 2, clippings: 2 },
};

/** agent_run_id, or `advisor:<session_id>` for the Advisor. */
export type BudgetKey = string;
export const advisorKey = (sessionId: string): BudgetKey => `advisor:${sessionId}`;

export interface ChargeResult {
  readonly ok: boolean; readonly used: number; readonly limit: number;
  readonly reason?: "page_budget_exceeded" | "clipping_budget_exceeded" | "search_budget_exceeded";
}

interface Spent { pages: Map<string, number>; clippings: Set<string>; searches: number }

/** In-memory only: a Core restart forgets everything. */
export class MemoryReadLedger {
  private readonly spent = new Map<BudgetKey, Spent>();
  private readonly limits: () => MemoryReadLimits;
  private readonly maxKeys: number;

  public constructor(options: { limits?: () => MemoryReadLimits; maxKeys?: number } = {}) {
    this.limits = options.limits ?? (() => DEFAULT_MEMORY_READ_LIMITS);
    this.maxKeys = options.maxKeys ?? 500;
  }

  private limitOf(role: MemoryRole): RoleReadLimit {
    const limits = this.limits();
    return limits[role as keyof MemoryReadLimits] ?? limits.worker;
  }

  private entry(key: BudgetKey): Spent {
    let found = this.spent.get(key);
    if (!found) {
      found = { pages: new Map(), clippings: new Set(), searches: 0 };
      this.spent.set(key, found);
      // Map keeps insertion order: the oldest key goes first.
      while (this.spent.size > this.maxKeys) this.spent.delete(this.spent.keys().next().value as BudgetKey);
    }
    return found;
  }

  private static tokens(spent: Spent): number { return [...spent.pages.values()].reduce((sum, n) => sum + n, 0); }

  /** What a theme page may still cost. */
  public remaining(key: BudgetKey, role: MemoryRole): { pages: number; tokens: number } {
    const limit = this.limitOf(role);
    const spent = this.entry(key);
    return { pages: limit.pages - spent.pages.size, tokens: limit.page_tokens - MemoryReadLedger.tokens(spent) };
  }

  /** Reopening a page costs no page; its tokens become the larger of the two reads. Nothing is recorded on refusal. */
  public chargePage(key: BudgetKey, role: MemoryRole, page: { path: string; tokens: number }): ChargeResult & { pages_used: number; pages_limit: number } {
    const limit = this.limitOf(role);
    const spent = this.entry(key);
    const before = spent.pages.get(page.path);
    const tokens = Math.max(before ?? 0, page.tokens);
    const pagesAfter = before === undefined ? spent.pages.size + 1 : spent.pages.size;
    const tokensAfter = MemoryReadLedger.tokens(spent) - (before ?? 0) + tokens;
    const pages = { pages_used: spent.pages.size, pages_limit: limit.pages };
    if (pagesAfter > limit.pages || tokensAfter > limit.page_tokens) {
      return { ok: false, used: MemoryReadLedger.tokens(spent), limit: limit.page_tokens, reason: "page_budget_exceeded", ...pages };
    }
    spent.pages.set(page.path, tokens);
    return { ok: true, used: tokensAfter, limit: limit.page_tokens, pages_used: pagesAfter, pages_limit: limit.pages };
  }

  public chargeClipping(key: BudgetKey, role: MemoryRole, path: string): ChargeResult {
    const limit = this.limitOf(role).clippings;
    const spent = this.entry(key);
    if (!spent.clippings.has(path) && spent.clippings.size >= limit) return { ok: false, used: spent.clippings.size, limit, reason: "clipping_budget_exceeded" };
    spent.clippings.add(path);
    return { ok: true, used: spent.clippings.size, limit };
  }

  public chargeSearch(key: BudgetKey, role: MemoryRole): ChargeResult {
    const limit = this.limitOf(role).searches;
    const spent = this.entry(key);
    if (spent.searches >= limit) return { ok: false, used: spent.searches, limit, reason: "search_budget_exceeded" };
    spent.searches += 1;
    return { ok: true, used: spent.searches, limit };
  }

  public reset(key: BudgetKey): void { this.spent.delete(key); }
}
