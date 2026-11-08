import { Suspense } from 'react';
import { MarkdownViewerView } from '@/components/MarkdownViewerView';

/** Static route; the Work id and file path come from `?id=` and `?path=` (read client-side via useSearchParams). */
export default function WorkMarkdownPage() {
  return (
    <Suspense fallback={<p className="empty">読み込み中…</p>}>
      <MarkdownViewerView />
    </Suspense>
  );
}
