'use client';

import { useLocale } from '@/lib/i18n';
import type { MessageAttachment } from '@/lib/types';

/** File names of a sent message (no thumbnails). Quarantined files get a warning badge. */
export function MessageAttachments({ attachments }: { attachments?: MessageAttachment[] | null }) {
  const { t } = useLocale();
  if (!attachments || attachments.length === 0) return null;
  return (
    <ul className="attach-sent">
      {attachments.map((attachment) => {
        const quarantined = attachment.status === 'quarantined';
        return (
          <li
            key={attachment.id}
            className={`attach-tag${quarantined ? ' attach-tag--warning' : ''}`}
            title={quarantined ? t('attachments.quarantined') : attachment.filename}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <span className="attach-tag__name">{attachment.filename}</span>
            {quarantined ? <span className="attach-badge attach-badge--warning">{t('attachments.quarantinedBadge')}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
