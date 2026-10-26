'use client';

import { useState } from 'react';
import { useLocale } from '@/lib/i18n';
import type { OwnerInviteLine } from '@/lib/types';

/** Invite button shared by Settings and the channel panel; disabled with a reason until the owner ID is saved. */
export function OwnerInviteButton({ ownerSet, label, onInvite }: { ownerSet: boolean; label: string; onInvite: () => Promise<OwnerInviteLine[]> }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<OwnerInviteLine[] | null>(null);

  async function run() {
    setBusy(true);
    try {
      setLines(await onInvite());
    } catch (error) {
      const { rawMessage, message } = error as { rawMessage?: string; message?: string };
      setLines([{ name: null, invite: 'failed', message: rawMessage ?? message ?? '' }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="owner-invite">
      <button type="button" className="btn" disabled={!ownerSet || busy} onClick={run}>{label}</button>
      {!ownerSet && <p className="owner-invite__hint">{t('ownerInvite.ownerMissing')}</p>}
      {lines && lines.length === 0 && <p role="status">{t('ownerInvite.noChannels')}</p>}
      {lines && lines.length > 0 && (
        <ul role="status">
          {lines.map((line, i) => (
            <li key={`${line.name ?? ''}-${i}`}>
              {line.name ? `#${line.name}: ` : ''}
              {line.invite === 'failed' ? t('ownerInvite.failed', { message: line.message ?? '' }) : t(`ownerInvite.${line.invite}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
