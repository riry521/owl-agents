'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AutoWorkHistoryTab } from '@/components/AutoWorkHistoryTab';
import { ApiRequestError, getAutoWorkSettings, putAutoWorkSettings, runAutoWorkNow } from '@/lib/api-client';
import {
  AUTO_WORK_SETTINGS_VIEW_KEY, fromLabelKey, originLabelKey, rulesSummary, sourceLabelKey, summarizeRun,
} from '@/lib/auto-work.mjs';
import { useLocale, type TFunction } from '@/lib/i18n';
import { humanizeError } from '@/lib/settings-errors';
import type { AutoWorkListState, AutoWorkProjectSettings, AutoWorkRule, AutoWorkSettings } from '@/lib/types';
import { useView } from '@/lib/view-loader';

export const AUTO_WORK_PATH = '/settings/auto-work';
type SettingsData = AutoWorkSettings & { version: number };

const time = (iso: string | null) => (iso === null ? null : new Date(iso).toLocaleString());

function Switch({ on, busy, disabled, title, labelledBy, onToggle }: {
  on: boolean; busy: boolean; disabled?: boolean; title?: string; labelledBy: string; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-busy={busy}
      aria-labelledby={labelledBy}
      title={title}
      disabled={busy || disabled}
      className={`toggle-switch toggle-switch--${on ? 'on' : 'off'}`}
      onClick={onToggle}
    />
  );
}

function ErrorLine({ text }: { text: string | null }) {
  return text === null ? <>—</> : <span className="badge badge--red">{text}</span>;
}

function RulesTable({ rules, t }: { rules: AutoWorkRule[]; t: TFunction }) {
  return (
    <div className="aw-table__wrap">
      <table className="aw-table">
        <thead>
          <tr>
            <th>{t('autoWork.rules.id')}</th><th>{t('autoWork.rules.source')}</th><th>{t('autoWork.rules.kinds')}</th>
            <th>{t('autoWork.rules.occurrences')}</th><th>{t('autoWork.rules.action')}</th><th>{t('autoWork.rules.size')}</th>
            <th>{t('autoWork.rules.origin')}</th><th>{t('autoWork.rules.status')}</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const sourceKey = sourceLabelKey(rule.source);
            return (
              <tr key={rule.id} className={rule.disabled ? 'aw-disabled' : undefined}>
                <td className="mono">{rule.id}</td>
                <td>{sourceKey === null ? rule.source : t(sourceKey)}</td>
                <td className="mono">{rule.kinds.join(', ')}</td>
                <td>{rule.min_occurrences > 1
                  ? t('autoWork.rules.occurrencesWindow', { count: String(rule.min_occurrences), minutes: String(rule.window_minutes) })
                  : t('autoWork.rules.occurrencesOnce')}</td>
                <td><span className={`badge${rule.action === 'start' ? ' badge--amber' : ''}`}>{t(rule.action === 'start' ? 'autoWork.action.start' : 'autoWork.action.draft')}</span></td>
                <td>{rule.size ?? '—'}</td>
                <td>
                  <span className={`badge${rule.origin === 'project' ? ' badge--accent' : ''}`}>{t(originLabelKey(rule.origin))}</span>
                  {rule.overridden_fields.length > 0 && (
                    <> <span className="badge badge--accent">{t('autoWork.overridden', { fields: rule.overridden_fields.join(', ') })}</span></>
                  )}
                </td>
                <td><span className={`badge ${rule.disabled ? 'badge--red' : 'badge--green'}`}>{t(rule.disabled ? 'autoWork.rules.disabled' : 'autoWork.rules.enabled')}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ListLine({ name, list, t }: { name: string; list: AutoWorkListState; t: TFunction }) {
  return (
    <div className="aw-list-line">
      <strong>{name}</strong>
      <span className="mono">since {time(list.since) ?? '—'}</span>
      <span className={`badge${list.pending_items > 0 ? ' badge--accent' : ''}`}>{t('autoWork.github.pending', { n: String(list.pending_items) })}</span>
      <span className={`badge${list.failed_items > 0 ? ' badge--red' : ''}`}>{t('autoWork.github.failed', { n: String(list.failed_items) })}</span>
      {list.last_error !== null && <span className="badge badge--red">{list.last_error}</span>}
    </div>
  );
}

function ProjectDetails({ project, t }: { project: AutoWorkProjectSettings; t: TFunction }) {
  const { scheduled_check: check, watch, github } = project;
  return (
    <>
      <div className="grid grid--3 mt-10">
        <div className="aw-block">
          <p className="aw-block__title">{t('autoWork.check.title')}</p>
          <dl className="kv">
            <dt>{t('autoWork.check.times')}</dt><dd>{check.times.length > 0 ? check.times.join(', ') : t('autoWork.none')}</dd>
            <dt>{t('autoWork.check.items')}</dt>
            <dd>{check.items.length > 0 ? check.items.map((item, index) => <span key={item}>{index > 0 && ', '}<span className="mono">{item}</span></span>) : t('autoWork.none')}</dd>
            <dt>{t('autoWork.check.next')}</dt><dd>{time(check.next_run_at) ?? t('autoWork.check.noNext')}</dd>
            <dt>{t('autoWork.check.last')}</dt><dd>{time(check.last_run_at) ?? t('autoWork.check.noLast')}</dd>
          </dl>
        </div>
        <div className="aw-block">
          <p className="aw-block__title">{t('autoWork.watch.title')}</p>
          <dl className="kv">
            <dt>{t('autoWork.watch.logs')}</dt><dd>{t('autoWork.count', { n: String(watch.logs) })}</dd>
            <dt>{t('autoWork.watch.commands')}</dt><dd>{t('autoWork.count', { n: String(watch.commands) })}</dd>
            <dt>{t('autoWork.lastError')}</dt><dd>{watch.last_error === null ? t('autoWork.none') : <ErrorLine text={watch.last_error} />}</dd>
          </dl>
        </div>
        <div className="aw-block">
          <p className="aw-block__title">GitHub</p>
          {github.repo === null ? (
            <p className="note">{t('autoWork.github.notWatched')}</p>
          ) : (
            <>
              <dl className="kv">
                <dt>{t('autoWork.github.repo')}</dt><dd className="mono">{github.repo}</dd>
                <dt>{t('autoWork.github.allowedUsers')}</dt>
                <dd>{github.allowed_users.map((user) => <span key={user}><span className="mono">{user}</span>{' '}</span>)}</dd>
                <dt>{t('autoWork.github.requireLabels')}</dt>
                <dd>{github.require_labels.length > 0 ? github.require_labels.map((label) => <span key={label} className="mono">{label} </span>) : t('autoWork.none')}</dd>
                <dt>{t('autoWork.github.mention')}</dt><dd className="mono">{github.mention ?? t('autoWork.none')}</dd>
                <dt>{t('autoWork.github.poll')}</dt><dd>{t('autoWork.github.pollMinutes', { n: String(github.poll_minutes) })}</dd>
                <dt>{t('autoWork.github.maxItems')}</dt><dd>{t('autoWork.count', { n: String(github.max_items_per_poll) })}</dd>
                <dt>{t('autoWork.github.margin')}</dt><dd>{t('autoWork.github.marginSeconds', { n: String(github.since_margin_seconds) })}</dd>
                <dt>{t('autoWork.github.lastPolled')}</dt><dd>{time(github.last_polled_at) ?? t('autoWork.none')}</dd>
                <dt>{t('autoWork.lastError')}</dt><dd>{github.last_error === null ? t('autoWork.none') : <ErrorLine text={github.last_error} />}</dd>
              </dl>
              <div className="aw-lists">
                <ListLine name={t('autoWork.github.issues')} list={github.lists.issues} t={t} />
                <ListLine name={t('autoWork.github.comments')} list={github.lists.comments} t={t} />
              </div>
            </>
          )}
        </div>
      </div>
      <p className="aw-block__title mt-10">{t('autoWork.rules.title')} <span className="count">{project.rules.length}</span></p>
      <RulesTable rules={project.rules} t={t} />
    </>
  );
}

function ProjectCard({ project, globalOn, busy, running, expanded, onExpand, onToggle, onRun }: {
  project: AutoWorkProjectSettings;
  globalOn: boolean;
  busy: boolean;
  running: string | null;
  expanded: boolean;
  onExpand: () => void;
  onToggle: (value: boolean | null) => void;
  onRun: (what: 'github' | 'scheduled_check') => void;
}) {
  const { t } = useLocale();
  const on = project.enabled.effective;
  const name = project.project_name ?? project.project_id;
  const summary = rulesSummary(project.rules);
  const atCap = project.today.created >= project.today.cap;
  const runOff = !on || !globalOn;
  const labelId = `aw-project-${project.project_id}`;
  const parts = [
    summary.local > 0 && t('autoWork.rulesSummary.local', { n: String(summary.local) }),
    summary.project > 0 && t('autoWork.rulesSummary.project', { n: String(summary.project) }),
    summary.overridden > 0 && t('autoWork.rulesSummary.overridden', { n: String(summary.overridden) }),
  ].filter(Boolean).join('・');
  return (
    <article className={`panel aw-project${on ? '' : ' aw-disabled'}`} aria-labelledby={labelId}>
      <div className="aw-project__head">
        <Switch
          on={on}
          busy={busy}
          disabled={!globalOn}
          title={globalOn ? undefined : t('autoWork.state.globalOff')}
          labelledBy={labelId}
          onToggle={() => onToggle(!on)}
        />
        <h3 className="aw-project__name" id={labelId}>
          {name}
          <span className={`badge${on ? ' badge--green' : ''}`}>{t(on ? 'autoWork.on' : 'autoWork.off')}</span>
          <span className="badge">{t('autoWork.decidedBy', { from: t(fromLabelKey(project.enabled.from)) })}</span>
          <span className={`badge${project.config_file_present ? ' badge--accent' : ''}`}>
            {t(project.config_file_present ? 'autoWork.configFile.present' : 'autoWork.configFile.absent')}
          </span>
          <span className={`badge${summary.defaultsOnly ? '' : ' badge--accent'}`}>
            {summary.defaultsOnly ? t('autoWork.rulesSummary.defaultsOnly') : t('autoWork.rulesSummary.custom', { parts })}
          </span>
          {busy && <span className="note">{t('autoWork.state.toggling')}</span>}
        </h3>
        <div className="aw-project__end">
          <span className={`badge${atCap ? ' badge--amber' : ''}`}>
            {t('autoWork.today', { created: String(project.today.created), cap: String(project.today.cap) })}{atCap ? t('autoWork.atCap') : ''}
          </span>
          <button type="button" className="btn btn--small" disabled={runOff || running !== null} title={runOff ? t('autoWork.run.offline') : undefined} onClick={() => onRun('scheduled_check')}>
            {running === `${project.project_id}:scheduled_check` ? t('autoWork.run.scheduledRunning') : t('autoWork.run.scheduled')}
          </button>
          <button
            type="button"
            className="btn btn--small"
            disabled={runOff || project.github.repo === null || running !== null}
            title={runOff ? t('autoWork.run.offline') : project.github.repo === null ? t('autoWork.run.noRepo') : undefined}
            onClick={() => onRun('github')}
          >
            {running === `${project.project_id}:github` ? t('autoWork.run.githubRunning') : t('autoWork.run.github')}
          </button>
          <Link className="btn btn--small" href={`${AUTO_WORK_PATH}?tab=history&project_id=${encodeURIComponent(project.project_id)}`}>{t('autoWork.viewHistory')}</Link>
          {project.enabled.from === 'db' && (
            <button type="button" className="text-btn" disabled={busy} onClick={() => onToggle(null)}>{t('autoWork.resetToFile')}</button>
          )}
        </div>
      </div>
      {expanded ? (
        <ProjectDetails project={project} t={t} />
      ) : (
        <p className="aw-summary">
          {t('autoWork.summaryLine', {
            times: project.scheduled_check.times.join(', ') || t('autoWork.none'),
            watch: project.watch.logs + project.watch.commands > 0 ? t('autoWork.summaryWatch', { n: String(project.watch.logs + project.watch.commands) }) : t('autoWork.summaryNoWatch'),
            github: project.github.repo === null ? t('autoWork.summaryNoGithub') : project.github.repo,
            rules: String(project.rules.length),
          })}
          {'  '}
          <button type="button" className="text-btn" onClick={onExpand}>{t('autoWork.showDetails')}</button>
        </p>
      )}
    </article>
  );
}

function SettingsTab({ data, error, loading, refresh }: {
  data: SettingsData | undefined; error: unknown; loading: boolean; refresh: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [busyScopes, setBusyScopes] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  async function toggle(scope: string | null, value: boolean | null) {
    if (!data) return;
    const key = scope ?? '';
    setBusyScopes((current) => [...current, key]);
    setNotice(null);
    setFailure(null);
    try {
      await putAutoWorkSettings(scope === null ? { enabled: value } : { projects: { [scope]: { enabled: value } } }, data.version);
      setNotice(t('autoWork.state.toggled'));
      await refresh();
    } catch (err) {
      console.error('[Owl] Auto Work toggle failed', err);
      if (err instanceof ApiRequestError && err.code === 'version_conflict') {
        setFailure(t('autoWork.state.versionConflict'));
        await refresh();
      } else {
        setFailure(t('autoWork.state.toggleFailed', { error: humanizeError(err, t) }));
      }
    } finally {
      setBusyScopes((current) => current.filter((item) => item !== key));
    }
  }

  async function run(projectId: string, what: 'github' | 'scheduled_check') {
    setRunning(`${projectId}:${what}`);
    setNotice(null);
    setFailure(null);
    try {
      const result = await runAutoWorkNow(projectId, what);
      const { created, skipped } = summarizeRun(result.events);
      setNotice(result.events.length === 0
        ? t('autoWork.run.resultNone')
        : t('autoWork.run.result', { created: String(created), skipped: String(skipped) }));
      await refresh();
    } catch (err) {
      console.error('[Owl] Auto Work run failed', err);
      setFailure(err instanceof ApiRequestError && err.code === 'invalid_state' ? t('autoWork.run.offNow') : t('autoWork.run.failed', { error: humanizeError(err, t) }));
    } finally {
      setRunning(null);
    }
  }

  if (data === undefined) {
    return loading ? (
      <section className="panel"><p className="empty">{t('autoWork.state.loading')}</p></section>
    ) : (
      <section className="panel">
        <div className="error" role="alert">{t('autoWork.state.loadFailed')}</div>
        <div className="btn-row mt-10"><button type="button" className="btn" onClick={() => void refresh()}>{t('autoWork.state.retry')}</button></div>
      </section>
    );
  }

  const globalOn = data.enabled.effective;
  return (
    <>
      {error !== null && (
        <div className="error" role="alert" style={{ marginBottom: '12px' }}>
          {t('autoWork.state.staleError')} <button type="button" className="text-btn" onClick={() => void refresh()}>{t('autoWork.state.retry')}</button>
        </div>
      )}
      {failure !== null && <div className="error" role="alert" style={{ marginBottom: '12px' }}>{failure}</div>}
      {notice !== null && <p className="note note--success" role="status" style={{ marginBottom: '12px' }}>{notice}</p>}
      <section className="panel" aria-labelledby="aw-global">
        <h2 className="panel__title" id="aw-global">{t('autoWork.global.title')}</h2>
        <div className="aw-switch-row">
          <Switch on={globalOn} busy={busyScopes.includes('')} labelledBy="aw-global-label" onToggle={() => void toggle(null, !globalOn)} />
          <span id="aw-global-label" className="aw-switch-row__label">{t('autoWork.global.label')}</span>
          <span className={`badge${globalOn ? ' badge--green' : ''}`}>{t(globalOn ? 'autoWork.on' : 'autoWork.off')}</span>
          <span className="badge">{t('autoWork.decidedBy', { from: t(fromLabelKey(data.enabled.from)) })}</span>
          {data.enabled.from === 'db' && (
            <button type="button" className="text-btn" disabled={busyScopes.includes('')} onClick={() => void toggle(null, null)}>{t('autoWork.resetToFile')}</button>
          )}
          {busyScopes.includes('') && <span className="note">{t('autoWork.state.toggling')}</span>}
        </div>
        {data.config_error !== null && (
          <div className="error mt-10" role="alert"><span className="mono">{data.config_error}</span><br />{t('autoWork.state.configError')}</div>
        )}
        <p className="note mt-10">{t('autoWork.global.hint')}</p>
        <div className="grid grid--3 mt-10">
          <div className="aw-block">
            <p className="aw-block__title">{t('autoWork.limits.title')}</p>
            <dl className="kv">
              <dt>{t('autoWork.limits.all')}</dt>
              <dd>
                <strong style={data.today.cap_all !== null && data.today.created_all >= data.today.cap_all ? { color: 'var(--amber)' } : undefined}>{data.today.created_all}</strong>
                {' / '}{data.today.cap_all ?? '—'} {t('autoWork.limits.todaySuffix')}
              </dd>
              <dt>{t('autoWork.limits.perProject')}</dt><dd>{data.limits.max_works_per_day === null ? '—' : t('autoWork.count', { n: String(data.limits.max_works_per_day) })}</dd>
              <dt>{t('autoWork.limits.cooldown')}</dt><dd>{data.limits.cooldown_hours === null ? '—' : t('autoWork.limits.hours', { n: String(data.limits.cooldown_hours) })}</dd>
              <dt>{t('autoWork.limits.dayStart')}</dt><dd>{data.limits.day_start_time ?? '—'}</dd>
            </dl>
          </div>
          <div className="aw-block">
            <p className="aw-block__title">{t('autoWork.judge.title')}</p>
            <dl className="kv">
              <dt>{t('autoWork.judge.role')}</dt>
              <dd><span className="mono">{data.judge_role ?? '—'}</span> <Link href="/settings#sec-model-settings">{t('autoWork.judge.change')}</Link></dd>
            </dl>
          </div>
          <div className="aw-block">
            <p className="aw-block__title">{t('autoWork.files.title')}</p>
            <dl className="kv">
              <dt>{t('autoWork.files.defaults')}</dt><dd className="mono">{data.files.defaults}</dd>
              <dt>{t('autoWork.files.local')}</dt><dd className="mono">{data.files.local ?? t('autoWork.files.notCreated')}</dd>
              <dt>{t('autoWork.files.projects')}</dt><dd className="mono">{data.files.projects_dir}</dd>
            </dl>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="aw-projects">
        <div className="section__head">
          <h2 className="section__title" id="aw-projects">{t('autoWork.projects.title')}</h2>
          <span className="count">{t('autoWork.count', { n: String(data.projects.length) })}</span>
        </div>
        {data.projects.length === 0 ? (
          <p className="empty">{t('autoWork.state.emptyProjects')}</p>
        ) : data.projects.map((project) => (
          <ProjectCard
            key={project.project_id}
            project={project}
            globalOn={globalOn}
            busy={busyScopes.includes(project.project_id)}
            running={running}
            expanded={opened[project.project_id] ?? (project.enabled.effective && globalOn)}
            onExpand={() => setOpened((current) => ({ ...current, [project.project_id]: true }))}
            onToggle={(value) => void toggle(project.project_id, value)}
            onRun={(what) => void run(project.project_id, what)}
          />
        ))}
      </section>
    </>
  );
}

export function AutoWorkView() {
  const { t } = useLocale();
  const params = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'settings';
  const settings = useView<SettingsData>(AUTO_WORK_SETTINGS_VIEW_KEY, getAutoWorkSettings);

  return (
    <>
      <div className="crumbs"><Link href="/settings">{t('nav.settings')}</Link><span>/</span><strong>{t('autoWork.title')}</strong></div>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('autoWork.title')}</h1>
          <p className="page__sub">{t('autoWork.subtitle')}</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <Link className={`tab${tab === 'settings' ? ' tab--active' : ''}`} role="tab" aria-selected={tab === 'settings'} href={AUTO_WORK_PATH}>{t('autoWork.tabs.settings')}</Link>
        <Link className={`tab${tab === 'history' ? ' tab--active' : ''}`} role="tab" aria-selected={tab === 'history'} href={`${AUTO_WORK_PATH}?tab=history`}>{t('autoWork.tabs.history')}</Link>
      </div>
      {tab === 'settings' ? (
        <SettingsTab {...settings} />
      ) : (
        <AutoWorkHistoryTab projects={settings.data?.projects ?? []} />
      )}
    </>
  );
}
