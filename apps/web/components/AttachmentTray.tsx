'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBytes, fileExtension } from '@/lib/attachment-draft.mjs';
import { useLocale } from '@/lib/i18n';
import type { DraftItem } from '@/lib/use-attachment-draft';

function ClipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** File Format Icon: a page outline with the extension as a label. */
export function FileIcon({ name }: { name: string }) {
  return (
    <span className="attach-ffi" aria-hidden="true">
      <svg viewBox="0 0 32 40" width="32" height="40" fill="none">
        <path d="M6 1h14l8 8v28a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="#fff" stroke="currentColor" strokeWidth="1.5" />
        <path d="M20 1v8h8" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span className="attach-ffi__label">{fileExtension(name)}</span>
    </span>
  );
}

/** 40×40 thumbnail; the object URL is revoked when the item is removed, sent or the screen is left. */
function Thumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img className="attach-thumb" src={url} width={40} height={40} alt="" /> : <span className="attach-thumb" aria-hidden="true" />;
}

export function AttachmentTray({
  items,
  notices,
  onRemove,
  onRetry,
  onDismissNotices,
}: {
  items: DraftItem[];
  notices: string[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onDismissNotices?: () => void;
}) {
  const { t } = useLocale();
  return (
    <>
      {notices.length > 0 ? (
        <div className="attach-notice" role="alert">
          <div className="attach-notice__body">
            {notices.map((notice) => <span key={notice}>{notice}</span>)}
          </div>
          {onDismissNotices ? (
            <button type="button" className="attach-notice__close" onClick={onDismissNotices} aria-label="×"><XIcon /></button>
          ) : null}
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className="attach-tray">
          {items.map((item) => (
            <li key={item.id} className={`attach-item attach-item--${item.status}`}>
              {item.file.type.startsWith('image/') ? <Thumbnail file={item.file} /> : <FileIcon name={item.file.name} />}
              <div className="attach-meta">
                <span className="attach-name" title={item.file.name}>{item.file.name}</span>
                <span className="attach-sub" role="status" aria-live="polite">
                  <span>{formatBytes(item.file.size)}</span>
                  {item.status === 'uploading' ? (
                    <><span className="attach-spinner" aria-hidden="true" />{t('attachments.uploading')}</>
                  ) : null}
                  {item.status === 'quarantined' ? (
                    <><span className="attach-badge attach-badge--warning">{t('attachments.quarantinedBadge')}</span>{t('attachments.quarantined')}</>
                  ) : null}
                  {item.status === 'failed' && item.reason ? (
                    <>
                      <span>{t(item.reason.key, item.reason.params)}</span>
                      <button type="button" className="attach-link" onClick={() => onRetry(item.id)}>{t('attachments.retry')}</button>
                    </>
                  ) : null}
                </span>
              </div>
              {item.status === 'uploading' ? <span className="attach-progress" aria-hidden="true" /> : null}
              <button type="button" className="attach-remove" onClick={() => onRemove(item.id)} aria-label={t('attachments.remove', { name: item.file.name })}>
                <XIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Clip button that opens a hidden multi-file input; the value is reset so the same file can be picked again. */
export function AttachButton({ onFiles, disabled = false }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="attach-button" disabled={disabled} onClick={() => input.current?.click()} aria-label={t('attachments.add')} title={t('attachments.add')}>
        <ClipIcon />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          onFiles(files);
        }}
      />
    </>
  );
}

/** Dropzone shown over the composer while files are dragged in. Limits are shown only once known. */
export function DropOverlay({ visible, hint }: { visible: boolean; hint?: string | null }) {
  const { t } = useLocale();
  if (!visible) return null;
  return (
    <div className="attach-drop" aria-hidden="true">
      <span className="attach-drop__icon">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 15V4m0 0-4 4m4-4 4 4" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
      </span>
      <span className="attach-drop__title">{t('attachments.dropHere')}</span>
      {hint ? <span className="attach-drop__sub">{hint}</span> : null}
    </div>
  );
}
