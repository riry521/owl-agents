'use client';

import type { KeyboardEvent, Ref } from 'react';
import type { AdvisorWindow } from '@/lib/types';
import { useLocale } from '@/lib/i18n';

interface Props {
  windows: AdvisorWindow[];
  currentKey: string;
  onSelect: (key: string) => void;
  // sidebar: PC column with its own heading. sheet: only the list, for AdvisorWindowSheet.
  variant: 'sidebar' | 'sheet';
  listRef?: Ref<HTMLUListElement>;
  // Given: project rows can be dragged; fromKey is dropped onto toKey's row.
  onReorder?: (fromKey: string, toKey: string) => void;
}

const STATUS_KEYS = {
  running: 'advisorWindows.statusRunning',
  starting: 'advisorWindows.statusRunning',
  suspended: 'advisorWindows.statusSuspended',
  none: 'advisorWindows.statusNone',
} as const;

// Arrow keys stop at the ends; moving focus lets the browser scroll only the list.
function moveFocus(ev: KeyboardEvent<HTMLUListElement>) {
  const rows = Array.from(ev.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = ev.key === 'ArrowDown' ? Math.min(at + 1, rows.length - 1)
    : ev.key === 'ArrowUp' ? Math.max(at - 1, 0)
    : ev.key === 'Home' ? 0
    : ev.key === 'End' ? rows.length - 1
    : -1;
  if (next < 0 || at < 0) return;
  ev.preventDefault();
  rows[next]?.focus();
}

export function AdvisorWindowPicker({ windows, currentKey, onSelect, variant, listRef, onReorder }: Props) {
  const { t } = useLocale();
  const nameOf = (w: AdvisorWindow) => w.name ?? t('advisorWindows.general');
  const list = (
    <ul ref={listRef} className={`advisor-window-picker__list advisor-window-picker__list--${variant}`} onKeyDown={moveFocus}>
      {windows.map((w) => (
        <li
          key={w.key}
          className={w.scope === 'general' ? 'advisor-window-picker__item--general' : undefined}
          draggable={onReorder && w.scope !== 'general' ? true : undefined}
          onDragStart={(ev) => ev.dataTransfer.setData('text/plain', w.key)}
          onDragOver={onReorder ? (ev) => ev.preventDefault() : undefined}
          onDrop={onReorder ? (ev) => {
            ev.preventDefault();
            const from = ev.dataTransfer.getData('text/plain');
            if (from && from !== w.key) onReorder(from, w.key);
          } : undefined}
        >
          <button
            type="button"
            className="advisor-window-picker__row"
            aria-current={w.key === currentKey ? 'page' : undefined}
            title={nameOf(w)}
            onClick={() => onSelect(w.key)}
          >
            <span className="advisor-window-picker__name">{nameOf(w)}</span>
            <span className="advisor-window-picker__meta">
              <span className={`advisor-window-picker__badge advisor-window-picker__badge--${w.session_status === 'starting' ? 'running' : w.session_status}`}>
                {t(STATUS_KEYS[w.session_status])}
              </span>
              {w.channels.map((c) => (
                <span key={`${c.provider}:${c.channel_id}`} className="advisor-window-picker__channel">#{c.display_name}</span>
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
  if (variant === 'sheet') return list;
  return (
    <nav className="advisor-window-picker" aria-label={t('advisorWindows.pickerLabel')}>
      <h2 className="advisor-window-picker__title">{t('advisorWindows.title')}</h2>
      {list}
    </nav>
  );
}
