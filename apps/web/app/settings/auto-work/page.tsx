import { Suspense } from 'react';
import { AutoWorkView } from '@/components/AutoWorkView';

/** Static route; the tab and the history filters come from the query string (read client-side via useSearchParams). */
export default function AutoWorkPage() {
  return (
    <Suspense fallback={<p className="empty">読み込み中…</p>}>
      <AutoWorkView />
    </Suspense>
  );
}
