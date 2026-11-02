'use client';

import Link from 'next/link';
import { getAutoWorkSettings } from '@/lib/api-client';
import { AUTO_WORK_SETTINGS_VIEW_KEY, fromLabelKey } from '@/lib/auto-work.mjs';
import { useLocale } from '@/lib/i18n';
import type { AutoWorkSettings } from '@/lib/types';
import { useView } from '@/lib/view-loader';

const AUTO_WORK_PATH = '/settings/auto-work';

/** The /settings entry to the automatic Work creation page. It shares the page's settings view, so it never fetches twice. */
export function AutoWorkEntryPanel() {
  const { t } = useLocale();
  const { data, loading, refresh } = useView<AutoWorkSettings & { version: number }>(AUTO_WORK_SETTINGS_VIEW_KEY, getAutoWorkSettings);
  const on = data?.enabled.effective === true;
  const configError = data?.config_error ?? null;
  const projectsOn = data?.projects.filter((project) => project.enabled.effective).length ?? 0;
  const projectsOff = (data?.projects.length ?? 0) - projectsOn;
  const open = (
    <Link className={`btn${on ? ' btn--primary' : ''}`} href={AUTO_WORK_PATH}>{t('autoWork.entry.open')}</Link>
  );

  return (
    <section className="panel" aria-labelledby="sec-auto-work" style={{ marginTop: '24px' }}>
      <h2 className="panel__title" id="sec-auto-work">{t('autoWork.entry.title')}</h2>
      {data === undefined && loading ? (
        <p className="empty">{t('autoWork.state.loading')}</p>
      ) : data === undefined ? (
        <div className="aw-entry">
          <div className="error" role="alert">{t('autoWork.entry.loadFailed')}</div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => void refresh()}>{t('autoWork.state.retry')}</button>
            {open}
          </div>
        </div>
      ) : (
        <div className="aw-entry">
          <div>
            <div className="aw-entry__status">
              {configError !== null ? (
                <>
                  <span className="badge badge--red">{t('autoWork.entry.configError')}</span>
                  <span className="badge">{t('autoWork.entry.treatedAsOff')}</span>
                </>
              ) : (
                <>
                  <span className={`badge${on ? ' badge--green' : ''}`}>{t(on ? 'autoWork.on' : 'autoWork.off')}</span>
                  <span className="badge">{t('autoWork.decidedBy', { from: t(fromLabelKey(data.enabled.from)) })}</span>
                </>
              )}
            </div>
            {configError !== null ? (
              <div className="error" role="alert">{configError} {t('autoWork.state.configError')}</div>
            ) : (
              <>
                {on && (
                  <dl className="kv">
                    <dt>{t('autoWork.entry.todayCreated')}</dt>
                    <dd>{t('autoWork.entry.todayValue', { created: String(data.today.created_all), cap: String(data.today.cap_all ?? '—') })}</dd>
                    <dt>{t('autoWork.entry.projects')}</dt>
                    <dd>{t('autoWork.entry.projectsValue', { on: String(projectsOn), off: String(projectsOff) })}</dd>
                    <dt>{t('autoWork.entry.judgeRole')}</dt>
                    <dd className="mono">{data.judge_role ?? '—'}</dd>
                  </dl>
                )}
                <p className="aw-entry__hint">
                  {t(on ? (data.projects.length === 0 ? 'autoWork.entry.hintNoProjects' : 'autoWork.entry.hintOn') : 'autoWork.entry.hintOff')}
                </p>
              </>
            )}
          </div>
          <div className="btn-row">{open}</div>
        </div>
      )}
    </section>
  );
}
