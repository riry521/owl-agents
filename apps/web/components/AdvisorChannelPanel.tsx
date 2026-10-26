'use client';

import Link from 'next/link';
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import {
  bindAdvisorWindowChannel,
  createAdvisorWindowChannel,
  getAdvisorWindowChannels,
  inviteOwnerToWindowChannel,
  renameAdvisorWindowChannel,
} from '@/lib/api-client';
import { OwnerInviteButton } from '@/components/OwnerInviteButton';
import { channelErrorMessage } from '@/lib/advisor-windows.mjs';
import { useLocale } from '@/lib/i18n';
import type { AdvisorWindowChannelState } from '@/lib/types';
import { useView } from '@/lib/view-loader';

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const PROVIDER_LABELS = { slack: 'Slack', discord: 'Discord' } as const;

interface ChannelFailure {
  code: string;
  details: Record<string, unknown>;
}

function ChannelSection({ windowKey, item, onChanged }: { windowKey: string; item: AdvisorWindowChannelState; onChanged: () => void }) {
  const { t } = useLocale();
  const { provider, binding } = item;
  const label = PROVIDER_LABELS[provider];
  const [newName, setNewName] = useState(item.default_name ?? '');
  const [channelId, setChannelId] = useState('');
  // null until typed, so the input follows the bound name after a create or a refresh.
  const [renameInput, setRenameInput] = useState<string | null>(null);
  const renameTo = renameInput ?? binding?.display_name ?? '';
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ChannelFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      onChanged();
    } catch (error) {
      const { code, details } = error as { code?: string; details?: Record<string, unknown> };
      setFailure({ code: code ?? '', details: details ?? {} });
    } finally {
      setBusy(false);
    }
  }

  const message = failure ? channelErrorMessage(failure.code, failure.details, provider) : null;
  const unavailable = !item.configured || !item.running;

  return (
    <section className="advisor-channel-panel__provider" aria-label={label}>
      <h3>
        {label}
        <span className={`badge${binding ? ' badge--green' : ''}`}>
          {binding ? t('advisorWindows.channels.boundState') : t('advisorWindows.channels.unboundState')}
        </span>
      </h3>
      {message && (
        <div className="advisor-error" role="alert">
          <strong>{t(message.key, message.values)}</strong>
          {message.steps.length > 0 && (
            <ol>{message.steps.map((step) => <li key={step}>{t(step, message.values)}</li>)}</ol>
          )}
        </div>
      )}
      {unavailable ? (
        <>
          <p className="advisor-channel-panel__text">{t(item.configured ? 'advisorWindows.channels.notRunning' : 'advisorWindows.channels.notConfigured', { provider: label })}</p>
          <Link href="/settings" className="btn">{t('advisorWindows.channels.settingsLink')}</Link>
        </>
      ) : binding ? (
        <div className="advisor-channel-panel__group">
          <div className="advisor-channel-panel__bound-name">#{binding.display_name} <code>{binding.channel_id}</code></div>
          <h4>{t('advisorWindows.channels.renameTitle')}</h4>
          <div className="advisor-channel-panel__row">
            <input className="input" value={renameTo} aria-label={`${label} ${t('advisorWindows.channels.renameLabel')}`} onChange={(ev) => setRenameInput(ev.target.value)} />
            <button type="button" className="btn btn--primary" disabled={busy || !renameTo.trim()} onClick={() => run(() => renameAdvisorWindowChannel(windowKey, provider, renameTo), t('advisorWindows.channels.renamed'))}>
              {t('advisorWindows.channels.renameButton')}
            </button>
          </div>
          <p className="advisor-channel-panel__hint">{t('advisorWindows.channels.renameHint')}</p>
        </div>
      ) : (
        <>
          <div className="advisor-channel-panel__group">
            <h4>{t('advisorWindows.channels.createTitle')}</h4>
            <div className="advisor-channel-panel__row">
              <input className="input" value={newName} aria-label={`${label} ${t('advisorWindows.channels.createLabel')}`} onChange={(ev) => setNewName(ev.target.value)} />
              <button type="button" className="btn btn--primary" disabled={busy || !newName.trim()} onClick={() => run(() => createAdvisorWindowChannel(windowKey, provider, newName), t('advisorWindows.channels.created'))}>
                {t('advisorWindows.channels.createButton')}
              </button>
            </div>
            {!newName.trim() && <p className="advisor-channel-panel__hint">{t('advisorWindows.channels.emptyName')}</p>}
          </div>
          <div className="advisor-channel-panel__group">
            <h4>{t('advisorWindows.channels.bindTitle')}</h4>
            <div className="advisor-channel-panel__row">
              <input className="input" value={channelId} aria-label={`${label} ${t('advisorWindows.channels.bindLabel')}`} onChange={(ev) => setChannelId(ev.target.value)} />
              <button type="button" className="btn btn--primary" disabled={busy || !channelId.trim()} onClick={() => run(() => bindAdvisorWindowChannel(windowKey, provider, channelId.trim()), t('advisorWindows.channels.bound', { id: channelId.trim() }))}>
                {t('advisorWindows.channels.bindButton')}
              </button>
            </div>
            <p className="advisor-channel-panel__hint">{t(`advisorWindows.channels.bindHint${label}`)}</p>
          </div>
        </>
      )}
      {provider === 'slack' && (
        <OwnerInviteButton
          ownerSet={item.owner_user_id_set}
          label={t('ownerInvite.channelButton')}
          onInvite={async () => {
            const result = await inviteOwnerToWindowChannel(windowKey);
            return [{ name: result.display_name, invite: result.invite }];
          }}
        />
      )}
      {notice && <p className="advisor-channel-panel__notice" role="status">{notice}</p>}
    </section>
  );
}

export function AdvisorChannelPanel({ windowKey, generalist = false, onClose, returnFocusTo }: { windowKey: string; generalist?: boolean; onClose: () => void; returnFocusTo?: RefObject<HTMLElement | null> }) {
  const { t } = useLocale();
  // The generalist window has no channels to load.
  const channelsView = useView<AdvisorWindowChannelState[]>(generalist ? null : `advisor-window-channels:${windowKey}`, () => getAdvisorWindowChannels(windowKey));
  const closeRef = useRef<HTMLButtonElement | null>(null);

  function close() {
    onClose();
    returnFocusTo?.current?.focus();
  }

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(ev: globalThis.KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // Mount only: the panel is rendered while open, and close() reads the latest props at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Same trap as FolderPickerDialog: Tab wraps inside the dialog instead of reaching the page behind it.
  function trapTab(ev: KeyboardEvent<HTMLDivElement>) {
    if (ev.key !== 'Tab') return;
    const items = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="advisor-channel-panel__overlay" role="presentation" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) close(); }}>
      <div className="advisor-channel-panel" role="dialog" aria-modal="true" aria-labelledby="advisor-channel-panel-title" onKeyDown={trapTab}>
        <header className="advisor-channel-panel__header">
          <h2 id="advisor-channel-panel-title">{t('advisorWindows.channels.title')}</h2>
          <button ref={closeRef} type="button" className="btn" onClick={close}>{t('advisorWindows.channels.close')}</button>
        </header>
        <div className="advisor-channel-panel__body">
          {generalist ? (
            <>
              <p className="advisor-channel-panel__text">{t('advisorWindows.channels.generalistNote')}</p>
              <Link href="/settings" className="btn">{t('advisorWindows.channels.settingsLink')}</Link>
            </>
          ) : (
            <>
              <p className="advisor-channel-panel__lead">{t('advisorWindows.channels.lead')}</p>
              {channelsView.error ? <div className="advisor-error">{t('advisorWindows.channels.loadError')}</div> : null}
              {(channelsView.data ?? []).map((item) => (
                <ChannelSection key={`${item.provider}-${windowKey}`} windowKey={windowKey} item={item} onChanged={() => void channelsView.refresh()} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
