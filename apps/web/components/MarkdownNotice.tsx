import Link from 'next/link';
import { useLocale } from '@/lib/i18n';
import { formatByteCount } from '@/lib/skill-diff';

export interface ViewerFailure {
  state: string;
  reason: string | null;
  network: boolean;
}

const DENIED_TEXT: Record<string, string> = {
  secret: 'mdViewer.denied.secret',
  not_markdown: 'mdViewer.denied.notMarkdown',
};
const RELOADABLE = new Set(['not_integrated', 'storage', 'load_failed']);
const TONE: Record<string, string> = { not_integrated: 'warning', storage: 'error', load_failed: 'error' };
const ICON: Record<string, string> = {
  denied: 'M4 11h16v10H4zM8 11V7a4 4 0 018 0v4',
  not_integrated: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  storage: 'M12 3l9.5 17h-19zM12 10v4M12 17h.01',
  load_failed: 'M12 3l9.5 17h-19zM12 10v4M12 17h.01',
};
const FILE_X = 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M10 13l4 4M14 13l-4 4';

/** The title/description shown for one non-ready state of the viewer. */
function noticeText(failure: ViewerFailure, details: Record<string, unknown>, workId: string | null, t: (key: string, params?: Record<string, string>) => string) {
  switch (failure.state) {
    case 'denied':
      return { title: t('mdViewer.denied.title'), text: t(DENIED_TEXT[failure.reason ?? ''] ?? 'mdViewer.denied.outside') };
    case 'not_found':
      return { title: t('mdViewer.notFound.title'), text: t('mdViewer.notFound.text') };
    case 'not_integrated':
      return { title: t('mdViewer.notIntegrated.title'), text: t('mdViewer.notIntegrated.text') };
    case 'too_large':
      return {
        title: t('mdViewer.tooLarge.title'),
        text: t('mdViewer.tooLarge.text', { limit: formatByteCount(Number(details.limit_bytes) || 0), size: formatByteCount(Number(details.size_bytes) || 0) }),
      };
    case 'unreadable':
      return { title: t('mdViewer.unreadable.title'), text: t('mdViewer.unreadable.text') };
    case 'storage':
      return { title: t('mdViewer.storage.title'), text: t('knowledge.storageUnavailable') };
    case 'invalid_url':
      return { title: t('mdViewer.invalidUrl.title'), text: t('mdViewer.invalidUrl.text') };
    case 'work_not_found':
      return { title: t('work.notFound'), text: t('work.notFoundDetail', { id: workId ?? '' }) };
    default:
      return { title: t('mdViewer.loadFailed.title'), text: t(failure.network ? 'mdViewer.loadFailed.network' : 'mdViewer.loadFailed.server') };
  }
}

/** One card explaining why the file cannot be shown, with the next action. */
export function MarkdownNotice({
  failure,
  details,
  workId,
  backHref,
  backLabel,
  onReload,
}: {
  failure: ViewerFailure;
  details: Record<string, unknown>;
  workId: string | null;
  backHref: string;
  backLabel: string;
  onReload: () => void;
}) {
  const { t } = useLocale();
  const { title, text } = noticeText(failure, details, workId, t);
  const reloadable = RELOADABLE.has(failure.state);
  const tone = TONE[failure.state];
  return (
    <div className={`md-notice${tone ? ` md-notice--${tone}` : ''}`} role="alert">
      <span className="md-notice__icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d={ICON[failure.state] ?? FILE_X} />
        </svg>
      </span>
      <h1 className="md-notice__title">{title}</h1>
      <p className="md-notice__text">{text}</p>
      <div className="md-notice__actions">
        {reloadable && (
          <button type="button" className="btn btn--primary" onClick={onReload}>
            {t('mdViewer.reload')}
          </button>
        )}
        <Link className={reloadable ? 'btn' : 'btn btn--primary'} href={backHref}>
          {backLabel}
        </Link>
      </div>
    </div>
  );
}
