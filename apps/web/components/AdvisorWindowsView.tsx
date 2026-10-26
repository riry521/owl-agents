'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AdvisorView } from '@/components/AdvisorView';
import { AdvisorWindowPicker } from '@/components/AdvisorWindowPicker';
import { AdvisorWindowSheet } from '@/components/AdvisorWindowSheet';
import { listAdvisorWindows } from '@/lib/api-client';
import { DEFAULT_WINDOW_KEY, resolveWindowKey, windowHref } from '@/lib/advisor-windows.mjs';
import { useLocale } from '@/lib/i18n';
import type { AdvisorWindow } from '@/lib/types';
import { useView } from '@/lib/view-loader';

// Shown when the list cannot be loaded: the generalist works without it.
const GENERAL_ONLY: AdvisorWindow[] = [
  { key: DEFAULT_WINDOW_KEY, scope: 'general', project_id: null, name: null, window_id: null, conversation_id: null, session_status: 'none', channels: [], last_message_at: null },
];

export function AdvisorWindowsView() {
  const { t } = useLocale();
  const router = useRouter();
  const param = useSearchParams().get('window');
  const windowsView = useView<AdvisorWindow[]>('advisor-windows', listAdvisorWindows);
  const windows = windowsView.data ?? (windowsView.error ? GENERAL_ONLY : []);
  const [sheetOpen, setSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Until the list arrives, trust the URL so the right conversation starts loading at once.
  // If loading failed, the generalist is the only window, so the conversation and the heading agree on it.
  const { key, found } = windowsView.data ? resolveWindowKey(param, windows) : { key: windowsView.error ? DEFAULT_WINDOW_KEY : param || DEFAULT_WINDOW_KEY, found: true };
  const current = windows.find((w) => w.key === key);
  // A project's name is unknown until the list arrives; AdvisorView then keeps its default heading.
  const windowName = key === DEFAULT_WINDOW_KEY ? t('advisorWindows.general') : current?.name ?? undefined;
  const windowScope = key === DEFAULT_WINDOW_KEY ? 'general' : current?.scope;

  useEffect(() => {
    if (!windowName) return;
    const previous = document.title;
    document.title = `${windowName} · ${t('advisor.title')}`;
    return () => { document.title = previous; };
  }, [windowName, t]);

  // Set when the sheet switches windows: the new AdvisorView's button takes the focus once it mounts.
  const refocus = useRef(false);
  useEffect(() => {
    if (refocus.current) {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [key]);

  // push, not replace: the browser's back button returns to the previous window.
  const select = (next: string) => {
    if (next !== key) router.push(windowHref(next));
  };

  return (
    <div className="advisor-windows-layout">
      {(windowsView.error || !found) && (
        <div className="advisor-windows-layout__notices">
          {windowsView.error ? <div className="advisor-error">{t('advisorWindows.loadError')}</div> : null}
          {!found && <div className="advisor-windows-layout__notice" role="status" aria-live="polite"><span>{t('advisorWindows.unknownWindow', { key: '\0' }).split('\0').flatMap((part, i) => (i ? [<code key={i}>{param}</code>, part] : [part]))}</span></div>}
        </div>
      )}
      <AdvisorWindowPicker variant="sidebar" windows={windows} currentKey={key} onSelect={select} />
      <div className="advisor-windows-layout__chat">
        <AdvisorView
          key={key}
          windowKey={key}
          knownConversationId={current?.conversation_id}
          channelControls
          windowName={windowName}
          windowScope={windowScope}
          onOpenWindowPicker={() => setSheetOpen(true)}
          windowPickerOpen={sheetOpen}
          windowTriggerRef={triggerRef}
        />
      </div>
      <AdvisorWindowSheet open={sheetOpen} onClose={() => setSheetOpen(false)} windows={windows} currentKey={key} onSelect={(next) => { refocus.current = next !== key; select(next); if (next === key) triggerRef.current?.focus(); }} returnFocusTo={triggerRef} />
    </div>
  );
}
