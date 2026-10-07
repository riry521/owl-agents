'use client';

import { useEffect } from 'react';
import { dismissRemovalError, useWorkRemovals } from '@/lib/work-removal';
import { useLocale } from '@/lib/i18n';

const ERROR_DISMISS_MS = 6000;

/**
 * Bottom-center pill shown only when an archive/unarchive/delete call fails, mounted once at
 * the app root. Reads the shared work-removal store directly and auto-dismisses after a while.
 */
export function RemovalErrorToast() {
  const { error } = useWorkRemovals();
  const { t } = useLocale();

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => dismissRemovalError(), ERROR_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [error?.id]);

  if (!error) return null;

  return (
    <div className="removal-toast-wrap" aria-live="polite" role="status">
      <div className="removal-toast" key={error.id}>
        <span className="removal-toast__text">{t('removal.error')}{error.detail ? ` (${error.detail})` : ''}</span>
        <button
          type="button"
          className="removal-toast__close"
          aria-label={t('common.close')}
          onClick={() => dismissRemovalError()}
        >
          ×
        </button>
      </div>
    </div>
  );
}
