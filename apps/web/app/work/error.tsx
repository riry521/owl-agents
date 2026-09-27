'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useLocale } from '@/lib/i18n';

export default function WorkError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useLocale();

  useEffect(() => {
    console.error('[Owl] Work detail render failed', error);
  }, [error]);

  return (
    <section className="panel">
      <div className="error" role="alert">
        {t('work.errorRender')}
      </div>
      <div className="btn-row mt-10">
        <button type="button" className="btn" onClick={reset}>{t('work.retry')}</button>
        <Link className="btn" href="/board">{t('common.backToBoard')}</Link>
      </div>
    </section>
  );
}
