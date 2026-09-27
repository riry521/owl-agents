'use client';

import { useState } from 'react';
import { archiveWork, unarchiveWork } from '@/lib/api-client';
import { confirmDeleteIfUnmerged, removeWorks } from '@/lib/work-removal';
import type { WorkSummary } from '@/lib/types';
import { useLocale, type TFunction } from '@/lib/i18n';
import { ArchiveBoxIcon, RestoreIcon, TrashIcon } from '@/components/icons';

type ArchivableWork = Pick<WorkSummary, 'id' | 'title' | 'state' | 'state_version' | 'archived_at'>;

export function WorkArchiveActions({
  work,
  onChanged,
  onDeleted,
  disabled = false,
}: {
  work: ArchivableWork;
  onChanged?: () => void;
  onDeleted: () => void;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isTerminal = work.state === 'completed' || work.state === 'cancelled';

  if (!isTerminal) return null;

  const run = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await operation();
      onChanged?.();
    } catch (reason) {
      setError(workActionError(reason, t));
    } finally {
      setPending(false);
    }
  };

  const handleDelete = () => {
    setPending(true);
    setError(null);
    void removeWorks([work], 'delete', () => confirmDeleteIfUnmerged([work], t))
      .then((deleted) => {
        if (deleted) onDeleted();
      })
      .finally(() => setPending(false));
  };

  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={disabled || pending}
        onClick={() => void run(() => work.archived_at
          ? unarchiveWork(work.id, work.state_version)
          : archiveWork(work.id, work.state_version))}
      >
        {work.archived_at ? <RestoreIcon /> : <ArchiveBoxIcon />}
        {work.archived_at ? t('work.unarchive') : t('work.archive')}
      </button>
      <button
        type="button"
        className="btn btn--danger"
        disabled={disabled || pending}
        onClick={handleDelete}
      >
        <TrashIcon />
        {t('work.delete')}
      </button>
      {pending && <span className="note" role="status">{t('work.operationPending')}</span>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

export function workActionError(error: unknown, t: TFunction): string {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
  const kind = typeof error === 'object' && error !== null && 'kind' in error && typeof error.kind === 'string'
    ? error.kind
    : '';
  return code === 'version_conflict'
    ? t('work.errorVersionConflict')
    : kind === 'network_error'
    ? t('work.errorNetwork')
      : t('work.errorOperation');
}
