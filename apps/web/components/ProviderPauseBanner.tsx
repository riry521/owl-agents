'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getProviderPauses, resumeProviderPause, subscribeToUpdates } from '@/lib/api-client';
import type { ProviderPauseView } from '@/lib/types';
import { useLocale } from '@/lib/i18n';
import { providerPauseLines, refreshProviderPauses } from '@/lib/provider-pauses.mjs';

const PROVIDER_PAUSE_EVENT_TYPES = [
  'provider.paused',
  'provider.pause_updated',
  'provider.resume_attempted',
  'provider.resumed',
];

export function ProviderPauseBanner() {
  const { t } = useLocale();
  const [pauses, setPauses] = useState<ProviderPauseView[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [resuming, setResuming] = useState<ReadonlySet<string>>(new Set());
  const [resumeErrors, setResumeErrors] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    await refreshProviderPauses(getProviderPauses, (next) => {
      if (mounted.current) setPauses(next);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeToUpdates([], refresh, () => {}, PROVIDER_PAUSE_EVENT_TYPES);
    const timer = setInterval(() => {
      setNow(new Date());
      void refresh();
    }, 60_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh]);

  const resume = async (provider: string) => {
    setResuming((s) => new Set(s).add(provider));
    setResumeErrors((s) => {
      const n = new Set(s);
      n.delete(provider);
      return n;
    });
    try {
      await resumeProviderPause(provider);
      await refresh();
    } catch {
      if (mounted.current) setResumeErrors((s) => new Set(s).add(provider));
    } finally {
      if (mounted.current) {
        setResuming((s) => {
          const n = new Set(s);
          n.delete(provider);
          return n;
        });
      }
    }
  };

  const lines = providerPauseLines(pauses, t, now);
  if (lines.length === 0) return null;

  return (
    <section className="info-banner provider-pause-banner" aria-live="polite">
      {lines.map((line) => (
        <div key={line.provider} className="provider-pause-banner__line">
          <span className="provider-pause-banner__text">
            {line.state === 'paused' ? '⏸' : '▶'} {line.text}
          </span>
          {line.state === 'paused' && (
            <button
              type="button"
              className="btn"
              title={t('providerPause.resumeNowHint')}
              disabled={resuming.has(line.provider)}
              onClick={() => void resume(line.provider)}
            >
              {t('providerPause.resumeNow')}
            </button>
          )}
          {resumeErrors.has(line.provider) && (
            <span className="provider-pause-banner__error" role="alert">
              {t('providerPause.resumeFailed')}
            </span>
          )}
        </div>
      ))}
    </section>
  );
}
