'use client';

import { type KeyboardEvent, type RefObject, useEffect, useRef } from 'react';
import { AdvisorWindowPicker } from '@/components/AdvisorWindowPicker';
import type { AdvisorWindow } from '@/lib/types';
import { useLocale } from '@/lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  windows: AdvisorWindow[];
  currentKey: string;
  onSelect: (key: string) => void;
  onReorder?: (fromKey: string, toKey: string) => void;
  /** The window-name button; gets the focus back when the sheet closes. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Bottom sheet for switching windows on narrow screens. */
export function AdvisorWindowSheet({ open, onClose, windows, currentKey, onSelect, onReorder, returnFocusTo }: Props) {
  const { t } = useLocale();
  const sheetRef = useRef<HTMLDivElement | null>(null);

  function close() {
    onClose();
    returnFocusTo.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const row = sheetRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? sheetRef.current?.querySelector<HTMLElement>('button');
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
    function onKeyDown(ev: globalThis.KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // Re-run only when the sheet opens; close() reads the latest props at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  if (!open) return null;
  return (
    <>
      <div className="advisor-window-sheet__overlay" role="presentation" onMouseDown={close} />
      <div ref={sheetRef} className="advisor-window-sheet" role="dialog" aria-modal="true" aria-labelledby="advisor-window-sheet-title" onKeyDown={trapTab}>
        <div className="advisor-window-sheet__grip" aria-hidden="true" />
        <div className="advisor-window-sheet__head">
          <h2 id="advisor-window-sheet-title" className="advisor-window-sheet__title">{t('advisorWindows.sheetTitle')}</h2>
          <button type="button" className="advisor-window-sheet__close" onClick={close} aria-label={t('advisorWindows.channels.close')}>✕</button>
        </div>
        <AdvisorWindowPicker
          variant="sheet"
          windows={windows}
          currentKey={currentKey}
          onReorder={onReorder}
          onSelect={(key) => {
            // No focus return here: switching remounts the heading, so the caller refocuses the new button.
            onSelect(key);
            onClose();
          }}
        />
      </div>
    </>
  );
}
