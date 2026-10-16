'use client';

import { useEffect, useState } from 'react';
import { designMockUrl, getWorkDesignMocks, type WorkDesignMockSummary } from '@/lib/api-client';
import { formatRelative } from '@/lib/format';
import { formatByteCount } from '@/lib/skill-diff';
import type { Locale, TFunction } from '@/lib/i18n';

interface DesignMocksSectionProps {
  workId: string;
  refreshToken: number;
  now: number;
  locale: Locale;
  t: TFunction;
}

/**
 * HTML mocks the Work's screen design Tasks saved, grouped by Task. The chosen
 * mock is shown in an iframe with sandbox="allow-scripts" and no
 * allow-same-origin, so the agent-written script cannot reach Owl's origin.
 * Hidden entirely when there is nothing to show.
 */
export function DesignMocksSection({ workId, refreshToken, now, locale, t }: DesignMocksSectionProps) {
  const [mocks, setMocks] = useState<WorkDesignMockSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkDesignMockSummary | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getWorkDesignMocks(workId)
      .then((result) => {
        if (!alive) return;
        setMocks(result.mocks);
        setLoadError(null);
      })
      .catch((error) => {
        console.error('[Owl] Design mocks list failed', error);
        if (alive) setLoadError(t('work.errorDesignMocksLoad'));
      });
    return () => {
      alive = false;
    };
  }, [workId, refreshToken, t]);

  const openMock = (mock: WorkDesignMockSummary) => {
    setSelected(mock);
    setFrameSrc(null);
    designMockUrl(workId, mock.task_id, mock.name)
      .then(setFrameSrc)
      .catch((error) => {
        console.error('[Owl] Design mock URL failed', error);
        setLoadError(t('work.errorDesignMocksLoad'));
      });
  };

  // Nothing to show and nothing went wrong: the section stays hidden.
  if (!loadError && (mocks === null || mocks.length === 0)) return null;

  const groups = new Map<string, { title: string; items: WorkDesignMockSummary[] }>();
  for (const mock of mocks ?? []) {
    const group = groups.get(mock.task_id) ?? { title: mock.task_title, items: [] };
    group.items.push(mock);
    groups.set(mock.task_id, group);
  }
  // A refreshed list may no longer contain the mock being shown.
  const shown = selected && mocks?.find((m) => m.task_id === selected.task_id && m.name === selected.name);

  return (
    <section className="panel" aria-labelledby="sec-design-mocks">
      <h2 className="panel__title" id="sec-design-mocks">
        {t('work.designMocks')} <span className="count">{mocks?.length ?? 0}</span>
      </h2>
      {loadError && <div className="error" role="alert">{loadError}</div>}
      {[...groups.entries()].map(([taskId, group]) => (
        <div key={taskId} className="list">
          <h3 className="row__sub">{group.title}</h3>
          {group.items.map((mock) => (
            <button
              type="button"
              key={mock.name}
              className="row"
              style={{ width: '100%', border: 'none', textAlign: 'left', font: 'inherit', cursor: 'pointer' }}
              onClick={() => openMock(mock)}
            >
              <div className="row__main">
                <div className="row__title">{mock.name}</div>
                <div className="row__sub">
                  {formatRelative(mock.updated_at, now, locale)} · {formatByteCount(mock.size_bytes)}
                </div>
              </div>
            </button>
          ))}
        </div>
      ))}
      {shown && frameSrc && (
        <div className="mt-10">
          <iframe
            key={`${shown.task_id}/${shown.name}/${shown.updated_at}`}
            className="design-mock-frame"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={frameSrc}
            title={t('work.designMockFrameTitle', { name: shown.name })}
          />
        </div>
      )}
    </section>
  );
}
