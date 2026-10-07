'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { getTokensView, setPlanUsageSettings } from '@/lib/api-client';
import { DEFAULT_TOKEN_SORT, aggregateByProject, cellValue, columnsFor, nextTokenSort, sortForGroup, sortTokenRows } from '@/lib/token-usage-table';
import type { TokenColumn, TokenColumnKey, TokenRow, TokenSort, TokenSortKey } from '@/lib/token-usage-table';
import type {
  PlanUsageHarnessView,
  PlanUsageSettings,
  PlanUsageStatus,
  PlanUsageWindow,
  TokenUsagePeriod,
  TokenUsageReport,
  TokenUsageTotals,
  TokenUsageWorkTotals,
} from '@/lib/types';
import { formatDateTime } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { useView } from '@/lib/view-loader';

const GROUPS = ['project', 'role', 'model', 'harness', 'work', 'task'] as const;
type Group = (typeof GROUPS)[number];
const COLUMN_LABELS: Record<TokenColumnKey, string> = {
  total: 'tokens.totalTokens', share: 'tokens.column.share', uncached: 'tokens.uncached', output: 'tokens.output',
  cacheRate: 'tokens.column.cacheRate', runs: 'tokens.runs', passRate: 'tokens.passRate', perTask: 'tokens.column.perTask',
  afterReview: 'tokens.afterReview', firstReview: 'tokens.column.firstReview',
};
const POLL_INTERVALS = [2, 5, 10, 15, 30, 60];
const WEEKLY_KINDS = new Set<PlanUsageWindow['kind']>(['weekly', 'weekly_opus', 'weekly_sonnet', 'weekly_oauth_apps']);
const STATUS_KEYS: PlanUsageStatus[] = [
  'ok', 'disabled', 'not_configured', 'not_logged_in', 'expired', 'unauthorized',
  'rate_limited', 'unavailable', 'unrecognized', 'error', 'not_installed', 'no_data',
];

export function TokensView() {
  const { locale, t } = useLocale();
  const [period, setPeriod] = useState<TokenUsagePeriod>('7d');
  const [settings, setSettings] = useState<PlanUsageSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [notice, setNotice] = useState(false);
  const [now, setNow] = useState(0);

  const { data: view, error: viewError } = useView(`tokens:${period}`, () => getTokensView(period), { refreshMs: 30_000 });
  const usage: TokenUsageReport | null = view && view.report.period === period ? view.report : null;
  const usageError = Boolean(viewError) || (view !== undefined && view.report.period !== period);
  const plan: { claude: PlanUsageHarnessView; codex: PlanUsageHarnessView } | null = view
    ? { claude: view.plan_usage.claude, codex: view.plan_usage.codex }
    : null;
  const planError = Boolean(viewError) && !view;
  const settingsError = Boolean(viewError) && !view && settings === null;
  const projectNames = useMemo(
    () => new Map((view?.projects ?? []).map((project) => [project.id, project.name] as [string, string])),
    [view],
  );

  useEffect(() => {
    if (view) setNow(Date.now());
  }, [view]);

  useEffect(() => {
    if (view) setSettings((current) => current ?? view.plan_usage_settings);
  }, [view]);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(clock);
  }, []);

  async function saveSettings() {
    if (!settings || saving) return;
    setSaving(true);
    setSaveError(false);
    setNotice(false);
    try {
      setSettings(await setPlanUsageSettings(settings));
      setNotice(true);
    } catch (error) {
      console.error("Token usage request failed", error);
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('tokens.title')}</h1>
          <p className="page__sub">{t('tokens.subtitle')}</p>
        </div>
      </div>

      <section className="section" aria-labelledby="sec-token-plan-usage">
        <div className="section__head">
          <h2 className="section__title" id="sec-token-plan-usage">{t('tokens.planTitle')}</h2>
        </div>
        {plan ? (
          <div className="token-usage__plan-grid">
            <PlanCard view={plan.claude} now={now} locale={locale} t={t} />
            <PlanCard view={plan.codex} now={now} locale={locale} t={t} />
          </div>
        ) : planError ? <p className="error">{t('tokens.errorPlan')}</p> : <p className="empty">{t('common.loading')}</p>}
      </section>

      <section className="section" aria-labelledby="sec-token-consumption">
        <div className="section__head token-usage__section-head">
          <h2 className="section__title" id="sec-token-consumption">{t('tokens.consumptionTitle')}</h2>
          <label className="token-usage__period">
            <span>{t('tokens.period.label')}</span>
            <select className="input" value={period} onChange={(event) => setPeriod(event.target.value as TokenUsagePeriod)}>
              {(['today', '7d', '30d'] as const).map((value) => <option key={value} value={value}>{t(`tokens.period.${value}`)}</option>)}
            </select>
          </label>
        </div>
        {usage?.period === period ? (
          <>
            <TokenTotals totals={usage.totals} locale={locale} t={t} />
            <UsageTable usage={usage} projectNames={projectNames} locale={locale} t={t} />
            <p className="page__sub">{t('tokens.runsWithoutUsage', { count: number(usage.runs_without_usage, locale) })}</p>
          </>
        ) : usageError ? <p className="error">{t('tokens.errorUsage')}</p> : <p className="empty">{t('common.loading')}</p>}
      </section>

      <section className="panel" aria-labelledby="sec-token-usage-settings">
        <h2 className="panel__title" id="sec-token-usage-settings">{t('tokens.settings.title')}</h2>
        <p className="page__sub">{t('tokens.settings.description')}</p>
        {settings ? (
          <>
            <label className="token-usage__setting-row">
              <input
                type="checkbox"
                checked={settings.claude_usage_api_enabled}
                disabled={saving}
                onChange={(event) => setSettings({ ...settings, claude_usage_api_enabled: event.target.checked })}
              />
              <span>{t('tokens.settings.enabled')}</span>
            </label>
            <label className="token-usage__interval">
              <span>{t('tokens.settings.interval')}</span>
              <select
                className="input"
                value={settings.poll_interval_minutes}
                disabled={saving}
                onChange={(event) => setSettings({ ...settings, poll_interval_minutes: Number(event.target.value) })}
              >
                {POLL_INTERVALS.map((minutes) => (
                  <option key={minutes} value={minutes}>{t('tokens.settings.intervalOption', { minutes: String(minutes) })}</option>
                ))}
              </select>
            </label>
            <div className="btn-row">
              <button type="button" className="btn btn--primary btn--small" onClick={saveSettings} disabled={saving}>
                {saving ? t('common.saving') : t('common.save')}
              </button>
              {notice && <span className="note note--success">{t('tokens.settings.saved')}</span>}
              {saveError && <span className="error">{t('tokens.settings.saveError')}</span>}
            </div>
          </>
        ) : settingsError ? <p className="error">{t('tokens.errorSettings')}</p> : <p className="empty">{t('common.loading')}</p>}
      </section>
    </>
  );
}

function PlanCard({ view, now, locale, t }: {
  view: PlanUsageHarnessView;
  now: number;
  locale: 'ja' | 'en';
  t: (key: string, params?: Record<string, string>) => string;
}) {
  const status = STATUS_KEYS.includes(view.status) ? view.status : 'error';
  const windows = view.display?.windows.filter((window) => window.kind === 'five_hour' || WEEKLY_KINDS.has(window.kind)) ?? [];
  return (
    <article className="panel token-usage__plan-card">
      <h3 className="panel__title">{t(`tokens.harness.${view.harness}`)}</h3>
      <div className="token-usage__plan-meta">
        <span className={`badge ${view.display ? 'badge--green' : 'badge--amber'}`}>{t(`tokens.status.${status}`)}</span>
        {view.display_origin && <span className="note">{t(`tokens.source.${view.display_origin}`)}</span>}
      </div>
      {view.display && <p className="token-usage__updated">{t('tokens.lastUpdated', { time: formatDateTime(view.display.observed_at, locale) })}</p>}
      {view.stale && <p className="warn">{t('tokens.stale')}</p>}
      {windows.length === 0 ? <p className="empty">{view.display ? t('tokens.noWindows') : t(`tokens.status.${status}`)}</p> : (
        <div className="token-usage__windows">
          {windows.map((window) => <UsageWindow key={window.id} window={window} now={now} locale={locale} t={t} />)}
        </div>
      )}
    </article>
  );
}

function UsageWindow({ window, now, locale, t }: {
  window: PlanUsageWindow;
  now: number;
  locale: 'ja' | 'en';
  t: (key: string, params?: Record<string, string>) => string;
}) {
  const percent = window.used_percent;
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const tone = window.state === 'limited' || clamped >= 95 ? 'red' : window.state === 'warning' || clamped >= 80 ? 'amber' : 'green';
  const label = t(`tokens.window.${window.kind}`);
  const percentage = percent === null ? t('format.dash') : t('tokens.percent', { value: new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { maximumFractionDigits: 1 }).format(percent) });
  return (
    <div className="token-usage__window">
      <div className="token-usage__window-heading"><strong>{label}</strong><strong>{percentage}</strong></div>
      <div className="token-meter" role="meter" aria-label={`${label}: ${percentage}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}>
        <div className={`token-meter__fill token-meter__fill--${tone}`} style={{ width: `${clamped}%` }} />
      </div>
      <p className="token-usage__reset">{t('tokens.reset', { remaining: resetRemaining(window.resets_at, now, t) })}</p>
    </div>
  );
}

function resetRemaining(resetsAt: string | null, now: number, t: (key: string, params?: Record<string, string>) => string): string {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return t('tokens.resetUnknown');
  const remaining = Date.parse(resetsAt) - now;
  if (remaining <= 0) return t('tokens.resetExpired');
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return t('tokens.resetDaysHoursMinutes', { days: String(days), hours: String(hours), minutes: String(rest) });
  if (hours > 0) return t('tokens.resetHoursMinutes', { hours: String(hours), minutes: String(rest) });
  return t('tokens.resetMinutes', { minutes: String(rest) });
}

function TokenTotals({ totals, locale, t }: {
  totals: TokenUsageTotals;
  locale: 'ja' | 'en';
  t: (key: string, params?: Record<string, string>) => string;
}) {
  return (
    <div className="token-usage__totals">
      {[
        ['tokens.input', totals.input_tokens], ['tokens.output', totals.output_tokens],
        ['tokens.cacheRead', totals.cache_read_tokens], ['tokens.cacheWrite', totals.cache_write_tokens],
        ['tokens.totalTokens', totals.total_tokens],
      ].map(([key, value]) => (
        <div className="token-usage__total" key={String(key)}>
          <span>{t(String(key))}</span><strong>{number(Number(value), locale)}</strong>
        </div>
      ))}
    </div>
  );
}

type Translate = (key: string, params?: Record<string, string>) => string;

function UsageTable({ usage, projectNames, locale, t }: {
  usage: TokenUsageReport;
  projectNames: Map<string, string>;
  locale: 'ja' | 'en';
  t: Translate;
}) {
  const [group, setGroup] = useState<Group>('work');
  const [sort, setSort] = useState<TokenSort>(DEFAULT_TOKEN_SORT);
  const rows: TokenRow[] = {
    project: () => aggregateByProject(usage.by_work).map((row) => ({
      label: row.project_id === null ? t('tokens.noProject') : projectNames.get(row.project_id) ?? row.project_id,
      totals: row.totals,
    })),
    role: () => usage.by_role.map((row) => ({ label: t(`tokens.role.${row.role}`), totals: row.totals, metrics: row.metrics })),
    model: () => usage.by_model.map((row) => ({
      label: `${row.provider} · ${row.model} · ${t(`tokens.harness.${row.harness}`)}`,
      totals: row.totals,
    })),
    harness: () => usage.by_harness.map((row) => ({ label: t(`tokens.harness.${row.harness}`), totals: row.totals })),
    work: () => usage.by_work.map((row) => ({ label: workLabel(row, t), href: workHref(row.work_id), totals: row.totals, metrics: row.metrics })),
    task: () => usage.by_task.map((row) => ({
      label: row.title,
      href: workHref(row.work_id),
      totals: row.totals,
      firstReviewVerdict: row.first_review_pass_rate,
      metrics: {
        uncached_input_tokens: row.uncached_input_tokens,
        tokens_after_first_review: row.tokens_after_first_review,
        first_review_pass_rate: row.first_review_pass_rate,
        uncached_input_tokens_per_completed_task: null,
      },
    })),
  }[group]();
  const columns = columnsFor(group);
  const sorted = sortTokenRows(rows, sort, usage.totals);
  const sortOptions: { key: TokenSortKey; label: string }[] = [
    { key: 'name', label: t('tokens.nameColumn') },
    ...columns.filter((column) => column.sortable).map((column) => ({ key: column.key as TokenSortKey, label: t(COLUMN_LABELS[column.key]) })),
  ];
  const sectionClass = (index: number) =>
    columns[index].section === 'efficiency' && columns[index - 1]?.section !== 'efficiency' ? 'token-usage__cell--section' : '';
  const header = (key: TokenSortKey, label: string, className = '') => (
    <th scope="col" className={className || undefined} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="token-usage__sort" onClick={() => setSort(nextTokenSort(sort, key))}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );
  return (
    <section className="panel token-usage__breakdown">
      <div className="pill-group token-usage__group" role="group" aria-label={t('tokens.groupBy')}>
        {GROUPS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={group === key}
            className={`pill${group === key ? ' pill--active' : ''}`}
            onClick={() => { setGroup(key); setSort(sortForGroup(sort, key)); }}
          >
            {t(`tokens.group.${key}`)}
          </button>
        ))}
      </div>
      <div className="token-usage__sort-bar">
        <label htmlFor="token-usage-sort-key">{t('tokens.sort.label')}</label>
        <select
          id="token-usage-sort-key"
          className="input"
          value={sort.key}
          onChange={(event) => { const key = event.target.value as TokenSortKey; setSort({ key, dir: key === 'name' ? 'asc' : 'desc' }); }}
        >
          {sortOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
        <button type="button" className="btn" onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}>
          {t(sort.dir === 'asc' ? 'tokens.sort.asc' : 'tokens.sort.desc')}
        </button>
      </div>
      <div className="token-usage__table-wrap">
        <table className="token-usage__table">
          <thead><tr>
            {header('name', t('tokens.nameColumn'))}
            {columns.map((column, index) => column.sortable
              ? <Fragment key={column.key}>{header(column.key as TokenSortKey, t(COLUMN_LABELS[column.key]), sectionClass(index))}</Fragment>
              : <th scope="col" key={column.key}>{t(COLUMN_LABELS[column.key])}</th>)}
          </tr></thead>
          <tbody>
            {sorted.length === 0 ? <tr><td colSpan={1 + columns.length}>{t('tokens.noUsage')}</td></tr> : sorted.map((row, rowIndex) => (
              <tr key={`${row.label}-${rowIndex}`}>
                <th scope="row">{row.href ? <Link href={row.href}>{row.label}</Link> : row.label}</th>
                {columns.map((column, index) => {
                  const value = cellValue(row, column.key, usage.totals);
                  const text = formatCell(column.kind, value, locale, t);
                  const className = [column.key === 'total' ? 'token-usage__cell--total' : column.key === 'share' ? 'token-usage__cell--share' : '', sectionClass(index)].filter(Boolean).join(' ');
                  return (
                    <td
                      key={column.key}
                      data-label={t(COLUMN_LABELS[column.key])}
                      className={className || undefined}
                      style={column.key === 'share' && value !== null ? ({ '--share': text } as CSSProperties) : undefined}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="page__sub">{t('tokens.legend')}</p>
    </section>
  );
}

function formatCell(kind: TokenColumn['kind'], value: number | null, locale: 'ja' | 'en', t: Translate): string {
  if (value === null || !Number.isFinite(value)) return t('format.dash');
  if (kind === 'percent') return new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { style: 'percent', maximumFractionDigits: 1 }).format(value);
  if (kind === 'verdict') return t(value === 1 ? 'tokens.review.pass' : 'tokens.review.fail');
  return number(Math.round(value), locale);
}

function workHref(id: string): string {
  return `/work?id=${encodeURIComponent(id)}`;
}

function workLabel(work: TokenUsageWorkTotals, t: (key: string, params?: Record<string, string>) => string): string {
  const title = work.title || t('tokens.workUnknown');
  return work.display_number === null ? title : `${t('work.numberLabel', { number: String(work.display_number) })} · ${title}`;
}

function number(value: number, locale: 'ja' | 'en'): string {
  return new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US').format(value);
}
