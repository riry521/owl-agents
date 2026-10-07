import { Suspense } from 'react';
import { DecisionView } from '@/components/DecisionView';

/** Static route; the Decision id comes from `?id=` (read client-side via useSearchParams). */
export default function DecisionPage() {
  return (
    <Suspense fallback={<p className="empty">読み込み中…</p>}>
      <DecisionView />
    </Suspense>
  );
}
