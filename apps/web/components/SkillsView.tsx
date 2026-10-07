'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSkillActivity, getSkillSettings, listProjects, listSkillProposals, listSkills } from '@/lib/api-client';
import type { Project, SkillActivity, SkillListItem, SkillProposal, SkillSettings, SkillState } from '@/lib/types';
import { formatRelative } from '@/lib/format';
import { useLocale, type TFunction } from '@/lib/i18n';
import { skillScopeLabel } from '@/lib/skill-scope';

type StateFilter = 'all' | SkillState | 'trial';

export function SkillsView() {
  const { locale, t } = useLocale();
  const [skills, setSkills] = useState<SkillListItem[] | null>(null);
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [settings, setSettings] = useState<SkillSettings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activity, setActivity] = useState<SkillActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StateFilter>('all');
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState('');
  const [now] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setError(null);
    // Only the skill list is required; the banner, tile hints and scope names
    // fall back quietly when their requests fail.
    const [skillList, pendingProposals, skillSettings, projectList, skillActivity] = await Promise.allSettled([
      listSkills(),
      listSkillProposals('awaiting_approval'),
      getSkillSettings(),
      listProjects(),
      getSkillActivity(),
    ]);
    if (skillList.status === 'fulfilled') {
      setSkills(skillList.value);
    } else {
      setError(t('skills.list.loadError'));
      console.error('[Owl] Skills load error', skillList.reason);
    }
    if (pendingProposals.status === 'fulfilled') setProposals(pendingProposals.value);
    else console.error('[Owl] Skill proposals load error', pendingProposals.reason);
    if (skillSettings.status === 'fulfilled') setSettings(skillSettings.value.settings);
    if (projectList.status === 'fulfilled') setProjects(projectList.value);
    if (skillActivity.status === 'fulfilled') setActivity(skillActivity.value);
    else console.error('[Owl] Skill activity load error', skillActivity.reason);
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scopes = useMemo(() => {
    const set = new Set<string>();
    for (const s of skills ?? []) set.add(s.scope);
    return [...set].sort();
  }, [skills]);

  const counts = useMemo(() => {
    const all = skills ?? [];
    return {
      all: all.length,
      active: all.filter((s) => s.state === 'active').length,
      trial: all.filter((s) => s.trial === 1).length,
      stale: all.filter((s) => s.state === 'stale').length,
      archived: all.filter((s) => s.state === 'archived').length,
    };
  }, [skills]);

  const filtered = useMemo(() => {
    const all = skills ?? [];
    return all.filter((s) => {
      if (filter === 'trial' && s.trial !== 1) return false;
      if (filter === 'active' || filter === 'stale' || filter === 'archived') {
        if (s.state !== filter) return false;
      }
      if (scope && s.scope !== scope) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const hay = `${s.name} ${s.description} ${s.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [skills, filter, scope, query]);

  if (skills === null) {
    return (
      <>
        <div className="page__head">
          <div>
            <h1 className="page__title">{t('skills.list.title')}</h1>
            <p className="page__sub">{t('skills.list.subtitle')}</p>
          </div>
        </div>
        {error ? <div className="error">{error}</div> : <p className="empty">{t('common.loading')}</p>}
      </>
    );
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('skills.list.title')}</h1>
          <p className="page__sub">{t('skills.list.subtitle')}</p>
        </div>
        <div className="btn-row">
          <Link href="/skills/settings" className="btn">
            {t('skills.list.settingsButton')}
          </Link>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {proposals.length > 0 && (
        <Link href="/skills/approvals" className="skills-banner">
          <span>{t('skills.list.banner', { count: String(proposals.length) })}</span>
          <span className="skills-banner__hint">{t('skills.list.bannerHint')}</span>
          <span className="skills-banner__spacer" />
          <strong className="skills-banner__cta">{t('skills.list.bannerCta')}</strong>
          <span className="skills-banner__chevron" aria-hidden="true">›</span>
        </Link>
      )}

      <div className="grid grid--4 skills-stats">
        <div className="stat-tile">
          <div className="stat-tile__label">{t('skills.list.statActive')}</div>
          <div className="stat-tile__value">{counts.active}</div>
          {settings && (
            <div className="stat-tile__hint">
              {t('skills.list.statActiveHint', { count: String(Math.min(counts.active, settings.max_items)) })}
            </div>
          )}
        </div>
        <div className="stat-tile stat-tile--amber">
          <div className="stat-tile__label" style={{ color: '#b45309' }}>{t('skills.list.statTrial')}</div>
          <div className="stat-tile__value stat-tile__value--amber">{counts.trial}</div>
          <div className="stat-tile__hint">{t('skills.list.statTrialHint')}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">{t('skills.list.statStale')}</div>
          <div className="stat-tile__value">{counts.stale}</div>
          {settings && (
            <div className="stat-tile__hint">{t('skills.list.statStaleHint', { days: String(settings.archived_days) })}</div>
          )}
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">{t('skills.list.statCurator')}</div>
          <div className="stat-tile__value">
            {activity
              ? t('skills.list.statCuratorValue', { created: String(activity.created), updated: String(activity.revised) })
              : '—'}
          </div>
          {activity && (
            <div className="stat-tile__hint">
              {t('skills.list.statCuratorHint2', { rejected: String(activity.rejected), rollback: String(activity.rolled_back) })}
            </div>
          )}
        </div>
      </div>

      <div className="skills-filters">
        <div className="pill-group" role="group" aria-label={t('skills.list.filterGroupLabel')}>
          {(
            [
              ['all', t('skills.scopeAll'), 'skills.list.filterAll', counts.all],
              ['active', t('skills.state.active'), 'skills.list.filterActive', counts.active],
              ['trial', t('skills.list.statTrial'), 'skills.list.filterTrial', counts.trial],
              ['stale', t('skills.state.stale'), 'skills.list.filterStale', counts.stale],
              ['archived', t('skills.state.archived'), 'skills.list.filterArchived', counts.archived],
            ] as const
          ).map(([value, label, key, count]) => (
            <button
              key={value}
              type="button"
              className={`pill${filter === value ? ' pill--active' : ''}`}
              aria-pressed={filter === value}
              aria-label={t('skills.list.filterPillAria', { label, count: String(count) })}
              onClick={() => setFilter(value)}
            >
              {t(key, { count: String(count) })}
            </button>
          ))}
        </div>
        <label className="skills-scope">
          <span>{t('skills.list.scopeLabel')}</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">{t('skills.scopeAll')}</option>
            {scopes.map((s) => (
              <option key={s} value={s}>{skillScopeLabel(s, projects, t)}</option>
            ))}
          </select>
        </label>
        <label className="skills-search">
          <span style={{ position: 'absolute', left: -9999 }}>{t('skills.list.searchLabel')}</span>
          <input
            className="input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('skills.list.searchPlaceholder')}
          />
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="empty">{t('skills.list.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((s) => (
            <SkillCard key={s.name} skill={s} now={now} locale={locale} projects={projects} t={t} />
          ))}
        </div>
      )}
    </>
  );
}

function SkillCard({
  skill,
  now,
  locale,
  projects,
  t,
}: {
  skill: SkillListItem;
  now: number;
  locale: 'ja' | 'en';
  projects: Project[];
  t: TFunction;
}) {
  return (
    <Link href={`/skills/detail?name=${encodeURIComponent(skill.name)}`} className="card">
      <div className="skill-card__head">
        <span className="skill-card__name">{skill.name}</span>
        {skill.trial === 1 && (
          <span className="badge badge--amber">
            {t('skills.list.trialBadge', {
              progress: skill.trial_progress ? `${skill.trial_progress.evaluations}/3` : '0/3',
            })}
          </span>
        )}
        {skill.state === 'stale' && <span className="badge badge--gray">{t('skills.list.staleBadge')}</span>}
        {skill.has_scripts && <span className="badge badge--accent">{t('skills.list.scriptsBadge')}</span>}
        <span className="card__spacer" />
        <span className="card__meta">{t('skills.list.lastUsed', { when: formatRelative(skill.last_used_at, now, locale) })}</span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{skill.description}</p>
      {skill.broken_reason && (
        <div className="skill-card__broken">{t('skills.list.brokenWarning', { reason: skill.broken_reason })}</div>
      )}
      <div className="skill-card__footer">
        <span className="scope-chip">{skillScopeLabel(skill.scope, projects, t)}</span>
        <span>{t('skills.list.usesCount', { count: String(skill.use_count) })}</span>
        <span className="stat--good">{t('skills.list.helpfulCount', { count: String(skill.helpful_count) })}</span>
        <span className="stat--bad">{t('skills.list.misleadingCount', { count: String(skill.misleading_count) })}</span>
        <span>{t('skills.list.irrelevantCount', { count: String(skill.irrelevant_count) })}</span>
        <span className="card__spacer" />
        <span>
          {skill.originating_work
            ? t('skills.list.origin', { title: skill.originating_work.title ?? skill.originating_work.id })
            : t('skills.list.originNone')}
        </span>
      </div>
    </Link>
  );
}
