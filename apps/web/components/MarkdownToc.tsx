import type { CSSProperties, MouseEvent } from 'react';
import Link from 'next/link';
import { useLocale } from '@/lib/i18n';

export interface TocItem {
  id: string;
  text: string;
  indent: number;
}

/** The link back to the Work detail (or the Board); a plain same-tab link so a direct visit returns too. */
export function MarkdownBackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="md-back" href={href}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" />
      </svg>
      {label}
    </Link>
  );
}

/** The heading list, shared by the right-hand column and the bottom sheet. Selecting moves without touching the URL. */
export function MarkdownToc({ items, onSelect }: { items: TocItem[]; onSelect: (id: string) => void }) {
  const { t } = useLocale();
  return (
    <ol className="md-toc__list" aria-label={t('mdViewer.toc')}>
      {items.map((item) => (
        <li key={item.id}>
          <a
            className="md-toc__link"
            style={{ '--toc-level': item.indent } as CSSProperties}
            href={`#${item.id}`}
            onClick={(event: MouseEvent) => {
              event.preventDefault();
              onSelect(item.id);
            }}
          >
            {item.text}
          </a>
        </li>
      ))}
    </ol>
  );
}
