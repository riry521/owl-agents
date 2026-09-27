'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { listDirectories, ApiRequestError } from '@/lib/api-client';
import type { DirectoryListing } from '@/lib/types';
import { useLocale } from '@/lib/i18n';
import { humanizeError } from '@/lib/settings-errors';
import { FolderIcon } from '@/components/icons';

const SHORTCUT_LABEL_KEYS: Record<string, string> = {
  home: 'folderPicker.shortcutHome',
  desktop: 'folderPicker.shortcutDesktop',
  documents: 'folderPicker.shortcutDocuments',
  downloads: 'folderPicker.shortcutDownloads',
  owl_data: 'folderPicker.shortcutOwlData',
};

interface FolderPickerDialogProps {
  /** Nothing renders when false. */
  open: boolean;
  /** Path to browse to on open; empty falls back to the host's home folder. */
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/** Modal folder browser shared by Settings' path inputs (shared/screenshot folders). */
export function FolderPickerDialog({ open, initialPath, onSelect, onClose }: FolderPickerDialogProps) {
  const { t } = useLocale();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  async function load(path: string | undefined, hidden: boolean) {
    setLoading(true);
    setError(null);
    try {
      setListing(await listDirectories(path, hidden));
    } catch (err) {
      // A remembered/typed path that no longer exists falls back to home.
      if (path && err instanceof ApiRequestError && err.status === 404) {
        await load(undefined, hidden);
        return;
      }
      // The server localizes 403/404/422 messages; everything else gets the generic mapping.
      setError(
        err instanceof ApiRequestError && (err.status === 403 || err.status === 404 || err.status === 422)
          ? err.rawMessage
          : humanizeError(err, t),
      );
      setListing(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    setShowHidden(false);
    void load(initialPath || undefined, false);
    dialogRef.current?.focus();
    // Re-run only when the dialog opens, not on every prop change while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        handleClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleClose() {
    onClose();
    if (typeof HTMLElement !== 'undefined' && previouslyFocused.current instanceof HTMLElement) {
      previouslyFocused.current.focus();
    }
  }

  function handleToggleHidden(ev: ChangeEvent<HTMLInputElement>) {
    const next = ev.target.checked;
    setShowHidden(next);
    void load(listing?.path, next);
  }

  function handleUse() {
    if (!listing) return;
    onSelect(listing.path);
    handleClose();
  }

  if (!open) return null;

  return (
    <div
      className="folder-picker-backdrop"
      role="presentation"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) handleClose();
      }}
    >
      <section
        className="folder-picker panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-picker-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="folder-picker__head">
          <h2 className="panel__title" id="folder-picker-title">{t('folderPicker.title')}</h2>
        </div>
        <div className="folder-picker__current mono">{listing?.path ?? initialPath}</div>

        <div className="btn-row mt-10">
          {(listing?.shortcuts ?? []).map((shortcut) => (
            <button
              type="button"
              key={shortcut.key}
              className="btn btn--small"
              disabled={loading}
              onClick={() => void load(shortcut.path, showHidden)}
            >
              {t(SHORTCUT_LABEL_KEYS[shortcut.key] ?? shortcut.key)}
            </button>
          ))}
        </div>

        <div className="btn-row mt-10">
          <button
            type="button"
            className="btn folder-picker__up"
            disabled={loading || !listing?.parent}
            onClick={() => listing?.parent && void load(listing.parent, showHidden)}
          >
            {t('folderPicker.up')}
          </button>
          <label className="folder-picker__hidden-toggle">
            <input type="checkbox" checked={showHidden} disabled={loading} onChange={handleToggleHidden} />
            {t('folderPicker.showHidden')}
          </label>
        </div>

        {loading ? (
          <p className="empty">{t('common.loading')}</p>
        ) : error ? (
          <>
            <div className="error mt-10">{error}</div>
            <div className="btn-row mt-10">
              <button type="button" className="btn" onClick={() => void load(undefined, showHidden)}>
                {t('folderPicker.backHome')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="folder-picker__list" role="list">
              {(listing?.entries ?? []).map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  className="folder-picker__item"
                  title={entry.path}
                  onClick={() => void load(entry.path, showHidden)}
                >
                  <FolderIcon />
                  <span>{entry.name}</span>
                </button>
              ))}
              {listing && listing.entries.length === 0 && <p className="empty">{t('folderPicker.empty')}</p>}
            </div>
            {listing?.truncated && <p className="note mt-10">{t('folderPicker.truncated')}</p>}
          </>
        )}

        <div className="btn-row btn-row--spaced">
          <button type="button" className="btn" onClick={handleClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn--primary folder-picker__use" disabled={!listing} onClick={handleUse}>
            {t('folderPicker.useThisFolder')}
          </button>
        </div>
      </section>
    </div>
  );
}
