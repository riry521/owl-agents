'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { getSkill, listProjects, listSkillRevisions, listSkills, updateSkill } from '@/lib/api-client';
import type { Project, SkillDetailData, SkillListItem, SkillRevision, SkillState } from '@/lib/types';
import { formatRelative, roleDisplayName } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { formatByteCount, formatByteSize } from '@/lib/skill-diff';
import { GLOBAL_SKILL_SCOPE, projectSkillScope, skillScopeLabel } from '@/lib/skill-scope';

const TRIAL_EVALUATIONS_LIMIT = 3;
const TRIAL_MISLEADING_LIMIT = 2;
const USAGE_LOG_PREVIEW = 5;

export function SkillDetailView() {
  const { locale, t } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const name = params.get('name') ?? '';

  const [listItem, setListItem] = useState<SkillListItem | null | undefined>(undefined);
  const [detail, setDetail] = useState<SkillDetailData | null | undefined>(undefined);
  const [revisions, setRevisions] = useState<SkillRevision[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sideLoadErrors, setSideLoadErrors] = useState<string[]>([]);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const [operationPending, setOperationPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [usageExpanded, setUsageExpanded] = useState(false);

  const retry = () => setRetryCount((c) => c + 1);

  const load = useCallback(async () => {
    if (!name) {
      setListItem(null);
      setDetail(null);
      return;
    }
    setLoadError(null);
    setNotFound(false);
    try {
      // The skill itself can be shown without revisions or projects, so these two only add a notice.
      const sideErrors: string[] = [];
      let revisionsFailure: string | null = null;
      const [items, detailData, revisionList, projectList] = await Promise.all([
        listSkills({ q: name }),
        getSkill(name),
        listSkillRevisions(name).catch((e) => {
          console.error('[Owl] Skill revisions load error', e);
          revisionsFailure = `${t('skills.detail.revisionsLoadError')}: ${e instanceof Error ? e.message : String(e)}`;
          sideErrors.push(revisionsFailure);
          return [] as SkillRevision[];
        }),
        listProjects().catch((e) => {
          console.error('[Owl] Skill detail projects load error', e);
          sideErrors.push(`${t('skills.detail.projectsLoadError')}: ${e instanceof Error ? e.message : String(e)}`);
          return [] as Project[];
        }),
      ]);
      setSideLoadErrors(sideErrors);
      setRevisionsError(revisionsFailure);
      setListItem(items.find((s) => s.name === name) ?? null);
      setDetail(detailData);
      setRevisions(revisionList);
      setProjects(projectList);
    } catch (e) {
      const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : '';
      if (code === 'skill_not_found') {
        setNotFound(true);
        return;
      }
      setLoadError(t('skills.detail.loadError'));
      console.error('[Owl] Skill detail load error', e);
    }
  }, [name, t]);

  useEffect(() => {
    void load();
  }, [load, retryCount]);

  useEffect(() => {
    if (!name) router.replace('/skills');
  }, [name, router]);

  async function handlePatch(patch: { state?: SkillState; scope?: string }) {
    setOperationPending(true);
    setOperationError(null);
    try {
      await updateSkill(name, patch, 0);
      retry();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : '';
      const kind = typeof error === 'object' && error !== null && 'kind' in error && typeof error.kind === 'string' ? error.kind : '';
      setOperationError(
        code === 'invalid_state_transition'
          ? t('skills.approvals.errorInvalidStateTransition')
          : kind === 'network_error'
            ? t('skills.approvals.errorNetwork')
            : t('skills.detail.updateError'),
      );
    } finally {
      setOperationPending(false);
    }
  }

  if (!name) {
    return null;
  }

  if (notFound) {
    return (
      <>
        <div className="crumbs">
          <Link href="/skills">{t('skills.detail.breadcrumb')}</Link>
          <span>/</span>
          <span className="mono">{name}</span>
        </div>
        <p className="empty">{t('skills.detail.notFound', { name })}</p>
      </>
    );
  }

  if (detail === undefined || listItem === undefined) {
    return (
      <>
        <div className="crumbs">
          <Link href="/skills">{t('skills.detail.breadcrumb')}</Link>
          <span>/</span>
          <span className="mono">{name}</span>
        </div>
        {loadError ? (
          <div className="panel">
            <div className="error" role="alert">{loadError}</div>
            <div className="btn-row mt-10">
              <button type="button" className="btn" onClick={retry}>{t('work.retry')}</button>
              <Link className="btn" href="/skills">{t('skills.detail.breadcrumb')}</Link>
            </div>
          </div>
        ) : (
          <p className="empty">{t('common.loading')}</p>
        )}
      </>
    );
  }

  if (detail === null) {
    return (
      <>
        <div className="crumbs">
          <Link href="/skills">{t('skills.detail.breadcrumb')}</Link>
          <span>/</span>
          <span className="mono">{name}</span>
        </div>
        <p className="empty">{t('skills.detail.loadError')}</p>
      </>
    );
  }

  const { skill, body, files, file_sizes, recent_uses } = detail;
  const filePaths = Object.keys(files).sort();
  const currentRevision = [...revisions].sort((a, b) => b.revision - a.revision)[0];
  const createRevision = revisions.find((r) => r.action === 'create') ?? revisions[revisions.length - 1];
  const scopeOptions = [GLOBAL_SKILL_SCOPE, ...projects.map((p) => projectSkillScope(p.id))];
  if (!scopeOptions.includes(skill.scope)) scopeOptions.push(skill.scope);

  return (
    <>
      <div className="crumbs">
        <Link href="/skills">{t('skills.detail.breadcrumb')}</Link>
        <span>/</span>
        <span className="mono">{skill.name}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 760 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page__title mono">{skill.name}</h1>
            <span className={`badge badge--${skill.state === 'active' ? 'green' : skill.state === 'stale' ? 'gray' : 'gray'}`}>
              {t(`skills.state.${skill.state}`)}
            </span>
            {skill.trial === 1 && listItem?.trial_progress && (
              <span className="badge badge--amber">
                {t('skills.list.trialBadge', { progress: `${listItem.trial_progress.evaluations}/${TRIAL_EVALUATIONS_LIMIT}` })}
              </span>
            )}
            <span className="scope-chip">{skillScopeLabel(skill.scope, projects, t)}</span>
          </div>
          <p style={{ margin: 0, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 }}>{skill.description}</p>
          {skill.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {skill.tags.map((tag) => (
                <span key={tag} className="scope-chip">{tag}</span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)' }}>
          {t('skills.detail.stateLabel')}
          <select
            className="select"
            value={skill.state}
            disabled={operationPending}
            onChange={(e) => void handlePatch({ state: e.target.value as SkillState })}
          >
            <option value="active">{t('skills.state.active')}</option>
            <option value="stale">{t('skills.state.stale')}</option>
            <option value="archived">{t('skills.state.archived')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)' }}>
          {t('skills.detail.scopeLabel')}
          <select
            className="select"
            value={skill.scope}
            disabled={operationPending}
            onChange={(e) => void handlePatch({ scope: e.target.value })}
          >
            {scopeOptions.map((scope) => (
              <option key={scope} value={scope}>{skillScopeLabel(scope, projects, t)}</option>
            ))}
          </select>
        </label>
        </div>
      </div>
      {operationError && <div className="error" role="alert">{operationError}</div>}
      {sideLoadErrors.map((message) => <div key={message} className="error" role="alert">{message}</div>)}

      <div className="tabs" role="tablist">
        <a href="#content" role="tab" aria-selected="true" className="tab tab--active">
          {t('skills.detail.tabContent')}
        </a>
        <Link href={`/skills/history?name=${encodeURIComponent(skill.name)}`} role="tab" aria-selected="false" className="tab">
          {t('skills.detail.tabHistory', { count: revisionsError ? '?' : String(revisions.length) })}
        </Link>
        <a href="#usage" role="tab" aria-selected="false" className="tab">
          {t('skills.detail.tabUsage', { count: String(recent_uses.length) })}
        </a>
      </div>

      <div className="detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} id="content">
          <section className="panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <h2 className="panel__title" style={{ margin: 0 }}>{t('skills.detail.skillMdTitle')}</h2>
              {currentRevision && (
                <span className="note">
                  {t('skills.detail.revisionMetaFormat', {
                    revision: String(currentRevision.revision),
                    size: formatByteSize(body),
                    actor: t(`skills.actor.${currentRevision.actor}`),
                    action: t(`skills.action.${currentRevision.action}`),
                    when: formatRelative(currentRevision.created_at, now, locale),
                  })}
                </span>
              )}
            </div>
            {skill.broken_reason ? (
              <div className="error" role="alert">
                {t('skills.detail.brokenState', { reason: skill.broken_reason })}
              </div>
            ) : body ? (
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.8, margin: 0 }}>{body}</pre>
            ) : (
              <p className="empty">{t('skills.detail.noBody')}</p>
            )}
          </section>

          <section className="panel">
            <h2 className="panel__title">{t('skills.detail.filesTitle')}</h2>
            {filePaths.length === 0 ? (
              <p className="empty">{t('skills.detail.noFiles')}</p>
            ) : (
              <div className="skill-files">
                {filePaths.map((path) => (
                  <details key={path} className="skill-file">
                    <summary className="skill-file-row">
                      <span className="skill-file-row__path">{path}</span>
                      <span className="card__spacer" />
                      <span className="skill-file-row__size">{file_sizes[path] !== undefined ? formatByteCount(file_sizes[path]) : formatByteSize(files[path] ?? '')}</span>
                    </summary>
                    <pre className="skill-file__content">{files[path]}</pre>
                  </details>
                ))}
              </div>
            )}
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {skill.trial === 1 && listItem?.trial_progress && (
            <section className="panel trial-panel">
              <h2 className="panel__title">{t('skills.detail.trialTitle')}</h2>
              <div className="trial-bar">
                <div className="trial-bar__head">
                  <span>{t('skills.detail.trialEvaluations')}</span>
                  <span>
                    {t('skills.detail.trialEvaluationsProgress', {
                      count: String(listItem.trial_progress.evaluations),
                      total: String(TRIAL_EVALUATIONS_LIMIT),
                    })}
                  </span>
                </div>
                <div className="trial-bar__track">
                  <div
                    className="trial-bar__fill trial-bar__fill--green"
                    style={{ width: `${Math.min(100, (listItem.trial_progress.evaluations / TRIAL_EVALUATIONS_LIMIT) * 100)}%` }}
                  />
                </div>
              </div>
              <div className="trial-bar">
                <div className="trial-bar__head">
                  <span>{t('skills.detail.trialMisleading')}</span>
                  <span>
                    {t('skills.detail.trialMisleadingProgress', {
                      count: String(listItem.trial_progress.misleading),
                      total: String(TRIAL_MISLEADING_LIMIT),
                    })}
                  </span>
                </div>
                <div className="trial-bar__track">
                  <div
                    className="trial-bar__fill trial-bar__fill--red"
                    style={{ width: `${Math.min(100, (listItem.trial_progress.misleading / TRIAL_MISLEADING_LIMIT) * 100)}%` }}
                  />
                </div>
              </div>
              <p className="note">
                {t('skills.detail.trialHint', {
                  remaining: String(Math.max(0, TRIAL_EVALUATIONS_LIMIT - listItem.trial_progress.evaluations)),
                  limit: String(TRIAL_MISLEADING_LIMIT),
                  revision: String(Math.max(1, skill.current_revision - 1)),
                })}
              </p>
            </section>
          )}

          <section className="panel" id="usage">
            <h2 className="panel__title">{t('skills.detail.usageTitle')}</h2>
            <div className="usage-grid">
              <div>
                <div className="usage-stat__label">{t('skills.detail.usageCount')}</div>
                <div className="usage-stat__value">{skill.use_count}</div>
              </div>
              <div>
                <div className="usage-stat__label">{t('skills.detail.usageLastUsed')}</div>
                <div className="usage-stat__value">{formatRelative(skill.last_used_at, now, locale)}</div>
              </div>
              <div>
                <div className="usage-stat__label">{t('skills.detail.usageHelpful')}</div>
                <div className="usage-stat__value usage-stat__value--green">{listItem?.helpful_count ?? 0}</div>
              </div>
              <div>
                <div className="usage-stat__label">{t('skills.detail.usageMisleading')}</div>
                <div className="usage-stat__value usage-stat__value--red">{listItem?.misleading_count ?? 0}</div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2 className="panel__title">{t('skills.detail.usageLogTitle')}</h2>
            {recent_uses.length === 0 ? (
              <p className="empty">{t('skills.detail.usageLogEmpty')}</p>
            ) : (
              <div className="usage-log" id="usage-log">
                {(usageExpanded ? recent_uses : recent_uses.slice(0, USAGE_LOG_PREVIEW)).map((use) => (
                  <div key={use.agent_run_id} className="usage-log-row" title={t('skills.detail.usageLogRun', { id: use.agent_run_id })}>
                    <div className="usage-log-row__meta">
                      <span className="badge badge--gray">{roleDisplayName(use.role ?? '', locale)}</span>
                      <span className={`usage-log-row__verdict usage-log-row__verdict--${use.verdict ?? 'none'}`}>
                        {t(`skills.detail.verdict.${use.verdict ?? 'none'}`)}
                      </span>
                      <span className="mono usage-log-row__revision">r{use.revision}</span>
                      <span className="card__spacer" />
                      <span className="usage-log-row__when">{formatRelative(use.used_at, now, locale)}</span>
                    </div>
                    {use.note && <div className="usage-log-row__note">{use.note}</div>}
                    {use.work_id && (
                      <Link href={`/work?id=${encodeURIComponent(use.work_id)}`} className="usage-log-row__work">
                        {t('skills.detail.originWorkLink', { title: use.work_title ?? use.work_id })}
                      </Link>
                    )}
                  </div>
                ))}
                {recent_uses.length > USAGE_LOG_PREVIEW && (
                  <button
                    type="button"
                    className="btn usage-log__toggle"
                    aria-expanded={usageExpanded}
                    aria-controls="usage-log"
                    onClick={() => setUsageExpanded((v) => !v)}
                  >
                    {usageExpanded
                      ? t('skills.detail.usageLogShowLess')
                      : t('skills.detail.usageLogShowMore', { count: String(recent_uses.length - USAGE_LOG_PREVIEW) })}
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <h2 className="panel__title">{t('skills.detail.originTitle')}</h2>
            {createRevision ? (
              <p className="note" style={{ lineHeight: 1.7 }}>
                {t('skills.detail.originFormat', {
                  actor: t(`skills.actor.${createRevision.actor}`),
                  when: formatRelative(createRevision.created_at, now, locale),
                  action: t(`skills.action.${createRevision.action}`),
                })}
                {listItem?.originating_work && (
                  <>
                    <br />
                    <Link href={`/work?id=${encodeURIComponent(listItem.originating_work.id)}`}>
                      {t('skills.detail.originWorkLink', { title: listItem.originating_work.title ?? listItem.originating_work.id })}
                    </Link>
                  </>
                )}
              </p>
            ) : revisionsError ? (
              <p className="error" role="alert">{revisionsError}</p>
            ) : (
              <p className="empty">{t('skills.detail.originNone')}</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

