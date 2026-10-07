import type { TokenUsageMetrics, TokenUsageTotals, TokenUsageWorkTotals } from './types';

export type TokenGroup = 'project' | 'role' | 'model' | 'harness' | 'work' | 'task';
export type TokenColumnKey =
  | 'total' | 'share' | 'uncached' | 'output' | 'cacheRate' | 'runs'
  | 'passRate' | 'perTask' | 'afterReview' | 'firstReview';
/** Raw-count keys of the screen before its column rewrite; kept sortable until the screen uses columnsFor. */
export type LegacyTokenSortKey = 'input' | 'cacheRead' | 'cacheWrite';
export type TokenSortKey = 'name' | Exclude<TokenColumnKey, 'share'> | LegacyTokenSortKey;
export type TokenSortDir = 'asc' | 'desc';
export interface TokenSort { key: TokenSortKey; dir: TokenSortDir }
export interface TokenColumn {
  key: TokenColumnKey;
  kind: 'tokens' | 'percent' | 'count' | 'verdict';
  sortable: boolean;
  section: 'volume' | 'efficiency';
}
export interface TokenRow {
  label: string;
  href?: string;
  totals: TokenUsageTotals;
  metrics?: Pick<TokenUsageMetrics, 'uncached_input_tokens' | 'tokens_after_first_review' | 'first_review_pass_rate' | 'uncached_input_tokens_per_completed_task'>;
  firstReviewVerdict?: 0 | 1 | null;
}
export interface ProjectTotals { project_id: string | null; totals: TokenUsageTotals }

export const DEFAULT_TOKEN_SORT: TokenSort = { key: 'total', dir: 'desc' };

const COLUMN_DEFS: Record<TokenColumnKey, Omit<TokenColumn, 'key'>> = {
  total: { kind: 'tokens', sortable: true, section: 'volume' },
  share: { kind: 'percent', sortable: false, section: 'volume' },
  uncached: { kind: 'tokens', sortable: true, section: 'volume' },
  output: { kind: 'tokens', sortable: true, section: 'volume' },
  cacheRate: { kind: 'percent', sortable: true, section: 'volume' },
  runs: { kind: 'count', sortable: true, section: 'volume' },
  passRate: { kind: 'percent', sortable: true, section: 'efficiency' },
  perTask: { kind: 'tokens', sortable: true, section: 'efficiency' },
  afterReview: { kind: 'tokens', sortable: true, section: 'efficiency' },
  firstReview: { kind: 'verdict', sortable: true, section: 'efficiency' },
};

const VOLUME_KEYS: TokenColumnKey[] = ['total', 'share', 'uncached', 'output', 'cacheRate', 'runs'];
const EFFICIENCY_KEYS: Record<TokenGroup, TokenColumnKey[]> = {
  project: [], model: [], harness: [],
  role: ['passRate', 'perTask', 'afterReview'],
  work: ['passRate', 'perTask', 'afterReview'],
  task: ['firstReview', 'afterReview'],
};

export function columnsFor(group: TokenGroup): readonly TokenColumn[] {
  return [...VOLUME_KEYS, ...EFFICIENCY_KEYS[group]].map((key) => ({ key, ...COLUMN_DEFS[key] }));
}

const finiteOrNull = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** numerator ÷ denominator, or null unless both are finite and the denominator is positive. */
function ratio(numerator: number, denominator: number): number | null {
  const n = finiteOrNull(numerator);
  const d = finiteOrNull(denominator);
  return n === null || d === null || d <= 0 ? null : finiteOrNull(n / d);
}

export function uncachedInputOf(row: TokenRow): number | null {
  return row.metrics ? finiteOrNull(row.metrics.uncached_input_tokens) : finiteOrNull(row.totals.input_tokens + row.totals.cache_write_tokens);
}

export function cacheRateOf(totals: TokenUsageTotals): number | null {
  return ratio(totals.cache_read_tokens, totals.input_tokens + totals.cache_read_tokens + totals.cache_write_tokens);
}

export function shareOf(totals: TokenUsageTotals, report: TokenUsageTotals): number | null {
  return ratio(totals.total_tokens, report.total_tokens);
}

const LEGACY_FIELD: Record<LegacyTokenSortKey, keyof TokenUsageTotals> = {
  input: 'input_tokens', cacheRead: 'cache_read_tokens', cacheWrite: 'cache_write_tokens',
};

/** Single source of the raw value behind both the displayed cell and the sort order. */
export function cellValue(row: TokenRow, key: TokenColumnKey | LegacyTokenSortKey, report: TokenUsageTotals): number | null {
  switch (key) {
    case 'total': return finiteOrNull(row.totals.total_tokens);
    case 'share': return shareOf(row.totals, report);
    case 'uncached': return uncachedInputOf(row);
    case 'output': return finiteOrNull(row.totals.output_tokens);
    case 'cacheRate': return cacheRateOf(row.totals);
    case 'runs': return finiteOrNull(row.totals.runs);
    case 'passRate': return finiteOrNull(row.metrics?.first_review_pass_rate);
    case 'perTask': return finiteOrNull(row.metrics?.uncached_input_tokens_per_completed_task);
    case 'afterReview': return finiteOrNull(row.metrics?.tokens_after_first_review);
    case 'firstReview': return row.firstReviewVerdict ?? null;
    default: return finiteOrNull(row.totals[LEGACY_FIELD[key]]);
  }
}

/** Same column toggles direction; a new column starts ascending for the name and descending for numbers. */
export function nextTokenSort(current: TokenSort, key: TokenSortKey): TokenSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

/** Keeps the sort when the new tab has that sortable column; otherwise falls back to the default. */
export function sortForGroup(sort: TokenSort, group: TokenGroup): TokenSort {
  if (sort.key === 'name' || columnsFor(group).some((column) => column.sortable && column.key === sort.key)) return sort;
  return DEFAULT_TOKEN_SORT;
}

export function sortTokenRows<T extends TokenRow>(rows: readonly T[], sort: TokenSort, report: TokenUsageTotals): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key !== 'name') {
      const x = cellValue(a, sort.key, report);
      const y = cellValue(b, sort.key, report);
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1; // missing values stay last in both directions
      } else if (x !== y) {
        return (x - y) * sign;
      }
    }
    const byName = a.label.localeCompare(b.label);
    return sort.key === 'name' ? byName * sign : byName;
  });
}

/** Sums by_work per project_id; Works without a project are grouped under project_id null. */
export function aggregateByProject(byWork: readonly TokenUsageWorkTotals[]): ProjectTotals[] {
  const groups = new Map<string | null, TokenUsageTotals>();
  for (const work of byWork) {
    const key = work.project_id ?? null;
    const sum = groups.get(key) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, runs: 0 };
    for (const field of Object.keys(sum) as (keyof TokenUsageTotals)[]) sum[field] += work.totals[field];
    groups.set(key, sum);
  }
  return [...groups].map(([project_id, totals]) => ({ project_id, totals }));
}
