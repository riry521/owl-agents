import type { ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLocale } from '@/lib/i18n';
import { remarkHeadingIds } from '@/lib/markdown-toc.mjs';

const EXTERNAL_URL = /^https?:\/\//i;

/**
 * Read-only view of an untrusted Markdown body: raw HTML is dropped, images become their alt text,
 * and only http(s) and in-page links stay links.
 */
export function MarkdownDocument({ markdown }: { markdown: string }) {
  const { t } = useLocale();
  if (markdown.trim() === '') return <p className="md-body">{t('mdViewer.empty')}</p>;
  const components: Components = {
    a: ({ href, children }: ComponentProps<'a'>) => {
      if (href?.startsWith('#')) return <a href={href}>{children}</a>;
      if (href && EXTERNAL_URL.test(href)) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }
      return <>{children}</>;
    },
    img: ({ alt }: ComponentProps<'img'>) => <span>{t('mdViewer.image', { alt: alt ?? '' })}</span>,
    table: ({ children }: ComponentProps<'table'>) => (
      <div className="md-table-scroll" tabIndex={0} role="region" aria-label={t('mdViewer.tableRegion')}>
        <table>{children}</table>
      </div>
    ),
  };
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkHeadingIds]} components={components} skipHtml>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
